// 打印服务：编排模板+数据+流水号，入 BullMQ 队列（异步、不阻塞）
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { PrintJob, PrintLog, Printer } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { useTenant, useTenantId } from '../common/tenant.context';
import { SerialModuleService } from '../serial/serial.service';
import { AuditService } from '../audit/audit.module';
import { UsageService } from '../billing/usage.service';
import { QuotaExceededException } from '../common/business.errors';
import { buildPrintFields, describePrintFormErrors, mergeFormValues, validateFormValues, validateRows } from './print-form.calc';
import { analyzeDotFit, summarizeDotFit } from '../../core/dot-fit';
// P8.3：治理前置校验（默认宽松，存量租户零行为变化）
import { GovernanceService } from '../governance/governance.service';

@Injectable()
export class PrintService {
  private logger = new Logger('PrintService');
  constructor(
    @InjectQueue('print') private queue: Queue,
    @InjectRepository(PrintJob) private jobs: Repository<PrintJob>,
    @InjectRepository(PrintLog) private logRepo: Repository<PrintLog>,
    @InjectRepository(Template) private tpls: Repository<Template>,
    @InjectRepository(Printer) private printers: Repository<Printer>,
    private serial: SerialModuleService,
    private audit: AuditService,
    private usage: UsageService,
    private governance: GovernanceService,
  ) {}

  /** 任务列表（打印队列页） */
  list(q: { status?: string; page?: number; pageSize?: number } = {}) {
    const where: any = { tenantId: useTenantId() };
    if (q.status) where.status = q.status;
    return this.jobs.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 20),
      take: Math.min(100, q.pageSize ?? 20),
    });
  }

  /** 批量统计仪表盘：按状态 / 打印机 / 时间窗口聚合 */
  async stats(q: { days?: number } = {}) {
    const tenantId = useTenantId();
    const days = Math.max(1, Math.min(90, q.days ?? 7));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const rows = await this.jobs.find({
      where: { tenantId, createdAt: since },
      order: { createdAt: 'DESC' },
      take: 1000,
    });

    const total = rows.length;
    const byStatus: Record<string, number> = {};
    const byPrinter: Record<number, { total: number; done: number; failed: number }> = {};
    const durations: number[] = [];
    const byDay: Record<string, number> = {};

    for (const j of rows) {
      byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
      if (j.printerId) {
        const p = byPrinter[j.printerId] ?? { total: 0, done: 0, failed: 0 };
        p.total++;
        if (j.status === 'done') p.done++;
        if (j.status === 'failed') p.failed++;
        byPrinter[j.printerId] = p;
      }
      if (j.status === 'done' && j.finishedAt) {
        const d = j.finishedAt.getTime() - j.createdAt.getTime();
        if (d >= 0 && d < 24 * 3600 * 1000) durations.push(d);
      }
      const day = j.createdAt.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    const success = byStatus.done ?? 0;
    const failed = byStatus.failed ?? 0;
    const canceled = byStatus.canceled ?? 0;
    const queued = byStatus.queued ?? 0;
    const running = byStatus.running ?? 0;

    const avgDurationMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const p50 = durations.length ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] : 0;
    const successRate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0;

    return {
      windowDays: days,
      since,
      total,
      byStatus,
      counts: { success, failed, canceled, queued, running },
      successRate,
      avgDurationMs,
      p50DurationMs: p50,
      byPrinter,
      byDay,
      printers: await this._resolvePrinterNames(Object.keys(byPrinter).map(Number), tenantId),
    };
  }

  private async _resolvePrinterNames(ids: number[], _tenantId: number): Promise<Record<number, string>> {
    if (!ids.length) return {};
    const list = await this.printers.findByIds(ids);
    const out: Record<number, string> = {};
    for (const p of list) out[p.id] = p.name;
    return out;
  }

  /** 创建批量打印任务：预分配流水号段 → 入队 → 立即返回 */
  /**
   * @param requirePrinter P9：WMS 自动打印等"必须落到物理打印机"的场景传 true。
   *   无 printerId 时不投队列、直接落一条 skipped_no_printer 任务（避免静默 success 让人以为已出纸）。
   */
  async createJob(dto: {
    templateId?: number; printerId?: number; rows?: any[]; copies?: number; params?: any;
    templateContent?: any; serialMap?: Record<string, string[]>; requirePrinter?: boolean;
    formValues?: Record<string, any>;
  }) {
    const tenantId = useTenantId();
    const tpl = dto.templateContent
      ? { id: dto.templateId ?? 0, content: dto.templateContent }
      : await this.tpls.findOne({ where: { id: dto.templateId, tenantId } });
    if (!tpl) throw new NotFoundException('模板不存在');

    // 打印时表单：字段来自模板 variables 的 atPrint 标记。必填缺失/格式不符在这里就拦，
    // 不能等渲染出来打成空标签——那一张纸已经废了。
    const formFields = buildPrintFields((tpl.content as any)?.variables ?? []);
    const formValues = dto.formValues && typeof dto.formValues === 'object' ? dto.formValues : undefined;
    // 先校验操作员当场填的值（填了但格式不对当场报），再看"最终每一行"是否齐全：
    // 打印页/ pack-print / WMS 自动打印三个入口共用同一份字段定义，谁都不许打出空变量的标签。
    if (formValues) {
      const v = validateFormValues(formFields, formValues);
      if (!v.ok) {
        throw new BadRequestException({
          message: `打印时填写的数据不合规：${describePrintFormErrors(v.errors)}`,
          fields: v.errors,
        });
      }
    }

    const baseRows: any[] = Array.isArray(dto.rows) && dto.rows.length ? dto.rows : [{}];
    // 表单值优先并入每一行（同一批标签共用同一批表单值）
    const rows: any[] = (formFields.length || formValues)
      ? baseRows.map((r) => mergeFormValues(r ?? {}, formValues, formFields))
      : baseRows;

    if (formFields.length) {
      const vr = validateRows(formFields, rows);
      if (!vr.ok) {
        throw new BadRequestException({
          message: `标签必填字段缺失或不合法：${describePrintFormErrors(vr.errors)}`,
          fields: vr.errors,
        });
      }
    }
    const copies = Math.max(1, Math.min(500, dto.copies ?? 1));
    const count = rows.length * copies;

    // P3 计费：hard_limit 超限直接拒绝（4033 带升级引导）；配额查询故障不阻断打印（宁可漏检不漏印）
    let quotaWarn = false;
    try {
      quotaWarn = (await this.usage.assertQuota(tenantId, 'print_labels', count)).warn;
    } catch (e: any) {
      if (e instanceof QuotaExceededException) throw e;
      this.logger.warn(`print_labels 配额检查降级: ${e?.message}`);
    }

    // P8.3 治理前置：发布准入（严格模式仅 published 可打）、防重、数量策略、水印。
    // 默认宽松策略下 prePrint 立即放行；任何治理表查询故障也降级放行并回 warning，
    // 保证治理能力不会成为打印链路的单点故障（与上面配额检查同口径）。
    const gov = await this.governance.prePrint(dto.templateId ?? 0, rows, count);
    if (!gov.allowed) {
      await this.audit.write(tenantId, 'print.job.blocked_by_governance', {
        templateId: dto.templateId ?? 0, reason: gov.reason, count, status: gov.status,
      }, undefined, 'print_job', 0);
      throw new ForbiddenException(gov.reason);
    }

    let printer: Printer | null = null;
    const dotFitWarnsOf = (els: any[] | undefined, dpi: number) =>
      summarizeDotFit(analyzeDotFit(els ?? [], dpi), dpi).issues.filter((i) => i.level === 'warn').map((i) => i.message);

    if (dto.printerId) {
      printer = await this.printers.findOne({ where: { id: dto.printerId, tenantId } });
      if (!printer) throw new NotFoundException('打印机不存在');
    }

    // P0-3：设计 mm 与打印机 dot 的一致性提示（不阻断）。先按模板页面 dpi 算一版
    // （skipped_no_printer 分支要回它），拿到打印机后再按其实际 dpi 重算。
    let dotFitWarnings = dotFitWarnsOf((tpl.content as any)?.elements, Number((tpl.content as any)?.page?.dpi ?? 203) || 203);
    if (printer?.dpi && Number(printer.dpi) !== Number((tpl.content as any)?.page?.dpi ?? 203)) {
      dotFitWarnings = dotFitWarnsOf((tpl.content as any)?.elements, Number(printer.dpi) || 203);
    }

    // P9：必须有物理打印机才继续。此前无打印机也会走 image 通道并标记 success，造成"以为打了"。
    if (dto.requirePrinter && !printer) {
      const { userId } = useTenant();
      const skippedJob = await this.jobs.save({
        tenantId, templateId: dto.templateId ?? 0,
        total: count, status: 'skipped_no_printer',
        params: { ...(dto.params ?? {}), copies, skipReason: 'no_printer', requirePrinter: true },
        dataRef: { rows, serialMap: {}, templateContent: tpl.content },
        createdBy: userId,
      });
      await this.audit.write(tenantId, 'print.job.skipped_no_printer', {
        jobId: skippedJob.id, templateId: dto.templateId ?? 0, total: count,
        printerRoute: (dto.params as any)?.printerRoute ?? null, reason: 'no printer bound',
      }, undefined, 'print_job', skippedJob.id);
      return {
        jobId: skippedJob.id, status: 'skipped_no_printer', total: count, quotaWarn,
        governanceWarnings: gov.warnings, dotFitWarnings, skipped: true,
        message: '未绑定打印机（printerRoute 无映射或未指定 printerId），标签未下发；收货主链路不阻塞',
      };
    }

    // 为每个 serial 元素预分配号段（行锁+一次性号段，保证不重号）
    // 前端也可传入 serialMap（模板未配置 sequenceRef 时按 serialStart 本地生成）
    const serialMap: Record<string, string[]> = {};
    const clientSerialMap: Record<string, string[]> = dto.serialMap ?? dto.params?.serialMap ?? {};
    for (const el of (tpl.content?.elements ?? []) as any[]) {
      if (el.type !== 'serial') continue;
      if (el.serial?.sequenceRef) {
        const seg = await this.serial.allocate(tenantId, el.serial.sequenceRef, count);
        serialMap[el.id] = seg.values;
      } else if (Array.isArray(clientSerialMap[el.id])) {
        serialMap[el.id] = clientSerialMap[el.id].slice(0, count);
      }
    }

    const { userId } = useTenant();
    const jobParams = {
      ...(dto.params ?? {}), copies,
      protocol: printer?.connection?.protocol,
      // 水印规格随任务留存，供追溯「这一单按什么策略打的」；指令通道不叠加水印
      ...(gov.watermark ? { watermark: gov.watermark } : {}),
    };
    const job = await this.jobs.save({
      tenantId, templateId: dto.templateId ?? 0, printerId: dto.printerId,
      total: count, status: 'queued', params: jobParams, dataRef: { rows, serialMap, templateContent: tpl.content },
      createdBy: userId,
    });
    // 固定 bull 任务 id，取消时可精确移除
    await this.queue.add('print', {
      jobId: job.id, tenantId, templateContent: tpl.content, rows, serialMap,
      printerId: dto.printerId, params: jobParams,
    }, { jobId: `print-${job.id}`, removeOnComplete: 500, removeOnFail: 500 });
    await this.audit.write(tenantId, 'print.job.create', { jobId: job.id, templateId: dto.templateId, copies, rows: rows.length, printerId: dto.printerId }, undefined, 'print_job', job.id);
    // 防重登记在任务受理之后（旁路，失败不影响已入队任务）
    await this.governance.recordPrint(gov.dedupeKey, dto.templateId ?? 0, job.id);
    // P3 计费：按标签张数计量（rows×copies）。计量失败不影响已入队的任务（兜底重算会补聚合）
    try {
      await this.usage.record(tenantId, 'print_labels', count, {
        moduleCode: 'print', userId, meta: { jobId: job.id, printerId: dto.printerId ?? null },
      });
    } catch (e: any) {
      this.logger.warn(`print_labels 计量写入失败(job ${job.id}): ${e?.message}`);
    }
    return {
      jobId: job.id, status: 'queued', total: count, quotaWarn,
      governanceWarnings: gov.warnings,
      dotFitWarnings,
      watermarkApplied: !!gov.watermark,
      watermarkChannelNote: gov.watermark
        ? '水印对浏览器打印 / SVG / PDF 输出生效；ZPL/TSPL/EPL 指令通道不叠加水印，请改用图像通道'
        : null,
    };
  }

  getJob(id: number) { return this.jobs.findOne({ where: { id, tenantId: useTenantId() } }); }

  async jobLogs(id: number, q: { page?: number; pageSize?: number } = {}) {
    await this.getJob(id);
    return this.logRepo.findAndCount({
      where: { jobId: id, tenantId: useTenantId() },
      order: { seqNo: 'ASC' },
      skip: ((q.page ?? 1) - 1) * (q.pageSize ?? 50),
      take: Math.min(200, q.pageSize ?? 50),
    });
  }

  logs(q: any = {}) {
    const where: any = { tenantId: useTenantId() };
    if (q.jobId) where.jobId = +q.jobId;
    if (q.status) where.status = q.status;
    return this.logRepo.find({ where, order: { createdAt: 'DESC' }, take: Math.min(200, q.pageSize ?? 50) });
  }

  async cancel(id: number) {
    const job = await this.getJob(id);
    if (!job) throw new NotFoundException('任务不存在');
    try { await this.queue.getJob(`print-${id}`).then((j) => j?.remove()); } catch { /* 已开始/不存在 */ }
    await this.jobs.update({ id, tenantId: useTenantId() }, { status: 'canceled', finishedAt: new Date() });
    await this.audit.write(useTenantId(), 'print.job.cancel', { jobId: id }, undefined, 'print_job', id);
    return { ok: true };
  }

  /**
   * 重打/补打：复用原数据与流水号，避免重打产生新号。
   * seqNos 为空则重打整单；指定序号只重打该标签。
   */
  async retry(id: number, seqNos?: number[]) {
    const job = await this.getJob(id);
    if (!job) throw new NotFoundException('任务不存在');
    const rows = (job.dataRef as any)?.rows ?? [{}];
    const serialMap = (job.dataRef as any)?.serialMap ?? {};
    const templateContent = (job.dataRef as any)?.templateContent ?? null;
    const copies = Math.max(1, job.params?.copies ?? 1);
    const printerId = job.printerId;
    const newJob = await this.jobs.save({
      tenantId: useTenantId(), templateId: job.templateId, printerId,
      total: rows.length * copies, status: 'queued',
      params: { ...job.params, copies, retryOf: id },
      dataRef: { rows, serialMap, templateContent, reprintOf: id, seqNos },
    });
    await this.queue.add('print', {
      jobId: newJob.id, tenantId: useTenantId(), templateContent, rows, serialMap,
      printerId, params: { ...job.params, copies, templateId: job.templateId, reprintOf: id, seqNos },
    }, { jobId: `print-${newJob.id}`, removeOnComplete: 500, removeOnFail: 500 });
    await this.audit.write(useTenantId(), 'print.job.reprint', { jobId: id, newJobId: newJob.id, seqNos: seqNos ?? null }, undefined, 'print_job', newJob.id);
    return { jobId: newJob.id, status: 'queued', reprintOf: id };
  }
}
