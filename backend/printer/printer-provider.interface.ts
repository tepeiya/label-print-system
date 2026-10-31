// =============================================================================
// printer-provider.interface.ts —— 打印通道抽象（插件化）
// 任何新打印机协议（ZPL/TSPL/EPL/CPCL/驱动）只需实现 PrinterProvider 并注册。
// print() 入参为「已渲染的标签帧」序列；由上层把模板+数据+流水号渲染成元素数组，
// 再由对应 Provider 转成指令/图片/PDF。
// =============================================================================

import type { PrintResult } from '../core/types';
import type { ZplElement } from '../core/zpl-generator';
import type { TsplElement } from '../core/tspl-generator';

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
    connection: { host?: string; port?: number; driverName?: string };
  };
  copies: number;
  // 每张标签的元素（由渲染层产出，已替换占位）
  labels: LabelFrame[];
}

export interface LabelFrame {
  // 一套元素，可同时包含 ZPL 与 TSPL 两种描述，由 Provider 选用其一
  zpl?: ZplElement[];
  tspl?: TsplElement[];
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
import { generateZpl, buildJob as buildZplJob } from '../core/zpl-generator';
import { buildJob as buildTsplJob } from '../core/tspl-generator';
import { createConnection } from 'net';

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

    // 根据打印机类型选择指令集：此处以 ZPL 为例（TSPL 同理，见 buildTsplJob）
    const frames = labels.map((f) => generateZpl(f.zpl ?? [], printer.dpi));
    const payload = Buffer.from(buildZplJob(frames, copies), 'ascii');

    return new Promise<PrintResult>((resolve) => {
      const socket = createConnection({ host, port, timeout: 5000 });
      let settled = false;
      const done = (r: PrintResult) => { if (!settled) { settled = true; resolve(r); } };
      socket.on('connect', () => socket.write(payload, () => { socket.end(); done({ ok: true, jobId: job.jobId }); }));
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
