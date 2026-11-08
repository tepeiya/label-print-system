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
import { generateEpl } from '../../core/epl-generator';
import { attachBitmapFallbacks } from '../../core/raster';
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
 * 打印机指令导出 —— ZPL / TSPL（EPL 见 P7.7）。
 * 用于「下载指令文件」「本地代理打印」「第三方系统集成」。
 * 入参 { templateContent, rows, copies, protocol, dpi, widthMm, heightMm, gapMm, offsets, density, speed }
 */
@Controller('print/commands')
export class PrintCommandsController {
  constructor(private render: RenderService) {}

  @Post()
  async commands(@Body() b: PrintCommandsDto) {
    const tpl = b.templateContent;
    // DTO 已挡掉缺 templateContent，这里兜底 page 结构；原来是 throw new Error → 500
    if (!tpl?.page) throw new BadRequestException('templateContent 缺少 page 结构');
    const rows: any[] = b.rows?.length ? b.rows : [{}];
    const copies = Math.max(1, Math.min(500, b.copies ?? 1));
    const dpi = b.dpi ?? tpl.page.dpi ?? 300;
    const protocol: CmdProtocol = b.protocol === 'tspl' || b.protocol === 'epl' ? b.protocol : 'zpl';
    const gapMm = b.gapMm ?? tpl.page.gapMm ?? 2;
    const widthMm = b.widthMm ?? tpl.page.widthMm;
    const heightMm = b.heightMm ?? tpl.page.heightMm;
    const offX = mmToDots(b.offsetXMm ?? 0, dpi);
    const offY = mmToDots(b.offsetYMm ?? 0, dpi);
    const density = b.density;
    const speed = b.speed;

    // 一律先汇成 Buffer 再决定怎么回给调用方：TSPL 的 BITMAP 与 EPL 的 GW 载荷是原始二进制，
    // 只有 Buffer 组装才不会被字符串编码改动字节数（位图行数/字节数一旦对不上，固件打出错图）
    const frames: Buffer[] = [];
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
        // 位图回填预生成：能力矩阵判为 bitmap 的二维符号 / image 元素在这里出点阵，
        // 生成器本身保持同步（拿不到点阵就跳过 + warning，绝不静默降级）
        const prepared = await attachBitmapFallbacks(this.render.toZplElements(rendered), dpi, 'zpl');
        genWarnings.push(...prepared.warnings);
        const zplOut = generateZpl(prepared.els, dpi);
        genWarnings.push(...zplOut.warnings);
        let out = zplOut.text.replace('^XA', `^XA^LH${offX},${offY}` + (density ? `~SD${density}` : '') + (speed ? `^PR${speed}` : ''));
        out = out.replace('^XZ', `^PQ${copies}^XZ`);
        frames.push(Buffer.from(out, 'utf8'));
      } else if (protocol === 'tspl') {
        const prepared = await attachBitmapFallbacks(this.render.toTsplElements(rendered), dpi, 'tspl');
        genWarnings.push(...prepared.warnings);
        const tsplOut = buildTsplJob(prepared.els, dpi, {
          widthMm, heightMm, gapMm, copies,
        }, (tpl.page.orientation ?? 0) as any);
        genWarnings.push(...tsplOut.warnings);
        const pre: string[] = [];
        if (density !== undefined) pre.push(`DENSITY ${density}`);
        if (speed !== undefined) pre.push(`SPEED ${speed}`);
        if (offX || offY) pre.push(`OFFSET ${offX},${offY}`);
        frames.push(Buffer.concat([
          ...pre.map((s) => Buffer.from(s + '\r\n', 'utf8')),
          tsplOut.buffer,
        ]));
      } else {
        // EPL2：整段作业是 latin1（GW 载荷逐字节），密度/速度/份数都在页头页尾里给
        const prepared = await attachBitmapFallbacks(this.render.toEplElements(rendered), dpi, 'epl');
        genWarnings.push(...prepared.warnings);
        const eplOut = generateEpl(prepared.els, dpi, {
          widthMm, heightMm, gapMm, copies,
          density, speed,
          orientation: (tpl.page.orientation ?? 0) as 0 | 90 | 180 | 270,
        });
        genWarnings.push(...eplOut.warnings);
        // OFFSET 在 EPL2 里没有对应指令（[M] 命令目录无 OFFSET），只能靠模板坐标；
        // 用户给了偏移就必须说清楚，否则他会以为偏移生效了
        if (offX || offY) {
          genWarnings.push(`[EPL] 打印偏移 ${offX},${offY} 点无法用 EPL2 表达（手册无 OFFSET 指令），已忽略；请改用模板坐标或 ZPL(^LH)/TSPL(OFFSET)`);
        }
        if (b.dpi !== undefined && dpi !== 203 && dpi !== 300) {
          genWarnings.push(`[EPL] dpi ${dpi} 非 EPL2 常见档位（203/300），q/Q/B 的点坐标按 ${dpi} 换算，实际机型可能是 203dpi，请先核对机型`);
        }
        frames.push(Buffer.from(eplOut.text, 'latin1'));
      }
    }

    const buf = protocol === 'zpl'
      ? Buffer.from(frames.map((f) => f.toString('utf8')).join('\n'), 'utf8')
      : Buffer.concat(frames);
    const text = buf.toString('utf8');
    // text 是否字节无损：含位图载荷时 utf8 解码会把高位字节换成 U+FFFD，
    // 此时 text 只能看不能用，下发/存盘必须走 textBase64
    const textExact = Buffer.from(text, 'utf8').equals(buf);
    if (!textExact) {
      genWarnings.push('[字节] 作业含图像指令的原始二进制（TSPL BITMAP / EPL GW），text 字段仅供阅读，字节已不可逆；下发或另存文件请用 textBase64 解码后的字节');
    }
    return {
      protocol,
      text,
      textBase64: buf.toString('base64'),
      textExact,
      labelCount: rows.length * copies,
      bytes: buf.length,
      dpi,
      // 合并：生成器 warnings（码制/几何/静区/GS1/位图）+ 协议层提示（TSPL 中文等）
      warnings: [...new Set([...genWarnings, ...buildWarnings(protocol, tpl)])],
    };
  }
}

/** 指令导出支持的协议（与 PrintCommandsDto 的 @IsIn 必须同步，P7.8 有守卫测试） */
type CmdProtocol = 'zpl' | 'tspl' | 'epl';

/** 指令导出能力提示（码制维度的提示已由生成器 warnings 精确产出，此处只保留字体维度） */
function buildWarnings(protocol: CmdProtocol, tpl: any): string[] {
  const warnings: string[] = [];
  if (protocol !== 'tspl') return warnings;
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
