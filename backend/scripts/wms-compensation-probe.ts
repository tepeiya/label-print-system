/**
 * 过账失败补偿探针 —— 实证 postReceipt 中途失败后重试的一致性。
 * 注入点：tasks.save 第一次抛错（模拟"行已RECEIVED、库存已加、任务未建"后进程崩溃）。
 * 观察：重试能否补齐任务、库存是否重复加、整单状态是否收敛。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/snake-naming.strategy';
import { tenantStorage, TenantCtx } from '../src/common/tenant.context';
import { InboundService } from '../src/wms/inbound/services/inbound.service';
import { WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule } from '../src/wms/inbound/entities/wms.entity';
import { Material, WarehouseLocation } from '../src/inventory/inventory.entity';

const DB = { type: 'postgres' as const, host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 5433),
  username: process.env.DB_USER || 'labelflow', password: process.env.DB_PASS || 'labelflow',
  database: process.env.DB_NAME || 'labelflow', namingStrategy: new SnakeNamingStrategy(), synchronize: false, logging: false };
const ctx: TenantCtx = { tenantId: 901, userId: 1, roles: [], modules: ['wms.inbound'], permissions: [], plan: null, features: {}, dataScopes: null, dataSourceKey: 'default' };

async function main() {
  const ds = new DataSource({ ...DB, entities: [WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule, Material, WarehouseLocation] });
  await ds.initialize();
  const receipts = ds.getRepository(WmsReceipt), lines = ds.getRepository(WmsReceiptLine), tasks = ds.getRepository(WmsPutawayTask);
  const rules = ds.getRepository(WmsPutawayRule), materials = ds.getRepository(Material), locations = ds.getRepository(WarehouseLocation);
  await ds.query(`DELETE FROM wms_putaway_tasks WHERE receipt_line_id IN (SELECT id FROM wms_receipt_lines WHERE receipt_id IN (SELECT id FROM wms_receipts WHERE receipt_no='COMP-001'))`);
  await ds.query(`DELETE FROM wms_receipt_lines WHERE receipt_id IN (SELECT id FROM wms_receipts WHERE receipt_no='COMP-001')`);
  await ds.query(`DELETE FROM wms_receipts WHERE receipt_no='COMP-001'`);

  let invCalls = 0, taskSaveCount = 0, failNextTaskSave = true;
  const printGw: any = { createJob: async (r: any) => ({ jobId: 'pj_' + r.idempotencyKey, status: 'queued' }) };
  const invGw: any = { increaseStock: async () => { invCalls++; return { movementId: 'mv' }; }, transferStock: async () => ({ movementId: 'mv' }), queryAvailable: async () => ({ qty: 0 }) };
  // 注入：让真实 tasks.save 第一次抛错（通过包装 repo）
  const realTaskRepo = tasks;
  const failingTasks: any = {
    save: async (...a: any[]) => { taskSaveCount++; if (failNextTaskSave) { failNextTaskSave = false; throw new Error('INJECTED_TASK_SAVE_FAILURE'); } return realTaskRepo.save(...a as any); },
    create: (x: any) => realTaskRepo.create(x), find: (...a: any[]) => realTaskRepo.find(...a as any),
    findOne: (...a: any[]) => realTaskRepo.findOne(...a as any), count: (...a: any[]) => realTaskRepo.count(...a as any),
  };
  const audit: any = { write: async () => {}, find: async () => [] };
  const svc = new InboundService(receipts, lines, failingTasks, rules, materials, locations, printGw, invGw, audit);

  await tenantStorage.run(ctx, async () => {
    const c = await svc.createReceipt({ receiptNo: 'COMP-001', sourceType: 'MANUAL', warehouseId: 801, lines: [{ sku: 'MAT-A001', batchNo: 'BX', qtyExpected: 10 }] });
    await svc.receiveScan(c.id, { sku: 'MAT-A001', qty: 10 });
    console.log('\n--- 第一次过账（注入 tasks.save 失败）---');
    try { await svc.postReceipt(c.id); } catch (e: any) { console.log('  抛错:', e.message); }
    const lineAfter = await lines.findOne({ where: { receiptId: c.id } });
    const taskAfter = await tasks.count({ where: { receiptLineId: Number(lineAfter!.id) } });
    console.log(`  行状态=${lineAfter!.status} 任务数=${taskAfter} 库存调用=${invCalls}`);

    console.log('\n--- 第二次过账（重试）---');
    try { const r = await svc.postReceipt(c.id); console.log('  返回:', r.status, 'results条数=', r.results.length); }
    catch (e: any) { console.log('  抛错:', e.message); }
    const line2 = await lines.findOne({ where: { receiptId: c.id } });
    const task2 = await tasks.count({ where: { receiptLineId: Number(line2!.id) } });
    const receipt2 = await receipts.findOne({ where: { id: c.id } });
    console.log(`  行状态=${line2!.status} 任务数=${task2} 整单状态=${receipt2!.status} 库存调用累计=${invCalls}`);
    console.log(`\n  结论: ${task2 === 1 && invCalls === 2 ? '✓ 重试补齐任务，库存幂等未重复' : '✗ 补偿失效：' + (task2 === 0 ? '任务永久丢失' : '') + (invCalls > 2 ? ' 库存重复' : '')}`);
  });
  await ds.destroy();
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(2); });
