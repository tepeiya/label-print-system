/**
 * PrintGateway 真实 HTTP 往返集成测试
 *
 * 补齐 T3 的覆盖缺口：T3（wms-inbound.int.test.ts）mock 了 PrintGateway 抛错，
 * 验证的是「过账流程对 gateway 异常的容错」；print.gateway.test.ts 用 mock fetch
 * 验证 gateway 逻辑；本文件起一个真实 HTTP 端点，让真实 PrintGateway 打过去，
 * 验证「真实 HTTP 500 / 超时 / 幂等映射 / 请求体约束」的降级行为——这是此前唯一
 * 没有运行时覆盖的一段（3s 超时 + 不重试 + 错误映射）。
 *
 * 运行：pnpm test:integration（无需真 PG，纯 HTTP）
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { PrintGateway } from '../../src/wms/gateways/print.gateway';

const REQ = {
  templateCode: 'RECEIPT_LABEL_V1',
  printerRoute: 'receipt-station',
  idempotencyKey: 'GRN:20261122:0001:L1',
  variables: { skuCode: 'MAT-001', qty: 120 },
  source: 'wms.inbound.receipt',
};

describe('PrintGateway 真实 HTTP 往返（非 mock fetch）', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: (req: http.IncomingMessage, body: any) => { status: number; body: any; delayMs?: number };
  let hitCount = 0;
  let lastBody: any;
  let lastAuth: string | undefined;

  beforeAll(async () => {
    process.env.WMS_SERVICE_TOKEN = 'lfagent_integration_token';
    server = http.createServer((req, res) => {
      hitCount++;
      lastAuth = req.headers.authorization;
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastBody = raw ? JSON.parse(raw) : {};
        const out = handler(req, lastBody);
        if (out.delayMs) {
          setTimeout(() => { res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.body)); }, out.delayMs);
        } else {
          res.writeHead(out.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out.body));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PRINT_INTERNAL_BASE_URL = baseUrl;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.PRINT_INTERNAL_BASE_URL;
    delete process.env.WMS_SERVICE_TOKEN;
  });

  beforeEach(() => { hitCount = 0; lastBody = undefined; lastAuth = undefined; });

  it('真实 200 往返：返回 jobId/status，Bearer token 正确，请求体不含 tenantId', async () => {
    handler = () => ({ status: 200, body: { jobId: 'pj_http_1', status: 'queued' } });
    const res = await new PrintGateway().createJob(REQ as any);
    expect(res.jobId).toBe('pj_http_1');
    expect(res.status).toBe('queued');
    expect(hitCount).toBe(1);
    expect(lastAuth).toBe('Bearer lfagent_integration_token');
    expect(lastBody.tenantId).toBeUndefined();
    expect(lastBody.templateCode).toBe('RECEIPT_LABEL_V1');
  });

  it('真实 500 往返：返回 status=failed + errorCode，不抛异常（供过账记 failed）', async () => {
    handler = () => ({ status: 500, body: { errorCode: 'PRINT_HTTP_500', message: '打印服务内部错误' } });
    const res = await new PrintGateway().createJob(REQ as any);
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('PRINT_HTTP_500');
    expect(hitCount).toBe(1);
  });

  it('真实 409/幂等往返：映射 idempotent=true', async () => {
    handler = () => ({ status: 200, body: { jobId: 'pj_http_1', status: 'queued', idempotent: true } });
    const res = await new PrintGateway().createJob(REQ as any);
    expect(res.idempotent).toBe(true);
  });

  it('真实超时（>3s）：抛不可达、只发一次请求（不重试）——打印侧幂等兜底', async () => {
    handler = () => ({ status: 200, body: { jobId: 'late', status: 'queued' }, delayMs: 5000 });
    const gw = new PrintGateway();
    await expect(gw.createJob(REQ as any)).rejects.toThrow(/超时|不可达/);
    expect(hitCount).toBe(1); // 关键：超时后不重试
  }, 10000);
});
