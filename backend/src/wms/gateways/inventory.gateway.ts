// =============================================================================
// InventoryGateway —— WMS 侧唯一库存变更入口（方向 A 逻辑边界）
//
// 硬性约束：
//   · WMS 禁止直接读写 stock_batches/stock_moves 表；所有变更经本 Gateway 包装 InventoryService。
//   · 本 Gateway 只做"适配 + 幂等"，不复制库存业务逻辑（FIFO/台账/行锁全在 InventoryService）。
//   · 调用方必须已在 tenantStorage.run 上下文内（WMS Controller 走 JWT 守卫，ALS 已注入）。
//
// 文档 8.4 契约签名（skuId/warehouseId 数字）在此适配为 InventoryService 的编码参数：
//   Gateway 按 ID 查物料/仓库得到 code，再调 adjustStock（C4：variables 由过账服务组装；此处
//   的 ID→code 解析是 Gateway 作为适配器的本职，避免 WMS service 直接依赖 inventory 内部模型）。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryService } from '../../inventory/inventory.service';
import { Material, Warehouse, WarehouseLocation, Bom, BomItem } from '../../inventory/inventory.entity';
import { KitOutcome, round3 } from '../../inventory/kit.calc';
import { IdempotencyService } from '../../agent/idempotency.service';
import { argsHash } from '../../agent/agent.calc';
import { useTenantId } from '../../common/tenant.context';

export interface IncreaseStockParams {
  tenantId: string | number;
  skuId: string | number;
  warehouseId: string | number;
  locationId?: string | number | null;
  batchNo?: string;
  qty: number;
  unit?: string;
  refType: string;
  refNo: string;
  idempotencyKey: string;
}

export interface TransferStockParams {
  tenantId: string | number;
  skuId: string | number;
  batchNo?: string;
  qty: number;
  fromLocationId: string | number;
  toLocationId: string | number;
  refType: string;
  refNo: string;
  idempotencyKey: string;
}

export interface QueryAvailableParams {
  tenantId: string | number;
  skuId: string | number;
  warehouseId: string | number;
  batchNo?: string;
}

export interface StockMovementResult {
  movementId: string;
  idempotent?: boolean;
}

// ---- 阶段二（wms.issuing）契约 ----
export interface DecreaseStockParams {
  tenantId: string | number;
  skuId: string | number;
  warehouseId: string | number;
  locationId?: string | number | null;
  batchNo?: string;
  qty: number;
  unit?: string;
  refType: string;
  refNo: string;
  idempotencyKey: string;
}

export interface ExpandBomParams {
  tenantId: string | number;
  productMaterialId: string | number;
}

export interface BomLinePlain {
  materialId: number; code: string; name: string; unit: string;
  qtyPer: number; lossRate: number;
}

export interface CheckKitParams {
  tenantId: string | number;
  product: string | number;
  demand: number;
  warehouseId?: string | number | null;
}

export interface AllocateBatchesParams {
  tenantId: string | number;
  skuId: string | number;
  warehouseId: string | number;
  batchNo?: string | null;
  qty: number;
}

export interface BatchRowPlain {
  batchNo: string;
  qty: number;
  locationId: number | null;
  expiresAt: string | null;
  createdAt: string | null;
  id: number;
}

@Injectable()
export class InventoryGateway {
  private static readonly IDEM_INCREASE = 'wms.stock.increase';
  private static readonly IDEM_TRANSFER = 'wms.stock.transfer';
  private static readonly IDEM_DECREASE = 'wms.stock.issue';

  constructor(
    private inventory: InventoryService,
    private idem: IdempotencyService,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
    @InjectRepository(Bom) private boms: Repository<Bom>,
    @InjectRepository(BomItem) private bomItems: Repository<BomItem>,
  ) {}

  /** 增加库存（批次维度 + 确定库位）。同 key 重放返回原结果，不重复入库。 */
  async increaseStock(p: IncreaseStockParams): Promise<StockMovementResult> {
    const tenantId = this.resolveTenant(p.tenantId);
    const qty = Number(p.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('入库数量必须为正数');
    const material = await this.materialById(tenantId, p.skuId);
    const warehouse = await this.warehouseById(tenantId, p.warehouseId);
    const locationId = await this.locationById(tenantId, warehouse.id, p.locationId);

    const claim = await this.idem.claim({
      tenantId, clientId: 0, tool: InventoryGateway.IDEM_INCREASE,
      idemKey: p.idempotencyKey,
      argsHash: argsHash({ sku: material.code, warehouse: warehouse.code, locationId, batchNo: p.batchNo, qty, refNo: p.refNo }),
    });
    if (!claim.fresh && claim.row.result) {
      return { ...(claim.row.result as any), idempotent: true };
    }

    const outcome = await this.inventory.adjustStock(tenantId, {
      sku: material.code,
      warehouse: warehouse.code,
      location_id: locationId,
      batch_no: p.batchNo,
      delta: qty,
      reason: `${p.refType}:${p.refNo}`,
    }, false, p.refType);
    const movementId = `${p.refType}:${p.refNo}:${material.code}:${p.batchNo ?? ''}`;
    await this.idem.finish(claim.row.id, { movementId });
    return { movementId };
  }

  /**
   * 同仓移库位：现有 transferStock 禁止同仓（from.id === to.id 抛错），且无暂存位概念。
   * 阶段一不做同仓移库（见勘察 §14.2），此处保留接口并明确抛错，避免误用。
   */
  async transferStock(_p: TransferStockParams): Promise<StockMovementResult> {
    throw new BadRequestException(
      'WMS 阶段一不支持同仓移库位（现有库存模型无暂存位；上架按"过账时直接入库到推荐位"简化，见勘察报告 §14.2）',
    );
  }

  /** 查询可用库存（按 SKU + 仓库 + 可选批次） */
  async queryAvailable(p: QueryAvailableParams): Promise<{ qty: number }> {
    const tenantId = this.resolveTenant(p.tenantId);
    const material = await this.materialById(tenantId, p.skuId);
    const warehouse = await this.warehouseById(tenantId, p.warehouseId);
    const res = await this.inventory.queryStock(tenantId, {
      keyword: material.code, warehouse: warehouse.code, groupBy: 'batch', limit: 100,
    });
    const qty = res.items.reduce((sum, r: any) => {
      const batchMatch = !p.batchNo || String(r.batchNo ?? r.batch_no ?? '') === p.batchNo;
      return batchMatch ? sum + Number(r.qty ?? 0) : sum;
    }, 0);
    return { qty };
  }

  // ================= 阶段二：齐套 / 扣减 / 批次 =================

  /** BOM 展开：取 active BOM 与明细行，返回组件与单位用量（不含需求量，需求由 WMS 按 demand 计算） */
  async expandBom(p: ExpandBomParams): Promise<{ bomId: number; version: string; lines: BomLinePlain[] } | null> {
    const tenantId = this.resolveTenant(p.tenantId);
    const material = await this.materialById(tenantId, p.productMaterialId);
    const bom = await this.boms.findOne({ where: { tenantId, productMaterialId: material.id, status: 'active' } });
    if (!bom) return null;
    const items = await this.bomItems.find({ where: { bomId: bom.id } });
    if (!items.length) return { bomId: bom.id, version: bom.version, lines: [] };
    const ids = items.map((i) => Number(i.materialId));
    const mats = await this.materials.find({ where: { tenantId } });
    const byId = new Map(mats.filter((m) => ids.includes(Number(m.id))).map((m) => [Number(m.id), m]));
    const lines: BomLinePlain[] = [];
    for (const i of items) {
      const m = byId.get(Number(i.materialId));
      if (!m) continue;   // 物料被删除：跳过（与 computeKit 防御口径一致）
      lines.push({
        materialId: Number(m.id), code: m.code, name: m.name, unit: m.unit,
        qtyPer: Number(i.qtyPer), lossRate: Number(i.lossRate ?? 0),
      });
    }
    return { bomId: bom.id, version: bom.version, lines };
  }

  /** 物料解析（编码或 ID → 基础字段），供工单手工行、标签变量使用 */
  async resolveMaterial(p: { tenantId: string | number; ref: string | number }): Promise<{ id: number; code: string; name: string; unit: string; gtin: string | null; udiRequired: boolean }> {
    const tenantId = this.resolveTenant(p.tenantId);
    const m = await this.materialById(tenantId, p.ref);
    return {
      id: Number(m.id), code: m.code, name: m.name, unit: m.unit,
      gtin: (m as any).gtin ?? null, udiRequired: !!(m as any).udiRequired,
    };
  }

  /** 仓库解析（编码或 ID → 基础字段） */
  async resolveWarehouse(p: { tenantId: string | number; ref: string | number }): Promise<{ id: number; code: string; name: string }> {
    const tenantId = this.resolveTenant(p.tenantId);
    const w = await this.warehouseById(tenantId, p.ref);
    return { id: Number(w.id), code: w.code, name: w.name };
  }

  /**
   * 齐套检查适配：ID → 编码解析后调 InventoryService.checkKit（单一口径，禁止另拼 SQL）。
   * 返回 plain 结构（product/bom 只给必要字段），WMS service 不碰 inventory 实体。
   */
  async checkKit(p: CheckKitParams): Promise<{
    product: { id: number; code: string; name: string; unit: string };
    bom: { id: number; version: string };
    kit: KitOutcome;
  }> {
    const tenantId = this.resolveTenant(p.tenantId);
    const material = await this.materialById(tenantId, p.product);
    const warehouse = p.warehouseId != null ? await this.warehouseById(tenantId, p.warehouseId) : null;
    const r = await this.inventory.checkKit(tenantId, {
      product: material.code, demand: Number(p.demand),
      warehouse: warehouse ? String(warehouse.id) : undefined,
    });
    return {
      product: { id: Number(r.product.id), code: r.product.code, name: r.product.name, unit: r.product.unit },
      bom: { id: Number(r.bom.id), version: r.bom.version },
      kit: r.kit,
    };
  }

  /** 发料扣减（delta 取负）。幂等键复用 claim/finish，argsHash 含批次与单据，防同键不同参。 */
  async decreaseStock(p: DecreaseStockParams): Promise<StockMovementResult> {
    const tenantId = this.resolveTenant(p.tenantId);
    const qty = Number(p.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('发料数量必须为正数');
    const material = await this.materialById(tenantId, p.skuId);
    const warehouse = await this.warehouseById(tenantId, p.warehouseId);
    const locationId = await this.locationById(tenantId, warehouse.id, p.locationId);

    const claim = await this.idem.claim({
      tenantId, clientId: 0, tool: InventoryGateway.IDEM_DECREASE,
      idemKey: p.idempotencyKey,
      argsHash: argsHash({
        sku: material.code, warehouse: warehouse.code, locationId,
        batchNo: p.batchNo, qty, refNo: p.refNo, dir: 'out',
      }),
    });
    if (!claim.fresh && claim.row.result) {
      return { ...(claim.row.result as any), idempotent: true };
    }

    const outcome = await this.inventory.adjustStock(tenantId, {
      sku: material.code,
      warehouse: warehouse.code,
      location_id: locationId,
      batch_no: p.batchNo,
      delta: -qty,
      reason: `${p.refType}:${p.refNo}`,
    }, false, p.refType);
    const movementId = `${p.refType}:${p.refNo}:${material.code}:${p.batchNo ?? ''}:out`;
    await this.idem.finish(claim.row.id, { movementId });
    return { movementId };
  }

  /** 批次余量明细（只读）：按 SKU + 仓库列可用批次，供 D5 分配与缺料解释 */
  async queryBatches(p: { tenantId: string | number; skuId: string | number; warehouseId: string | number }): Promise<BatchRowPlain[]> {
    const tenantId = this.resolveTenant(p.tenantId);
    const material = await this.materialById(tenantId, p.skuId);
    const warehouse = await this.warehouseById(tenantId, p.warehouseId);
    const res = await this.inventory.queryStock(tenantId, {
      keyword: material.code, warehouse: warehouse.code, groupBy: 'batch', limit: 200,
    });
    return (res.items as any[])
      .filter((r) => Number(r.materialId) === Number(material.id))
      .map((r) => ({
        batchNo: String(r.batchNo ?? ''),
        qty: round3(Number(r.qty ?? 0)),
        locationId: r.locationId != null ? Number(r.locationId) : null,
        expiresAt: r.expiresAt ? String(r.expiresAt).slice(0, 10) : null,
        createdAt: r.createdAt ? String(r.createdAt) : null,
        id: Number(r.id ?? 0),
      }))
      .filter((r) => r.batchNo);
  }

  // ---- 内部辅助 ----
  private resolveTenant(v: string | number): number {
    const id = Number(v) || useTenantId();
    if (!id) throw new BadRequestException('InventoryGateway 缺少 tenantId');
    return id;
  }

  private async materialById(tenantId: number, ref: string | number): Promise<Material> {
    const id = Number(ref);
    const m = Number.isInteger(id) && id > 0
      ? await this.materials.findOne({ where: { tenantId, id } })
      : await this.materials.findOne({ where: { tenantId, code: String(ref) } });
    if (!m) throw new NotFoundException(`物料不存在：${ref}`);
    return m;
  }

  private async warehouseById(tenantId: number, ref: string | number): Promise<Warehouse> {
    const id = Number(ref);
    const w = Number.isInteger(id) && id > 0
      ? await this.warehouses.findOne({ where: { tenantId, id } })
      : await this.warehouses.findOne({ where: { tenantId, code: String(ref) } });
    if (!w) throw new NotFoundException(`仓库不存在：${ref}`);
    return w;
  }

  private async locationById(tenantId: number, warehouseId: number, ref?: string | number | null): Promise<number | null> {
    if (ref == null || ref === '') return null;
    const id = Number(ref);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('库位参数无效');
    const loc = await this.locations.findOne({ where: { tenantId, id, warehouseId, active: true } });
    if (!loc) throw new NotFoundException(`库位不存在或不属于该仓库：${id}`);
    return id;
  }

}
