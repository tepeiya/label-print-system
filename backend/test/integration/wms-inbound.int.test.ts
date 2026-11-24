/**
 * WMS 阶段一真 PG 集成测试（5 条最小验收门）
 *
 * 与 src/wms/__tests__ 的 14 例纯函数测试职责不同、并存互补：
 *   - 纯函数层：决策逻辑（幂等键/差异/库位校验/推荐排序），快、无依赖、开发反馈。
 *   - 本集成层：只有真 PG 能验证的行为——RLS 跨租户隔离、过账状态机、并发幂等、
 *     Gateway 真实降级、订阅门。mock 仅打印/库存 Gateway 可控成功/失败。
 *
 * 5 条验收门（文档 13.2 最小集合；全链路①留 PDA 就绪后补）：
 *   T1 跨租户隔离 + RLS：A 建单 B 查不到；直连 SQL 验证 4 表挂 tenant_isolation
 *   T2 重复过账拒绝：同单过账两次，第 2 次拒、库存不翻倍
 *   T3 打印降级：打印 Gateway 抛 500/超时 → 过账成功、审计 failed、补打成功
 *   T4 过账中途失败：库存变更抛错 → 行状态/任务无脏数据（暴露非单一事务后果）
 *   T5 订阅门：未开通 wms.inbound 的租户被 ModuleGuard 拦截（真实查库）
 *   G8 收货侧 UDI 拦截：udi_required 物料无码/码不符 → 拒；正确码 → 收；箱码按件数折（与发料同口径）
 *      （G8 曾因"InboundService 缺夹具"长期 skip，本套件夹具齐备后补齐；udi 用替身，校验其收到的参数）
 *
 * 前提：测试库已按 scripts/wms-test-db-bootstrap.sh 初始化。
 * 运行：pnpm test:integration（DB_PORT 默认 5434）
 */
import { DataSource } from 'typeorm';
import { Reflector } from '@nestjs/core';
import { SnakeNamingStrategy } from '../../src/snake-naming.strategy';
import { tenantStorage, TenantCtx } from '../../src/common/tenant.context';
import { ModuleGuard, MODULE_KEY } from '../../src/common/module.guard';
import { ModulesService } from '../../src/saas/modules.service';
import { InboundService } from '../../src/wms/inbound/services/inbound.service';
import { WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule } from '../../src/wms/inbound/entities/wms.entity';
import { Material, WarehouseLocation } from '../../src/inventory/inventory.entity';
import { ModuleRecord, TenantModule, Plan, PlanModule, Subscription } from '../../src/entities/saas.entity';

const DB = {
  type: 'postgres' as const,
  host: process.env.DB_HOST || '127.0.0.1',
  port: +(process.env.DB_PORT || 5434),
  username: process.env.DB_USER || 'labelflow',
  password: process.env.DB_PASS || 'labelflow',
  database: process.env.DB_NAME || 'labelflow',
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  logging: false,
};

const A = 901; // 已开通 wms.inbound
const B = 902; // 未开通

function ctx(tenantId: number, userId = 1): TenantCtx {
  return {
    tenantId, userId, roles: [], modules: ['wms.inbound'], permissions: [],
    plan: null, features: {}, dataScopes: null, dataSourceKey: 'default',
  } as TenantCtx;
}
async function asTenant<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(ctx(tenantId), fn);
}

/** 集成测试夹具（幂等）：两个租户（A 开通 wms.inbound / B 不开通）、仓库、库位、物料、上架规则 */
async function seedFixtures(ds: DataSource) {
  await ds.query(`INSERT INTO tenants (id,name,code,status) VALUES (901,'租户A','wms_test_a',1),(902,'租户B','wms_test_b',1)
                  ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO tenant_modules (tenant_id,module_code,status,source) VALUES (901,'wms.inbound','active','manual')
                  ON CONFLICT (tenant_id,module_code) DO NOTHING`);
  await ds.query(`INSERT INTO warehouses (id,tenant_id,code,name) VALUES (801,901,'WH-A','A仓'),(802,902,'WH-B','B仓')
                  ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO warehouse_locations (id,tenant_id,warehouse_id,code,name,zone) VALUES
                    (8011,901,801,'A-01','A库位01','FAST'),(8012,901,801,'A-02','A库位02','SLOW'),
                    (8021,902,802,'B-01','B库位01','FAST') ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO materials (id,tenant_id,code,name,unit) VALUES
                    (9011,901,'MAT-A001','轴承6204','PCS'),(9012,901,'MAT-A002','齿轮','PCS'),
                    (9021,902,'MAT-B001','B司物料','PCS') ON CONFLICT (id) DO NOTHING`);
  // G8 夹具：udi_required 物料（主码 06901234567892）+ 箱码（06901234567885，箱规 24）
  await ds.query(`INSERT INTO materials (id,tenant_id,code,name,unit,gtin,udi_required) VALUES
                    (9013,901,'MAT-A003','一次性注射器 5ml','PCS','06901234567892',true)
                  ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO material_gtins (tenant_id,material_id,gtin,pack_level,pack_qty,is_primary) VALUES
                    (901,9013,'06901234567892','UNIT',1,true),(901,9013,'06901234567885','CARTON',24,false)
                  ON CONFLICT DO NOTHING`);
  const ruleCount = await ds.query(`SELECT count(*)::int AS n FROM wms_putaway_rules WHERE tenant_id = 901 AND warehouse_id = 801`);
  if (!ruleCount[0].n) {
    await ds.query(`INSERT INTO wms_putaway_rules (tenant_id,warehouse_id,priority,condition_json,action_json)
                    VALUES (901,801,10,'{"abc":"A"}'::jsonb,'{"zoneCode":"FAST","sortBy":"DISTANCE"}'::jsonb)`);
  }
}

// ---- 可控 Gateway 替身（唯一 mock 点）----
class PrintGwStub {
  calls: any[] = [];
  mode: 'ok' | 'fail500' | 'timeout' = 'ok';
  async createJob(req: any) {
    this.calls.push(req);
    if (this.mode === 'fail500') { const e: any = new Error('PRINT_TEMPLATE_NOT_FOUND'); e.errorCode = 'PRINT_HTTP_500'; throw e; }
    if (this.mode === 'timeout') { const e: any = new Error('PRINT_GATEWAY_TIMEOUT'); e.errorCode = 'ETIMEDOUT'; throw e; }
    return { jobId: `pj_${req.idempotencyKey}`, status: 'queued' };
  }
}
class InventoryGwStub {
  calls: any[] = [];
  failNext = false;
  /** 真查 material_gtins（收发货共用的包码表）；与真实 InventoryGateway 同义，只是不经过仓储层代理 */
  constructor(private ds?: DataSource) {}
  async resolveMaterialGtinRows(p: { tenantId: number; materialId: number }) {
    const rows = await this.ds!.query(
      `SELECT gtin, pack_level AS "packLevel", pack_qty AS "packQty", is_primary AS "isPrimary"
         FROM material_gtins WHERE tenant_id = $1 AND material_id = $2 ORDER BY is_primary DESC, id`,
      [p.tenantId, p.materialId],
    );
    return rows.map((r: any) => ({ ...r, packQty: String(r.packQty) }));
  }
  async increaseStock(p: any) {
    this.calls.push(p);
    if (this.failNext) { this.failNext = false; throw new Error('STOCK_WRITE_FAILED'); }
    return { movementId: `mv_${p.idempotencyKey}` };
  }
  async transferStock(p: any) { return { movementId: `mv_t_${p.idempotencyKey}` }; }
  async queryAvailable() { return { qty: 0 }; }
}
class UdiStub {
  calls: any[] = [];
  async receiveByScan(p: any) {
    this.calls.push(p);
    return { udiKey: `${p.code}|${p.receiptNo}`, gtin: String(p.code).replace(/[()]/g, '').slice(0, 14), idempotent: false, qty: p.qty };
  }
}
class AuditStub {
  rows: any[] = [];
  async write(tenantId: number, action: string, detail: any) { this.rows.push({ tenantId, action, detail }); }
  async find(q: any) { return this.rows.filter((r) => r.action === q.action); }
}

describe('WMS 阶段一 真 PG 集成测试（验收门 5 条）', () => {
  let ds: DataSource;
  let svc: InboundService;
  let printGw: PrintGwStub;
  let invGw: InventoryGwStub;
  let audit: AuditStub;
  let udi: UdiStub;
  let modulesSvc: ModulesService;

  beforeAll(async () => {
    ds = new DataSource({
      ...DB,
      entities: [
        WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule,
        Material, WarehouseLocation, ModuleRecord, TenantModule, Plan, PlanModule, Subscription,
      ],
    });
    await ds.initialize();
    const receipts = ds.getRepository(WmsReceipt);
    const lines = ds.getRepository(WmsReceiptLine);
    const tasks = ds.getRepository(WmsPutawayTask);
    const rules = ds.getRepository(WmsPutawayRule);
    const materials = ds.getRepository(Material);
    const locations = ds.getRepository(WarehouseLocation);
    printGw = new PrintGwStub();
    invGw = new InventoryGwStub(ds);
    audit = new AuditStub();
    udi = new UdiStub();
    svc = new InboundService(receipts, lines, tasks, rules, materials, locations, printGw as any, invGw as any, audit as any, udi as any);
    modulesSvc = new ModulesService(
      ds.getRepository(ModuleRecord), ds.getRepository(TenantModule),
      ds.getRepository(Plan), ds.getRepository(PlanModule), ds.getRepository(Subscription),
    );
    // 自备夹具（原本由 scripts/wms-test-db-bootstrap.sh 用 docker exec 灌入）：
    // 改成测试自己幂等插入，任何库跑完 db-init.sh 后即可直接跑本套件，不再依赖外部脚本。
    await seedFixtures(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  /** 每个测试前清理 IT-% 测试单与 Gateway 记录，保证独立 */
  beforeEach(async () => {
    await ds.query(`DELETE FROM wms_putaway_tasks WHERE receipt_line_id IN (SELECT id FROM wms_receipt_lines WHERE receipt_id IN (SELECT id FROM wms_receipts WHERE receipt_no LIKE 'IT-%'))`);
    await ds.query(`DELETE FROM wms_receipt_lines WHERE receipt_id IN (SELECT id FROM wms_receipts WHERE receipt_no LIKE 'IT-%')`);
    await ds.query(`DELETE FROM wms_receipts WHERE receipt_no LIKE 'IT-%'`);
    printGw.calls = []; printGw.mode = 'ok';
    invGw.calls = []; invGw.failNext = false;
    audit.rows = [];
  });

  async function createAndScan(receiptNo: string, sku = 'MAT-A001', qty = 120) {
    const created = await asTenant(A, () => svc.createReceipt({
      receiptNo, sourceType: 'MANUAL', warehouseId: 801,
      lines: [{ sku, batchNo: 'B-IT', qtyExpected: qty }],
    }));
    await asTenant(A, () => svc.receiveScan(created.id, { sku, batchNo: 'B-IT', qty }));
    return created;
  }

  // ---------------------------------------------------------------- T1
  it('T1 跨租户隔离 + RLS：A 建单 B 查不到；全部 wms_* 表均挂 tenant_isolation', async () => {
    // ① 应用层隔离：租户 B 读 A 的单据 → 404
    const created = await createAndScan('IT-T1');
    await expect(asTenant(B, () => svc.getReceipt(created.id))).rejects.toThrow(/不存在/);
    const bList = await asTenant(B, () => svc.listReceipts({}));
    expect(bList.items.some((x: any) => x.receiptNo === 'IT-T1')).toBe(false);

    // ② 数据库层 RLS：4 张表 relrowsecurity=t 且挂 tenant_isolation 策略
    const rows = await ds.query(`
      SELECT t.tablename, c.relrowsecurity AS rls, p.policyname
      FROM pg_tables t
      JOIN pg_class c ON c.relname = t.tablename
        AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
      LEFT JOIN pg_policies p ON p.tablename = t.tablename AND p.policyname='tenant_isolation'
      WHERE t.tablename LIKE 'wms_%' AND t.schemaname='public'
      ORDER BY t.tablename
    `);
    // 不写死表数：阶段一 4 张 + 阶段二 4 张，以后新增 WMS 表自动纳入门禁
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(r.rls).toBe(true);
      expect(r.policyname).toBe('tenant_isolation');
    }
  });

  // ---------------------------------------------------------------- T2
  it('T2 重复过账拒绝：同单过账两次，第 2 次拒、库存不翻倍', async () => {
    const created = await createAndScan('IT-T2');
    const posted = await asTenant(A, () => svc.postReceipt(created.id));
    expect(posted.status).toBe('RECEIVED');
    expect(invGw.calls).toHaveLength(1);
    await expect(asTenant(A, () => svc.postReceipt(created.id))).rejects.toThrow(/重复过账|已过账/);
    expect(invGw.calls).toHaveLength(1); // 未重复加库存
  });

  // ---------------------------------------------------------------- T3
  it('T3 打印降级：打印抛 500/超时 → 过账成功、审计 failed、补打成功', async () => {
    printGw.mode = 'fail500';
    const created = await createAndScan('IT-T3', 'MAT-A002', 50);
    const posted = await asTenant(A, () => svc.postReceipt(created.id));
    expect(posted.status).toBe('RECEIVED'); // 打印失败不阻塞过账

    const c2db = await asTenant(A, () => svc.getReceipt(created.id));
    expect(c2db.lines[0].status).toBe('RECEIVED'); // 账实一致
    const failed = audit.rows.filter((r) => r.action === 'wms.print.call' && r.detail.status === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);

    // 超时也降级
    printGw.mode = 'timeout';
    const created2 = await createAndScan('IT-T3B', 'MAT-A002', 30);
    await expect(asTenant(A, () => svc.postReceipt(created2.id))).resolves.toMatchObject({ status: 'RECEIVED' });

    // 补打成功 + 新幂等键 + source=reprint
    printGw.mode = 'ok'; printGw.calls = [];
    const reprint = await asTenant(A, () => svc.reprintLabel(c2db.lines[0].id));
    expect(reprint.jobId).toBeTruthy();
    expect(String(reprint.idempotencyKey)).toContain(':reprint:');
    expect(printGw.calls[0].source).toBe('wms.inbound.receipt.reprint');
  });

  // ---------------------------------------------------------------- T4
  it('T4 过账中途失败：库存变更抛错 → 行状态/任务无脏数据（非单一事务的真实后果）', async () => {
    const created = await createAndScan('IT-T4');
    invGw.failNext = true; // 注入：库存变更（过账第一步）抛错
    await expect(asTenant(A, () => svc.postReceipt(created.id))).rejects.toThrow(/STOCK_WRITE_FAILED/);

    // 库存是过账第一步：它失败后，行状态更新与任务创建都不应执行 → 无脏数据
    const cdb = await asTenant(A, () => svc.getReceipt(created.id));
    expect(cdb.status).toBe('RECEIVING'); // 单据未错误地置为 RECEIVED
    expect(cdb.lines[0].status).toBe('PENDING'); // 行未被错误地置 RECEIVED
    const tasks = await ds.getRepository(WmsPutawayTask).find({ where: { tenantId: A } });
    const thisOrderTasks = tasks.filter((t: any) => String(t.qty) === '120');
    // 精确按本单行 id 查
    const byLine = await ds.getRepository(WmsPutawayTask).count({ where: { receiptLineId: cdb.lines[0].id } });
    expect(byLine).toBe(0); // 未留下孤立上架任务
    expect(thisOrderTasks.length).toBeGreaterThanOrEqual(0); // （辅助：不作强断言）

    // 重试恢复：库存不再失败后，同单可继续过账成功（幂等重试兜底）
    const posted = await asTenant(A, () => svc.postReceipt(created.id));
    expect(posted.status).toBe('RECEIVED');
  });

  // ---------------------------------------------------------------- T5
  it('T5 订阅门：未开通 wms.inbound 的租户被 ModuleGuard 拦截（真实查库）', async () => {
    const aActive = await modulesSvc.listTenantActive(A);
    const bActive = await modulesSvc.listTenantActive(B);
    expect(aActive).toContain('wms.inbound');
    expect(bActive).not.toContain('wms.inbound');

    const guard = new ModuleGuard(new Reflector(), modulesSvc);
    function fakeCtx(tenantId: number) {
      const handler = () => {};
      Reflect.defineMetadata(MODULE_KEY, ['wms.inbound'], handler);
      return {
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => ({ user: { tenantId } }) }),
      } as any;
    }
    let bBlocked = false;
    try { await guard.canActivate(fakeCtx(B)); }
    catch (e: any) { bBlocked = e.bizCode === 4031 || /未开通|4031/.test(e.message); }
    expect(bBlocked).toBe(true);
    await expect(guard.canActivate(fakeCtx(A))).resolves.toBe(true);
  });

  // ---------------------------------------------------------------- G8
  // 收货侧 UDI 拦截（udi_required 物料必须带码）。长期 skip 的原因是"InboundService 缺服务级夹具"，
  // 本套件已有六 repo + 可查包装表的 InventoryGateway 替身 + UDI 替身，故在此补齐。
  it('G8 收货侧 UDI 拦截：无码/码不符拒收，正确码放行，箱码按件数折', async () => {
    // ① 无码：udi_required 物料 → 拒收，且不落任何收货数量
    const r1 = await asTenant(A, () => svc.createReceipt({
      receiptNo: 'IT-G8-1', sourceType: 'MANUAL', warehouseId: 801,
      lines: [{ sku: 'MAT-A003', batchNo: 'B-G8', qtyExpected: 100 }],
    }));
    await expect(asTenant(A, () => svc.receiveScan(r1.id, { sku: 'MAT-A003', batchNo: 'B-G8', qty: 10 })))
      .rejects.toThrow(/udi_required|UDI 码/);
    const l1 = await asTenant(A, () => svc.getReceipt(r1.id));
    expect(Number(l1.lines[0].qtyReceived)).toBe(0);
    // 审计里留下拦截证据，便于现场排查"为什么扫不进去"
    expect(audit.rows.filter((r) => r.action === 'wms.receive.udi.gtin_block').length).toBeGreaterThanOrEqual(1);
    expect(udi.calls).toHaveLength(0);

    // ② 有码但 GTIN 与物料不符 → 拒收
    await expect(asTenant(A, () => svc.receiveScan(r1.id, {
      sku: 'MAT-A003', batchNo: 'B-G8', qty: 10, udiCode: '(01)06901234567908(10)B-G8',
    }))).rejects.toThrow(/GTIN|不符|udi_required/);

    // ③ 正确 UNIT 码 → 放行，并把码交给 UDI 建档（参数与行号/数量一致）
    const unitCode = '(01)06901234567892(10)B-G8(17)271231(21)SN0001';
    const okScan = await asTenant(A, () => svc.receiveScan(r1.id, {
      sku: 'MAT-A003', batchNo: 'B-G8', qty: 10, udiCode: unitCode,
    }));
    expect(okScan.ok).toBe(true);
    expect(Number(okScan.line.qtyReceived)).toBe(10);
    expect(udi.calls).toHaveLength(1);
    expect(udi.calls[0].qty).toBe(10);
    expect(udi.calls[0].receiptNo).toBe('IT-G8-1');
    expect(audit.rows.filter((r) => r.action === 'wms.receive.udi').length).toBeGreaterThanOrEqual(1);

    // ④ 箱码：2 箱 × 24 = 48 件（与发料侧 D4 同一折算口径）
    const r2 = await asTenant(A, () => svc.createReceipt({
      receiptNo: 'IT-G8-2', sourceType: 'MANUAL', warehouseId: 801,
      lines: [{ sku: 'MAT-A003', batchNo: 'B-G8', qtyExpected: 200 }],
    }));
    const boxScan = await asTenant(A, () => svc.receiveScan(r2.id, {
      sku: 'MAT-A003', batchNo: 'B-G8', qty: 2, udiCode: '(01)06901234567885(10)B-G8',
    }));
    expect(boxScan.ok).toBe(true);
    expect(boxScan.pack).toMatchObject({ packLevel: 'CARTON', packCount: 2, units: 48 });
    expect(String(boxScan.pack.packQty)).toBe('24');
    expect(Number(boxScan.line.qtyReceived)).toBe(48);
    expect(udi.calls[1].qty).toBe(48);
    expect(udi.calls[1].packLevel).toBe('CARTON');

  });
});
