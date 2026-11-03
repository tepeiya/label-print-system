// BullMQ 消费端（Worker）：逐张标签渲染 → 调用 PrinterProvider 下发（异步、不阻塞 API）
// 支持：模板重新加载（重打）、指定序号补打、ZPL/TSPL 协议、偏移/浓度/速度、逐张日志。
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PrintJob, PrintLog, Printer } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { RenderService } from './render.service';
import { PrinterProviderRegistry } from '../../printer/printer-provider.interface';
import { PrintEvents } from './events.event';
import * as crypto from 'crypto';

@Processor('print')
export class PrintProcessor extends WorkerHost {
  constructor(
    @InjectRepository(PrintJob) private jobs: Repository<PrintJob>,
    @InjectRepository(PrintLog) private logs: Repository<PrintLog>,
    @InjectRepository(Template) private tpls: Repository<Template>,
    private render: RenderService,
    private events: PrintEvents,
  ) { super(); }

  async process(job: Job) {
    const data = job.data as any;
    const {
      jobId, tenantId, templateContent, rows, serialMap, printerId, params = {},
    } = data;
    const copies = Math.max(1, params.copies ?? 1);
    const protocol: 'zpl' | 'tspl' | 'browser' =
      params.protocol === 'tspl' ? 'tspl' : params.protocol === 'browser' ? 'browser' : 'zpl';

    // 重打场景队列里 templateContent 为空：按 templateId 重新加载
    let content = templateContent;
    if (!content || typeof content === 'string') {
      if (typeof content === 'string') {
        try { content = JSON.parse(content); } catch { content = null; }
      }
      if (!content) {
        const templateId = params.templateId ?? data.templateId;
        const tpl = templateId
          ? await this.tpls.findOne({ where: { id: templateId, tenantId } })
          : null;
        if (!tpl) throw new Error(`模板不存在（id=${templateId}）`);
        content = typeof tpl.content === 'string' ? JSON.parse(tpl.content as any) : tpl.content;
      }
    }

    const printer: Printer | null = printerId
      ? await this.loadPrinter(printerId, tenantId)
      : null;

    const providerType = printer?.type ?? (protocol === 'browser' ? 'browser' : 'image');
    const provider = providerType === 'browser' ? null : PrinterProviderRegistry.get(providerType as any);

    const allRows: any[] = Array.isArray(rows) && rows.length ? rows : [{}];
    const totalLabels = allRows.length * copies;

    // seqNos：1 基标签序号，指定时只补打这些张
    const wanted: number[] | undefined = Array.isArray(params.seqNos) && params.seqNos.length
      ? params.seqNos.map((n: any) => +n).filter((n: number) => n >= 1 && n <= totalLabels)
      : undefined;

    let done = 0, failed = 0, processed = 0;
    for (let idx = 0; idx < totalLabels; idx++) {
      const seqNo = idx + 1;
      if (wanted && !wanted.includes(seqNo)) continue;
      const rowIndex = idx % allRows.length;
      const row = allRows[rowIndex];
      processed++;

      try {
        const sysVars = {
          pageNo: seqNo,
          pageTotal: wanted?.length ?? totalLabels,
          copyIndex: Math.floor(idx / allRows.length),
          printDate: new Date().toISOString().slice(0, 10),
          printTime: new Date().toISOString().slice(11, 19),
          uuid: crypto.randomUUID(),
        };
        const rendered = this.render.renderRow(
          content.elements ?? [],
          row,
          serialMap ?? {},
          sysVars,
          idx,
        );

        let payload: any;
        if (protocol === 'zpl') {
          payload = { zpl: this.render.toZplElements(rendered) };
        } else if (protocol === 'tspl') {
          payload = { tspl: this.render.toTsplElements(rendered) };
        }

        if (provider) {
          await provider.print({
            tenantId,
            jobId,
            templateId: params.templateId ?? data.templateId ?? content.id ?? 0,
            printer: {
              type: (printer?.type ?? 'image') as any,
              dpi: printer?.dpi ?? content.page?.dpi ?? 300,
              widthMm: Number(printer?.labelWidthMm ?? content.page?.widthMm ?? 40),
              heightMm: Number(printer?.labelHeightMm ?? content.page?.heightMm ?? 30),
              offsetXMm: Number(params.offsetXMm ?? printer?.offsetXMm ?? 0),
              offsetYMm: Number(params.offsetYMm ?? printer?.offsetYMm ?? 0),
              orientation: (params.orientation ?? printer?.orientation ?? 0) as any,
              density: params.density ?? printer?.density ?? undefined,
              speed: params.speed ?? printer?.speed ?? undefined,
              protocol,
              gapMm: Number(params.gapMm ?? content.page?.gapMm ?? 2),
              connection: (printer?.connection ?? {}) as any,
            },
            copies: 1,
            labels: [payload],
          });
        }

        await this.logs.save({
          tenantId, jobId,
          templateId: params.templateId ?? data.templateId ?? 0,
          printerId,
          seqNo,
          serialValues: this.pickSerials(serialMap, idx),
          dataSnapshot: row,
          status: 'success',
          ...(params.reprintOf ? { reprintOf: params.reprintOf } : {}),
        });
        done++;
      } catch (err: any) {
        failed++;
        await this.logs.save({
          tenantId, jobId,
          templateId: params.templateId ?? data.templateId ?? 0,
          printerId,
          seqNo,
          dataSnapshot: row,
          status: 'failed',
          errorMsg: String(err?.message ?? err).slice(0, 500),
          ...(params.reprintOf ? { reprintOf: params.reprintOf } : {}),
        });
      }
      await this.jobs.update(jobId, { done, failed, total: processed });
      this.events.publish(tenantId, { type: 'progress', jobId, seqNo, done, failed, total: processed, status: done + failed === wanted?.length ? 'running' : 'running' });
    }

    await this.jobs.update(jobId, {
      done, failed, total: processed,
      status: failed === 0 ? 'success' : done === 0 ? 'failed' : 'partial',
      finishedAt: new Date(),
    });
    this.events.publish(tenantId, { type: 'completed', jobId, done, failed, total: processed, status: failed === 0 ? 'success' : done === 0 ? 'failed' : 'partial' });
    return { done, failed, processed };
  }

  private async loadPrinter(id: number, tenantId: number): Promise<Printer | null> {
    return this.tpls.manager.getRepository(Printer).findOne({ where: { id, tenantId } });
  }

  private pickSerials(serialMap: Record<string, string[]>, idx: number): Record<string, string> | undefined {
    if (!serialMap) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(serialMap)) {
      if (Array.isArray(v) && v[idx] !== undefined) out[k] = v[idx];
    }
    return Object.keys(out).length ? out : undefined;
  }
}
