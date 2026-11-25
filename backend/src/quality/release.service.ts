// =============================================================================
// ReleaseService —— 成品放行（QA 电子签）
//
// 合规依据：GMP「未经放行不得上市销售」。落成系统动作就是两件事：
//   ① 成品入库的批次先置 PENDING（不可发）；
//   ② 只有签批后才置 RELEASED（发货时 getBatchQuality 一看就能挡）。
//
// 电子签的"签"是真人验证：签批必须再次输入当前账号密码（AuthService.verifyPassword），
// 只凭 JWT 证明不了"点按钮的是本人"——离开工位没锁屏就能被代签，飞检查签批记录会问这个。
// =============================================================================
import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QaRelease, QcInspection } from './entities/quality.entity';
import { Material, StockBatch, Warehouse } from '../inventory/inventory.entity';
import { User } from '../entities/tenant.entity';
import { InventoryGateway } from '../wms/gateways/inventory.gateway';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.module';
import { checkBeforeRelease, targetBatchStatus, checkOpinion, stalePending } from './release.calc';
import { nextDocNo } from './iqc.calc';

const REL_STATUS_TEXT: Record<string, string> = { PENDING: '待签批', RELEASED: '已放行', REJECTED: '已驳回', CANCELLED: '已作废' };

export interface SubmitReleaseInput {
  skuCode: string;
  warehouseId: number;
  batchNo: string;
  qty?: number;
  workOrderId?: number;
  inspectionId?: number;
  submitter?: string;
  remark?: string;
}

@Injectable()
export class ReleaseService {
  private readonly log = new Logger(ReleaseService.name);

  constructor(
    @InjectRepository(QaRelease) private docs: Repository<QaRelease>,
    @InjectRepository(QcInspection) private insp: Repository<QcInspection>,
    @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Warehouse) private warehouses: Repository<Warehouse>,
    @InjectRepository(StockBatch) private batches: Repository<StockBatch>,
    @InjectRepository(User) private users: Repository<User>,
    private gate: InventoryGateway,
    private auth: AuthService,
    private audit: AuditService,
  ) {}

  async list(tenantId: number, q: { status?: string; keyword?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const qb = this.docs.createQueryBuilder('d').where('d.tenant_id = :tenantId', { tenantId });
    if (q.status) qb.andWhere('d.status = :status', { status: q.status });
    if (q.keyword) qb.andWhere('(d.release_no ILIKE :kw OR d.batch_no ILIKE :kw OR d.sku_code ILIKE :kw)', { kw: `%${q.keyword}%` });
    const total = await qb.getCount();
    const rows = await qb.orderBy('d.id', 'DESC').offset((page - 1) * pageSize).limit(pageSize).getMany();
    const mats = await this.materials.find({ where: { tenantId } });
    const whs = await this.warehouses.find({ where: { tenantId } });
    const byMat = new Map(mats.map((m) => [Number(m.id), m]));
    const byWh = new Map(whs.map((w) => [Number(w.id), w]));
    return {
      items: rows.map((d) => ({
        id: Number(d.id), releaseNo: d.releaseNo, status: d.status,
        statusText: REL_STATUS_TEXT[d.status] ?? d.status,
        skuCode: d.skuCode, materialName: byMat.get(Number(d.materialId))?.name ?? d.skuCode,
        warehouse: byWh.get(Number(d.warehouseId))?.name ?? String(d.warehouseId),
        batchNo: d.batchNo, qty: Number(d.qty),
        submitter: d.submitter, submittedAt: d.submittedAt,
        reviewer: d.reviewer, reviewedAt: d.reviewedAt, createdAt: d.createdAt,
      })),
      total, page, pageSize,
    };
  }

  async detail(tenantId: number, id: number) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('放行单不存在');
    const mat = await this.materials.findOne({ where: { tenantId, id: Number(doc.materialId) } });
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(doc.warehouseId) } });
    const batch = await this.batches.findOne({
      where: { tenantId, materialId: Number(doc.materialId), warehouseId: Number(doc.warehouseId), batchNo: doc.batchNo },
    });
    const inspection = doc.inspectionId
      ? await this.insp.findOne({ where: { tenantId, id: Number(doc.inspectionId) } })
      : null;
    const readiness = checkBeforeRelease({
      releaseStatus: doc.status,
      batchStatus: String((batch as any)?.qualityStatus ?? 'PENDING'),
      qcRequired: !!(mat as any)?.qcRequired,
      inspectionStatus: doc.inspectionId ? (inspection?.status as any) : undefined,
    });
    return {
      id: Number(doc.id), releaseNo: doc.releaseNo, status: doc.status,
      statusText: REL_STATUS_TEXT[doc.status] ?? doc.status, source: doc.source,
      skuCode: doc.skuCode, materialName: mat?.name ?? doc.skuCode, unit: mat?.unit ?? '件',
      qcRequired: !!(mat as any)?.qcRequired,
      warehouseId: Number(doc.warehouseId), warehouse: wh?.name ?? String(doc.warehouseId),
      batchNo: doc.batchNo, qty: Number(doc.qty),
      batchQty: batch ? Number(batch.qty) : null,
      batchQualityStatus: (batch as any)?.qualityStatus ?? null,
      workOrderId: doc.workOrderId ? Number(doc.workOrderId) : null,
      inspectionId: doc.inspectionId ? Number(doc.inspectionId) : null,
      inspectionNo: inspection?.inspectionNo ?? null, inspectionStatus: inspection?.status ?? null,
      submitter: doc.submitter, submittedAt: doc.submittedAt,
      reviewer: doc.reviewer, reviewedAt: doc.reviewedAt, opinion: doc.opinion, remark: doc.remark,
      createdAt: doc.createdAt,
      canSign: readiness.ok, signBlockReason: readiness.reason,
    };
  }

  /** 提交放行申请：只建单，不动库存状态（真正的开关在签批） */
  async submit(tenantId: number, input: SubmitReleaseInput, userId: number | null) {
    const mat = await this.materials.findOne({ where: { tenantId, code: String(input.skuCode) } });
    if (!mat) throw new NotFoundException(`物料不存在：${input.skuCode}`);
    const wh = await this.warehouses.findOne({ where: { tenantId, id: Number(input.warehouseId) } });
    if (!wh) throw new NotFoundException(`仓库不存在：${input.warehouseId}`);
    const batch = await this.batches.findOne({
      where: { tenantId, materialId: Number(mat.id), warehouseId: Number(wh.id), batchNo: String(input.batchNo) },
    });
    if (!batch) throw new BadRequestException(`批次不存在：${input.batchNo}（仓库 ${wh.name}）`);
    const existing = await this.docs.findOne({
      where: { tenantId, materialId: Number(mat.id), warehouseId: Number(wh.id), batchNo: String(input.batchNo), status: 'PENDING' },
    });
    if (existing) throw new BadRequestException(`该批次已有待签批的放行单：${existing.releaseNo}`);

    // 关联检验单：显式传优先；否则找该批次最近一张 FQC/OQC 且结论 PASS 的单
    let inspectionId: number | null = input.inspectionId ? Number(input.inspectionId) : null;
    if (!inspectionId) {
      const latest = await this.insp.findOne({
        where: { tenantId, materialId: Number(mat.id), warehouseId: Number(wh.id), batchNo: String(input.batchNo), status: 'PASS' },
        order: { id: 'DESC' },
      });
      inspectionId = latest ? Number(latest.id) : null;
    }
    if (inspectionId) {
      const ins = await this.insp.findOne({ where: { tenantId, id: inspectionId } });
      if (!ins) throw new BadRequestException(`关联的检验单不存在：${input.inspectionId}`);
      if (ins.batchNo !== String(input.batchNo)) throw new BadRequestException('检验单的批次与放行单不一致');
    }

    const doc = await this.insertWithNo(tenantId, {
      tenantId, source: 'PRODUCTION',
      warehouseId: Number(wh.id), materialId: Number(mat.id), skuCode: mat.code,
      batchNo: String(input.batchNo), qty: String(input.qty ?? Number(batch.qty)),
      workOrderId: input.workOrderId ? Number(input.workOrderId) : null,
      inspectionId, status: 'PENDING',
      submitter: input.submitter ?? null, submittedBy: userId ?? null, submittedAt: new Date(),
      remark: input.remark ?? null,
    });
    await this.audit.write(tenantId, 'quality.release.submit', {
      id: doc.id, no: doc.releaseNo, batch: doc.batchNo,
    }, userId ?? undefined, 'qa_release', Number(doc.id));
    return this.detail(tenantId, Number(doc.id));
  }

  /**
   * 签批（电子签）：必须带当前账号密码。
   * decision=APPROVE → 批次 RELEASED；REJECT → REJECTED（隔离）
   */
  async sign(
    tenantId: number, id: number,
    input: { decision: 'APPROVE' | 'REJECT'; password: string; reviewer?: string; opinion?: string },
    userId: number | null, username?: string | null,
  ) {
    if (!userId) throw new UnauthorizedException('签批必须使用登录账号');
    const okPwd = await this.auth.verifyPassword(Number(userId), Number(tenantId), String(input.password ?? ''));
    if (!okPwd) throw new UnauthorizedException('签批密码错误（电子签必须验证本人）');
    const opin = checkOpinion(input.decision, input.opinion);
    if (!opin.ok) throw new BadRequestException(opin.reason);

    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('放行单不存在');
    const mat = await this.materials.findOne({ where: { tenantId, id: Number(doc.materialId) } });
    const batchStatus = await this.gate.getBatchQuality({
      tenantId, skuId: doc.materialId, warehouseId: doc.warehouseId, batchNo: doc.batchNo,
    });
    if (!batchStatus.exists) throw new BadRequestException(`批次 ${doc.batchNo} 已不存在，放行单无法签批`);
    const inspection = doc.inspectionId
      ? await this.insp.findOne({ where: { tenantId, id: Number(doc.inspectionId) } })
      : null;
    const ready = checkBeforeRelease({
      releaseStatus: doc.status,
      batchStatus: batchStatus.qualityStatus,
      qcRequired: !!(mat as any)?.qcRequired,
      inspectionStatus: doc.inspectionId ? (inspection?.status as any) : undefined,
    });
    if (!ready.ok) throw new BadRequestException(ready.reason);

    const target = targetBatchStatus(input.decision);
    doc.status = input.decision === 'APPROVE' ? 'RELEASED' : 'REJECTED';
    let reviewerName = input.reviewer ?? username ?? null;
    if (!reviewerName) {
      const u = await this.users.findOne({ where: { tenantId: Number(tenantId), id: Number(userId) } });
      reviewerName = (u as any)?.displayName || (u as any)?.username || `user-${userId}`;
    }
    doc.reviewer = reviewerName;
    doc.reviewedBy = Number(userId);
    doc.reviewedAt = new Date();
    doc.opinion = input.opinion ?? null;
    await this.docs.save(doc);

    await this.gate.setBatchQualityStatus({
      tenantId: doc.tenantId, skuId: doc.materialId, warehouseId: doc.warehouseId, batchNo: doc.batchNo,
      status: target,
      reason: `${input.decision === 'APPROVE' ? 'QA 放行' : 'QA 驳回'}：${doc.releaseNo}`,
      refType: 'QA_RELEASE', refNo: doc.releaseNo, operator: doc.reviewer ?? 'qa',
    });
    await this.audit.write(tenantId, 'quality.release.sign', {
      id: doc.id, no: doc.releaseNo, decision: input.decision, reviewer: doc.reviewer,
    }, Number(userId), 'qa_release', Number(doc.id));
    return this.detail(tenantId, Number(id));
  }

  async cancel(tenantId: number, id: number, reason: string, userId: number | null) {
    const doc = await this.docs.findOne({ where: { tenantId, id: Number(id) } });
    if (!doc) throw new NotFoundException('放行单不存在');
    if (doc.status !== 'PENDING') throw new BadRequestException('只有待签批的放行单可以作废');
    if (!String(reason ?? '').trim()) throw new BadRequestException('作废必须写明原因');
    doc.status = 'CANCELLED';
    doc.opinion = String(reason).slice(0, 300);
    await this.docs.save(doc);
    await this.audit.write(tenantId, 'quality.release.cancel', { id: doc.id, reason }, userId ?? undefined, 'qa_release', Number(doc.id));
    return this.detail(tenantId, Number(id));
  }

  /** 概览：待签批 / 已放行 / 驳回 + 超 3 天未签批（成品压库提醒） */
  async summary(tenantId: number) {
    const [pending, released, rejected] = await Promise.all([
      this.docs.count({ where: { tenantId, status: 'PENDING' } }),
      this.docs.count({ where: { tenantId, status: 'RELEASED' } }),
      this.docs.count({ where: { tenantId, status: 'REJECTED' } }),
    ]);
    const rows = await this.docs.find({ where: { tenantId, status: 'PENDING' } });
    const stale = stalePending(rows.map((r) => ({ submittedAt: r.submittedAt, status: r.status })), 3);
    return { pending, released, rejected, stalePending: stale.length };
  }

  private async insertWithNo(tenantId: number, patch: Partial<QaRelease>): Promise<QaRelease> {
    const d = new Date();
    const prefix = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cnt = await this.docs.createQueryBuilder('d')
        .where('d.tenant_id = :tenantId', { tenantId })
        .andWhere('d.release_no LIKE :p', { p: `RL-${prefix}-%` })
        .getCount();
      const no = nextDocNo('RL', d, cnt + attempt);
      try {
        return await this.docs.save(this.docs.create({ ...patch, releaseNo: no } as QaRelease));
      } catch (e: any) {
        if (!String(e?.message ?? '').includes('ux_qa_rel_no')) throw e;
      }
    }
    throw new BadRequestException('放行单号生成冲突，请重试');
  }
}
