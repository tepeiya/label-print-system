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
import { Material, Warehouse, WarehouseLocation } from '../../inventory/inventory.entity';
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

@Injectable()
export class InventoryGateway {
  private static readonly IDEM_INCREASE = 'wms.stock.increase';
  private static readonly IDEM_TRANSFER = 'wms.stock.transfer';

  constructor(
    private inventory: InventoryService,
    private idem: IdempotencyService,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
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
