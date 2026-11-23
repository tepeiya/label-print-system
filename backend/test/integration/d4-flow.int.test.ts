/**
 * D4「流程闭合」真库验收（docs/24 §D4 三门）
 *
 *   D4-1 发料扫包码：扫 2 箱（每箱 24）→ 台账扣减 48 件，与 U5.3 收货的折箱口径一致
 *   D4-2 退货幂等：同一退料重复提交 → 第二次走幂等回放，库存不二次回补
 *   D4-3 状态机全链：CREATED → RELEASED → ISSUING → ISSUED（发料不断链）
 *
 * 只测后端（PDA 页面是同一批接口的壳，见 docs/28）。
 */
import { DataSource } from 'typeorm';
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

const T = 905;            // 独立租户，避免与他人数据互踩
const CARTON_GTIN = '06901234567892';   // 组件A 的箱码（13 位 6901234567892 → 补零）
const CARTON_QTY = 24;

function ctx(tenantId: number): TenantCtx {
  return {
    tenantId, userId: 1, roles: [], modules: ['wms.issuing'], permissions: [],
    plan: null, features: {}, dataScopes: null, dataSourceKey: 'default',
  } as TenantCtx;
}
const asTenant = <R>(tenantId: number, fn: () => Promise<R>) => tenantStorage.run(ctx(tenantId), fn);

class PrintStub { async createJob() { return { jobId: 'pj_d4', status: 'queued' }; } }
class AuditStub {
  rows: any[] = [];
  async write(tenantId: number, action: string, detail: any, _u?: number, targetType?: string, targetId?: number) {
    this.rows.push({ tenantId, action, detail, targetType, targetId });
  }
  async find(q: { action: string }) {
    const items = this.rows.filter((r) => r.action === q.action);
    return { items, total: items.length };
  }
}

async function seed(ds: DataSource) {
  await ds.query(`INSERT INTO tenants (id,name,code,status) VALUES (${T},'流程闭合租户','d4_t',1)
    ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO tenant_modules (tenant_id,module_code,status,source) VALUES
    (${T},'wms.issuing','active','manual') ON CONFLICT (tenant_id,module_code) DO NOTHING`);
  await ds.query(`INSERT INTO warehouses (id,tenant_id,code,name) VALUES (805,${T},'WH-D4','D4 仓')
    ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO warehouse_locations (id,tenant_id,warehouse_id,code,name,zone) VALUES
    (8051,${T},805,'D4-01','D4 库位','FAST') ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO materials (id,tenant_id,code,name,unit,udi_required) VALUES
    (9051,${T},'P-9051','成品-流程','PCS',false),
    (9052,${T},'C-9052','组件-箱装','PCS',false)
    ON CONFLICT (id) DO NOTHING`);
  // 物料 9052 的一物料多码：UNIT 主码 + CARTON 箱码（每箱 24）
  await ds.query(`DELETE FROM material_gtins WHERE tenant_id=${T}`);
  await ds.query(`INSERT INTO material_gtins (tenant_id,material_id,gtin,pack_level,pack_qty,is_primary) VALUES
    (${T},9052,'06901234567892','CARTON',${CARTON_QTY},true),
    (${T},9052,'06901234567885','UNIT',1,false)`);
  await ds.query(`INSERT INTO boms (id,tenant_id,product_material_id,version,status) VALUES
    (9051,${T},9051,'v1','active') ON CONFLICT (id) DO NOTHING`);
  await ds.query(`INSERT INTO bom_items (id,bom_id,material_id,qty_per,loss_rate) VALUES
    (90511,9051,9052,1,0) ON CONFLICT (id) DO NOTHING`);
  await ds.query(`DELETE FROM stock_batches WHERE tenant_id=${T}`);
  await ds.query(`INSERT INTO stock_batches (tenant_id,material_id,warehouse_id,batch_no,location_id,qty) VALUES
    (${T},9052,805,'D4-A',8051,500)`);
}

describe('D4 医院流程闭合（真 PG）', () => {
  let ds: DataSource;
  let svc: IssuingService;

  const stockQty = async (materialId: number) =>
    Number((await ds.query(`SELECT coalesce(sum(qty),0)::float AS q FROM stock_batches WHERE tenant_id=${T} AND material_id=${materialId}`))[0].q);

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
    const inv = new InventoryGateway(
      inventorySvc, idem,
      ds.getRepository(Material), ds.getRepository(MaterialGtin), ds.getRepository(Warehouse),
      ds.getRepository(WarehouseLocation), ds.getRepository(Bom), ds.getRepository(BomItem),
    );
    svc = new IssuingService(
      ds.getRepository(WmsWorkOrder), ds.getRepository(WmsWoLine),
      ds.getRepository(WmsIssueRecord), ds.getRepository(WmsWoReturn),
      inv, new PrintStub() as any, new AuditStub() as any, undefined,
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
    await ds.query(`DELETE FROM stock_batches WHERE tenant_id=${T}`);
    await ds.query(`INSERT INTO stock_batches (tenant_id,material_id,warehouse_id,batch_no,location_id,qty) VALUES
      (${T},9052,805,'D4-A',8051,500)`);
  });

  /** 建单 → 齐套 → 放行 → 开始发料（D4-1/D4-2 的共同前置） */
  const toIssuing = async (woNo: string, demand = 100) => {
    const wo = await asTenant(T, () => svc.create({ woNo, productMaterialId: 9051, warehouseId: 805, demandQty: demand, expandBom: true }));
    await asTenant(T, () => svc.kitCheck(wo.id));
    await asTenant(T, () => svc.release(wo.id));
    await asTenant(T, () => svc.issueStart(wo.id));
    return wo;
  };

  // ---------------------------------------------------------------- D4-1
  it('D4-1 发料扫箱码：2 箱 × 24 = 48 件扣减（与收货折箱同口径）', async () => {
    const wo = await toIssuing('D4-1', 200);   // 需要 200 件组件
    const line = (await asTenant(T, () => svc.detail(wo.id)) as any).lines[0];
    expect(Number(line.qtyRequired)).toBe(200);

    const res: any = await asTenant(T, () => svc.issuePost(wo.id, {
      packs: [{ lineId: line.id, udiCode: `(01)${CARTON_GTIN}(10)D4-A`, packCount: 2 }],
    }));
    const pack = res.posted.find((p: any) => p.pack)?.pack;
    expect(pack).toMatchObject({ gtin: CARTON_GTIN, packLevel: 'CARTON', packQty: CARTON_QTY, packCount: 2, units: 48 });

    // 台账：只扣 48（不是整行 200）
    expect(await stockQty(9052)).toBe(500 - 48);
    const moves = await ds.query(`SELECT qty, before_qty, after_qty FROM stock_moves WHERE tenant_id=${T} AND kind='out'`);
    expect(moves.length).toBe(1);
    expect(Number(moves[0].qty)).toBe(-48);
    expect(Number(moves[0].after_qty)).toBe(452);

    // 行处 PARTIAL（48/200），并记录缺口
    const after = await asTenant(T, () => svc.detail(wo.id));
    const l2 = (after as any).lines.find((l: any) => l.id === line.id);
    expect(Number(l2.qtyIssued)).toBe(48);
    expect(Number(l2.qtyShortage)).toBe(152);
  });

  it('D4-1b 扫未登记箱码：不拦截、按剩余量发，并给出 packWarning', async () => {
    const wo = await toIssuing('D4-1b', 50);
    const line = (await asTenant(T, () => svc.detail(wo.id)) as any).lines[0];
    const res: any = await asTenant(T, () => svc.issuePost(wo.id, {
      packs: [{ lineId: line.id, udiCode: `(01)09999999999999`, packCount: 1 }],
    }));
    // 未登记码 / 校验位错 都会给 packWarning（不拦截，按剩余量发）
    expect(String(res.posted[0].packWarning)).toMatch(/不在该物料包装表内|解析失败/);
    expect(await stockQty(9052)).toBe(450);      // 按剩余量 50 发
  });

  // ---------------------------------------------------------------- D4-2
  it('D4-2 退货幂等：重复提交同内容走回放，库存不二次回补', async () => {
    const wo = await toIssuing('D4-2', 100);
    await asTenant(T, () => svc.issuePost(wo.id));
    await asTenant(T, () => svc.issueDone(wo.id));    // 退料只在 ISSUED 状态允许（状态机 RETURN 边）
    expect(await stockQty(9052)).toBe(400);           // 100 已发

    const line = (await asTenant(T, () => svc.detail(wo.id)) as any).lines[0];
    const req = { lineId: line.id, qty: 40, batchNo: 'D4-A', reason: '产线退料（D4 验收）' };
    const r1: any = await asTenant(T, () => svc.createReturn(wo.id, req));
    expect(r1.idempotent).toBeUndefined();
    expect(await stockQty(9052)).toBe(440);           // 回补 40

    // 网络重试：同内容再提交一次
    const r2: any = await asTenant(T, () => svc.createReturn(wo.id, req));
    expect(r2.idempotent).toBe(true);
    expect(r2.returnId).toBe(r1.returnId);
    expect(await stockQty(9052)).toBe(440);           // 没有二次回补
    const rows = await ds.query(`SELECT count(*)::int AS n FROM wms_wo_returns WHERE tenant_id=${T}`);
    expect(rows[0].n).toBe(1);

    // 客户端显式幂等键：退料把工单打回 ISSUING，再退必须重新发料并完成（状态机要求）
    await asTenant(T, () => svc.issuePost(wo.id));
    await asTenant(T, () => svc.issueDone(wo.id));
    const r3: any = await asTenant(T, () => svc.createReturn(wo.id, { ...req, qty: 20, idemKey: 'pda-retry-001' }));
    expect(await stockQty(9052)).toBe(460);
    const r4: any = await asTenant(T, () => svc.createReturn(wo.id, { ...req, qty: 20, idemKey: 'pda-retry-001' }));
    expect(r4.idempotent).toBe(true);
    expect(await stockQty(9052)).toBe(460);
  });

  it('D4-2b 退料必须带原因；超发量退料被拒', async () => {
    const wo = await toIssuing('D4-2b', 100);
    await asTenant(T, () => svc.issuePost(wo.id));
    await asTenant(T, () => svc.issueDone(wo.id));
    const line = (await asTenant(T, () => svc.detail(wo.id)) as any).lines[0];
    await expect(asTenant(T, () => svc.createReturn(wo.id, { lineId: line.id, qty: 10, reason: ' ' })))
      .rejects.toThrow(/原因/);
    await expect(asTenant(T, () => svc.createReturn(wo.id, { lineId: line.id, qty: 200, reason: '超量' })))
      .rejects.toThrow(/超过已发量/);
  });

  // ---------------------------------------------------------------- D4-3
  it('D4-3 全链状态：CREATED → RELEASED → ISSUING → ISSUED → CLOSED', async () => {
    const wo = await toIssuing('D4-3', 100);
    const posted: any = await asTenant(T, () => svc.issuePost(wo.id));
    expect(posted.posted.length).toBeGreaterThan(0);
    const done: any = await asTenant(T, () => svc.issueDone(wo.id));
    expect(done.status).toBe('ISSUED');
    const closed: any = await asTenant(T, () => svc.close(wo.id));
    expect(closed.status).toBe('CLOSED');
  });
});
