/**
 * WMS 阶段二（发料）真 PG 集成验收：G1–G7（docs/17 §8.1 的 7 道门）
 *
 * 与 src/wms/issuing/__tests__ 的纯函数测试互补：
 *   - 纯函数层：齐套计算、批次分配、发料计算（mock 网关，快）
 *   - 本层：只有真 PG 能证明的——BOM 展开落库、库存真扣减、stock_moves 台账、重跑幂等、
 *     缺料无记录、退料回补、跨租户不可见（含 labelflow_app 角色 RLS 实测）
 *
 * 运行：pnpm test:integration（需先跑 backend/scripts/db-init.sh 建库）
 */
import { DataSource } from 'typeorm';
import { Reflector } from '@nestjs/core';
import { SnakeNamingStrategy } from '../../src/snake-naming.strategy';
import { tenantStorage, TenantCtx } from '../../src/common/tenant.context';
import { InventoryService } from '../../src/inventory/inventory.service';
import {
  Material, MaterialGtin, MaterialFieldDefinition, Warehouse, WarehouseLocation,
  ProductGroup, StockBatch, StockMove, Bom, BomItem,
} from '../../src/inventory/inventory.entity';
import { Printer } from '../../src/entities/print.entity';
import { Template } from '../../src/entities/template.entity';
import { ToolIdempotency } from '../../src/agent/agent.entity';
import { IdempotencyService } from '../../src/agent/idempotency.service';
import { InventoryGateway } from '../../src/wms/gateways/inventory.gateway';
import { IssuingService } from '../../src/wms/issuing/services/issuing.service';
import { WmsWorkOrder, WmsWoLine, WmsIssueRecord, WmsWoReturn } from '../../src/wms/issuing/entities/wo.entity';

const DB = {
  type: 'postgres' as const,
  host: process.env.DB_HOST || '127.0.0.1',
  port: +(process.env.DB_PORT || 5432),
  username: process.env.DB_USER || 'labelflow',
  password: process.env.DB_PASS || 'labelflow',
  database: process.env.DB_NAME || 'labelflow_test',
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  logging: false,
};

const T = 903;   // 发料测试租户
const T2 = 904;  // 对照租户（什么都看不到）

function ctx(tenantId: number): TenantCtx {
  return {
    tenantId, userId: 1, roles: [], modules: ['wms.issuing'], permissions: [],
    plan: null, features: {}, dataScopes: null, dataSourceKey: 'default',
  } as TenantCtx;
}
const asTenant = <R>(tenantId: number, fn: () => Promise<R>) => tenantStorage.run(ctx(tenantId), fn);

class PrintStub { calls: any[] = []; async createJob(req: any) { this.calls.push(req); return { jobId: `pj_${this.calls.length}`, status: 'queued' }; } }
class AuditStub {
  rows: any[] = [];
  async write(tenantId: number, action: string, detail: any, _userId?: number, targetType?: string, targetId?: number) {
    this.rows.push({ tenantId, action, detail, targetType, targetId });
  }
  /** release 之前要查"是否做过齐套检查"，靠审计里的 wms.wo.kit_check 记录 */
  async find(q: { action: string; page?: number; pageSize?: number }) {
    const items = this.rows.filter((r) => r.action === q.action);
    return { items, total: items.length };
  }
}

async function seed(ds: DataSource) {
  await ds.query(`INSERT INTO tenants (id,name,code,status) VALUES
      (${T},'发料租户','wms_issue_t',1),(${T2},'对照租户','wms_issue_t2',1) ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO tenant_modules (tenant_id,module_code,status,source) VALUES
      (${T},'wms.issuing','active','manual') ON CONFLICT (tenant_id,module_code) DO NOTHING`);
  await ds.query(`INSERT INTO warehouses (id,tenant_id,code,name) VALUES
      (803,${T},'WH-IT','集成测试仓'),(804,${T2},'WH-X','对照仓') ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO warehouse_locations (id,tenant_id,warehouse_id,code,name,zone) VALUES
      (8031,${T},803,'IT-01','测试库位01','FAST') ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO materials (id,tenant_id,code,name,unit) VALUES
      (9031,${T},'P-9031','成品泵体','PCS'),
      (9032,${T},'C-9032','组件A','PCS'),
      (9033,${T},'C-9033','组件B','PCS'),
      (9034,${T},'C-9034','组件C-无库存','PCS')
    ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO boms (id,tenant_id,product_material_id,version,status) VALUES
      (9031,${T},9031,'v1','active') ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO bom_items (id,bom_id,material_id,qty_per,loss_rate) VALUES
      (90311,9031,9032,2,0),(90312,9031,9033,1,0.05),(90313,9031,9034,1,0)
    ON CONFLICT (id) DO NOTHING`);
  // 库存：组件A 500、组件B 30（故意不足）、组件C 0
  await ds.query(`DELETE FROM stock_batches WHERE tenant_id=${T} AND batch_no LIKE 'IT-%'`);
  await ds.query(`INSERT INTO stock_batches (tenant_id,material_id,warehouse_id,batch_no,location_id,qty) VALUES
      (${T},9032,803,'IT-A',8031,500),(${T},9033,803,'IT-B',8031,30)`);
}

describe('WMS 阶段二 发料真 PG 验收（G1–G7）', () => {
  let ds: DataSource;
  let svc: IssuingService;
  let inv: InventoryGateway;
  let print: PrintStub;
  let audit: AuditStub;

  const stockQty = async (materialId: number) => {
    const rows = await ds.query(`SELECT coalesce(sum(qty),0)::float AS q FROM stock_batches WHERE tenant_id=${T} AND material_id=${materialId}`);
    return Number(rows[0].q);
  };
  // stock_moves 字段：kind(in/out) + reason（'WMS_ISSUE:...'），没有 ref_no 列
  const moveCount = async (reasonLike: string) =>
    Number((await ds.query(`SELECT count(*)::int AS n FROM stock_moves WHERE tenant_id=${T} AND kind='out' AND reason LIKE '${reasonLike}%'`))[0].n);

  beforeAll(async () => {
    ds = new DataSource({
      ...DB,
      entities: [
        WmsWorkOrder, WmsWoLine, WmsIssueRecord, WmsWoReturn,
        Material, MaterialGtin, MaterialFieldDefinition, Warehouse, WarehouseLocation,
        ProductGroup, Printer, StockBatch, StockMove, Bom, BomItem, Template, ToolIdempotency,
      ],
    });
    await ds.initialize();
    await seed(ds);

    const inventorySvc = new InventoryService(
      ds.getRepository(Material), ds.getRepository(MaterialGtin), ds.getRepository(MaterialFieldDefinition),
      ds.getRepository(Warehouse), ds.getRepository(WarehouseLocation), ds.getRepository(ProductGroup),
      ds.getRepository(Printer), ds.getRepository(StockBatch), ds.getRepository(StockMove),
      ds.getRepository(Bom), ds.getRepository(BomItem), ds.getRepository(Template),
      ds as any, {} as any,
    );
    const idem = new IdempotencyService(ds.getRepository(ToolIdempotency));
    inv = new InventoryGateway(
      inventorySvc, idem,
      ds.getRepository(Material), ds.getRepository(MaterialGtin), ds.getRepository(Warehouse),
      ds.getRepository(WarehouseLocation), ds.getRepository(Bom), ds.getRepository(BomItem),
    );
    print = new PrintStub();
    audit = new AuditStub();
    svc = new IssuingService(
      ds.getRepository(WmsWorkOrder), ds.getRepository(WmsWoLine),
      ds.getRepository(WmsIssueRecord), ds.getRepository(WmsWoReturn),
      inv, print as any, audit as any, undefined,
    );
  });

  afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

  beforeEach(async () => {
    await ds.query(`DELETE FROM wms_issue_records WHERE tenant_id=${T}`);
    await ds.query(`DELETE FROM wms_wo_returns WHERE tenant_id=${T}`);
    await ds.query(`DELETE FROM wms_wo_lines WHERE tenant_id=${T}`);
    await ds.query(`DELETE FROM wms_work_orders WHERE tenant_id=${T}`);
    await ds.query(`DELETE FROM tool_idempotency WHERE tenant_id=${T}`);
    await ds.query(`DELETE FROM stock_moves WHERE tenant_id=${T}`);
    await ds.query(`DELETE FROM stock_batches WHERE tenant_id=${T} AND batch_no LIKE 'IT-%'`);
    await ds.query(`INSERT INTO stock_batches (tenant_id,material_id,warehouse_id,batch_no,location_id,qty) VALUES
        (${T},9032,803,'IT-A',8031,500),(${T},9033,803,'IT-B',8031,30)`);
    print.calls = []; audit.rows = [];
  });

  const newWo = async (woNo: string, demand = 100) => asTenant(T, () => svc.create({
    woNo, productMaterialId: 9031, warehouseId: 803, demandQty: demand, expandBom: true,
  }));

  // ---------------------------------------------------------- G1
  it('G1 BOM 展开：行数与需求量含损耗（100 件 × 2、×1.05、×1）', async () => {
    const wo = await newWo('IT-G1');
    expect(wo.lines).toHaveLength(3);
    const byCode = Object.fromEntries(wo.lines.map((l: any) => [l.materialCode ?? l.materialId, Number(l.qtyRequired)]));
    expect(byCode['C-9032']).toBe(200);
    expect(byCode['C-9033']).toBe(105);   // 100*1*(1+0.05)
    expect(byCode['C-9034']).toBe(100);
  });

  // ---------------------------------------------------------- G2
  it('G2 齐套：行级与整体一致，缺料行被标出', async () => {
    const wo = await newWo('IT-G2');
    const kit = await asTenant(T, () => svc.kitCheck(wo.id));
    const lineA = kit.lines.find((l: any) => l.materialId === 9032)!;
    const lineB = kit.lines.find((l: any) => l.materialId === 9033)!;
    expect(lineA.available).toBe(500);
    expect(lineA.shortage).toBe(0);
    expect(lineB.available).toBe(30);
    expect(lineB.shortage).toBe(75);
    expect(kit.shortageLines.length).toBeGreaterThanOrEqual(2);   // 组件B + 组件C(0)
    // 组件C 无库存 → 整套数为 0（语义：能配套几台），齐套率因此也低
    expect(kit.overallMaxSets).toBe(0);
    expect(kit.overallKitRate).toBeLessThan(100);
    const db = await asTenant(T, () => svc.detail(wo.id));
    expect((db as any).shortageFlag ?? true).toBe(true);
  });

  // ---------------------------------------------------------- G3
  it('G3 过账真扣库存 + stock_moves 台账 + 发料记录唯一', async () => {
    const wo = await newWo('IT-G3');
    await asTenant(T, () => svc.kitCheck(wo.id));
    await asTenant(T, () => svc.release(wo.id));
    await asTenant(T, () => svc.issueStart(wo.id));
    const posted = await asTenant(T, () => svc.issuePost(wo.id));

    expect(await stockQty(9032)).toBe(300);        // 500 - 200
    expect(await stockQty(9033)).toBe(0);          // 30 全发，缺口 75
    const recs = await ds.query(`SELECT count(*)::int AS n FROM wms_issue_records WHERE tenant_id=${T} AND wo_id=${wo.id}`);
    expect(recs[0].n).toBe(2);                     // 两条行都动了库存
    expect(await moveCount('WMS_ISSUE')).toBeGreaterThanOrEqual(2);   // 台账 out 行
    expect((posted as any).posted?.length ?? 0).toBeGreaterThanOrEqual(2);

    // 台账数量方向正确（out 为负或单独列）
    const moves = await ds.query(`SELECT qty, kind, before_qty, after_qty, reason FROM stock_moves WHERE tenant_id=${T} ORDER BY id`);
    expect(moves.length).toBeGreaterThanOrEqual(2);
    for (const m of moves) {
      expect(m.kind).toBe('out');
      // 台账 qty 是带符号的变动量：出库为负
      expect(Number(m.qty)).toBeLessThan(0);
      // 台账守恒：after = before + qty
      expect(Number(m.after_qty)).toBeCloseTo(Number(m.before_qty) + Number(m.qty), 3);
      expect(String(m.reason)).toContain('WMS_ISSUE');
    }
  });

  // ---------------------------------------------------------- G4
  it('G4 重跑不二次扣减（幂等）：库存与台账不变，行报「已发满/无新扣减」', async () => {
    const wo = await newWo('IT-G4');
    await asTenant(T, () => svc.kitCheck(wo.id));
    await asTenant(T, () => svc.release(wo.id));
    await asTenant(T, () => svc.issueStart(wo.id));
    await asTenant(T, () => svc.issuePost(wo.id));
    const qtyA1 = await stockQty(9032);
    const moves1 = await moveCount('WMS_ISSUE');

    await asTenant(T, () => svc.issuePost(wo.id));
    expect(await stockQty(9032)).toBe(qtyA1);
    expect(await moveCount('WMS_ISSUE')).toBe(moves1);
  });

  // ---------------------------------------------------------- G5
  it('G5 缺料：完全无可用批次的行走 SHORT 且不落记录；有部分库存的行按量发 PARTIAL', async () => {
    await ds.query(`UPDATE stock_batches SET qty=0 WHERE tenant_id=${T} AND batch_no='IT-A'`);
    const wo = await newWo('IT-G5');
    await asTenant(T, () => svc.kitCheck(wo.id));
    await asTenant(T, () => svc.release(wo.id));
    await asTenant(T, () => svc.issueStart(wo.id));
    const res = await asTenant(T, () => svc.issuePost(wo.id));

    const recs = await ds.query(`SELECT count(*)::int AS n FROM wms_issue_records WHERE tenant_id=${T} AND wo_id=${wo.id}`);
    // 组件A 完全无货 → SHORT 且**不落记录**；组件B 有 30 → 按量发 PARTIAL 落 1 条
    expect(recs[0].n).toBe(1);
    const db = await asTenant(T, () => svc.detail(wo.id));
    const lineA = (db as any).lines.find((l: any) => l.materialId === 9032);
    const lineB = (db as any).lines.find((l: any) => l.materialId === 9033);
    expect(lineA.status).toBe('SHORT');
    expect(Number(lineA.qtyShortage)).toBe(200);
    expect(lineB.status).toBe('PARTIAL');
    expect(Number(lineB.qtyIssued)).toBe(30);
    expect(await stockQty(9032)).toBe(0);
    expect(await stockQty(9033)).toBe(0);
    // 跳过的行（含缺料原因）在 skipped 里
    expect((res as any).skipped?.length ?? 0).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------- G6
  it('G6 退料回补 + 工单回 ISSUING + 退料记录可追溯', async () => {
    const wo = await newWo('IT-G6');
    await asTenant(T, () => svc.kitCheck(wo.id));
    await asTenant(T, () => svc.release(wo.id));
    await asTenant(T, () => svc.issueStart(wo.id));
    await asTenant(T, () => svc.issuePost(wo.id));
    await asTenant(T, () => svc.issueDone(wo.id, { force: true }));

    const db1 = await asTenant(T, () => svc.detail(wo.id));
    expect((db1 as any).status).toBe('ISSUED');
    const lineA = (db1 as any).lines.find((l: any) => l.materialId === 9032);
    const before = await stockQty(9032);

    const ret = await asTenant(T, () => svc.createReturn(wo.id, {
      lineId: lineA.id, qty: 50, batchNo: 'IT-A', reason: '集成测试退料',
    }));
    expect(await stockQty(9032)).toBe(before + 50);
    const rets = await ds.query(`SELECT count(*)::int AS n FROM wms_wo_returns WHERE tenant_id=${T} AND wo_id=${wo.id}`);
    expect(rets[0].n).toBe(1);
    const db2 = await asTenant(T, () => svc.detail(wo.id));
    expect((db2 as any).status).toBe('ISSUING');   // RETURN: ISSUED → ISSUING
    void ret;
  });

  // ---------------------------------------------------------- G7
  it('G7 跨租户不可见：应用层 404 且 labelflow_app 角色 RLS 下查不到', async () => {
    const wo = await newWo('IT-G7');
    await expect(asTenant(T2, () => svc.detail(wo.id))).rejects.toThrow(/不存在/);

    // 直连 RLS 角色：设置 app.tenant_id=904，查 903 的工单应为 0 行
    const rlsDs = new DataSource({
      ...DB,
      username: process.env.DB_RLS_USER || 'labelflow_app',
      password: process.env.DB_RLS_PASSWORD || 'labelflow_app',
      entities: [WmsWorkOrder],
    });
    await rlsDs.initialize();
    try {
      const own = await rlsDs.query(`SELECT set_config('app.tenant_id','${T}','false')`);
      const rowsSelf = await rlsDs.query(`SELECT count(*)::int AS n FROM wms_work_orders`);
      expect(rowsSelf[0].n).toBeGreaterThanOrEqual(1);      // 自己的能看到
      await rlsDs.query(`SELECT set_config('app.tenant_id','${T2}','false')`);
      const rowsOther = await rlsDs.query(`SELECT count(*)::int AS n FROM wms_work_orders`);
      expect(rowsOther[0].n).toBe(0);                       // 别人的看不到
      void own;
    } finally {
      await rlsDs.destroy();
    }
  });
});
