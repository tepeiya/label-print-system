// =============================================================================
// print.controller.ts —— 打印队列 / 指令导出 / 实时预览
// =============================================================================

import { Controller, Post, Get, Param, Body, Query, UseGuards } from '@nestjs/common';
import { PrintService } from './print.service';
import { RenderService } from './render.service';
import { renderPrintHtml, HtmlRenderOutput } from './html-renderer';
import { TenantGuard } from '../common/tenant.guard';
import { generateZpl, mmToDots } from '../../core/zpl-generator';
import { buildJob as buildTsplJob } from '../../core/tspl-generator';
import * as crypto from 'crypto';

@Controller('print/jobs')
@UseGuards(TenantGuard)
export class PrintController {
  constructor(private svc: PrintService) {}
  @Post() create(@Body() b: any) { return this.svc.createJob(b); }
  @Get() list(@Query() q: any) { return this.svc.list(q); }
  @Get('logs') logs(@Query() q: any) { return this.svc.logs(q); }
  @Get(':id') get(@Param('id') id: number) { return this.svc.getJob(+id); }
  @Get(':id/logs') jobLogs(@Param('id') id: number, @Query() q: any) { return this.svc.jobLogs(+id, q); }
  @Post(':id/cancel') cancel(@Param('id') id: number) { return this.svc.cancel(+id); }
  @Post(':id/retry') retry(@Param('id') id: number, @Body() b: any) { return this.svc.retry(+id, b?.seqNos); }
  @Post(':id/reprint') reprint(@Param('id') id: number, @Body() b: any) { return this.svc.retry(+id, b?.seqNos); }
}

/**
 * 实时预览端点 —— 前端把当前模板 JSON + 数据行 POST 过来，
 * 后端返回一份完整 HTML（含 mm→px 换算、变量/公式/流水号已求值）。
 */
@Controller('print/preview')
export class PrintPreviewController {
  @Post()
  render(@Body() body: any): HtmlRenderOutput {
    return renderPrintHtml({
      templateContent: body.templateContent,
      rows: body.rows ?? [{}],
      copies: body.copies ?? 1,
    });
  }
}

/**
 * 打印机指令导出 —— ZPL / TSPL。
 * 用于「下载指令文件」「本地代理打印」「第三方系统集成」。
 * 入参 { templateContent, rows, copies, protocol, dpi, widthMm, heightMm, gapMm, offsets, density, speed }
 */
@Controller('print/commands')
export class PrintCommandsController {
  constructor(private render: RenderService) {}

  @Post()
  commands(@Body() b: any) {
    const tpl = b.templateContent;
    if (!tpl?.page) throw new Error('缺少 templateContent');
    const rows: any[] = b.rows?.length ? b.rows : [{}];
    const copies = Math.max(1, Math.min(500, b.copies ?? 1));
    const dpi = b.dpi ?? tpl.page.dpi ?? 300;
    const protocol: 'zpl' | 'tspl' = b.protocol === 'tspl' ? 'tspl' : 'zpl';
    const gapMm = b.gapMm ?? tpl.page.gapMm ?? 2;
    const offX = mmToDots(b.offsetXMm ?? 0, dpi);
    const offY = mmToDots(b.offsetYMm ?? 0, dpi);
    const density = b.density;
    const speed = b.speed;

    const frames: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sysVars = {
        pageNo: i + 1, pageTotal: rows.length,
        printDate: new Date().toISOString().slice(0, 10),
        printTime: new Date().toISOString().slice(11, 19),
        uuid: crypto.randomUUID(),
      };
      const rendered = this.render.renderRow(tpl.elements ?? [], row, b.serialMap ?? {}, sysVars, i);
      if (protocol === 'zpl') {
        const zpl = generateZpl(this.render.toZplElements(rendered), dpi);
        let out = zpl.replace('^XA', `^XA^LH${offX},${offY}` + (density ? `~SD${density}` : '') + (speed ? `^PR${speed}` : ''));
        out = out.replace('^XZ', `^PQ${copies}^XZ`);
        frames.push(out);
      } else {
        const tspl = buildTsplJob(this.render.toTsplElements(rendered), dpi, {
          widthMm: b.widthMm ?? tpl.page.widthMm,
          heightMm: b.heightMm ?? tpl.page.heightMm,
          gapMm, copies,
        }, (tpl.page.orientation ?? 0) as any);
        let text = tspl.toString('utf8');
        if (density !== undefined) text = `DENSITY ${density}\r\n` + text;
        if (speed !== undefined) text = `SPEED ${speed}\r\n` + text;
        frames.push(text);
      }
    }

    const text = protocol === 'zpl' ? frames.join('\n') : frames.join('');
    return {
      protocol,
      text,
      labelCount: rows.length * copies,
      bytes: Buffer.byteLength(text, 'utf8'),
      dpi,
      warnings: buildWarnings(protocol, tpl),
    };
  }
}

/** 指令导出能力提示：TSPL 只有 QRCODE，其余二维码只能按 QR 输出 */
function buildWarnings(protocol: 'zpl' | 'tspl', tpl: any): string[] {
  const warnings: string[] = [];
  if (protocol !== 'tspl') return warnings;
  const NON_QR = /^(DATAMATRIX|PDF417|AZTEC)/i;
  const coerced = (tpl.elements ?? [])
    .filter((e: any) => e.type === 'qrcode' && NON_QR.test(String(e.qrcode?.sym ?? '')))
    .map((e: any) => e.qrcode.sym);
  if (coerced.length) {
    warnings.push(`TSPL 无对应指令，${[...new Set(coerced)].join('/')} 已按 QRCODE 输出；如需原码制请改用 ZPL 协议或图像通道`);
  }
  // TSPL 文本按 FONT001 输出，中文依赖打印机内置中文字库
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  const texts: string[] = [
    ...(tpl.elements ?? []).map((e: any) => e.text ?? e.rendered ?? e.barcode?.content ?? e.qrcode?.content ?? ''),
    ...(tpl.variables ?? []).map((v: any) => v.defaultValue ?? ''),
  ];
  if (texts.some((s) => CJK.test(String(s)))) {
    warnings.push('TSPL 文本使用 FONT001，中文需打印机内置中文字库；无字库时请改用 ZPL(^CI28) 或图像通道');
  }
  return warnings;
}
