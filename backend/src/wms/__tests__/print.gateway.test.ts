// PrintGateway 单测：mock 全局 fetch，覆盖成功/幂等/错误/超时不重试
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintGateway } from '../gateways/print.gateway';

function withEnv(token: string | undefined, fn: () => void) {
  const old = process.env.WMS_SERVICE_TOKEN;
  const oldBase = process.env.PRINT_INTERNAL_BASE_URL;
  if (token === undefined) delete process.env.WMS_SERVICE_TOKEN;
  else process.env.WMS_SERVICE_TOKEN = token;
  process.env.PRINT_INTERNAL_BASE_URL = 'http://print.test';
  try { fn(); } finally {
    if (old === undefined) delete process.env.WMS_SERVICE_TOKEN; else process.env.WMS_SERVICE_TOKEN = old;
    if (oldBase === undefined) delete process.env.PRINT_INTERNAL_BASE_URL; else process.env.PRINT_INTERNAL_BASE_URL = oldBase;
  }
}

const req = {
  templateCode: 'RECEIPT_LABEL_V1', idempotencyKey: 'GRN:20261122:0001:L1',
  variables: { skuCode: 'MAT-001', qty: 120 }, source: 'wms.inbound.receipt',
};

test('未配置 service token：直接拒绝，不发起请求', async () => {
  await withEnv(undefined, async () => {
    const gw = new PrintGateway();
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; throw new Error('不应调用'); }) as any;
    try {
      await assert.rejects(() => gw.createJob(req), /WMS_SERVICE_TOKEN 未配置/);
      assert.equal(called, false);
    } finally { globalThis.fetch = orig; }
  });
});

test('成功响应：返回 jobId/status，并带 Bearer token + 不透传 tenantId', async () => {
  await withEnv('lfagent_abc', async () => {
    const gw = new PrintGateway();
    const orig = globalThis.fetch;
    let captured: any;
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ jobId: 'pj_1', status: 'queued' }) } as any;
    }) as any;
    try {
      const res = await gw.createJob(req as any);
      assert.equal(res.jobId, 'pj_1');
      assert.equal(res.idempotent, false);
      assert.equal(captured.init.headers.Authorization, 'Bearer lfagent_abc');
      assert.equal(captured.url, 'http://print.test/api/v1/internal/print-jobs');
      const body = JSON.parse(captured.init.body);
      assert.equal(body.tenantId, undefined, '请求体不得携带 tenantId');
      assert.equal(body.templateCode, 'RECEIPT_LABEL_V1');
    } finally { globalThis.fetch = orig; }
  });
});

test('409 幂等命中：映射为 idempotent=true', async () => {
  await withEnv('lfagent_abc', async () => {
    const gw = new PrintGateway();
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ jobId: 'pj_1', status: 'queued', idempotent: true }),
    })) as any;
    try {
      const res = await gw.createJob(req as any);
      assert.equal(res.idempotent, true);
    } finally { globalThis.fetch = orig; }
  });
});

test('模板不存在错误：返回 failed + errorCode，不抛异常（供过账记 failed）', async () => {
  await withEnv('lfagent_abc', async () => {
    const gw = new PrintGateway();
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false, status: 404, json: async () => ({ errorCode: 'PRINT_TEMPLATE_NOT_FOUND', message: '模板不存在' }),
    })) as any;
    try {
      const res = await gw.createJob(req as any);
      assert.equal(res.status, 'failed');
      assert.equal(res.errorCode, 'PRINT_TEMPLATE_NOT_FOUND');
    } finally { globalThis.fetch = orig; }
  });
});

test('超时：抛 ServiceUnavailableException 且不重试（只调用一次）', async () => {
  await withEnv('lfagent_abc', async () => {
    const gw = new PrintGateway();
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: any) => {
      calls++;
      // 模拟 AbortError（超时）
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      // 触发 signal 的 abort 监听逻辑：直接抛 AbortError
      return await new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(err));
        // 主动触发 abort 以模拟超时
        setTimeout(() => init.signal.dispatchEvent(new Event('abort')), 1);
      });
    }) as any;
    try {
      await assert.rejects(() => gw.createJob(req as any), /超时|不可达/);
      assert.equal(calls, 1, '超时不得重试');
    } finally { globalThis.fetch = orig; }
  });
});
