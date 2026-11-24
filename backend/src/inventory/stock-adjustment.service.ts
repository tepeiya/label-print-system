// =============================================================================
// StockAdjustmentService —— 库存调整单（① 手工出入库单据化，2026-11-25）
//
// 边界：
//   · 本服务**不直接改库存**，过账只逐行调 InventoryService.adjustStock
//     （FIFO / 行锁 / 事务台账 / 入库自动建批次，全部走原来那条路，不产生第二套账）。
//   · 单据号写进台账 reason 前缀 `[SA-YYYYMMDD-NNNN] 事由`，stock_moves 结构不动。
//   · 部分行失败时停在失败行、单据落 PARTIAL，失败行可重试（不整单回滚已成功行——
//     库存在真实世界已经动了，假装回滚才是说谎）。
// =============================================================================
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockAdjustment, StockAdjustmentLine, Material, Warehouse, WarehouseLocation } from './inventory.entity';
import { InventoryService } from './inventory.service';
import { round3 } from './kit.calc';
import { ADJUST_TYPE_TEXT, assertDirection, formatAdjustNo, nextDocStatus, type AdjustType } from './stock-adjustment.calc';

export interface AdjustLineInput {
  sku: string;
  batchNo?: string;
  locationId?: number;
  /** 带符号：盘盈为正、盘亏为负 */
  qtyDelta: number;
  note?: string;
}

export interface AdjustInput {
  adjustType: AdjustType;
  warehouseId?: number;
  warehouseCode?: string;
  reason: string;
  remark?: string;
  lines: AdjustLineInput[];
}

@Injectable()
export class StockAdjustmentService {
  constructor(
    @InjectRepository(StockAdjustment) private docs: Repository<StockAdjustment>,
    @InjectRepository(StockAdjustmentLine) private lines: Repository<StockAdjustmentLine>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseLocation) private locations: Repository<WarehouseLocation>,
    private inv: InventoryService,
  ) {}

  // ---------------------------------------------------------------- 查询

  async list(tenantId: number, q: { status?: string; adjustType?: string; keyword?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.docs.createQueryBuilder('d')
      .where('d.tenant_id = :tenantId', { tenantId })
      .orderBy('d.id', 'DESC');
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.adjustType) qb.andWhere('d.adjust_type = :t', { t: q.adjustType });
    if (q.keyword) qb.andWhere('(d.adjust_no ILIKE :kw OR d.reason ILIKE :kw)', { kw: `%${q.keyword}%` });
    const [rows, total] = await qb.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();

    const whs = new Map<number, { code: string; name: string }>();
    for (const w of await this.warehouses.find({ where: { tenantId } })) whs.set(Number(w.id), { code: w.code, name: w.name });

    const ids = rows.map((r) => Number(r.id));
    const counts = new Map<number, { total: number; done: number }>();
    if (ids.length) {
      const cnt = await this.lines.createQueryBuilder('l')
        .select('l.adjustment_id', 'aid')
        .addSelect('COUNT(*)', 'n')
        .addSelect(`SUM(CASE WHEN l.status = 'DONE' THEN 1 ELSE 0 END)`, 'done')
        .where('l.tenant_id = :tenantId', { tenantId })
        .andWhere('l.adjustment_id IN (:...ids)', { ids })
        .groupBy('l.adjustment_id')
        .getRawMany();
      for (const c of cnt) counts.set(Number(c.aid), { total: Number(c.n), done: Number(c.done) });
    }

    return {
      total, page, pageSize,
      items: rows.map((d) => {
        const c = counts.get(Number(d.id)) ?? { total: 0, done: 0 };
        const w = whs.get(Number(d.warehouseId));
        return {
          id: Number(d.id), adjustNo: d.adjustNo, adjustType: d.adjustType, adjustTypeText: ADJUST_TYPE_TEXT[d.adjustType],
          warehouseId: Number(d.warehouseId), warehouse: w ? `${w.code} ${w.name}` : String(d.warehouseId),
          status: d.status, reason: d.reason, remark: d.remark,
          lineCount: c.total, doneLines: c.done,
          createdBy: d.createdBy ? Number(d.createdBy) : null, createdAt: d.createdAt, postedAt: d.postedAt,
        };
      }),
    };
  }

  async detail(tenantId: number, id: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('调整单不存在');
    const lines = await this.lines.find({ where: { tenantId, adjustmentId: id }, order: { lineNo: 'ASC' } });

    const mats = new Map<number, { code: string; name: string; unit: string }>();
    for (const l of lines) {
      if (!mats.has(Number(l.materialId))) {
        const m = await this.materials.findOne({ where: { tenantId, id: Number(l.materialId) } });
        if (m) mats.set(Number(m.id), { code: m.code, name: m.name, unit: m.unit });
      }
    }
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    const locRows = await this.locations.find({ where: { tenantId } });
    const locs = new Map<number, string>();
    for (const l of locRows) locs.set(Number(l.id), `${l.code} ${l.name}`);

    const netDelta = lines.filter((l) => l.status === 'DONE').reduce((s, l) => s + Number(l.qtyDelta), 0);
    return {
      id: Number(doc.id), adjustNo: doc.adjustNo, adjustType: doc.adjustType, adjustTypeText: ADJUST_TYPE_TEXT[doc.adjustType],
      warehouseId: Number(doc.warehouseId), warehouse: wh ? { id: Number(wh.id), code: wh.code, name: wh.name } : null,
      status: doc.status, reason: doc.reason, remark: doc.remark,
      createdBy: doc.createdBy ? Number(doc.createdBy) : null,
      postedBy: doc.postedBy ? Number(doc.postedBy) : null, postedAt: doc.postedAt,
      cancelledBy: doc.cancelledBy ? Number(doc.cancelledBy) : null, cancelledAt: doc.cancelledAt,
      cancelReason: doc.cancelReason,
      createdAt: doc.createdAt,
      netDelta: round3(netDelta),
      lines: lines.map((l) => {
        const m = mats.get(Number(l.materialId));
        return {
          id: Number(l.id), lineNo: l.lineNo, materialId: Number(l.materialId),
          skuCode: l.skuCode, materialName: m?.name ?? '', unit: m?.unit ?? '',
          batchNo: l.batchNo, locationId: l.locationId ? Number(l.locationId) : null,
          locationText: l.locationId ? (locs.get(Number(l.locationId)) ?? String(l.locationId)) : null,
          qtyDelta: Number(l.qtyDelta), status: l.status,
          qtyBefore: l.qtyBefore != null ? Number(l.qtyBefore) : null,
          qtyAfter: l.qtyAfter != null ? Number(l.qtyAfter) : null,
          error: l.error, postedAt: l.postedAt,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- 建单

  async create(tenantId: number, dto: AdjustInput, userId: number | null) {
    const type = dto.adjustType;
    if (!ADJUST_TYPE_TEXT[type]) throw new BadRequestException(`未知调整类型：${type}`);
    const reason = String(dto.reason ?? '').trim();
    if (reason.length < 2) throw new BadRequestException('调整原因必填（至少 2 个字符）');
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) throw new BadRequestException('至少要有 1 行调整明细');
    if (dto.lines.length > 50) throw new BadRequestException('单张调整单最多 50 行');

    const warehouse = await this.resolveWarehouse(tenantId, dto);
    const prepared: Array<{ material: Material; input: AdjustLineInput; delta: number }> = [];
    for (let i = 0; i < dto.lines.length; i++) {
      const l = dto.lines[i];
      const code = String(l?.sku ?? '').trim();
      if (!code) throw new BadRequestException(`第 ${i + 1} 行：物料必填`);
      const delta = round3(Number(l.qtyDelta));
      if (!Number.isFinite(delta) || delta === 0) throw new BadRequestException(`第 ${i + 1} 行：数量必须是非零数字（盘盈正、盘亏负）`);
      assertDirection(type, delta, i + 1);
      const material = await this.materials.findOne({ where: { tenantId, code } });
      if (!material) throw new BadRequestException(`第 ${i + 1} 行：物料不存在（${code}）`);
      prepared.push({ material, input: l, delta });
    }

    const doc = await this.insertWithNo(tenantId, {
      tenantId, adjustType: type, warehouseId: Number(warehouse.id), reason, remark: dto.remark?.trim() || null,
      createdBy: userId, status: 'DRAFT',
    });
    const rows = prepared.map((p, idx) => this.lines.create({
      tenantId, adjustmentId: Number(doc.id), lineNo: idx + 1,
      materialId: Number(p.material.id), skuCode: p.material.code,
      batchNo: p.input.batchNo?.trim() || null,
      locationId: p.input.locationId ?? null,
      qtyDelta: String(p.delta), status: 'PENDING',
    }));
    await this.lines.save(rows);
    return this.detail(tenantId, Number(doc.id));
  }

  /** 单号 SA-YYYYMMDD-NNNN：按当日已有张数 +1，唯一索引撞了重试 */
  private async insertWithNo(tenantId: number, patch: Partial<StockAdjustment>): Promise<StockAdjustment> {
    const d = new Date();
    const ymd = formatAdjustNo(d, 0).slice(3, 11);
    for (let attempt = 0; attempt < 6; attempt++) {
      const seqRow = await this.docs.createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.adjust_no LIKE :p', { p: `SA-${ymd}-%` })
        .select('COUNT(*)', 'n')
        .getRawOne();
      const n = Number(seqRow?.n ?? 0) + 1 + attempt;
      const adjustNo = formatAdjustNo(d, n);
      try {
        return await this.docs.save(this.docs.create({ ...patch, adjustNo } as StockAdjustment));
      } catch (e: any) {
        if (String(e?.code) === '23505' || /duplicate key/i.test(String(e?.message))) continue;
        throw e;
      }
    }
    throw new BadRequestException('调整单单号生成冲突，请重试');
  }

  private async resolveWarehouse(tenantId: number, dto: { warehouseId?: number; warehouseCode?: string }): Promise<Warehouse> {
    if (dto.warehouseId) {
      const w = await this.warehouses.findOne({ where: { tenantId, id: Number(dto.warehouseId) } });
      if (!w) throw new BadRequestException('仓库不存在');
      return w;
    }
    if (dto.warehouseCode) {
      const w = await this.warehouses.findOne({ where: { tenantId, code: String(dto.warehouseCode).trim() } });
      if (!w) throw new BadRequestException(`仓库不存在：${dto.warehouseCode}`);
      return w;
    }
    throw new BadRequestException('请选择仓库');
  }

  // ---------------------------------------------------------------- 过账

  async post(tenantId: number, id: number, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('调整单不存在');
    if (doc.status === 'POSTED') throw new BadRequestException('该调整单已过账，不能重复过账');
    if (doc.status === 'CANCELLED') throw new BadRequestException('该调整单已作废，不能过账');

    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    if (!wh) throw new BadRequestException('单据上的仓库已不存在，无法过账');
    const lines = await this.lines.find({ where: { tenantId, adjustmentId: id }, order: { lineNo: 'ASC' } });
    const todo = lines.filter((l) => l.status === 'PENDING' || l.status === 'FAILED');
    if (!todo.length) throw new BadRequestException('没有待过账的行');

    const tag = `[${doc.adjustNo}] ${ADJUST_TYPE_TEXT[doc.adjustType]}：${doc.reason}`;
    const results: any[] = [];
    let stopped = false;
    for (const l of todo) {
      if (stopped) { results.push({ lineNo: l.lineNo, status: 'SKIPPED', message: '前一行失败，本次未执行' }); continue; }
      try {
        const outcome = await this.inv.adjustStock(tenantId, {
          sku: l.skuCode, warehouse: wh.code, batch_no: l.batchNo ?? undefined,
          location_id: l.locationId ?? undefined, delta: Number(l.qtyDelta), reason: tag.slice(0, 200),
        }, false, `user#${userId ?? 0}`);
        const first = outcome.lines[0];
        const last = outcome.lines[outcome.lines.length - 1];
        await this.lines.update({ id: l.id }, {
          status: 'DONE', postedAt: new Date(),
          qtyBefore: first ? String(first.before) : null,
          qtyAfter: last ? String(last.after) : null,
          error: null,
        });
        results.push({ lineNo: l.lineNo, status: 'DONE', change: outcome.change, note: outcome.note });
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 200);
        await this.lines.update({ id: l.id }, { status: 'FAILED', error: msg });
        results.push({ lineNo: l.lineNo, status: 'FAILED', message: msg });
        stopped = true;
      }
    }

    const after = await this.lines.find({ where: { tenantId, adjustmentId: id } });
    const docStatus = nextDocStatus(after.map((l) => l.status));
    const allDone = docStatus === 'POSTED';
    await this.docs.update({ id }, {
      status: docStatus,
      postedBy: userId ?? null,
      postedAt: new Date(),
    });
    return { adjustment: await this.detail(tenantId, id), results, allDone };
  }

  // ---------------------------------------------------------------- 作废

  async cancel(tenantId: number, id: number, reason: string, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id } });
    if (!doc) throw new NotFoundException('调整单不存在');
    if (doc.status === 'CANCELLED') throw new BadRequestException('该单已作废');
    if (doc.status === 'POSTED') throw new BadRequestException('已过账的单不能作废（库存已变动，需另开一张反方向调整单）');
    const lines = await this.lines.find({ where: { tenantId, adjustmentId: id } });
    const done = lines.filter((l) => l.status === 'DONE').length;
    await this.docs.update({ id }, {
      status: 'CANCELLED', cancelledBy: userId ?? null, cancelledAt: new Date(),
      cancelReason: String(reason ?? '').trim().slice(0, 200) || '手工作废',
    });
    // 已过账的行不回滚：库里确实动过，反方向另开单才是可审计的做法
    return {
      adjustment: await this.detail(tenantId, id),
      note: done > 0 ? `本单已有 ${done} 行过账，作废仅关闭剩余行，已过账部分需另开反方向调整单冲回` : '已作废，未产生库存变动',
    };
  }
}
