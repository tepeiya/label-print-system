// =============================================================================
// QualityService —— 检验单（IQC / IPQC / FQC / OQC）
//
// 边界：
//   · 本服务**不直接写 stock_batches**；批次质量状态一律经 InventoryGateway.setBatchQualityStatus
//     （库存 owner 在 inventory，质量模块只表达"判定结论"，不越权改库存）。
//   · 判定合格 → 批次 RELEASED（可出库）；判定不合格 → 批次 REJECTED（隔离，只能报废）。
//   · 已判定的检验单锁死不可修改（飞检要看原始记录，不能回改）。
//
// 待检怎么来的（两个入口，都走同一条库存口径）：
//   ① 收货：物料 qc_required=true → 收货过账时批次按 PENDING 建（inbound 传 qcStatus）；
//   ② 手工：质检员按「待检批次」列表一键开单（本服务 listPending / autoOpenForPending）。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QcInspection, QcInspectionItem } from './entities/quality.entity';
import { Material, StockBatch, Warehouse } from '../inventory/inventory.entity';
import { InventoryGateway } from '../wms/gateways/inventory.gateway';
import { AuditService } from '../audit/audit.module';
import {
  checkItemsForPass, checkItemsForFail, normalizeItems, nextDocNo, canEditInspection,
  qcStatusFromResult, type InspectionItemPlain,
} from './iqc.calc';

const INSP_TYPE_TEXT: Record<string, string> = { IQC: '来料检验', IPQC: '过程检验', FQC: '成品检验', OQC: '出货检验' };
const INSP_STATUS_TEXT: Record<string, string> = { DRAFT: '待判定', PASS: '合格', FAIL: '不合格', CANCELLED: '已作废' };

export interface CreateInspectionInput {
  inspType?: 'IQC' | 'IPQC' | 'FQC' | 'OQC';
  skuCode: string;
  warehouseId: number;
  batchNo: string;
  qty?: number;
  sampleQty?: number;
  inspector?: string;
  remark?: string;
  source?: 'RECEIPT' | 'MANUAL' | 'WORKORDER';
}

@Injectable()
export class QualityService {
  private readonly log = new Logger(QualityService.name);

  constructor(
    @InjectRepository(QcInspection) private docs: Repository<QcInspection>,
    @InjectRepository(QcInspectionItem) private items: Repository<QcInspectionItem>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(StockBatch) private batches: Repository<StockBatch>,
    private gate: InventoryGateway,
    private audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ 查询

  async list(tenantId: number, q: { status?: string; inspType?: string; keyword?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.docs.createQueryBuilder('d').where('d.tenant_id = :tenantId', { tenantId });
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.inspType) qb.andWhere('d.insp_type = :inspType', { inspType: q.inspType });
    if (q.keyword) {
      qb.andWhere('(d.inspection_no ILIKE :kw OR d.batch_no ILIKE :kw OR d.sku_code ILIKE :kw)', { kw: `%${q.keyword}%` });
    }
    const total = await qb.getCount();
    const rows = await qb.orderBy('d.id', 'DESC').offset((page - 1) * pageSize).limit(pageSize).getMany();
    const mats = await this.materials.find({ where: { tenantId } });
    const whs = await this.warehouses.find({ where: { tenantId } });
    const byMat = new Map(mats.map((m) => [Number(m.id), m]));
    const byWh = new Map(whs.map((w) => [Number(w.id), w]));
    return {
      items: rows.map((d) => ({
        id: Number(d.id), inspectionNo: d.inspectionNo, inspType: d.inspType,
        inspTypeText: INSP_TYPE_TEXT[d.inspType] ?? d.inspType,
        status: d.status, statusText: INSP_STATUS_TEXT[d.status] ?? d.status,
        skuCode: d.skuCode, materialName: byMat.get(Number(d.materialId))?.name ?? d.skuCode,
        warehouse: byWh.get(Number(d.warehouseId))?.name ?? String(d.warehouseId),
        batchNo: d.batchNo, qty: Number(d.qty), sampleQty: Number(d.sampleQty),
        inspector: d.inspector, inspectedAt: d.inspectedAt, createdAt: d.createdAt,
      })),
      total, page, pageSize,
    };
  }

  async detail(tenantId: number, id: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('检验单不存在');
    const items = await this.items.find({ where: { tenantId, inspectionId: Number(id) }, order: { seq: 'ASC' } });
    const mat = await this.materials.findOne({ where: { tenantId, id: Number(doc.materialId) } });
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    const batch = await this.batches.findOne({
      where: { tenantId, materialId: Number(doc.materialId), warehouseId: Number(doc.warehouseId), batchNo: doc.batchNo },
    });
    return {
      id: Number(doc.id), inspectionNo: doc.inspectionNo, inspType: doc.inspType,
      inspTypeText: INSP_TYPE_TEXT[doc.inspType] ?? doc.inspType,
      status: doc.status, statusText: INSP_STATUS_TEXT[doc.status] ?? doc.status,
      source: doc.source, receiptId: doc.receiptId ? Number(doc.receiptId) : null,
      skuCode: doc.skuCode, materialName: mat?.name ?? doc.skuCode, unit: mat?.unit ?? '件',
      warehouseId: Number(doc.warehouseId), warehouse: wh?.name ?? String(doc.warehouseId),
      batchNo: doc.batchNo, qty: Number(doc.qty), sampleQty: Number(doc.sampleQty),
      batchQty: batch ? Number(batch.qty) : null,
      batchQualityStatus: (batch as any)?.qualityStatus ?? null,
      inspector: doc.inspector, inspectedAt: doc.inspectedAt,
      reviewer: doc.reviewer, reviewedAt: doc.reviewedAt,
      opinion: doc.opinion, remark: doc.remark, createdAt: doc.createdAt,
      items: items.map((i) => ({
        id: Number(i.id), seq: i.seq, itemName: i.itemName, standard: i.standard,
        measured: i.measured, verdict: i.verdict, remark: i.remark,
      })),
    };
  }

  /** 待检批次：库存里 PENDING 且没有待判定检验单的批次（页面「待检清单」，一键开单） */
  async listPending(tenantId: number) {
    const [rows, drafts, mats, whs] = await Promise.all([
      this.batches.createQueryBuilder('sb')
        .where('sb.tenant_id = :tenantId', { tenantId })
        .andWhere(`sb.quality_status = 'PENDING'`)
        .andWhere('sb.qty > 0')
        .orderBy('sb.created_at', 'DESC')
        .limit(200)
        .getMany(),
      this.docs.find({ where: { tenantId, status: 'DRAFT' } }),
      this.materials.find({ where: { tenantId } }),
      this.warehouses.find({ where: { tenantId } }),
    ]);
    const byMat = new Map(mats.map((m) => [Number(m.id), m]));
    const byWh = new Map(whs.map((w) => [Number(w.id), w]));
    const hasDraft = new Set(drafts.map((d) => `${Number(d.materialId)}|${Number(d.warehouseId)}|${d.batchNo}`));
    return rows.map((b) => ({
      materialId: Number(b.materialId), skuCode: byMat.get(Number(b.materialId))?.code ?? '',
      materialName: byMat.get(Number(b.materialId))?.name ?? '',
      unit: byMat.get(Number(b.materialId))?.unit ?? '件',
      warehouseId: Number(b.warehouseId), warehouse: byWh.get(Number(b.warehouseId))?.name ?? '',
      batchNo: b.batchNo, qty: Number(b.qty),
      expiresAt: (b as any).expiresAt ? String((b as any).expiresAt).slice(0, 10) : null,
      hasDraft: hasDraft.has(`${Number(b.materialId)}|${Number(b.warehouseId)}|${b.batchNo}`),
      createdAt: b.createdAt,
    }));
  }

  // ------------------------------------------------------------------ 开单

  async create(tenantId: number, input: CreateInspectionInput, userId: number | null) {
    const inspType = input.inspType ?? 'IQC';
    const mat = await this.materials.findOne({ where: { tenantId, code: String(input.skuCode) } });
    if (!mat) throw new NotFoundException(`物料不存在：${input.skuCode}`);
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(input.warehouseId) } });
    if (!wh) throw new NotFoundException(`仓库不存在：${input.warehouseId}`);
    const batch = await this.batches.findOne({
      where: { tenantId, materialId: Number(mat.id), warehouseId: Number(wh.id), batchNo: String(input.batchNo) },
    });
    if (!batch) throw new BadRequestException(`批次不存在：${input.batchNo}（仓库 ${wh.name}）`);
    const dup = await this.docs.findOne({
      where: { tenantId, materialId: Number(mat.id), warehouseId: Number(wh.id), batchNo: String(input.batchNo), status: 'DRAFT' },
    });
    if (dup) throw new BadRequestException(`该批次已有待判定检验单：${dup.inspectionNo}`);

    const doc = await this.insertWithNo(tenantId, {
      tenantId, inspType, source: input.source ?? 'MANUAL',
      warehouseId: Number(wh.id), materialId: Number(mat.id), skuCode: mat.code,
      batchNo: String(input.batchNo),
      qty: String(input.qty ?? Number(batch.qty)), sampleQty: String(input.sampleQty ?? 0),
      status: 'DRAFT', inspector: input.inspector ?? null, remark: input.remark ?? null,
      createdBy: userId ?? null,
    });
    await this.audit.write(tenantId, 'quality.inspection.create', { id: doc.id, no: doc.inspectionNo }, userId ?? undefined, 'qc_inspection', Number(doc.id));
    return this.detail(tenantId, Number(doc.id));
  }

  /** 扫一遍待检批次，缺检验单的一律补开（一次最多 50 张，防误点刷屏） */
  async autoOpenForPending(tenantId: number, userId: number | null) {
    const pending = await this.listPending(tenantId);
    const targets = pending.filter((p) => !p.hasDraft).slice(0, 50);
    const created: string[] = [];
    for (const t of targets) {
      const doc = await this.insertWithNo(tenantId, {
        tenantId, inspType: 'IQC', source: 'RECEIPT',
        warehouseId: t.warehouseId, materialId: t.materialId, skuCode: t.skuCode,
        batchNo: t.batchNo, qty: String(t.qty), sampleQty: '0', status: 'DRAFT',
        createdBy: userId ?? null,
      });
      created.push(doc.inspectionNo);
    }
    return { scanned: pending.length, created: created.length, numbers: created, skipped: pending.length - targets.length };
  }

  /** 保存检验项（覆盖式：一次提交整张单的项，避免逐行改乱序） */
  async saveItems(tenantId: number, id: number, items: InspectionItemPlain[]) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('检验单不存在');
    const guard = canEditInspection(doc.status);
    if (!guard.ok) throw new BadRequestException(guard.reason);
    const normalized = normalizeItems(items);
    if (!normalized.length) throw new BadRequestException('至少录入一个检验项');
    for (const it of normalized) {
      if (!['PASS', 'FAIL', 'NA'].includes(String(it.verdict))) {
        throw new BadRequestException(`第 ${it.seq} 项判定值非法：${it.verdict}`);
      }
    }
    await this.items.delete({ tenantId, inspectionId: Number(id) });
    await this.items.save(normalized.map((it) => this.items.create({
      tenantId, inspectionId: Number(id), seq: it.seq!, itemName: it.itemName,
      standard: it.standard ?? null, measured: it.measured ?? null,
      verdict: it.verdict, remark: it.remark ?? null,
    })));
    return this.detail(tenantId, Number(id));
  }

  /**
   * 判定（这张单的唯一出口）
   *   result=PASS → 批次 RELEASED（可出库）
   *   result=FAIL → 批次 REJECTED（隔离）
   * 判定时把「批次状态变更」交给 Gateway，本服务不碰 stock_batches 写。
   */
  async judge(
    tenantId: number, id: number,
    input: { result: 'PASS' | 'FAIL'; reviewer?: string; opinion?: string },
    userId: number | null,
  ) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('检验单不存在');
    if (doc.status !== 'DRAFT') throw new BadRequestException(`检验单已判定（${doc.status}），不能重复判定`);
    const rows = await this.items.find({ where: { tenantId, inspectionId: Number(id) }, order: { seq: 'ASC' } });
    const plain: InspectionItemPlain[] = rows.map((r) => ({
      seq: r.seq, itemName: r.itemName, standard: r.standard, measured: r.measured,
      verdict: r.verdict as any, remark: r.remark,
    }));
    const check = input.result === 'PASS' ? checkItemsForPass(plain) : checkItemsForFail(plain);
    if (!check.ok) throw new BadRequestException(check.reason);
    if (input.result === 'FAIL' && !String(input.opinion ?? '').trim()) {
      throw new BadRequestException('判定不合格必须写明结论意见（不合格事实与处置建议）');
    }

    doc.status = input.result;
    doc.reviewer = input.reviewer ?? null;
    doc.reviewedBy = userId ?? null;
    doc.reviewedAt = new Date();
    doc.opinion = input.opinion ?? null;
    if (!doc.inspectedAt) doc.inspectedAt = new Date();
    await this.docs.save(doc);

    /**
     * 检验合格 ≠ 放行（GMP 的关键分工）：
     *   · IQC / IPQC 合格 → 批次 RELEASED，物料可以投料/继续加工；
     *   · FQC / OQC（成品/出货检验）合格 → 批次仍是 PENDING（等 QA 签放行单），
     *     因为「未经放行不得上市销售」—— 检验只是放行的依据之一，签发权在 QA。
     *   · 任何不合格 → REJECTED（隔离）。
     */
    const resultStatus = input.result === 'FAIL'
      ? 'REJECTED'
      : (doc.inspType === 'FQC' || doc.inspType === 'OQC' ? 'PENDING' : 'RELEASED');
    await this.gate.setBatchQualityStatus({
      tenantId: doc.tenantId, skuId: doc.materialId, warehouseId: doc.warehouseId, batchNo: doc.batchNo,
      status: resultStatus as any,
      reason: input.result === 'PASS'
        ? (resultStatus === 'PENDING' ? `成品检验合格，待 QA 放行：${doc.inspectionNo}` : `检验合格：${doc.inspectionNo}`)
        : `检验不合格，隔离：${doc.inspectionNo}`,
      refType: 'QC_INSPECTION', refNo: doc.inspectionNo, operator: input.reviewer ?? 'qc',
    });
    await this.audit.write(tenantId, 'quality.inspection.judge', {
      id: doc.id, no: doc.inspectionNo, result: input.result,
    }, userId ?? undefined, 'qc_inspection', Number(doc.id));
    return this.detail(tenantId, Number(id));
  }

  async cancel(tenantId: number, id: number, reason: string, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('检验单不存在');
    if (doc.status !== 'DRAFT') throw new BadRequestException('只有待判定的检验单可以作废');
    if (!String(reason ?? '').trim()) throw new BadRequestException('作废必须写明原因');
    doc.status = 'CANCELLED';
    doc.opinion = String(reason).slice(0, 300);
    await this.docs.save(doc);
    await this.audit.write(tenantId, 'quality.inspection.cancel', { id: doc.id, reason }, userId ?? undefined, 'qc_inspection', Number(doc.id));
    return this.detail(tenantId, Number(id));
  }

  /** 概览：待判定 / 今日判定 / 不合格批次数（页面顶部卡片） */
  async summary(tenantId: number) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [waiting, decidedToday, failed] = await Promise.all([
      this.docs.count({ where: { tenantId, status: 'DRAFT' } }),
      this.docs.createQueryBuilder('d').where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.status IN (:...s)', { s: ['PASS', 'FAIL'] })
        .andWhere('d.reviewed_at >= :today', { today }).getCount(),
      this.docs.count({ where: { tenantId, status: 'FAIL' } }),
    ]);
    const pendingBatches = await this.batches.createQueryBuilder('sb')
      .where('sb.tenant_id = :tenantId', { tenantId })
      .andWhere(`sb.quality_status = 'PENDING'`).andWhere('sb.qty > 0').getCount();
    return { waiting, decidedToday, failed, pendingBatches };
  }

  private async insertWithNo(tenantId: number, patch: Partial<QcInspection>): Promise<QcInspection> {
    const d = new Date();
    const prefix = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cnt = await this.docs.createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.inspection_no LIKE :p', { p: `QC-${prefix}-%` })
        .getCount();
      const no = nextDocNo('QC', d, cnt + attempt);
      try {
        const entity = this.docs.create({ ...patch, inspectionNo: no } as QcInspection);
        return await this.docs.save(entity);
      } catch (e: any) {
        if (!String(e?.message ?? '').includes('ux_qc_insp_no')) throw e;
      }
    }
    throw new BadRequestException('检验单号生成冲突，请重试');
  }
}
