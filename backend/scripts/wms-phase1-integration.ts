/**
 * WMS 阶段一真实集成测试（连真实 PostgreSQL）
 * 用编译产物 + 真实 TypeORM DataSource + 真实 InboundService，mock 打印/库存 Gateway 可控成功/失败。
 * 覆盖文档 13.2 的 4 个场景（全链路①留 PDA 就绪后补）：
 *   ②重复过账拒绝  ③打印不可用时过账成功+补打  ④订阅门拦截  ⑤跨租户隔离
 * 另附：US-3 扫码累加/超收差异、US-5 上架推荐落库。
 * 运行：node --import tsx scripts/wms-phase1-integration.ts（连 DB_HOST:5433 测试库）
 */
import { DataSource, Repository } from 'typeorm';
import { SnakeNamingStrategy } from '../src/snake-naming.strategy';
import { tenantStorage, TenantCtx } from '../src/common/tenant.context';
import { InboundService } from '../src/wms/inbound/services/inbound.service';
import { WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule } from '../src/wms/inbound/entities/wms.entity';
import { Material, WarehouseLocation } from '../src/inventory/inventory.entity';

const DB = {
  type: 'postgres' as const,
  host: process.env.DB_HOST || '127.0.0.1',
  port: +(process.env.DB_PORT || 5433),
  username: process.env.DB_USER || 'labelflow',
  password: process.env.DB_PASS || 'labelflow',
  database: process.env.DB_NAME || 'labelflow',
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  logging: false,
};

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${detail}`); }
}
function ctx(tenantId: number, userId = 1): TenantCtx {
  return { tenantId, userId, roles: [], modules: ['wms.inbound'], permissions: [], plan: null, features: {}, dataScopes: null, dataSourceKey: 'default' };
}
async function run(tenantId: number, fn: () => Promise<any>) { return tenantStorage.run(ctx(tenantId), fn); }

// ---- 可控 mock Gateway ----
class MockPrintGw {
  calls: any[] = [];
  mode: 'ok' | 'fail' = 'ok';
  async createJob(req: any) {
    this.calls.push(req);
    if (this.mode === 'fail') throw new Error('PRINT_SERVICE_UNAVAILABLE');
    return { jobId: `pj_${req.idempotencyKey}`, status: 'queued' };
  }
}
class MockInventoryGw {
  calls: any[] = [];
  async increaseStock(p: any) { this.calls.push(p); return { movementId: `mv_${p.idempotencyKey}` }; }
  async transferStock(p: any) { return { movementId: `mv_t_${p.idempotencyKey}` }; }
  async queryAvailable(p: any) { return { qty: 0 }; }
}
class MockAudit {
  rows: any[] = [];
  async write(tenantId: number, action: string, detail: any) { this.rows.push({ tenantId, action, detail }); }
  async find(q: any) { return this.rows.filter((r) => r.action === q.action); }
}

async function main() {
  const { ModuleRecord, TenantModule, Plan, PlanModule, Subscription } = require('../src/entities/saas.entity');
  const ds = new DataSource({ ...DB, entities: [WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule, Material, WarehouseLocation, ModuleRecord, TenantModule, Plan, PlanModule, Subscription] });
  await ds.initialize();
  console.log('[DB] 连接成功');

  const receipts = ds.getRepository(WmsReceipt);
  const lines = ds.getRepository(WmsReceiptLine);
  const tasks = ds.getRepository(WmsPutawayTask);
  const rules = ds.getRepository(WmsPutawayRule);
  const materials = ds.getRepository(Material);
  const locations = ds.getRepository(WarehouseLocation);

  const printGw = new MockPrintGw();
  const invGw = new MockInventoryGw();
  const audit = new MockAudit();
  const svc = new InboundService(receipts, lines, tasks, rules, materials, locations, printGw as any, invGw as any, audit as any);

  // 清理测试单号（先子表后父表，规避 FK）
  await ds.query(`DELETE FROM wms_putaway_tasks WHERE receipt_line_id IN (SELECT id FROM wms_receipt_lines WHERE receipt_id IN (SELECT id FROM wms_receipts WHERE receipt_no LIKE 'IT-%'))`);
  await ds.query(`DELETE FROM wms_receipt_lines WHERE receipt_id IN (SELECT id FROM wms_receipts WHERE receipt_no LIKE 'IT-%')`);
  await ds.query(`DELETE FROM wms_receipts WHERE receipt_no LIKE 'IT-%'`);
  printGw.calls = [];
  invGw.calls = [];
  audit.rows = [];

  console.log('\n=== 场景② 重复过账拒绝 + 过账编排 ===');
  const created = await run(901, () => svc.createReceipt({
    receiptNo: 'IT-001', sourceType: 'MANUAL', warehouseId: 801,
    lines: [{ sku: 'MAT-A001', batchNo: 'B01', qtyExpected: 120 }],
  }));
  ok('建单 status=CREATED', created.status === 'CREATED');
  await run(901, () => svc.receiveScan(created.id, { sku: 'MAT-A001', batchNo: 'B01', qty: 120 }));
  const posted = await run(901, () => svc.postReceipt(created.id));
  ok('过账后 status=RECEIVED', posted.status === 'RECEIVED');
  ok('库存Gateway被调用一次', invGw.calls.length === 1, `实际${invGw.calls.length}`);
  ok('库存落点=推荐库位(非空)', !!invGw.calls[0]?.locationId, JSON.stringify(invGw.calls[0]));
  ok('上架任务已生成', (await tasks.count({ where: { tenantId: 901, receiptLineId: posted.results[0].lineId } })) === 1);
  ok('打印被调用一次', printGw.calls.length === 1);
  let dupRejected = false;
  try { await run(901, () => svc.postReceipt(created.id)); } catch (e: any) { dupRejected = /重复过账|已过账/.test(e.message); }
  ok('重复过账被拒绝(409语义)', dupRejected);
  ok('重复过账未重复加库存', invGw.calls.length === 1);

  console.log('\n=== 场景③ 打印不可用时过账成功 + 补打成功 ===');
  printGw.mode = 'fail';
  printGw.calls = [];
  const c2 = await run(901, () => svc.createReceipt({
    receiptNo: 'IT-002', sourceType: 'MANUAL', warehouseId: 801,
    lines: [{ sku: 'MAT-A002', batchNo: 'B02', qtyExpected: 50 }],
  }));
  await run(901, () => svc.receiveScan(c2.id, { sku: 'MAT-A002', qty: 50 }));
  let post2Ok = true;
  try { await run(901, () => svc.postReceipt(c2.id)); } catch { post2Ok = false; }
  ok('打印失败时过账仍成功', post2Ok);
  const c2db = await run(901, () => svc.getReceipt(c2.id));
  ok('过账后行状态=RECEIVED(账实一致)', c2db.lines[0].status === 'RECEIVED', c2db.lines[0].status);
  const failAudit = audit.rows.filter((r) => r.action === 'wms.print.call' && r.detail.status === 'failed');
  ok('打印失败审计已记录(failed)', failAudit.length >= 1);
  const line2Id = c2db.lines[0].id;
  printGw.mode = 'ok';
  printGw.calls = [];
  const reprint = await run(901, () => svc.reprintLabel(line2Id));
  ok('补打成功', !!reprint.jobId, JSON.stringify(reprint));
  ok('补打用新幂等键(reprint)', String(reprint.idempotencyKey).includes(':reprint:'));
  ok('补打source为reprint', printGw.calls[0]?.source === 'wms.inbound.receipt.reprint');

  console.log('\n=== 场景⑤ 跨租户隔离（租户B读A的单据）===');
  let crossDenied = false;
  try { await run(902, () => svc.getReceipt(created.id)); } catch (e: any) { crossDenied = /不存在/.test(e.message); }
  ok('租户B读租户A收货单被拒(404)', crossDenied);
  const bList = await run(902, () => svc.listReceipts({}));
  ok('租户B列表看不到A的单据', !bList.items.some((x: any) => x.receiptNo === 'IT-001'));

  console.log('\n=== 场景④ 订阅门拦截（ModulesService 真实查库）===');
  const { ModulesService } = await import('../src/saas/modules.service');
  const modulesSvc = new ModulesService(
    ds.getRepository(ModuleRecord), ds.getRepository(TenantModule),
    ds.getRepository(Plan), ds.getRepository(PlanModule), ds.getRepository(Subscription),
  );
  const aActive = await modulesSvc.listTenantActive(901);
  const bActive = await modulesSvc.listTenantActive(902);
  ok('租户A已开通wms.inbound', aActive.includes('wms.inbound'), JSON.stringify(aActive));
  ok('租户B未开通wms.inbound(应被Guard拦)', !bActive.includes('wms.inbound'), JSON.stringify(bActive));
  const { ModuleGuard, MODULE_KEY } = await import('../src/common/module.guard');
  const { Reflector } = await import('@nestjs/core');
  const guard = new ModuleGuard(new Reflector(), modulesSvc);
  function fakeCtx(tenantId: number) {
    const handler = () => {};
    Reflect.defineMetadata(MODULE_KEY, ['wms.inbound'], handler);
    return { getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ user: { tenantId } }) }) } as any;
  }
  let bBlocked = false, aAllowed = false;
  try { await guard.canActivate(fakeCtx(902)); } catch (e: any) { bBlocked = (e as any).bizCode === 4031 || /未开通|4031/.test(e.message); }
  aAllowed = await guard.canActivate(fakeCtx(901));
  ok('ModuleGuard拦截未开通租户B(4031)', bBlocked);
  ok('ModuleGuard放行已开通租户A', aAllowed === true);

  console.log('\n=== 附加：US-3 扫码累加/超收差异（真实DB）===');
  const c3 = await run(901, () => svc.createReceipt({
    receiptNo: 'IT-003', sourceType: 'MANUAL', warehouseId: 801,
    lines: [{ sku: 'MAT-A001', qtyExpected: 100 }],
  }));
  await run(901, () => svc.receiveScan(c3.id, { sku: 'MAT-A001', qty: 60 }));
  const s2 = await run(901, () => svc.receiveScan(c3.id, { sku: 'MAT-A001', qty: 70 }));
  ok('重复扫码累加(60+70=130)', Number(s2.line.qtyReceived) === 130, String(s2.line.qtyReceived));
  ok('超收差异=OVER且diffQty=30', s2.line.diffType === 'OVER' && Number(s2.line.diffQty) === 30, JSON.stringify(s2.line));

  console.log('\n=== 附加：US-5 上架推荐落库（真实DB含推荐原因）===');
  const task = await tasks.findOne({ where: { tenantId: 901, receiptLineId: posted.results[0].lineId } });
  ok('上架任务落库含推荐原因', !!task?.recommendReason, task?.recommendReason ?? '(空)');

  await ds.destroy();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(2); });
