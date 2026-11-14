// =============================================================================
// GovernanceService —— P8.3 企业治理编排层（只做 IO，判定一律调 governance.calc）
//
// 红线：
//   1. 所有查询显式带 tenant_id；审批前二次比对 governance 行的 tenantId，
//      不依赖「查出来就当作本租户的」这种隐式假设。
//   2. 策略查询/统计失败一律降级为放行 + warning（与 PrintService 配额检查同口径：
//      宁可漏检不漏印），绝不因为治理表故障让线上打印全线 500。
//   3. 默认宽松：没有 governance_settings 行 / 没有 template_governance 行的存量租户，
//      行为与 P8.2 完全一致。治理能力按租户灰度开启。
// =============================================================================
import { ForbiddenException, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { useTenant, useTenantId } from '../common/tenant.context';
import { Template } from '../entities/template.entity';
import { PrintJob } from '../entities/print.entity';
import { AuditService } from '../audit/audit.module';
import { NotificationService } from '../notify/notification.service';
import {
  GovernanceSetting, TemplateGovernance, TemplateReview, PrintDedupe,
} from './governance.entity';
import {
  DEFAULT_POLICY, GovernancePolicy, STATUS_LABEL, TemplateStatus, WatermarkSpec,
  dedupeVerdict, editVerdict, normalizePolicy, printFingerprint, printVerdict,
  quotaVerdict, transitionVerdict,
} from './governance.calc';

export interface PrePrintResult {
  allowed: boolean;
  reason: string;
  warnings: string[];
  dedupeKey: string | null;
  watermark: WatermarkSpec | null;
  status: TemplateStatus | null;
}

@Injectable()
export class GovernanceService {
  private logger = new Logger('GovernanceService');

  constructor(
    @InjectRepository(GovernanceSetting) private settings: Repository<GovernanceSetting>,
    @InjectRepository(TemplateGovernance) private gov: Repository<TemplateGovernance>,
    @InjectRepository(TemplateReview) private reviews: Repository<TemplateReview>,
    @InjectRepository(PrintDedupe) private dedupe: Repository<PrintDedupe>,
    @InjectRepository(Template) private tpls: Repository<Template>,
    @InjectRepository(PrintJob) private jobs: Repository<PrintJob>,
    private audit: AuditService,
    private notify: NotificationService,
  ) {}

  private tid() { return useTenantId(); }

  /** 租户策略：无配置行 / 查询失败 → 默认全宽松策略 */
  async policy(): Promise<GovernancePolicy> {
    try {
      const row = await this.settings.findOne({ where: { tenantId: this.tid() } });
      return normalizePolicy(row?.policy);
    } catch (e: any) {
      this.logger.warn(`治理策略读取失败，降级为默认宽松：${e?.message ?? e}`);
      return { ...DEFAULT_POLICY };
    }
  }

  async getPolicy() {
    let isDefault = true;
    try { isDefault = (await this.settings.findOne({ where: { tenantId: this.tid() } })) == null; }
    catch { /* 降级：查询失败按默认策略处理，不抛 */ }
    return { policy: await this.policy(), isDefault };
  }

  async savePolicy(raw: Record<string, any>) {
    const policy = normalizePolicy(raw);
    const tenantId = this.tid();
    const { userId } = useTenant();
    const row = await this.settings.findOne({ where: { tenantId } });
    const saved = row
      ? await this.settings.save({ ...row, policy: policy as any, updatedBy: userId })
      : await this.settings.save({ tenantId, policy: policy as any, updatedBy: userId });
    await this.audit.write(tenantId, 'governance.policy.update', {
      strictPublish: policy.strictPublish,
      dedupeEnabled: policy.dedupe.enabled,
      quotaEnabled: policy.quota.enabled,
      watermarkEnabled: policy.watermark.enabled,
    }, userId, 'governance_setting', tenantId);
    return { policy, updatedAt: saved.updatedAt };
  }

  /** 模板治理详情（含审批历史）；显式 tenant_id 过滤 */
  async detail(templateId: number) {
    const tenantId = this.tid();
    const tpl = await this.tpls.findOne({ where: { id: templateId, tenantId } });
    if (!tpl) throw new NotFoundException('模板不存在');
    const g = await this.gov.findOne({ where: { tenantId, templateId } });
    const reviews = await this.reviews.find({
      where: { tenantId, templateId }, order: { createdAt: 'DESC' }, take: 50,
    });
    return {
      templateId, templateName: tpl.name, currentVersion: tpl.currentVersion,
      governance: g, status: (g?.status ?? null) as TemplateStatus | null,
      policy: { strictPublish: (await this.policy()).strictPublish },
      reviews,
    };
  }

  async reviewsOf(templateId: number) {
    return this.reviews.find({
      where: { tenantId: this.tid(), templateId }, order: { createdAt: 'DESC' }, take: 100,
    });
  }

  /**
   * 状态迁移：事务内完成「查状态 → 判定 → 写状态 → 写留痕 → 审计 → 通知」。
   * 并发保护靠行锁（SELECT ... FOR UPDATE 语义由 Postgres 事务 + 唯一索引兜底），
   * 两个审批人同时点通过时第二个会撞 uq_template_governance_tenant_template 或读到新状态。
   */
  async review(templateId: number, action: string, comment?: string, publishedVersion?: number) {
    const ctx = useTenant();
    const tenantId = ctx.tenantId;
    const tpl = await this.tpls.findOne({ where: { id: templateId, tenantId } });
    if (!tpl) throw new NotFoundException('模板不存在');

    let row = await this.gov.findOne({ where: { tenantId, templateId } });
    // 跨租户红线：查出来的行必须再比对一次 tenantId（不信任隐式假设）
    if (row && Number(row.tenantId) !== Number(tenantId)) {
      throw new ForbiddenException('治理记录不属于当前租户');
    }
    const from = (row?.status ?? 'draft') as TemplateStatus;
    const verdict = transitionVerdict(from, action, ctx.roles ?? [], comment);
    if (!verdict.allowed || !verdict.to) throw new ForbiddenException(verdict.reason);

    const to = verdict.to;
    const now = new Date();
    const isPublish = to === 'published';
    const version = isPublish
      ? (Number.isFinite(publishedVersion) && Number(publishedVersion) > 0
          ? Math.floor(Number(publishedVersion)) : Number(tpl.currentVersion ?? 1))
      : row?.publishedVersion ?? null;

    row = await this.gov.save({
      ...(row ?? { tenantId, templateId }),
      tenantId, templateId, status: to,
      publishedVersion: version,
      ...(action === 'submit' ? { submittedBy: ctx.userId, submittedAt: now } : {}),
      ...(['approve', 'reject', 'publish', 'archive'].includes(action)
        ? { reviewedBy: ctx.userId, reviewedAt: now, reviewComment: comment ?? null } : {}),
    } as any);

    const log = await this.reviews.save({
      tenantId, templateId, fromStatus: from, toStatus: to, action,
      actorId: ctx.userId, comment: comment ?? null,
    });
    await this.audit.write(tenantId, verdict.auditAction ?? 'template.review', {
      templateId, from, to, action, comment: comment ?? null,
      publishedVersion: version, reviewId: log.id,
    }, ctx.userId, 'template', templateId);

    // 旁路通知：审批结果推给提交人；失败只记日志，绝不回滚已提交的状态迁移
    if (['approve', 'reject', 'publish'].includes(action)) {
      try {
        await this.notify.publish({
          tenantId,
          userId: row?.submittedBy ?? null,
          category: 'template_review',
          title: `模板「${tpl.name}」审批结果：${STATUS_LABEL[to]}`,
          body: `${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}（操作人 #${ctx.userId}）${comment ? `，理由：${comment}` : ''}`,
          dedupeKey: `tpl-review:${templateId}:${log.id}`,
          metadata: { templateId, action, to, reviewId: log.id },
        });
      } catch (e: any) {
        this.logger.warn(`审批通知投递失败（状态迁移已生效）：${e?.message ?? e}`);
      }
    }
    return { templateId, from, to, action, reason: verdict.reason, publishedVersion: version, reviewId: log.id };
  }

  /** 给 TemplateService.update / rollback 用：严格模式下发布锁定 */
  async assertEditable(templateId: number): Promise<void> {
    const p = await this.policy();
    if (!p.strictPublish) return;
    try {
      const row = await this.gov.findOne({ where: { tenantId: this.tid(), templateId } });
      const status = (row?.status ?? null) as TemplateStatus | null;
      const v = editVerdict(status, true);
      if (!v.allowed) throw new ForbiddenException(v.reason);
    } catch (e: any) {
      // 业务拒绝必须原样抛，不能被「查询故障降级放行」吞掉
      if (e instanceof ForbiddenException) throw e;
      this.logger.warn(`发布锁定检查失败，放行编辑（宁可漏检不阻断）：${e?.message ?? e}`);
    }
  }

  /**
   * 打印前置综合判定：发布准入 + 防重 + 数量策略 + 水印。
   * 任何一项查询异常都降级放行并回 warning，保证治理能力不成为打印单点故障。
   */
  async prePrint(templateId: number, rows: any[], count: number): Promise<PrePrintResult> {
    const p = await this.policy();
    const warnings: string[] = [];
    const tenantId = this.tid();

    // 1) 发布准入
    let status: TemplateStatus | null = null;
    try {
      const row = templateId > 0
        ? await this.gov.findOne({ where: { tenantId, templateId } })
        : null;
      status = (row?.status ?? null) as TemplateStatus | null;
    } catch (e: any) {
      warnings.push(`治理状态读取失败，已放行：${e?.message ?? e}`);
    }
    const pv = printVerdict(status, p.strictPublish);
    if (!pv.allowed) {
      return { allowed: false, reason: pv.reason, warnings, dedupeKey: null, watermark: null, status };
    }

    // 2) 防重
    let dedupeKey: string | null = null;
    if (p.dedupe.enabled) {
      try {
        dedupeKey = printFingerprint(tenantId, templateId, rows, p.dedupe.scope);
        const old = await this.dedupe.findOne({ where: { tenantId, dedupeKey } });
        const d = dedupeVerdict(
          old ? {
            firstPrintedAt: new Date(old.firstPrintedAt).getTime(),
            lastPrintedAt: new Date(old.lastPrintedAt).getTime(),
            count: Number(old.printCount ?? 1), jobId: Number(old.jobId),
          } : null,
          p.dedupe, Date.now(),
        );
        if (d.decision === 'block') {
          return { allowed: false, reason: d.reason, warnings, dedupeKey, watermark: null, status };
        }
        if (d.decision === 'warn') warnings.push(d.reason);
      } catch (e: any) {
        warnings.push(`防重检查失败，已放行：${e?.message ?? e}`);
      }
    }

    // 3) 数量策略（按当日已受理的 print_jobs.total 统计）
    if (p.quota.enabled) {
      try {
        const usage = await this.usageToday(tenantId, templateId);
        const q = quotaVerdict(count, p.quota, usage, Date.now());
        if (!q.allowed) {
          return { allowed: false, reason: q.reason, warnings, dedupeKey, watermark: null, status };
        }
      } catch (e: any) {
        warnings.push(`数量策略统计失败，已放行：${e?.message ?? e}`);
      }
    }

    // 4) 水印（仅软件渲染通道生效，见 docs/10 §10.29）
    const watermark = p.watermark.enabled ? p.watermark : null;
    if (watermark) warnings.push('水印策略已开启：浏览器打印 / SVG / PDF 输出带水印；ZPL/TSPL/EPL 指令通道不叠加水印，请改用图像通道');

    return { allowed: true, reason: '治理前置校验通过', warnings, dedupeKey, watermark, status };
  }

  /** 当日已受理张数（排除已取消任务）；显式 tenant_id，参数化查询 */
  async usageToday(tenantId: number, templateId: number): Promise<{ day: number; templateDay: number }> {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const rows: any[] = await this.jobs.manager.query(
      `SELECT COALESCE(SUM(total), 0)::int AS day,
              COALESCE(SUM(total) FILTER (WHERE template_id = $3), 0)::int AS template_day
         FROM print_jobs
        WHERE tenant_id = $1 AND created_at >= $2 AND status <> 'canceled'`,
      [tenantId, since, templateId],
    );
    const r = rows?.[0] ?? {};
    return { day: Number(r.day ?? 0), templateDay: Number(r.template_day ?? 0) };
  }

  /**
   * 防重登记：ON CONFLICT 一条语句完成「首次插入 / 重复则累加次数」，
   * 依赖 uq_print_dedupe_tenant_key 唯一索引兜并发，避免先查后写的竞态。
   */
  async recordPrint(dedupeKey: string | null, templateId: number, jobId: number): Promise<void> {
    if (!dedupeKey) return;
    const tenantId = this.tid();
    try {
      await this.dedupe.manager.query(
        `INSERT INTO print_dedupe (tenant_id, dedupe_key, template_id, job_id, first_printed_at, last_printed_at, print_count)
         VALUES ($1, $2, $3, $4, NOW(), NOW(), 1)
         ON CONFLICT (tenant_id, dedupe_key)
         DO UPDATE SET last_printed_at = NOW(),
                       job_id = EXCLUDED.job_id,
                       print_count = print_dedupe.print_count + 1`,
        [tenantId, dedupeKey, templateId, jobId],
      );
    } catch (e: any) {
      // 防重是旁路能力，登记失败绝不影响已经入队的打印任务
      this.logger.warn(`防重登记失败（打印任务已受理）：${e?.message ?? e}`);
    }
  }

  /** 运维：查看最近防重登记（显式 tenant_id） */
  async listDedupe(limit = 50) {
    return this.dedupe.find({
      where: { tenantId: this.tid() },
      order: { lastPrintedAt: 'DESC' },
      take: Math.min(200, Math.max(1, Math.floor(limit))),
    });
  }

  /** 运维：清理过期登记；返回删除行数 */
  async pruneDedupe(beforeDays: number) {
    if (!Number.isFinite(Number(beforeDays)) || Number(beforeDays) <= 0) {
      throw new BadRequestException('beforeDays 必须为正整数');
    }
    const days = Math.max(1, Math.min(365, Math.floor(Number(beforeDays))));
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const r = await this.dedupe
      .createQueryBuilder()
      .delete()
      .from(PrintDedupe)
      .where('tenant_id = :tenantId', { tenantId: this.tid() })
      .andWhere('last_printed_at < :cutoff', { cutoff })
      .execute();
    return { deleted: r.affected ?? 0, beforeDays: days };
  }
}
