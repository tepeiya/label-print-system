// =============================================================================
// printer-provider.interface.ts —— 打印通道抽象（插件化）
// 任何新打印机协议（ZPL/TSPL/EPL/CPCL/驱动）只需实现 PrinterProvider 并注册。
// print() 入参为「已渲染的标签帧」序列；由上层把模板+数据+流水号渲染成元素数组，
// 再由对应 Provider 转成指令/图片/PDF。
// =============================================================================

import type { PrintResult } from '../core/types';
import type { ZplElement } from '../core/zpl-generator';
import type { TsplElement } from '../core/tspl-generator';
import type { EplElement } from '../core/epl-generator';

export type ProviderType = 'browser' | 'raw_tcp' | 'windows_spooler' | 'image';

/** 统一打印任务（已解析好变量/公式/流水号） */
export interface PrintJobInput {
  tenantId: number;
  jobId: number;
  templateId: number;
  printer: {
    type: ProviderType;
    dpi: number;
    widthMm: number;
    heightMm: number;
    offsetXMm: number;
    offsetYMm: number;
    orientation: 0 | 90 | 180 | 270;
    /** 打印浓度（ZPL ~SD / TSPL DENSITY） */
    density?: number;
    /** 打印速度（ZPL ^PR / TSPL SPEED） */
    speed?: number;
    /** 指令协议：zpl（斑马）/ tspl（台半等）/ epl（老 Zebra/Eltron 页模式机） */
    protocol?: 'zpl' | 'tspl' | 'epl' | 'browser';
    /** 标签间隙 mm（TSPL GAP） */
    gapMm?: number;
    connection: { host?: string; port?: number; driverName?: string; protocol?: string; [k: string]: any };
  };
  copies: number;
  // 每张标签的元素（由渲染层产出，已替换占位）
  labels: LabelFrame[];
}

export interface LabelFrame {
  // 一套元素，可同时包含 ZPL / TSPL / EPL 三种描述，由 Provider 选用其一
  zpl?: ZplElement[];
  tspl?: TsplElement[];
  epl?: EplElement[];
  // 服务端出图通道使用（ImageProvider）
  pngBuffer?: Buffer;
}

export interface PrinterProvider {
  readonly type: ProviderType;
  /** 校验打印机连通性/参数 */
  validate(printer: PrintJobInput['printer']): Promise<void>;
  /** 执行打印，返回结果 */
  print(job: PrintJobInput): Promise<PrintResult>;
}

// =============================================================================
// 实现 1：RawTcpProvider —— 直连网络打印机 9100 端口发送 ZPL/TSPL 指令流
// 适用：斑马/台半等支持 raw socket 的工业打印机；低延迟、无驱动依赖。
// =============================================================================
import { generateZpl, buildJob as buildZplJob, mmToDots } from '../core/zpl-generator';
import { buildJob as buildTsplJob } from '../core/tspl-generator';
import { generateEpl } from '../core/epl-generator';
import { attachBitmapFallbacks } from '../core/raster';
import { createConnection } from 'net';

/** 指令导出/下发支持的协议（与 PrintCommandsDto、core/barcode-caps.PrintProtocol 同步） */
export type CommandProtocol = 'zpl' | 'tspl' | 'epl';

export class RawTcpProvider implements PrinterProvider {
  readonly type: ProviderType = 'raw_tcp';

  async validate(printer: PrintJobInput['printer']): Promise<void> {
    if (!printer.connection.host) throw new Error('raw_tcp 需要 host');
    // 可选：发空连接探测端口通断（此处仅校验参数）
  }

  async print(job: PrintJobInput): Promise<PrintResult> {
    const { printer, labels, copies } = job;
    const host = printer.connection.host!;
    const port = printer.connection.port ?? 9100; // 默认 9100

    const protocol = ((printer.protocol === 'browser' ? 'zpl' : printer.protocol)
      || printer.connection.protocol || 'zpl') as CommandProtocol;
    const offX = mmToDots(printer.offsetXMm ?? 0, printer.dpi);
    const offY = mmToDots(printer.offsetYMm ?? 0, printer.dpi);

    // ★ 这里全程用 Buffer 组装，不再走 string：
    //   TSPL 的 BITMAP 数据段与 EPL 的 GW 数据段是原始二进制，旧实现那句
    //   `.toString('ascii')` 会把每个字节的高位抹掉（实测 0x80→0x00、0xFF→0x7F），
    //   **字节数不变**，所以头部声明的行宽/行数照样「对得上」，固件不报错，
    //   打出来的却是一张点位被改过的图 —— 这类缺陷不会以故障形式暴露，只能靠字节断言防住。
    //   ZPL 的 ^CI28 中文同理不能按 ascii 发。
    const zplFrames: string[] = [];
    const chunks: Buffer[] = [];
    for (const f of labels) {
      if (protocol === 'tspl') {
        // 位图回填点阵在这里出（能力矩阵判为 bitmap 的二维符号 / image 元素）
        const prepared = await attachBitmapFallbacks(f.tspl ?? [], printer.dpi, 'tspl');
        chunks.push(buildTsplJob(
          prepared.els,
          printer.dpi,
          {
            widthMm: printer.widthMm,
            heightMm: printer.heightMm,
            gapMm: printer.gapMm ?? 2,
            copies: Math.max(1, copies),
          },
          printer.orientation,
        ).buffer);
      } else if (protocol === 'epl') {
        // EPL2 手册没有 OFFSET 指令（[M] 命令目录里只有 A/B/b/D/GW/N/P/q/Q/S/X/Z），
        // 所以打印偏移在这里等价地折算成元素坐标平移
        const els = (f.epl ?? []).map((e: any) => ({
          ...e,
          xMm: Number(e.xMm ?? 0) + (printer.offsetXMm ?? 0),
          yMm: Number(e.yMm ?? 0) + (printer.offsetYMm ?? 0),
        }));
        const prepared = await attachBitmapFallbacks(els, printer.dpi, 'epl');
        const out = generateEpl(prepared.els, printer.dpi, {
          widthMm: printer.widthMm,
          heightMm: printer.heightMm,
          gapMm: printer.gapMm ?? 2,
          copies: Math.max(1, copies),
          density: printer.density,
          speed: printer.speed,
          orientation: printer.orientation,
        });
        // GW 载荷是 latin1 逐字节；页头/元素/页尾全是 ASCII，所以 latin1 是无损的
        chunks.push(Buffer.from(out.text, 'latin1'));
      } else {
        const prepared = await attachBitmapFallbacks(f.zpl ?? [], printer.dpi, 'zpl');
        const { text: raw } = generateZpl(prepared.els, printer.dpi);
        const head = `^LH${offX},${offY}`
          + (printer.density !== undefined && printer.density !== null ? `~SD${printer.density}` : '')
          + (printer.speed !== undefined && printer.speed !== null ? `^PR${printer.speed}` : '');
        zplFrames.push(raw.replace('^XA', `^XA${head}`));
      }
    }

    let payload: Buffer;
    if (protocol === 'zpl') {
      payload = Buffer.from(buildZplJob(zplFrames, Math.max(1, copies)), 'utf8');
    } else {
      const pre: string[] = [];
      if (protocol === 'tspl') {
        if (printer.density !== undefined && printer.density !== null) pre.push(`DENSITY ${printer.density}`);
        if (printer.speed !== undefined && printer.speed !== null) pre.push(`SPEED ${printer.speed}`);
        if (offX || offY) pre.push(`OFFSET ${offX},${offY}`);
      }
      payload = Buffer.concat([...pre.map((s) => Buffer.from(`${s}\r\n`, 'utf8')), ...chunks]);
    }
    return new Promise<PrintResult>((resolve) => {
      const socket = createConnection({ host, port, timeout: 5000 });
      let settled = false;
      const done = (r: PrintResult) => { if (!settled) { settled = true; resolve(r); } };
      socket.on('connect', () => socket.write(payload, () => { socket.end(); done({ ok: true, jobId: job.jobId, bytes: payload }); }));
      socket.on('timeout', () => { socket.destroy(); done({ ok: false, error: '连接超时' }); });
      socket.on('error', (e) => done({ ok: false, error: e.message }));
    });
  }
}

// =============================================================================
// 实现 2：ImageProvider —— 服务端渲染 PNG/PDF（存档 & 第三方集成 & 本地代理）
// 适用：需要矢量 PDF 精确归档、或没有物理打印机时的预览/留档。
// 这里演示 PNG 出图；PDF 用 pdf-lib 叠加（示意）。canvas 为可选依赖（懒加载）。
// =============================================================================

export class ImageProvider implements PrinterProvider {
  readonly type: ProviderType = 'image';

  async validate(): Promise<void> { /* 无需连接校验 */ }

  async print(job: PrintJobInput): Promise<PrintResult> {
    const { printer, labels } = job;
    // 逐张渲染为 PNG（mm→px 按 printer.dpi）
    const pngs: Buffer[] = [];
    for (const frame of labels) {
      if (frame.pngBuffer) { pngs.push(frame.pngBuffer); continue; }
      // 优先用 node-canvas 绘制（若已安装）；否则用内置 PNG 写出占位文本位图
      pngs.push(this.renderWithCanvasOrFallback(frame, printer));
    }
    return { ok: true, bytes: pngs[0], jobId: job.jobId };
  }

  private renderWithCanvasOrFallback(frame: LabelFrame, printer: PrintJobInput['printer']): Buffer {
    try {
      // 懒加载可选依赖 canvas（未安装时回退到内置编码器）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createCanvas } = require('canvas');
      const w = Math.round((printer.widthMm * printer.dpi) / 25.4);
      const h = Math.round((printer.heightMm * printer.dpi) / 25.4);
      const cv = createCanvas(w, h);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      for (const el of frame.zpl ?? []) {
        const x = (el.xMm * printer.dpi) / 25.4;
        const y = (el.yMm * printer.dpi) / 25.4;
        if (el.type === 'text') {
          ctx.fillStyle = '#000';
          ctx.font = `${Math.round((el.fontHeightMm ?? 3) * printer.dpi / 25.4)}px sans-serif`;
          ctx.fillText(el.text ?? '', x, y);
        }
        // 条码/二维码实际应调用 @bwip-js 渲染到 canvas
      }
      return cv.toBuffer('image/png');
    } catch {
      // 回退：生成一张白底占位 PNG（真实场景接入 @bwip-js/node）
      const { encodeGrayPng } = require('../core/png');
      const w = Math.max(1, Math.round((printer.widthMm * printer.dpi) / 25.4));
      const h = Math.max(1, Math.round((printer.heightMm * printer.dpi) / 25.4));
      const px = new Uint8Array(w * h).fill(255);
      return encodeGrayPng(w, h, px);
    }
  }
}

// =============================================================================
// 注册表（插件化扩展点）
// =============================================================================
export class PrinterProviderRegistry {
  private static map = new Map<ProviderType, new () => PrinterProvider>();
  static register(type: ProviderType, ctor: new () => PrinterProvider) { this.map.set(type, ctor); }
  static get(type: ProviderType): PrinterProvider {
    const C = this.map.get(type);
    if (!C) throw new Error(`未注册的打印 Provider: ${type}`);
    return new C();
  }
}
// 默认注册
PrinterProviderRegistry.register('raw_tcp', RawTcpProvider);
PrinterProviderRegistry.register('image', ImageProvider);
// 浏览器通道由前端 @page 完成，无需服务端 Provider；windows_spooler 由本地代理对接。
