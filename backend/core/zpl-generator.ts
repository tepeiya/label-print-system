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
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'box' | 'line' | 'ellipse';
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
  // 图形（矩形 / 直线 / 椭圆）
  wMm?: number; hMm?: number; x2Mm?: number; y2Mm?: number;
  borderMm?: number; strokeMm?: number;
}

/** 字体点阵高度（mm→dots），ZPL ^A0 高度以 dots 计 */
function fontDots(mm: number, dpi: number) { return mmToDots(mm, dpi); }

/** 元素旋转 → ZPL 朝向字符（N=0° R=90° I=180° B=270°） */
function zplOrient(rot: number): 'N' | 'R' | 'I' | 'B' {
  return ({ 90: 'R', 180: 'I', 270: 'B' } as const)[rot as 90 | 180 | 270] ?? 'N';
}

/**
 * 生成单个标签的完整 ZPL（不含作业头尾 ^XA/^XZ 由调用方包）。
 * @param els 已按数据行解析好的元素数组（含流水号已替换）
 * @param dpi 打印机 dpi
 */
export function generateZpl(els: ZplElement[], dpi: number): string {
  const out: string[] = ['^XA', '^CI28', '^FH\\']; // 标签起始 + UTF-8 + 十六进制转义开关

  for (const e of els) {
    const x = mmToDots(e.xMm, dpi);
    const y = mmToDots(e.yMm, dpi);
    const rot = e.rotation ?? 0;
    const orient = zplOrient(rot);

    switch (e.type) {
      case 'text': {
        const text = String(e.text ?? '');
        if (!text) break; // 空文本不产生指令
        // ^FO x,y ^A0 N,h,w ^FD text ^FS
        const h = Math.max(1, fontDots(e.fontHeightMm ?? 3, dpi));
        const w = Math.max(1, fontDots(e.fontWidthMm ?? (e.fontHeightMm ?? 3) * 0.6, dpi));
        out.push(`^FO${x},${y}^A0${orient},${h},${w}^FD${esc(text)}^FS`);
        break;
      }
      case 'barcode': {
        const b = e.barcode!;
        const bh = Math.max(1, mmToDots(b.heightMm, dpi));
        const byW = Math.max(1, mmToDots(b.moduleWidthMm, dpi));
        // ^BY 宽窄比有效范围 2.0~3.0，缺省 2.5（uC 未传时为 undefined 会产生 ^BY2,undefined）
        const ratio = Number.isFinite(b.wideRatio)
          ? Math.min(3, Math.max(2, Math.round(Number(b.wideRatio) * 10) / 10))
          : 2.5;
        const human = b.showText ? 'Y' : 'N';
        const checksum = b.checksum === false ? 'N' : 'Y';
        out.push(`^FO${x},${y}^BY${byW},${ratio},${bh}`);
        out.push(...zplBarcodeLine(b.sym, orient, bh, human, checksum, b.content));
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        const key = String(q.sym ?? 'QRCODE').toUpperCase();
        const content = esc(q.content);
        const moduleDots = mmToDots(q.moduleSizeMm ?? 0.4, dpi);
        // ZPL 放大系数 1-10（每个模块 dots）
        const m = Math.min(10, Math.max(1, moduleDots));
        const bh = Math.max(1, mmToDots(e.hMm ?? 15, dpi));
        const eccMap: Record<string, string> = { H: 'H', Q: 'Q', M: 'M', L: 'L' };
        if (key.startsWith('DATA')) {
          // Data Matrix（含矩形版）：^BX o,h,s,e（e=200 为标准 ECC200）
          out.push(`^FO${x},${y}^BX${orient},${bh},${m},200^FD${content}^FS`);
        } else if (key.startsWith('PDF')) {
          // PDF417：^B2 o,h,f,g,e（f=N 不打印人类可读行）
          out.push(`^FO${x},${y}^B2${orient},${bh},N,N,Y^FD${content}^FS`);
        } else if (key.startsWith('AZTEC')) {
          // Aztec：^BO o,h,s,e
          out.push(`^FO${x},${y}^BO${orient},${bh},${m},0^FD${content}^FS`);
        } else {
          // QR / Micro QR：^BQ o,model,m,ecc
          out.push(`^FO${x},${y}^BQ${orient},2,${m},${eccMap[q.ecc ?? 'M'] ?? 'M'}^FDQA,${content}^FS`);
        }
        break;
      }
      case 'box': {
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        const t = Math.max(1, mmToDots(e.borderMm ?? 0.3, dpi));
        out.push(`^FO${x},${y}^GB${w},${h},${t},B^FS`);
        break;
      }
      case 'ellipse': {
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        const t = Math.max(1, mmToDots(e.borderMm ?? 0.3, dpi));
        out.push(`^FO${x},${y}^GE${w},${h},${t},B^FS`);
        break;
      }
      case 'line': {
        // 水平/垂直线用细长矩形还原；斜线 ZPL 无原生支持，退化为外接细框
        const x2 = mmToDots(e.x2Mm ?? e.xMm, dpi);
        const y2 = mmToDots(e.y2Mm ?? e.yMm, dpi);
        const t = Math.max(1, mmToDots(e.strokeMm ?? 0.3, dpi));
        const w = Math.max(t, Math.abs(x2 - x));
        const h = Math.max(t, Math.abs(y2 - y));
        out.push(`^FO${Math.min(x, x2)},${Math.min(y, y2)}^GB${w},${h},${t},B^FS`);
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

/** 码制归一化（前端使用 CODE128 / UPC_E / GS1_128 等大写标识） */
function zplSymKey(sym: string): string {
  const s = String(sym ?? '').toUpperCase().replace(/^CODE-?128$/, 'CODE128');
  return s
    .replace(/^UPCA$/, 'UPC')
    .replace(/^UPC-A$/, 'UPC')
    .replace(/^UPC-E$/, 'UPC_E')
    .replace(/^UPCE$/, 'UPC_E')
    .replace(/^INTERLEAVED2OF5$/, 'ITF');
}

/**
 * 按码制生成条码指令行（不同码制的参数顺序不同，不能统一用 ^BC）：
 *   ^BC o,h,f,g,e    Code128（f=打印明文, g=明文在上, e=UCC 校验位）
 *   ^B3 o,e,h,f,g    Code39（e=Mod-43 校验位）
 *   ^BA o,h,f,g,e    Code93
 *   ^BE/^B8 o,h,f,g  EAN-13 / EAN-8
 *   ^BU o,h,f,g,e    UPC-A
 *   ^B9 o,h,f,g,e    UPC-E
 *   ^BI o,h,f,g      Interleaved 2 of 5
 *   ^BK o,e,h,f,g    Codabar
 *   ^BM o,e,h,f,g    MSI
 */
function zplBarcodeLine(
  sym: string, orient: 'N' | 'R' | 'I' | 'B', bh: number,
  human: 'Y' | 'N', checksum: 'Y' | 'N', content: string,
): string[] {
  const key = zplSymKey(sym);
  const fd = esc(content);
  switch (key) {
    case 'GS1_128': {
      // GS1-128 = Code128 + FNC1：去掉人类可读的括号并前置 FNC1（>;）
      // 变长 AI 之间的 FNC1 分隔需在数据里写成 >8
      const data = String(content ?? '').replace(/[()]/g, '');
      return [`^BC${orient},${bh},${human},N,Y^FD>;${esc(data)}^FS`];
    }
    case 'CODE39':
      return [`^B3${orient},${checksum},${bh},${human},N^FD${fd}^FS`];
    case 'CODE93':
      return [`^BA${orient},${bh},${human},N,${checksum}^FD${fd}^FS`];
    case 'EAN13':
      return [`^BE${orient},${bh},${human},N^FD${fd}^FS`];
    case 'EAN8':
      return [`^B8${orient},${bh},${human},N^FD${fd}^FS`];
    case 'UPC':
      return [`^BU${orient},${bh},${human},N,${checksum}^FD${fd}^FS`];
    case 'UPC_E':
      return [`^B9${orient},${bh},${human},N,${checksum}^FD${fd}^FS`];
    case 'ITF14':
    case 'ITF':
      return [`^BI${orient},${bh},${human},N^FD${fd}^FS`];
    case 'CODABAR':
      return [`^BK${orient},${checksum},${bh},${human},N^FD${fd}^FS`];
    case 'MSI':
      return [`^BM${orient},${checksum},${bh},${human},N^FD${fd}^FS`];
    case 'CODE128':
    default:
      // 其余（PHARMACODE / CODE16K 等）统一回落 Code128，避免输出空指令
      return [`^BC${orient},${bh},${human},N,${checksum}^FD${fd}^FS`];
  }
}

/** 转义 ZPL 控制字符（^ ~ \ 会与指令冲突，用 ^FH 十六进制转义） */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\5C')
    .replace(/\^/g, '\\5E')
    .replace(/~/g, '\\7E');
}

/**
 * 完整作业（含张数 ^PQ）：用于 RawTcp Provider 直发。
 * @param labels 每张标签的 ZPL 片段数组
 * @param copies 每张打印份数
 */
export function buildJob(labels: string[], copies = 1): string {
  return labels.map((l) => l.replace('^XA', `^XA^PQ${copies}`)).join('\n');
}
