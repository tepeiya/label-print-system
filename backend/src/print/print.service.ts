// 打印服务：编排模板+数据+流水号，入 BullMQ 队列（异步、不阻塞）
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { PrintJob, PrintLog, Printer } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { useTenant, useTenantId } from '../common/tenant.context';
import { SerialModuleService } from '../serial/serial.service';
import { AuditService } from '../audit/audit.module';

@Injectable()
export class PrintService {
  constructor(
    @InjectQueue('print') private queue: Queue,
    @InjectRepository(PrintJob) private jobs: Repository<PrintJob>,
    @InjectRepository(PrintLog) private logRepo: Repository<PrintLog>,
    @InjectRepository(Template) private tpls: Repository<Template>,
    @InjectRepository(Printer) private printers: Repository<Printer>,
    private serial: SerialModuleService,
    private audit: AuditService,
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

  /** 创建批量打印任务：预分配流水号段 → 入队 → 立即返回 */
  async createJob(dto: { templateId: number; printerId?: number; rows?: any[]; copies?: number; params?: any; templateContent?: any; serialMap?: Record<string, string[]> }) {
    const tenantId = useTenantId();
    const tpl = dto.templateContent
      ? { id: dto.templateId ?? 0, content: dto.templateContent }
      : await this.tpls.findOne({ where: { id: dto.templateId, tenantId } });
    if (!tpl) throw new NotFoundException('模板不存在');

    const rows: any[] = Array.isArray(dto.rows) && dto.rows.length ? dto.rows : [{}];
    const copies = Math.max(1, Math.min(500, dto.copies ?? 1));
    const count = rows.length * copies;

    let printer: Printer | null = null;
    if (dto.printerId) {
      printer = await this.printers.findOne({ where: { id: dto.printerId, tenantId } });
      if (!printer) throw new NotFoundException('打印机不存在');
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
    const job = await this.jobs.save({
      tenantId, templateId: dto.templateId ?? 0, printerId: dto.printerId,
      total: count, status: 'queued', params: { ...(dto.params ?? {}), copies, protocol: printer?.connection?.protocol }, dataRef: { rows, serialMap, templateContent: tpl.content },
      createdBy: userId,
    });
    // 固定 bull 任务 id，取消时可精确移除
    await this.queue.add('print', {
      jobId: job.id, tenantId, templateContent: tpl.content, rows, serialMap,
      printerId: dto.printerId, params: { ...(dto.params ?? {}), copies },
    }, { jobId: `print-${job.id}`, removeOnComplete: 500, removeOnFail: 500 });
    await this.audit.write(tenantId, 'print.job.create', { jobId: job.id, templateId: dto.templateId, copies, rows: rows.length, printerId: dto.printerId }, undefined, 'print_job', job.id);
    return { jobId: job.id, status: 'queued', total: count };
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
