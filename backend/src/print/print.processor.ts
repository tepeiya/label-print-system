// BullMQ 消费端（Worker）：逐行渲染 → 调用 PrinterProvider 下发（异步、不阻塞 API）
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PrintJob, PrintLog } from '../entities/print.entity';
import { RenderService } from './render.service';
import { PrinterProviderRegistry } from '../../printer/printer-provider.interface';
import { generateZpl } from '../../core/zpl-generator';
import { mmToPx } from '../../core/barcode-renderer';

@Processor('print')
export class PrintProcessor extends WorkerHost {
  constructor(
    @InjectRepository(PrintJob) private jobs: Repository<PrintJob>,
    @InjectRepository(PrintLog) private logs: Repository<PrintLog>,
    @InjectDataSource() private ds: DataSource,
    private render: RenderService,
  ) { super(); }

  async process(job: Job) {
    const { jobId, tenantId, templateContent, rows, serialMap, printerId, params } = job.data as any;
    const printer = printerId ? await this.ds.getRepository('printers').findOne({ where: { id: printerId } }) : null;
    const provider = PrinterProviderRegistry.get((printer?.type ?? 'image') as any);
    let done = 0, failed = 0;

    for (let i = 0; i < rows.length; i++) {
      try {
        const sysVars = { pageNo: i + 1, pageTotal: rows.length, uuid: crypto.randomUUID() };
        const els = this.render.renderRow(templateContent.elements, rows[i], serialMap, sysVars, i);
        const zplEls = els.map((e: any) => this.toZplElement(e));
        const payload = { tenantId, jobId, templateId: templateContent.id ?? 0, printer: {
          type: printer?.type ?? 'image', dpi: printer?.dpi ?? 300,
          widthMm: printer?.labelWidthMm ?? templateContent.page.widthMm,
          heightMm: printer?.labelHeightMm ?? templateContent.page.heightMm,
          offsetXMm: 0, offsetYMm: 0, orientation: 0, connection: printer?.connection ?? {},
        }, copies: params.copies ?? 1, labels: [{ zpl: zplEls }] };
        await provider.print(payload as any);
        await this.logs.save({ tenantId, jobId, templateId: templateContent.id ?? 0, printerId, seqNo: i + 1, serialValues: serialMap, dataSnapshot: rows[i], status: 'success' });
        done++;
      } catch (err: any) {
        failed++;
        await this.logs.save({ tenantId, jobId, templateId: templateContent.id ?? 0, printerId, seqNo: i + 1, status: 'failed', errorMsg: err.message });
      }
      await this.jobs.update(jobId, { done, failed });
    }
    await this.jobs.update(jobId, { status: failed === 0 ? 'success' : 'partial', finishedAt: new Date() });
  }

  /** 把通用元素转成 ZPL 元素描述（核心生成器消费） */
  private toZplElement(e: any) {
    if (e.type === 'text') return { type: 'text', xMm: e.x, yMm: e.y, text: e.rendered ?? e.text, fontHeightMm: e.font?.size ? e.font.size / 72 * 25.4 : 3 };
    if (e.type === 'barcode') return { type: 'barcode', xMm: e.x, yMm: e.y, barcode: { ...e.barcode, content: e.barcode.content } };
    if (e.type === 'qrcode') return { type: 'qrcode', xMm: e.x, yMm: e.y, qrcode: e.qrcode };
    if (e.type === 'serial') return { type: 'text', xMm: e.x, yMm: e.y, text: e.rendered ?? '', fontHeightMm: 3 };
    return { type: 'text', xMm: e.x, yMm: e.y, text: '' };
  }
}
