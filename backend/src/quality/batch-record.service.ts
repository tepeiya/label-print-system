// =============================================================================
// BatchRecordService —— 批记录（GMP 飞检第一份材料的最小可用版）
//
// 为什么不是"生产报表"：批记录要回答四件事，缺一件就过不了审核——
//   ① 这一批是怎么做出来的：工序顺序、设备、操作人、时间；
//   ② 每道工序的工艺参数是多少：灭菌温度/时间、EO 浓度、解析时长…
//   ③ 每道工序结果如何：PASS/FAIL，FAIL 必须写事实；
//   ④ 这批货对应哪些码、哪些检验单（可追溯到个体）。
//
// 边界：本服务只管记录与审核，不做工艺参数校验、不控制设备（那是 MES 的活）。
//        工序步骤可以挂附件 URL（设备打印记录/现场照片），但系统不托管文件本体。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BatchRecord, BatchRecordStep, QcInspection } from './entities/quality.entity';
import { Material, Warehouse } from '../inventory/inventory.entity';
import { WmsWorkOrder } from '../wms/issuing/entities/wo.entity';
import { UdiUnit } from '../udi/entities/udi.entity';
import { AuditService } from '../audit/audit.module';
import { checkBeforeSubmit, checkBeforeApprove, nextSeq, summarizeSteps, type StepPlain } from './batch-record.calc';
import { nextDocNo } from './iqc.calc';

const BR_STATUS_TEXT: Record<string, string> = { OPEN: '记录中', SUBMITTED: '已提交', APPROVED: '已批准', REJECTED: '已退回' };

export interface RecordInput {
  workOrderId?: number;
  skuCode?: string;
  warehouseId?: number;
  batchNo: string;
  qtyPlanned?: number;
  remark?: string;
}

export interface StepInput {
  seq?: number;
  stepName: string;
  equipment?: string;
  operator?: string;
  startedAt?: string;
  endedAt?: string;
  params?: Record<string, any>;
  result?: 'PASS' | 'FAIL' | 'NA';
  remark?: string;
  attachmentUrl?: string;
}

@Injectable()
export class BatchRecordService {
  private readonly log = new Logger(BatchRecordService.name);

  constructor(
    @InjectRepository(BatchRecord) private docs: Repository<BatchRecord>,
    @InjectRepository(BatchRecordStep) private steps: Repository<BatchRecordStep>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(WmsWorkOrder) private wos: Repository<WmsWorkOrder>,
    @InjectRepository(UdiUnit) private units: Repository<UdiUnit>,
    @InjectRepository(QcInspection) private insp: Repository<QcInspection>,
    private audit: AuditService,
  ) {}

  async list(tenantId: number, q: { status?: string; keyword?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.docs.createQueryBuilder('d').where('d.tenant_id = :tenantId', { tenantId });
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.keyword) qb.andWhere('(d.record_no ILIKE :kw OR d.batch_no ILIKE :kw OR d.sku_code ILIKE :kw)', { kw: `%${q.keyword}%` });
    const total = await qb.getCount();
    const rows = await qb.orderBy('d.id', 'DESC').offset((page - 1) * pageSize).limit(pageSize).getMany();
    const ids = rows.map((r) => Number(r.id));
    const stepRows = ids.length
      ? await this.steps.find({ where: { tenantId, recordId: In(ids) }, order: { seq: 'ASC' } })
      : [];
    return {
      items: rows.map((r) => {
        const mine = stepRows.filter((s) => Number(s.recordId) === Number(r.id));
        const sum = summarizeSteps(mine.map(toPlain));
        return {
          id: Number(r.id), recordNo: r.recordNo, status: r.status,
          statusText: BR_STATUS_TEXT[r.status] ?? r.status,
          skuCode: r.skuCode, productName: r.productName, batchNo: r.batchNo,
          woNo: r.woNo, qtyPlanned: Number(r.qtyPlanned), qtyActual: r.qtyActual ? Number(r.qtyActual) : null,
          stepCount: sum.total, failSteps: sum.fail,
          openedAt: r.openedAt, submittedAt: r.submittedAt, approvedAt: r.approvedAt, createdAt: r.createdAt,
        };
      }),
      total, page, pageSize,
    };
  }

  async detail(tenantId: number, id: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('批记录不存在');
    const rows = await this.steps.find({ where: { tenantId, recordId: Number(id) }, order: { seq: 'ASC' } });
    const sum = summarizeSteps(rows.map(toPlain));
    // 关联证据：这批货打了多少码、有几张检验单（只读聚合，不做写）
    const [udiCount, udiPrinted, inspections] = await Promise.all([
      this.units.count({ where: { tenantId, lot: doc.batchNo } }),
      this.units.createQueryBuilder('u')
        .where('u.tenant_id = :tenantId', { tenantId }).andWhere('u.lot = :lot', { lot: doc.batchNo })
        .andWhere(`u.status <> 'REGISTERED'`).getCount(),
      this.insp.find({ where: { tenantId, materialId: Number(doc.materialId), batchNo: doc.batchNo } }),
    ]);
    return {
      id: Number(doc.id), recordNo: doc.recordNo, status: doc.status,
      statusText: BR_STATUS_TEXT[doc.status] ?? doc.status,
      workOrderId: doc.workOrderId ? Number(doc.workOrderId) : null, woNo: doc.woNo,
      skuCode: doc.skuCode, productName: doc.productName, batchNo: doc.batchNo,
      qtyPlanned: Number(doc.qtyPlanned), qtyActual: doc.qtyActual ? Number(doc.qtyActual) : null,
      openedAt: doc.openedAt, submittedAt: doc.submittedAt, approvedAt: doc.approvedAt,
      approvalOpinion: doc.approvalOpinion, remark: doc.remark, createdAt: doc.createdAt,
      steps: rows.map((s) => ({
        id: Number(s.id), seq: s.seq, stepName: s.stepName, equipment: s.equipment, operator: s.operator,
        startedAt: s.startedAt, endedAt: s.endedAt, params: s.params ?? {},
        result: s.result, remark: s.remark, attachmentUrl: s.attachmentUrl,
      })),
      summary: sum,
      evidence: {
        udiUnits: udiCount, udiPrinted, inspectionCount: inspections.length,
        inspectionNos: inspections.map((i) => i.inspectionNo), inspectionStatus: inspections.map((i) => i.status),
      },
      canSubmit: doc.status === 'OPEN' ? checkBeforeSubmit(rows.map(toPlain)).ok : false,
      submitBlockReason: doc.status === 'OPEN' ? checkBeforeSubmit(rows.map(toPlain)).reason : '当前状态不允许提交',
    };
  }

  async create(tenantId: number, input: RecordInput, userId: number | null) {
    let skuCode = input.skuCode;
    let materialId: number | null = null;
    let productName: string | null = null;
    let qtyPlanned = Number(input.qtyPlanned ?? 0);
    let woNo: string | null = null;
    if (input.workOrderId) {
      const wo = await this.wos.findOne({ where: { tenantId, id: Number(input.workOrderId) } });
      if (!wo) throw new NotFoundException(`工单不存在：${input.workOrderId}`);
      const pm = await this.materials.findOne({ where: { tenantId, id: Number(wo.productMaterialId) } });
      skuCode = skuCode || pm?.code || '';
      materialId = Number(wo.productMaterialId);
      productName = pm?.name ?? null;
      if (!qtyPlanned) qtyPlanned = Number(wo.demandQty);
      woNo = wo.woNo;
    }
    if (!skuCode) throw new BadRequestException('需要提供工单或产品编码');
    if (!materialId) {
      const m = await this.materials.findOne({ where: { tenantId, code: String(skuCode) } });
      if (!m) throw new NotFoundException(`物料不存在：${skuCode}`);
      materialId = Number(m.id);
      productName = m.name;
    }
    const batchNo = String(input.batchNo ?? '').trim();
    if (!batchNo) throw new BadRequestException('批次号必填（批记录按批次归档）');
    const dup = await this.docs.findOne({ where: { tenantId, materialId, batchNo } });
    if (dup) throw new BadRequestException(`该批次已有批记录：${dup.recordNo}`);

    const doc = await this.insertWithNo(tenantId, {
      tenantId, workOrderId: input.workOrderId ?? null, woNo,
      materialId, skuCode, productName, batchNo,
      qtyPlanned: String(qtyPlanned), status: 'OPEN',
      openedBy: userId ?? null, openedAt: new Date(), remark: input.remark ?? null,
    });
    await this.audit.write(tenantId, 'quality.batch_record.create', {
      id: doc.id, no: doc.recordNo, batch: batchNo,
    }, userId ?? undefined, 'batch_record', Number(doc.id));
    return this.detail(tenantId, Number(doc.id));
  }

  async addStep(tenantId: number, id: number, input: StepInput) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('批记录不存在');
    if (doc.status !== 'OPEN') throw new BadRequestException(`批记录状态为 ${BR_STATUS_TEXT[doc.status] ?? doc.status}，不能新增工序（退回后可改）`);
    if (!String(input.stepName ?? '').trim()) throw new BadRequestException('工序名称必填');
    const rows = await this.steps.find({ where: { tenantId, recordId: Number(id) } });
    const seq = input.seq ?? nextSeq(rows);
    const dupSeq = rows.find((r) => Number(r.seq) === Number(seq));
    if (dupSeq) throw new BadRequestException(`工序号 ${seq} 已存在`);
    const st = input.startedAt ? new Date(input.startedAt) : null;
    const en = input.endedAt ? new Date(input.endedAt) : null;
    if (st && en && en.getTime() < st.getTime()) throw new BadRequestException('结束时间不能早于开始时间');
    await this.steps.save(this.steps.create({
      tenantId, recordId: Number(id), seq: Number(seq), stepName: String(input.stepName).trim(),
      equipment: input.equipment ?? null, operator: input.operator ?? null,
      startedAt: st, endedAt: en, params: input.params ?? {},
      result: input.result ?? 'PASS', remark: input.remark ?? null, attachmentUrl: input.attachmentUrl ?? null,
    }));
    return this.detail(tenantId, Number(id));
  }

  async updateStep(tenantId: number, id: number, stepId: number, input: Partial<StepInput>) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('批记录不存在');
    if (doc.status !== 'OPEN') throw new BadRequestException('只有记录中的批记录可以修改工序');
    const step = await this.steps.findOne({ where: { tenantId, recordId: Number(id), id: Number(stepId) } });
    if (!step) throw new NotFoundException('工序不存在');
    const patch: Partial<BatchRecordStep> = {};
    if (input.stepName !== undefined) patch.stepName = String(input.stepName).trim();
    if (input.equipment !== undefined) patch.equipment = input.equipment || null;
    if (input.operator !== undefined) patch.operator = input.operator || null;
    if (input.params !== undefined) patch.params = input.params ?? {};
    if (input.result !== undefined) patch.result = input.result;
    if (input.remark !== undefined) patch.remark = input.remark || null;
    if (input.attachmentUrl !== undefined) patch.attachmentUrl = input.attachmentUrl || null;
    if (input.startedAt !== undefined) patch.startedAt = input.startedAt ? new Date(input.startedAt) : null;
    if (input.endedAt !== undefined) patch.endedAt = input.endedAt ? new Date(input.endedAt) : null;
    const st = patch.startedAt ?? step.startedAt;
    const en = patch.endedAt ?? step.endedAt;
    if (st && en && new Date(en).getTime() < new Date(st).getTime()) throw new BadRequestException('结束时间不能早于开始时间');
    Object.assign(step, patch);
    await this.steps.save(step);
    return this.detail(tenantId, Number(id));
  }

  async deleteStep(tenantId: number, id: number, stepId: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('批记录不存在');
    if (doc.status !== 'OPEN') throw new BadRequestException('只有记录中的批记录可以删除工序');
    await this.steps.delete({ tenantId, recordId: Number(id), id: Number(stepId) });
    return this.detail(tenantId, Number(id));
  }

  async submit(tenantId: number, id: number, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('批记录不存在');
    if (doc.status !== 'OPEN' && doc.status !== 'REJECTED') {
      throw new BadRequestException(`批记录状态为 ${BR_STATUS_TEXT[doc.status] ?? doc.status}，不能提交`);
    }
    const rows = await this.steps.find({ where: { tenantId, recordId: Number(id) }, order: { seq: 'ASC' } });
    const check = checkBeforeSubmit(rows.map(toPlain));
    if (!check.ok) throw new BadRequestException(check.reason);
    doc.status = 'SUBMITTED';
    doc.submittedBy = userId ?? null;
    doc.submittedAt = new Date();
    await this.docs.save(doc);
    await this.audit.write(tenantId, 'quality.batch_record.submit', {
      id: doc.id, no: doc.recordNo, steps: rows.length,
    }, userId ?? undefined, 'batch_record', Number(doc.id));
    return { ...(await this.detail(tenantId, Number(id))), warnings: check.warnings };
  }

  async approve(tenantId: number, id: number, input: { decision: 'APPROVE' | 'REJECT'; opinion?: string }, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('批记录不存在');
    const guard = checkBeforeApprove(doc.status);
    if (!guard.ok) throw new BadRequestException(guard.reason);
    if (input.decision === 'REJECT' && !String(input.opinion ?? '').trim()) {
      throw new BadRequestException('退回必须写明原因');
    }
    doc.status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    doc.approvedBy = userId ?? null;
    doc.approvedAt = new Date();
    doc.approvalOpinion = input.opinion ?? null;
    await this.docs.save(doc);
    await this.audit.write(tenantId, 'quality.batch_record.approve', {
      id: doc.id, no: doc.recordNo, decision: input.decision,
    }, userId ?? undefined, 'batch_record', Number(doc.id));
    return this.detail(tenantId, Number(id));
  }

  async summary(tenantId: number) {
    const [open, submitted, approved] = await Promise.all([
      this.docs.count({ where: { tenantId, status: 'OPEN' } }),
      this.docs.count({ where: { tenantId, status: 'SUBMITTED' } }),
      this.docs.count({ where: { tenantId, status: 'APPROVED' } }),
    ]);
    return { open, submitted, approved };
  }

  private async insertWithNo(tenantId: number, patch: Partial<BatchRecord>): Promise<BatchRecord> {
    const d = new Date();
    const prefix = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cnt = await this.docs.createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.record_no LIKE :p', { p: `BR-${prefix}-%` })
        .getCount();
      const no = nextDocNo('BR', d, cnt + attempt);
      try {
        return await this.docs.save(this.docs.create({ ...patch, recordNo: no } as BatchRecord));
      } catch (e: any) {
        if (!String(e?.message ?? '').includes('ux_br_no')) throw e;
      }
    }
    throw new BadRequestException('批记录号生成冲突，请重试');
  }
}

function toPlain(s: BatchRecordStep): StepPlain {
  return {
    seq: Number(s.seq), stepName: s.stepName, equipment: s.equipment, operator: s.operator,
    startedAt: s.startedAt, endedAt: s.endedAt, params: s.params ?? {}, result: s.result as any,
    remark: s.remark,
  };
}

/** 局部导入 In 的替代（避免顶层 import 名字冲突） */
function InIds(ids: number[]): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { In } = require('typeorm');
  return In(ids);
}
