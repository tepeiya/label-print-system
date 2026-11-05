// =============================================================================
// InventoryService —— P4 库存只读查询（docs/11 §11.7.2/§11.7.3）
// 只服务 Agent 只读工具（/agent/v1），没有租户 REST 控制器——完整 WMS 页面在后续阶段。
// 全部查询强制 tenant_id；数值列（numeric/bigint 反射为 string）出参前 Number()。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Material, StockBatch, Warehouse, Bom, BomItem } from './inventory.entity';
import { computeKit, escapeLike, KitOutcome, round3 } from './kit.calc';

export interface QueryStockArgs {
  keyword?: string;
  warehouse?: string;
  groupBy?: 'sku' | 'batch' | 'warehouse';
  belowSafety?: boolean;
  expiringDays?: number;
  limit?: number;
}

export interface StockRow {
  materialId: number; code: string; name: string; spec: string | null; unit: string;
  warehouseId?: number; warehouse?: string; batchNo?: string; expiresAt?: string | null;
  qty: number; safetyStock?: number; belowSafety?: boolean;
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(StockBatch) private batches: Repository<StockBatch>,
    @InjectRepository(Bom) private boms: Repository<Bom>,
    @InjectRepository(BomItem) private bomItems: Repository<BomItem>,
    private ds: DataSource,
  ) {}

  /** 分页上限统一 100（§11.7.4「分页统一」） */
  private clampLimit(limit?: number): number {
    const n = Math.floor(Number(limit ?? 20));
    if (!Number.isFinite(n) || n < 1) return 20;
    return Math.min(n, 100);
  }

  /** expiring_days ∈ [1,365]（§11.7.3 schema） */
  private clampDays(days?: number, dflt = 30): number {
    const n = Math.floor(Number(days ?? dflt));
    if (!Number.isFinite(n) || n < 1) return dflt;
    return Math.min(n, 365);
  }

  // 公共 WHERE 片段：keyword 模糊 + warehouse（名称/编码模糊，纯数字按 ID）
  private applyFilters(qb: any, args: { keyword?: string; warehouse?: string }) {
    if (args.keyword) {
      const kw = `%${escapeLike(args.keyword)}%`;
      qb.andWhere('(m.name ILIKE :kw OR m.code ILIKE :kw OR m.spec ILIKE :kw)', { kw });
    }
    if (args.warehouse) {
      const w = String(args.warehouse).trim();
      if (/^\d+$/.test(w)) {
        qb.andWhere('w.id = :wid', { wid: Number(w) });
      } else {
        const wl = `%${escapeLike(w)}%`;
        qb.andWhere('(w.name ILIKE :wl OR w.code ILIKE :wl)', { wl });
      }
    }
    return qb;
  }

  /** 多维度库存查询（group_by = sku | batch | warehouse） */
  async queryStock(tenantId: number, args: QueryStockArgs = {}): Promise<{ items: StockRow[]; groupBy: string; total: number }> {
    const groupBy = ['sku', 'batch', 'warehouse'].includes(String(args.groupBy)) ? args.groupBy! : 'sku';
    const limit = this.clampLimit(args.limit);

    if (groupBy === 'batch') {
      const qb = this.batches.createQueryBuilder('sb')
        .innerJoin(Material, 'm', 'm.id = sb.material_id')
        .innerJoin(Warehouse, 'w', 'w.id = sb.warehouse_id')
        .where('sb.tenant_id = :tid', { tid: tenantId })
        .andWhere('m.active = true');
      this.applyFilters(qb, args);
      if (args.expiringDays) {
        qb.andWhere('sb.expires_at IS NOT NULL AND sb.expires_at <= current_date + (:days)::int', { days: this.clampDays(args.expiringDays) });
      }
      const rows = await qb
        .select('sb.material_id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
        .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit')
        .addSelect('w.id', 'warehouseId').addSelect('w.name', 'warehouse').addSelect('sb.batch_no', 'batchNo')
        .addSelect('to_char(sb.expires_at, \'YYYY-MM-DD\')', 'expiresAt')
        .addSelect('sb.qty', 'qty').addSelect('m.safety_stock', 'safetyStock')
        .orderBy('sb.expires_at', 'ASC', 'NULLS LAST').addOrderBy('sb.id', 'ASC')
        .limit(limit)
        .getRawMany();
      const items = rows.map((r) => ({
        ...r,
        materialId: Number(r.materialId), warehouseId: Number(r.warehouseId),
        qty: Number(r.qty), safetyStock: Number(r.safetyStock ?? 0),
      }));
      return { items, groupBy, total: items.length };
    }

    if (groupBy === 'warehouse') {
      const qb = this.batches.createQueryBuilder('sb')
        .innerJoin(Material, 'm', 'm.id = sb.material_id')
        .innerJoin(Warehouse, 'w', 'w.id = sb.warehouse_id')
        .where('sb.tenant_id = :tid', { tid: tenantId })
        .andWhere('m.active = true');
      this.applyFilters(qb, args);
      const rows = await qb
        .select('w.id', 'warehouseId').addSelect('w.name', 'warehouse')
        .addSelect('m.id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
        .addSelect('m.unit', 'unit')
        .addSelect('SUM(sb.qty)', 'qty')
        .groupBy('w.id').addGroupBy('w.name').addGroupBy('m.id').addGroupBy('m.code')
        .addGroupBy('m.name').addGroupBy('m.unit')
        .orderBy('w.id', 'ASC').addOrderBy('m.code', 'ASC')
        .limit(limit)
        .getRawMany();
      const items = rows.map((r) => ({ ...r, materialId: Number(r.materialId), warehouseId: Number(r.warehouseId), qty: Number(r.qty) }));
      return { items, groupBy, total: items.length };
    }

    // 默认 sku：按物料汇总；below_safety 只看低于安全库存的行
    const qb = this.batches.createQueryBuilder('sb')
      .innerJoin(Material, 'm', 'm.id = sb.material_id')
      .innerJoin(Warehouse, 'w', 'w.id = sb.warehouse_id')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('m.active = true');
    this.applyFilters(qb, args);
    if (args.expiringDays) {
      // sku 维度下 expiring_days 先收敛批次再汇总
      qb.andWhere('sb.expires_at IS NOT NULL AND sb.expires_at <= current_date + (:days)::int', { days: this.clampDays(args.expiringDays) });
    }
    if (args.belowSafety) {
      qb.having('SUM(sb.qty) < MAX(m.safety_stock)');
    }
    const rows = await qb
      .select('m.id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
      .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit')
      .addSelect('SUM(sb.qty)', 'qty').addSelect('MAX(m.safety_stock)', 'safetyStock')
      .groupBy('m.id').addGroupBy('m.code').addGroupBy('m.name').addGroupBy('m.spec').addGroupBy('m.unit')
      .orderBy('m.code', 'ASC')
      .limit(limit)
      .getRawMany();
    const items = rows.map((r) => {
      const qty = Number(r.qty); const safety = Number(r.safetyStock ?? 0);
      return { ...r, materialId: Number(r.materialId), qty, safetyStock: safety, belowSafety: qty < safety };
    });
    return { items, groupBy: 'sku', total: items.length };
  }

  /** 低于安全库存清单（sku 维度，含缺口） */
  async listLowStock(tenantId: number, args: { keyword?: string; limit?: number } = {}): Promise<{ items: Array<StockRow & { gap: number }>; total: number }> {
    const limit = this.clampLimit(args.limit);
    const qb = this.materials.createQueryBuilder('m')
      .leftJoin(StockBatch, 'sb', 'sb.material_id = m.id AND sb.tenant_id = m.tenant_id')
      .where('m.tenant_id = :tid', { tid: tenantId })
      .andWhere('m.active = true')
      .andWhere('m.safety_stock > 0');
    if (args.keyword) {
      const kw = `%${escapeLike(args.keyword)}%`;
      qb.andWhere('(m.name ILIKE :kw OR m.code ILIKE :kw)', { kw });
    }
    const rows = await qb
      .select('m.id', 'materialId').addSelect('m.code', 'code').addSelect('m.name', 'name')
      .addSelect('m.spec', 'spec').addSelect('m.unit', 'unit').addSelect('m.safety_stock', 'safetyStock')
      .addSelect('COALESCE(SUM(sb.qty), 0)', 'qty')
      .groupBy('m.id').addGroupBy('m.code').addGroupBy('m.name').addGroupBy('m.spec').addGroupBy('m.unit').addGroupBy('m.safety_stock')
      .having('COALESCE(SUM(sb.qty), 0) < m.safety_stock')
      .orderBy('m.code', 'ASC')
      .limit(limit)
      .getRawMany();
    const items = rows.map((r) => {
      const qty = Number(r.qty); const safety = Number(r.safetyStock);
      return { ...r, materialId: Number(r.materialId), qty, safetyStock: safety, gap: round3(Math.max(0, safety - qty)) };
    });
    return { items, total: items.length };
  }

  /** 批次列表（sku 明细视角，按到期升序） */
  async listBatches(tenantId: number, args: { keyword?: string; warehouse?: string; limit?: number } = {}) {
    const res = await this.queryStock(tenantId, { ...args, groupBy: 'batch' });
    return res;
  }

  /** 临期批次（默认 30 天内到期） */
  async listExpiring(tenantId: number, args: { days?: number; warehouse?: string; keyword?: string; limit?: number } = {}) {
    return this.queryStock(tenantId, {
      keyword: args.keyword, warehouse: args.warehouse, limit: args.limit,
      groupBy: 'batch', expiringDays: this.clampDays(args.days),
    });
  }

  /** 按编码或名称定位物料（业务标识优先，§11.7.4）；找不到 404 */
  async findMaterial(tenantId: number, ref: string): Promise<Material> {
    const q = String(ref ?? '').trim();
    if (!q) throw new BadRequestException('product/sku 不能为空');
    const byCode = await this.materials.findOne({ where: { tenantId, code: q } });
    if (byCode) return byCode;
    const row = await this.materials.createQueryBuilder('m')
      .where('m.tenant_id = :tid', { tid: tenantId })
      .andWhere('(m.name ILIKE :kw OR m.code ILIKE :kw)', { kw: `%${escapeLike(q)}%` })
      .orderBy('m.id', 'ASC').limit(1).getOne();
    if (!row) throw new NotFoundException(`物料不存在：${q}`);
    return row;
  }

  /** 某物料当前库存快照（resources 用） */
  async materialSnapshot(tenantId: number, ref: string) {
    const m = /^\d+$/.test(String(ref)) && !q_is_code(ref)
      ? await this.materials.findOne({ where: { tenantId, id: Number(ref) } }).then((r) => r ?? this.findMaterial(tenantId, ref))
      : await this.findMaterial(tenantId, ref);
    const stock = await this.queryStock(tenantId, { keyword: m.code, groupBy: 'batch', limit: 100 });
    return {
      material: {
        id: m.id, code: m.code, name: m.name, spec: m.spec, unit: m.unit,
        category: m.category, safetyStock: Number(m.safetyStock),
      },
      batches: stock.items,
      total: round3(stock.items.reduce((s: number, r) => s + Number(r.qty), 0)),
    };
  }

  /**
   * 齐套/缺料计算（§11.7.2 bom.check_kit_rate / explain_shortage）。
   * 无 BOM → 404（NotFoundException，不暴露其它租户信息）。
   */
  async checkKit(tenantId: number, args: { product: string; demand: number; warehouse?: string }): Promise<{ product: Material; bom: Bom; kit: KitOutcome }> {
    const product = await this.findMaterial(tenantId, args.product);
    const demand = Math.floor(Number(args.demand));
    if (!Number.isFinite(demand) || demand < 1) throw new BadRequestException('demand 必须是 ≥1 的整数');
    const bom = await this.boms.findOne({ where: { tenantId, productMaterialId: product.id, status: 'active' } });
    if (!bom) throw new NotFoundException(`产品「${product.name}」没有启用中的 BOM`);
    const items = await this.bomItems.find({ where: { bomId: bom.id } });
    if (!items.length) {
      // BOM 存在但没有行：视为 0 行齐套（空数据 → 友好摘要路径的一部分）
      return { product, bom, kit: computeKit([], demand) };
    }
    const matIds = items.map((i) => Number(i.materialId));
    const mats = await this.materials.createQueryBuilder('m')
      .where('m.tenant_id = :tid', { tid: tenantId }).andWhere('m.id IN (:...ids)', { ids: matIds })
      .getMany();
    const matById = new Map(mats.map((m) => [Number(m.id), m]));

    // 可用库存：按物料（可选仓库过滤）一次聚合
    const availQb = this.ds.createQueryBuilder()
      .select('sb.material_id', 'materialId')
      .addSelect('COALESCE(SUM(sb.qty), 0)', 'avail')
      .from('stock_batches', 'sb')
      .innerJoin('warehouses', 'w', 'w.id = sb.warehouse_id')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('sb.material_id IN (:...ids)', { ids: matIds });
    if (args.warehouse) {
      const w = String(args.warehouse).trim();
      if (/^\d+$/.test(w)) availQb.andWhere('w.id = :wid', { wid: Number(w) });
      else {
        const wl = `%${escapeLike(w)}%`;
        availQb.andWhere('(w.name ILIKE :wl OR w.code ILIKE :wl)', { wl });
      }
    }
    availQb.groupBy('sb.material_id');
    const availRows: Array<{ materialId: string; avail: string }> = await availQb.getRawMany();
    const avail = new Map(availRows.map((r) => [Number(r.materialId), Number(r.avail)]));

    const lines = items.flatMap((i) => {
      const m = matById.get(Number(i.materialId));
      if (!m) return []; // 物料被物理删除时跳过（防御）
      return [{
        materialId: Number(i.materialId), code: m.code, name: m.name, unit: m.unit,
        qtyPer: Number(i.qtyPer), lossRate: Number(i.lossRate), available: avail.get(Number(i.materialId)) ?? 0,
      }];
    });
    return { product, bom, kit: computeKit(lines, demand) };
  }
}

// resource id 判断辅助：stock 快照的 :id 既可能是物料数字 ID，也可能是编码（如 M-APPLE-ORG）
// '123' 这种纯数字串优先按 ID 找；找不到再按名称/编码模糊。抽成函数便于测试与阅读。
function q_is_code(ref: unknown): boolean {
  return /^[A-Za-z]/.test(String(ref ?? ''));
}
