// =============================================================================
// zpl-generator.ts —— ZPL II 指令生成器（斑马等 ZPL 打印机）
// 覆盖：文本 ^FO/^A0、条码 ^BC/^BY、二维码 ^BQ、图片 ^GF、流水号（由数据预填）。
// 坐标换算：所有 mm 在生成时按 printer.dpi 转 dots：dots = mm * dpi / 25.4。
//   - 203dpi → 8 dots/mm；300dpi → 11.81 dots/mm；600dpi → 23.62 dots/mm
// 注意：ZPL 原点在左上角；旋转用 ^FW 或元素级 ^A 的朝向参数。
// =============================================================================

import type { BarcodeSpec, QrcodeSpec } from './types';

/** mm → dots（按 dpi）。核心换算公式，全指令生成统一使用 */
export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

export interface ZplElement {
  type: 'text' | 'barcode' | 'qrcode' | 'image';
  xMm: number; yMm: number;
  // 通用
  rotation?: 0 | 90 | 180 | 270;
  // text
  text?: string; fontFamily?: string; fontHeightMm?: number; fontWidthMm?: number;
  bold?: boolean; align?: 'L' | 'C' | 'R';
  colorInvert?: boolean;
  // barcode
  barcode?: BarcodeSpec;
  // qrcode
  qrcode?: QrcodeSpec;
  // image
  imageData?: string;   // base64 的 ^GF 数据（行压缩或 ASCII hex）
  imgWmm?: number; imgHmm?: number;
}

/** 字体点阵高度（mm→dots），ZPL ^A0 高度以 dots 计 */
function fontDots(mm: number, dpi: number) { return mmToDots(mm, dpi); }

/**
 * 生成单个标签的完整 ZPL（不含作业头尾 ^XA/^XZ 由调用方包）。
 * @param els 已按数据行解析好的元素数组（含流水号已替换）
 * @param dpi 打印机 dpi
 */
export function generateZpl(els: ZplElement[], dpi: number): string {
  const out: string[] = ['^XA']; // 标签起始

  for (const e of els) {
    const x = mmToDots(e.xMm, dpi);
    const y = mmToDots(e.yMm, dpi);
    const rot = e.rotation ?? 0;

    switch (e.type) {
      case 'text': {
        // ^FO x,y ^A0 N,h,w ^FD text ^FS
        const h = fontDots(e.fontHeightMm ?? 3, dpi);
        const w = fontDots(e.fontWidthMm ?? h * 0.6, dpi);
        out.push(`^FO${x},${y}^A0${e.bold ? 'B' : 'N'},${h},${w}^FD${esc(e.text ?? '')}^FS`);
        break;
      }
      case 'barcode': {
        const b = e.barcode!;
        // ^BY 模块宽dots, 宽窄比, 条码高dots
        const byW = mmToDots(b.moduleWidthMm, dpi);
        const bh = mmToDots(b.heightMm, dpi);
        // ^BC o,h,f,g,e（Code128：o 朝向, h 高, f 打印明文, g 上方, e 校验位）
        const checksum = b.checksum === false ? 'N' : 'Y';
        out.push(`^FO${x},${y}^BY${byW},${b.wideRatio},${bh}`);
        out.push(`^BC${rot},${bh},${b.showText ? 'Y' : 'N'},N,${checksum}^FD${esc(b.content)}^FS`);
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        // ^BQ o,r,m,u（o 朝向, r=模型1/2, m 放大系数, u=纠错等级 1-4 对应 H-Q-M-L 反向）
        const eccMap: Record<string, string> = { H: '4', Q: '3', M: '2', L: '1' };
        const moduleDots = mmToDots(q.moduleSizeMm, dpi); // 放大系数由模块尺寸近似
        const m = Math.max(1, Math.round(moduleDots / 4)); // ZPL 放大系数 1-10
        out.push(`^FO${x},${y}^BQ${rot},2,${m},${eccMap[q.ecc]}^FDQA,${esc(q.content)}^FS`);
        break;
      }
      case 'image': {
        const iw = mmToDots(e.imgWmm ?? 10, dpi);
        const ih = mmToDots(e.imgHmm ?? 10, dpi);
        // ^GF a,c,b,xw,yw,data —— 实际应用用行压缩(RLE)减小体积，此处示意 ASCII
        out.push(`^FO${x},${y}^GFA,${e.imageData?.length ?? 0},${e.imageData?.length ?? 0},,${iw},${ih},^FS`);
        out.push(e.imageData ?? '');
        break;
      }
    }
  }

  out.push('^XZ'); // 标签结束
  return out.join('\n');
}

/** 转义 ZPL 控制字符（^ 与 ~ 需替换为 ^5e / ^5f，或按需处理） */
function esc(s: string): string {
  return s.replace(/\^/g, '\\^').replace(/~/g, '\\~');
}

/**
 * 完整作业（含张数 ^PQ）：用于 RawTcp Provider 直发。
 * @param labels 每张标签的 ZPL 片段数组
 * @param copies 每张打印份数
 */
export function buildJob(labels: string[], copies = 1): string {
  return labels.map((l) => l.replace('^XA', `^XA^PQ${copies}`)).join('\n');
}
