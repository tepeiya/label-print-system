// =============================================================================
// InventoryService —— P4 库存只读查询（docs/11 §11.7.2/§11.7.3）
// 只服务 Agent 只读工具（/agent/v1），没有租户 REST 控制器——完整 WMS 页面在后续阶段。
// 全部查询强制 tenant_id；数值列（numeric/bigint 反射为 string）出参前 Number()。
// =============================================================================
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Material, StockBatch, Warehouse, Bom, BomItem } from './inventory.entity';
import { computeKit, escapeLike, KitOutcome, round3 } from './kit.calc';
// P6.2 阶段 B：事务/原生 QB 也按 TenantCtx.dataSourceKey 路由（Repository 已由代理模块接管）
import { TENANT_DATASOURCE, tenantDataSourceProxy } from '../common/tenant-routing';

type TenantDataSource = ReturnType<typeof tenantDataSourceProxy>;

/** 一次库存变动落到的批次行（P5 写路径：adjust / transfer 复用） */
export interface StockMoveLine {
  batchNo: string;
  warehouse: string;
  change: number;
  before: number;
  after: number;
}

/** adjustStock / transferStock 的统一出参（dryRun 时 lines 是「将会发生」的变动） */
export interface StockWriteOutcome {
  material: { id: number; code: string; name: string; unit: string };
  warehouse: { id: number; code: string; name: string };
  dryRun: boolean;
  change: number;
  lines: StockMoveLine[];
  note: string | null;
}

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
    @Inject(TENANT_DATASOURCE) private ds: TenantDataSource,
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

  // ------------------------------------------------------------------ P5 写路径
  // docs/11 §11.7.2 把 inventory.adjust / inventory.transfer 定为「高危」工具：
  // 执行器只提供原子操作本身，审批（§11.7.6）与幂等（§11.7.4）由 Agent dispatch 层负责，
  // 这样同一套写路径将来也能直接给租户侧库存 REST 页面复用（P6）。

  /** 仓库定位：编码精确 → 数字 ID → 名称/编码模糊（与 findMaterial 同口径） */
  async findWarehouse(tenantId: number, ref: unknown): Promise<Warehouse> {
    const q = String(ref ?? '').trim();
    if (!q) throw new BadRequestException('warehouse 不能为空');
    const byCode = await this.warehouses.findOne({ where: { tenantId, code: q } });
    if (byCode) return byCode;
    if (/^\d+$/.test(q)) {
      const byId = await this.warehouses.findOne({ where: { tenantId, id: Number(q) } });
      if (byId) return byId;
    }
    const row = await this.warehouses.createQueryBuilder('w')
      .where('w.tenant_id = :tid', { tid: tenantId })
      .andWhere('(w.name ILIKE :kw OR w.code ILIKE :kw)', { kw: `%${escapeLike(q)}%` })
      .orderBy('w.id', 'ASC').limit(1).getOne();
    if (!row) throw new NotFoundException(`仓库不存在：${q}`);
    return row;
  }

  /** 出库批次排序：先到期先出（NULLS LAST 由 Postgres ASC 默认保证），再按生产日期、再按 ID */
  private fifoQb(tenantId: number, materialId: number, warehouseId: number) {
    return this.batches.createQueryBuilder('sb')
      .where('sb.tenant_id = :tid', { tid: tenantId })
      .andWhere('sb.material_id = :mid', { mid: materialId })
      .andWhere('sb.warehouse_id = :wid', { wid: warehouseId })
      .andWhere('sb.qty > 0')
      .orderBy('sb.expires_at', 'ASC')
      .addOrderBy('sb.produced_at', 'ASC')
      .addOrderBy('sb.id', 'ASC');
  }

  /**
   * 库存调整（§11.7.3 inventory.adjust）。
   * delta>0 入库：有 batch_no 就并入该批次，没有则生成 ADJ- 时间戳批次（保证批次可追溯，
   *   不把无主入库混进别人的批次）。
   * delta<0 出库：有 batch_no 只动该批次；没有则按 FIFO 跨批次扣减，不足则整笔拒绝（不做部分扣减）。
   * dryRun 只算不改，用于「高危可预演」。
   */
  async adjustStock(
    tenantId: number,
    args: { sku: string; warehouse: string; batch_no?: string; delta: number; reason: string },
    dryRun = false,
  ): Promise<StockWriteOutcome> {
    const delta = round3(Number(args.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException('delta 必须是非零数字（正数入库、负数出库）');
    }
    const reason = String(args.reason ?? '').trim();
    if (reason.length < 2) throw new BadRequestException('reason 必填（至少 2 个字符，调整要留痕）');
    const material = await this.findMaterial(tenantId, args.sku);
    const warehouse = await this.findWarehouse(tenantId, args.warehouse);
    const batchNo = args.batch_no ? String(args.batch_no).trim() : '';

    if (batchNo) {
      const batch = await this.batches.findOne({
        where: { tenantId, materialId: material.id, warehouseId: warehouse.id, batchNo },
      });
      if (!batch) {
        if (delta < 0) throw new BadRequestException(`批次不存在，无法出库：${batchNo}（仓库 ${warehouse.name}）`);
        const created: StockMoveLine = { batchNo, change: delta, before: 0, after: delta, warehouse: warehouse.code };
        if (!dryRun) {
          await this.batches.save(this.batches.create({
            tenantId, materialId: material.id, warehouseId: warehouse.id,
            batchNo, qty: String(delta),
          }));
        }
        return this.outcome(material, warehouse, dryRun, delta, [created], `批次 ${batchNo} 新建`);
      }
      const before = Number(batch.qty);
      const after = round3(before + delta);
      if (after < -1e-9) {
        throw new BadRequestException(
          `库存不足：批次 ${batchNo} 现有 ${before}${material.unit}，本次需出 ${Math.abs(delta)}${material.unit}`,
        );
      }
      const line: StockMoveLine = { batchNo, change: delta, before, after, warehouse: warehouse.code };
      if (!dryRun) {
        await this.batches.update({ id: batch.id }, { qty: String(after) });
      }
      return this.outcome(material, warehouse, dryRun, delta, [line]);
    }

    if (delta > 0) {
      const generated = `ADJ-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
      const line: StockMoveLine = { batchNo: generated, change: delta, before: 0, after: delta, warehouse: warehouse.code };
      if (!dryRun) {
        await this.batches.save(this.batches.create({
          tenantId, materialId: material.id, warehouseId: warehouse.id,
          batchNo: generated, qty: String(delta),
        }));
      }
      return this.outcome(material, warehouse, dryRun, delta, [line], '未给批次号，按入库生成新批次');
    }

    // 出库 FIFO：先算计划，再在事务里加锁复核（并发下不能被别的调用扣成负数）
    const plan = await this.planFifo(tenantId, material, warehouse, Math.abs(delta));
    const lines: StockMoveLine[] = plan.map((p) => ({
      batchNo: p.batch.batchNo, change: -p.take, before: p.before, after: round3(p.before - p.take),
      warehouse: warehouse.code,
    }));
    if (!dryRun) {
      await this.ds.transaction(async (em) => {
        const ids = plan.map((p) => Number(p.batch.id));
        const locked = await em.getRepository(StockBatch).find({ where: { id: In(ids) }, lock: { mode: 'pessimistic_write' } });
        const byId = new Map(locked.map((b) => [Number(b.id), b]));
        for (const p of plan) {
          const b = byId.get(Number(p.batch.id));
          if (!b) throw new BadRequestException(`批次 ${p.batch.batchNo} 已被删除，调整中止`);
          const now = round3(Number(b.qty));
          if (now + 1e-9 < p.take) {
            throw new BadRequestException(
              `并发冲突：批次 ${b.batchNo} 仅剩 ${now}${material.unit}，本次需出 ${p.take}${material.unit}，请重试`,
            );
          }
          await em.getRepository(StockBatch).update({ id: b.id }, { qty: String(round3(now - p.take)) });
        }
      });
    }
    return this.outcome(material, warehouse, dryRun, delta, lines);
  }

  /**
   * 跨仓调拨（§11.7.2 inventory.transfer）。
   * 同批次号原样带过去（批次是追溯单位），目标仓没有该批次就按源批次属性新建一行。
   */
  async transferStock(
    tenantId: number,
    args: { sku: string; from_warehouse: string; to_warehouse: string; qty: number; batch_no?: string },
    dryRun = false,
  ): Promise<StockWriteOutcome> {
    const qty = round3(Number(args.qty));
    if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('qty 必须是正数');
    const material = await this.findMaterial(tenantId, args.sku);
    const from = await this.findWarehouse(tenantId, args.from_warehouse);
    const to = await this.findWarehouse(tenantId, args.to_warehouse);
    if (Number(from.id) === Number(to.id)) throw new BadRequestException('调拨的出入仓库不能相同');
    const onlyBatch = args.batch_no ? String(args.batch_no).trim() : '';

    const candidates = onlyBatch
      ? [await this.batches.findOne({ where: { tenantId, materialId: material.id, warehouseId: from.id, batchNo: onlyBatch } })]
      : await this.fifoQb(tenantId, material.id, from.id).getMany();
    const valid = candidates.filter((b): b is StockBatch => !!b);
    if (!valid.length) {
      throw new BadRequestException(
        `${from.name} 没有可调拨的「${material.name}」批次${onlyBatch ? `（批次 ${onlyBatch}）` : ''}`,
      );
    }
    const plan = onlyBatch
      ? this.allocate([{ batch: valid[0], before: Number(valid[0].qty) }], qty, material)
      : this.allocate(valid.map((b) => ({ batch: b, before: Number(b.qty) })), qty, material);

    const lines: StockMoveLine[] = [];
    for (const p of plan) {
      lines.push({ batchNo: p.batch.batchNo, change: -p.take, before: p.before, after: round3(p.before - p.take), warehouse: from.code });
      const target = await this.batches.findOne({
        where: { tenantId, materialId: material.id, warehouseId: to.id, batchNo: p.batch.batchNo },
      });
      if (target) {
        const tb = Number(target.qty);
        lines.push({ batchNo: p.batch.batchNo, change: p.take, before: tb, after: round3(tb + p.take), warehouse: to.code });
      } else {
        lines.push({ batchNo: p.batch.batchNo, change: p.take, before: 0, after: p.take, warehouse: to.code });
      }
    }
    if (!dryRun) {
      await this.ds.transaction(async (em) => {
        const repo = em.getRepository(StockBatch);
        const ids = plan.map((p) => Number(p.batch.id));
        const locked = await repo.find({ where: { id: In(ids) }, lock: { mode: 'pessimistic_write' } });
        const byId = new Map(locked.map((b) => [Number(b.id), b]));
        for (const p of plan) {
          const b = byId.get(Number(p.batch.id));
          if (!b) throw new BadRequestException(`批次 ${p.batch.batchNo} 已被删除，调拨中止`);
          const now = round3(Number(b.qty));
          if (now + 1e-9 < p.take) {
            throw new BadRequestException(
              `并发冲突：${from.name} 的批次 ${b.batchNo} 仅剩 ${now}${material.unit}，本次需调 ${p.take}${material.unit}`,
            );
          }
          await repo.update({ id: b.id }, { qty: String(round3(now - p.take)) });
          const target = await repo.findOne({
            where: { tenantId, materialId: material.id, warehouseId: to.id, batchNo: b.batchNo },
          });
          if (target) {
            await repo.update({ id: target.id }, { qty: String(round3(Number(target.qty) + p.take)) });
          } else {
            await repo.save(repo.create({
              tenantId, materialId: material.id, warehouseId: to.id, batchNo: b.batchNo,
              qty: String(p.take), unitCostCents: b.unitCostCents, producedAt: b.producedAt, expiresAt: b.expiresAt,
            }));
          }
        }
      });
    }
    return this.outcome(material, from, dryRun, qty, lines, `调拨至 ${to.name}（${to.code}）`);
  }

  /** FIFO 出库计划（不足则抛错，带缺口数量） */
  private async planFifo(tenantId: number, material: Material, warehouse: Warehouse, need: number) {
    const rows = await this.fifoQb(tenantId, material.id, warehouse.id).getMany();
    if (!rows.length) {
      throw new BadRequestException(`${warehouse.name} 没有「${material.name}」的可出库批次`);
    }
    return this.allocate(rows.map((b) => ({ batch: b, before: Number(b.qty) })), need, material, warehouse.name);
  }

  private allocate(
    source: Array<{ batch: StockBatch; before: number }>, need: number, material: Material, where = '',
  ): Array<{ batch: StockBatch; before: number; take: number }> {
    let left = round3(need);
    const out: Array<{ batch: StockBatch; before: number; take: number }> = [];
    for (const s of source) {
      if (left <= 1e-9) break;
      const take = round3(Math.min(left, Math.max(0, s.before)));
      if (take <= 0) continue;
      out.push({ ...s, take });
      left = round3(left - take);
    }
    if (left > 1e-9) {
      throw new BadRequestException(
        `库存不足${where ? `（${where}）` : ''}：「${material.name}」需 ${round3(need)}${material.unit}，`
        + `可用 ${round3(need - left)}${material.unit}，缺 ${round3(left)}${material.unit}`,
      );
    }
    return out;
  }

  private outcome(
    material: Material, warehouse: Warehouse, dryRun: boolean, change: number,
    lines: StockMoveLine[], note?: string,
  ): StockWriteOutcome {
    return {
      material: { id: Number(material.id), code: material.code, name: material.name, unit: material.unit },
      warehouse: { id: Number(warehouse.id), code: warehouse.code, name: warehouse.name },
      dryRun, change: round3(change), lines, note: note ?? null,
    };
  }
}

// resource id 判断辅助：stock 快照的 :id 既可能是物料数字 ID，也可能是编码（如 M-APPLE-ORG）
// '123' 这种纯数字串优先按 ID 找；找不到再按名称/编码模糊。抽成函数便于测试与阅读。
function q_is_code(ref: unknown): boolean {
  return /^[A-Za-z]/.test(String(ref ?? ''));
}
