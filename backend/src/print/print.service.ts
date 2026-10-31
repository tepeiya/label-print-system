// 打印服务：编排模板+数据+流水号，入 BullMQ 队列（异步、不阻塞）
import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { PrintJob, PrintLog } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { useTenantId } from '../common/tenant.context';
import { SerialModuleService } from '../serial/serial.service';
import { RenderService } from './render.service';

const REDIS = process.env.REDIS_URL || 'redis://localhost:6379';

@Injectable()
export class PrintService {
  private queue = new Queue('print', { connection: { url: REDIS } });
  constructor(
    @InjectRepository(PrintJob) private jobs: Repository<PrintJob>,
    @InjectRepository(Template) private tpls: Repository<Template>,
    @InjectDataSource() private ds: DataSource,
    private serial: SerialModuleService,
    private render: RenderService,
  ) {}

  /** 创建批量打印任务：预分配流水号段 → 入队 → 立即返回 202 风格 */
  async createJob(dto: { templateId: number; printerId?: number; rows?: any[]; copies?: number; params?: any }) {
    const tenantId = useTenantId();
    const tpl = await this.tpls.findOne({ where: { id: dto.templateId, tenantId } });
    if (!tpl) throw new Error('模板不存在');

    // 解析数据行（手工传入或来自数据源，此处取手工 rows）
    const rows: any[] = dto.rows ?? [{}];
    const count = rows.length * (dto.copies ?? 1);

    // 为每个 serial 元素预分配号段（行锁+一次性号段，保证不重号）
    const serialMap: Record<string, string[]> = {};
    for (const el of (tpl.content.elements ?? []) as any[]) {
      if (el.type === 'serial') {
        const seg = await this.serial.allocate(tenantId, el.serial.sequenceRef, count);
        serialMap[el.id] = seg.values;
      }
    }

    const job = await this.jobs.save({
      tenantId, templateId: dto.templateId, printerId: dto.printerId,
      total: count, status: 'queued', params: dto.params ?? {}, dataRef: { rows },
    });
    await this.queue.add('print', { jobId: job.id, tenantId, templateContent: tpl.content, rows, serialMap, printerId: dto.printerId, params: dto.params ?? {} });
    return { jobId: job.id, status: 'queued' };
  }

  getJob(id: number) { return this.jobs.findOne({ where: { id, tenantId: useTenantId() } }); }
  cancel(id: number) { return this.jobs.update({ id, tenantId: useTenantId() }, { status: 'canceled' }); }
  logs(q: any) { return this.ds.getRepository(PrintLog).find({ where: { tenantId: useTenantId() }, take: q.pageSize ?? 50 }); }
}
