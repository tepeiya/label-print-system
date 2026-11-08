// =============================================================================
// print.controller.ts —— 打印队列 / 指令导出 / 实时预览
// =============================================================================

import { Controller, Post, Get, Param, Body, Query, UseGuards, Res, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Public } from '../common/public.decorator';
import { Response } from 'express';
import { PrintService } from './print.service';
import { RenderService } from './render.service';
import { renderPrintHtml, HtmlRenderOutput } from './html-renderer';
import { TenantGuard } from '../common/tenant.guard';
import { Roles, RoleName } from '../common/roles.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { generateZpl, mmToDots } from '../../core/zpl-generator';
import { CreatePrintJobDto, PreviewRenderDto, PrintCommandsDto, RetryPrintDto } from './dto/print.dto';
import { buildJob as buildTsplJob } from '../../core/tspl-generator';
import { PrintEvents } from './events.event';
import * as crypto from 'crypto';
import { JWT_SECRET } from '../common/config';

const PRINT_ACTION: RoleName[] = ['admin', 'operator'];

@Controller('print/jobs')
@UseGuards(TenantGuard)
// 模块门：print 是所有套餐的必含模块（docs/11 §11.16），挂上门禁对现有租户零影响，
// 但没订阅 print 的租户（未来 FREE/停用）会被 4031 统一拦下。
@RequireModule('print')
export class PrintController {
  constructor(private svc: PrintService) {}
  // 提交：人工入口沿用 print:job:write，Agent 走 print:job:submit（D7 灰度，任一即可）
  @RequirePermission('print:job:write', 'print:job:submit')
  @Roles(...PRINT_ACTION)
  @Post() create(@Body() b: CreatePrintJobDto) { return this.svc.createJob(b); }
  @RequirePermission('print:job:read')
  @Get() list(@Query() q: any) { return this.svc.list(q); }
  @RequirePermission('print:stats:read')
  @Get('stats') stats(@Query('days') days?: string) {
    return this.svc.stats({ days: days ? parseInt(days, 10) : undefined });
  }
  @RequirePermission('print:job:read')
  @Get('logs') logs(@Query() q: any) { return this.svc.logs(q); }
  @RequirePermission('print:job:read')
  @Get(':id') get(@Param('id') id: number) { return this.svc.getJob(+id); }
  @RequirePermission('print:job:read')
  @Get(':id/logs') jobLogs(@Param('id') id: number, @Query() q: any) { return this.svc.jobLogs(+id, q); }
  // 取消/重试/重打：operator 旧行为里就能做，所以把 print:job:write 也列为等效钥匙（saas_p0_roles.sql 第 12 节）
  @RequirePermission('print:job:cancel', 'print:job:write')
  @Roles(...PRINT_ACTION)
  @Post(':id/cancel') cancel(@Param('id') id: number) { return this.svc.cancel(+id); }
  @RequirePermission('print:job:write')
  @Roles(...PRINT_ACTION)
  @Post(':id/retry') retry(@Param('id') id: number, @Body() b: RetryPrintDto) { return this.svc.retry(+id, b?.seqNos); }
  @RequirePermission('print:job:write')
  @Roles(...PRINT_ACTION)
  @Post(':id/reprint') reprint(@Param('id') id: number, @Body() b: RetryPrintDto) { return this.svc.retry(+id, b?.seqNos); }
}

/**
 * 实时预览端点 —— 前端把当前模板 JSON + 数据行 POST 过来，
 * 后端返回一份完整 HTML（含 mm→px 换算、变量/公式/流水号已求值）。
 */
@Controller('print/preview')
export class PrintPreviewController {
  @Post()
  render(@Body() body: PreviewRenderDto): HtmlRenderOutput {
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
  commands(@Body() b: PrintCommandsDto) {
    const tpl = b.templateContent;
    // DTO 已挡掉缺 templateContent，这里兜底 page 结构；原来是 throw new Error → 500
    if (!tpl?.page) throw new BadRequestException('templateContent 缺少 page 结构');
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
    const genWarnings: string[] = [];
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
        const zplOut = generateZpl(this.render.toZplElements(rendered), dpi);
        genWarnings.push(...zplOut.warnings);
        let out = zplOut.text.replace('^XA', `^XA^LH${offX},${offY}` + (density ? `~SD${density}` : '') + (speed ? `^PR${speed}` : ''));
        out = out.replace('^XZ', `^PQ${copies}^XZ`);
        frames.push(out);
      } else {
        const tsplOut = buildTsplJob(this.render.toTsplElements(rendered), dpi, {
          widthMm: b.widthMm ?? tpl.page.widthMm,
          heightMm: b.heightMm ?? tpl.page.heightMm,
          gapMm, copies,
        }, (tpl.page.orientation ?? 0) as any);
        genWarnings.push(...tsplOut.warnings);
        let text = tsplOut.buffer.toString('utf8');
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
      // 合并：生成器不支持码制警告 + 已有的协议层提示（TSPL 中文 / 二维码）
      warnings: [...new Set([...genWarnings, ...buildWarnings(protocol, tpl)])],
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

/** SSE：打印任务实时事件流。@Public() 跳过全局守卫，handler 内手动解 query.token。
 * 用独立前缀 print-stream 避免和 PrintController(/print/jobs) 冲突 */
@Controller('print-stream')
@Public()
export class PrintEventsController {
  constructor(private bus: PrintEvents, private jwt: JwtService) {}

  @Get('events')
  stream(@Query('token') token: string, @Res() res: Response) {
    try {
      let tenantId: number;
      try {
        const payload: any = this.jwt.verify(String(token || ''), { secret: JWT_SECRET });
        tenantId = +payload.tenantId;
        if (!tenantId) throw new Error('缺少 tenantId');
      } catch (e) {
        res.status(401).json({ code: 401, message: '无效 token', data: null });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      res.write(`retry: 15000\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, tenantId })}\n\n`);

      const send = (name: string, data: any) => {
        if (res.writableEnded) return false;
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      };

      const unsubscribe = this.bus.subscribe(tenantId, (ev) => {
        if (!send('event', ev)) return false;
      }, 5 * 60_000);

      const ping = setInterval(() => {
        if (res.writableEnded) { clearInterval(ping); return; }
        res.write(`: ping ${Date.now()}\n\n`);
      }, 20_000);

      res.on('close', () => { clearInterval(ping); unsubscribe(); });
    } catch (e: any) {
      console.error('[SSE INNER ERROR]', e?.stack || e);
      if (!res.headersSent) {
        res.status(500).json({ code: 500, message: e?.message || '内部错误', data: null });
      }
    }
  }
}
