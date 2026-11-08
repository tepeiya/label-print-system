// =============================================================================
// tspl-generator.ts —— TSPL（TSC 指令，台半等打印机）指令生成
// 覆盖：SIZE/DIRECTION/GAP 页面头、TEXT、BARCODE、QRCODE、BITMAP（位图回填）。
// 坐标换算：TSPL 默认 203dpi（1mm=8 dots），新机型支持 DPI 设置；按 printer.dpi 换算
//   dots = mm * dpi / 25.4。指令以 \r\n 结尾。
//
// P7.3/P7.4 在本文件里修的三件事：
//   1) GS1-128 必须用码型 "EAN128"（TSC 手册里 EAN128 = GS1-128，旧称 UCC/EAN-128）。
//      之前映射成 "128" 会打成普通 Code128 —— 符号能扫，但扫出来是一整串裸数字，
//      AI 结构全丢，属于"数据错但看不出来"的那类事故。
//   2) EAN/UPC 是固定比例码制，wide 必须等于 narrow，之前一律 wide=narrow×ratio，
//      打出来是非法符号。
//   3) BITMAP 之前只发指令头、不带点阵数据（等于什么都没打）。现在按 TSC 的
//      数据格式下发真实二进制：width 单位字节、height 单位点、1=打印点、MSB 在左，
//      数据紧跟指令头、不做任何编码。
//      ⚠️ 因此 TSPL 作业里混了「UTF-8 文本 + 原始字节」，不能整体按 utf8 编码，
//      必须分段 Buffer.concat（见 tsplParts / buildJob）。
// 码制能不能原生输出，一律查 barcode-caps.ts 的 planChannel。
// =============================================================================

import type { BarcodeSpec, BitmapFallback, QrcodeSpec } from './types';
import { capNote, planChannel } from './barcode-caps';
import { compute2dGeometry, computeGeometry, normSym } from './barcode-geometry';
import { gs1ToRawStream, parseGs1, validateGs1 } from './gs1';

export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

export interface TsplElement {
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'box' | 'line' | 'ellipse';
  xMm: number; yMm: number;
  rotation?: 0 | 90 | 180 | 270;
  text?: string; fontHeightMm?: number; fontWidthMm?: number; bold?: boolean;
  barcode?: BarcodeSpec;
  qrcode?: QrcodeSpec;
  imageData?: Buffer | string; imgWmm?: number; imgHmm?: number;
  wMm?: number; hMm?: number; x2Mm?: number; y2Mm?: number;
  borderMm?: number; strokeMm?: number;
  /** 位图回填点阵（P7.3），由 raster.attachBitmapFallbacks 预生成 */
  fallback?: BitmapFallback;
}

/** 一行指令，或「指令头 + 原始字节」的二进制段（BITMAP 数据不能走文本编码） */
export type TsplPart = string | { head: string; bin: Buffer };

// =============================================================================
// TSPL BARCODE 码型表（照抄 TSC《TSPL Programming Guide》BARCODE 一节）：
//   128 / 128M / EAN128 / EAN128M / 39 / 39C / 93 / EAN13(+2/+5) / EAN8(+2/+5)
//   / UPCA(+2/+5) / UPCE(+2/+5) / ITF / ITF14 / EAN14 / CODABAR / POSTNET
//   / CPOST / MSI / MSIC / PLESSEY
// 二维只有 QRCODE 指令（DATAMATRIX / PDF417 / AZTEC / MicroQR 无原生指令 → 位图通道）。
// =============================================================================
const TSPL_CODE_TYPE: Record<string, string> = {
  CODE128: '128',
  GS1_128: 'EAN128',      // ★ 不是 "128"
  CODE39: '39',
  CODE93: '93',
  EAN13: 'EAN13',
  EAN8: 'EAN8',
  UPC: 'UPCA',
  UPC_A: 'UPCA',
  UPC_E: 'UPCE',
  ITF: 'ITF',
  ITF14: 'ITF14',
  CODABAR: 'CODABAR',
  MSI: 'MSI',
};

/**
 * 生成单张标签的指令段（不含 SIZE/DIRECTION 等页头，由 buildJob 封装）。
 * 需要纯文本（测试/预览）时用 generateTspl().text；要发给打印机请用 buildJob().buffer。
 */
export function tsplParts(els: TsplElement[], dpi: number): { parts: TsplPart[]; warnings: string[] } {
  const L: TsplPart[] = [];
  const warnings: string[] = [];

  for (const e of els) {
    const x = mmToDots(e.xMm, dpi);
    const y = mmToDots(e.yMm, dpi);
    const rot = e.rotation ?? 0;

    switch (e.type) {
      case 'text': {
        if (!String(e.text ?? '').trim()) break;
        // TEXT x,y,"font",rotation,x-mul,y-mul,"content" —— FONT001 基准约 12 dots 高（203dpi）
        const baseDots = 12;
        const my = Math.max(1, Math.round(mmToDots(e.fontHeightMm ?? 3, dpi) / baseDots));
        const mx = Math.max(1, Math.round(mmToDots(e.fontWidthMm ?? (e.fontHeightMm ?? 3) * 0.6, dpi) / baseDots));
        L.push(`TEXT ${x},${y},"FONT001",${rot},${mx},${my},"${esc(e.text ?? '')}"`);
        break;
      }
      case 'barcode':
        emitBarcode(L, warnings, e, dpi, x, y, rot);
        break;
      case 'qrcode':
        emitQrcode(L, warnings, e, dpi, x, y, rot);
        break;
      case 'box': {
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        const t = Math.max(1, mmToDots(e.borderMm ?? 0.3, dpi));
        L.push(`BOX ${x},${y},${x + w},${y + h},${t}`);
        break;
      }
      case 'ellipse': {
        const w = Math.max(1, mmToDots(e.wMm ?? 0, dpi));
        const h = Math.max(1, mmToDots(e.hMm ?? 0, dpi));
        const t = Math.max(1, mmToDots(e.borderMm ?? 0.3, dpi));
        L.push(`ELLIPSE ${x},${y},${x + w},${y + h},${t}`);
        break;
      }
      case 'line': {
        const x2 = mmToDots(e.x2Mm ?? e.xMm, dpi);
        const y2 = mmToDots(e.y2Mm ?? e.yMm, dpi);
        const t = Math.max(1, mmToDots(e.strokeMm ?? 0.3, dpi));
        // BAR x,y,width,height —— 水平线；垂直线用 BAR 的宽高互换表示；斜线退化为外接框
        if (Math.abs(y2 - y) <= t) L.push(`BAR ${Math.min(x, x2)},${y},${Math.abs(x2 - x)},${t}`);
        else if (Math.abs(x2 - x) <= t) L.push(`BAR ${x},${Math.min(y, y2)},${t},${Math.abs(y2 - y)}`);
        else L.push(`BOX ${Math.min(x, x2)},${Math.min(y, y2)},${Math.max(x, x2)},${Math.max(y, y2)},${t}`);
        break;
      }
      case 'image': {
        if (!e.fallback) {
          warnings.push('[图像] TSPL image 元素未预置点阵数据（调用方未走位图通道），该元素已跳过。建议经 /print/commands 或 RawTcpProvider 打印，这两条路径会预生成 BITMAP 点阵');
          break;
        }
        L.push(...bitmapParts(e.fallback, x, y, dpi, warnings, 'TSPL'));
        break;
      }
    }
  }
  return { parts: L, warnings };
}

/** 兼容旧签名：把指令段压成字符串。⚠️ 含位图时二进制按 latin1 内联，
 *  直接 utf8 编码会破坏点阵 —— 要发给打印机请用 buildJob().buffer。 */
export function generateTspl(els: TsplElement[], dpi: number): { text: string; warnings: string[] } {
  const { parts, warnings } = tsplParts(els, dpi);
  return { text: parts.map(partText).join('\r\n'), warnings };
}

function partText(p: TsplPart): string {
  return typeof p === 'string' ? p : p.head + p.bin.toString('latin1');
}

// =============================================================================
// BARCODE
// =============================================================================
function emitBarcode(
  L: TsplPart[], warnings: string[], e: TsplElement, dpi: number,
  x: number, y: number, rot: number,
): void {
  const b = e.barcode!;
  const sym = normSym(b.sym);
  const plan = planChannel(sym, 'tspl', b.content);
  if (plan.channel !== 'native') {
    warnings.push(
      `[码制] TSPL 无法原生输出 ${sym}：${plan.why ?? capNote(sym, 'tspl')}。该元素已跳过。`
      + `建议：①改用 ZPL 协议（^B 家族覆盖更广）；②用 protocol=image 走 bwip-js 位图；③换成业务等效码制`,
    );
    return;
  }
  const codeType = tsplCodeType(sym, b);
  if (!codeType) {
    // 能力矩阵说 native 但码型表里没有 —— 属于代码 bug，宁可停下来也不猜
    throw new Error(`emitBarcode: 能力矩阵标记 ${sym} 为 TSPL native，但 TSPL_CODE_TYPE 未登记码型`);
  }

  const geo = computeGeometry({
    sym, dpi,
    moduleWidthMm: b.moduleWidthMm, wideRatio: b.wideRatio, heightMm: b.heightMm,
    quietZoneMm: (b as any).quietZoneMm, content: b.content,
  });
  warnings.push(...geo.warnings);

  // TSPL 的 narrow/wide 单位是「点」，手册允许 1–10；越界钳到上限并提示
  const narrow = clamp(geo.xDots, 1, 10, `${sym} 窄元素宽度`, warnings);
  // 固定比例码制（EAN/UPC）宽必须等于窄，否则符号非法
  const wide = geo.fixedRatio ? narrow : clamp(geo.wideDots, narrow, 10, `${sym} 宽元素宽度`, warnings);
  const height = clamp(geo.heightDots, 1, 9999, `${sym} 条码高度`, warnings);

  // 人类可读：0=不打印，1=打印（TSC 手册该位还接受 2/3 = 居中/右对齐）
  const human = b.showText ? 1 : 0;
  if (b.showText && b.textPosition === 'top') {
    warnings.push(`[版式] TSPL BARCODE 无「明文在上」参数，${sym} 的人类可读行按打印机默认位置（符号下方）输出`);
  }
  if (rot === 90 || rot === 270) {
    warnings.push(`[版式] ${sym} 旋转 ${rot}°：TSPL 的人类可读文字方向跟随符号旋转，若机型字库不支持该朝向，明文可能缺字`);
  }

  const content = tsplBarcodeContent(sym, b, warnings);
  if (content === undefined) return;
  L.push(`BARCODE ${x},${y},"${codeType}",${height},${human},${rot},${narrow},${wide},${tsplString(content)}`);
}

/**
 * GS1-128 数据：码型 EAN128 本身代表「起始 FNC1 的 Code128」，
 * 因此只需按 GS1 General Specifications 在**变长 AI 之后**插入分隔符 GS(0x1D)。
 * 定长 AI 后不加 GS；末尾不加。解析失败时跳过并 warning（不猜 FNC1 位置）。
 * 其它码制：Code128/Code39 等直接用原内容；MSI 显式要校验位时用 MSIC 码型。
 */
function tsplBarcodeContent(sym: string, b: BarcodeSpec, warnings: string[]): string | undefined {
  if (sym === 'GS1_128') {
    let comps;
    try {
      comps = parseGs1(b.content);
    } catch (err: any) {
      warnings.push(`[GS1] GS1-128 内容解析失败：${err?.message ?? err}。该元素已跳过（不能凭猜测插 GS 分隔符）`);
      return undefined;
    }
    const errs = validateGs1(comps);
    if (errs.length) warnings.push(`[GS1] ${errs.join('；')}`);
    return gs1ToRawStream(comps);
  }
  if (sym === 'MSI' && b.checksum === true) {
    warnings.push('[校验位] MSI 改用 TSPL 码型 MSIC（带校验位版本）：扫描结果会比预览数据多一位');
  }
  if (sym === 'ITF') {
    const digits = String(b.content ?? '').replace(/\D/g, '');
    if (digits.length % 2 !== 0) {
      warnings.push(`[码制] ITF 数据为奇数位（${digits.length}）：交叉二五码按数字对编码，奇数位会被打印机补 0，扫描结果与预览不同`);
    }
  }
  return String(b.content ?? '');
}

/** MSI 要校验位时换码型：MSI → MSIC（TSC 码型表里的「MSI with check digit」） */
function tsplCodeType(sym: string, b: BarcodeSpec): string {
  if (sym === 'MSI' && b.checksum === true) return 'MSIC';
  return TSPL_CODE_TYPE[sym];
}

// =============================================================================
// QRCODE / 位图回填
// =============================================================================
function emitQrcode(
  L: TsplPart[], warnings: string[], e: TsplElement, dpi: number,
  x: number, y: number, rot: number,
): void {
  const q = e.qrcode!;
  const sym = normSym(q.sym ?? 'QRCODE');
  const plan = planChannel(sym, 'tspl', q.content);

  if (plan.channel !== 'native') {
    if (!e.fallback) {
      warnings.push(`[码制] TSPL ${plan.channel === 'bitmap' ? '需位图回填但未拿到点阵' : '无法输出'}：${plan.why ?? capNote(sym, 'tspl')}。该元素已跳过。建议改用 ZPL 协议或 protocol=image`);
      return;
    }
    L.push(...bitmapParts(e.fallback, x, y, dpi, warnings, 'TSPL', plan.why ?? capNote(sym, 'tspl')));
    return;
  }

  const geo = compute2dGeometry({ sym, dpi, moduleSizeMm: q.moduleSizeMm, quietZoneMm: q.quietZoneMm });
  warnings.push(...geo.warnings);
  // QRCODE 的 cell size 手册范围 1–10（点/模块）
  const cell = clamp(geo.moduleDots, 1, 10, `${sym} 模块尺寸（cell size）`, warnings);
  const ecc = ({ H: 'H', Q: 'Q', M: 'M', L: 'L' } as Record<string, string>)[q.ecc ?? 'M'] ?? 'M';
  // QRCODE x,y,ECC,cell size,mode,rotation[,model],[mask],content
  // ⚠️ model 只能是 M2/A（标准 QR）；TSC 无 Micro QR / RMQR 模型参数。
  L.push(`QRCODE ${x},${y},${ecc},${cell},A,${rot},${tsplString(q.content)}`);
}

// =============================================================================
// BITMAP 段：指令头 + 原始字节
// TSC: BITMAP X,Y,width(bytes),height(dots),mode,data —— mode 0=OVERWRITE/1=OR/2=XOR
// data 恰好 width×height 字节，逐行、MSB 在左、1=打印点、不做任何编码（不转 hex、不压缩）
// =============================================================================
function bitmapParts(
  b: BitmapFallback, x: number, y: number, dpi: number,
  warnings: string[], label: string, why?: string,
): TsplPart[] {
  if (b.hex.length !== b.bytesPerRow * b.heightDots * 2) {
    warnings.push(`[位图] ${label} 点阵长度不符（hex ${b.hex.length} 字符，应为 ${b.bytesPerRow * b.heightDots * 2}），该元素已跳过`);
    return [];
  }
  // 指令头以逗号收尾，数据紧随其后（TSC 的 BITMAP 参数与 data 之间没有分隔符约定，
  // 手册示例是 `BITMAP x,y,w,h,mode,` + 原始字节 + CRLF）
  const head = `BITMAP ${x},${y},${b.bytesPerRow},${b.heightDots},0,`;
  if (why) {
    warnings.push(`[位图] ${why}；已用 bwip-js 点阵经 BITMAP 下发（${b.widthDots}×${b.heightDots} 点 = ${b.bytesPerRow} 字节/行，${((b.widthDots * 25.4) / dpi).toFixed(2)}mm 宽），可扫但不是打印机原生符号`);
  }
  return [{ head, bin: Buffer.from(b.hex, 'hex') }];
}

/** 参数钳制（越界如实提示，不静默改数据） */
function clamp(v: number, min: number, max: number, what: string, warnings: string[]): number {
  if (!Number.isFinite(v) || v < min) {
    warnings.push(`[参数] ${what} ${v} 低于下限，已抬到 ${min}`);
    return min;
  }
  if (v > max) {
    warnings.push(`[参数] ${what} ${v} 超出 TSPL 允许上限 ${max}，已钳到 ${max}（如需更大物理尺寸请提高 dpi 或缩小元素尺寸）`);
    return max;
  }
  return Math.round(v);
}

/** TSPL 字符串参数：内容用双引号包裹，内部双引号成对转义 */
function tsplString(s: string): string {
  return `"${esc(String(s ?? ''))}"`;
}

/**
 * 封装整张作业页头 + 元素 + 打印命令。
 * ⚠️ 输出必须是 Buffer：文本段 utf8、BITMAP 数据段原样字节，混在一起不能整体按 utf8 编码。
 * @returns { buffer: Buffer; warnings: string[] }
 */
export function buildJob(
  els: TsplElement[],
  dpi: number,
  page: { widthMm: number; heightMm: number; gapMm?: number; copies?: number },
  orientation: 0 | 90 | 180 | 270 = 0,
): { buffer: Buffer; warnings: string[] } {
  const w = mmToDots(page.widthMm, dpi);
  const h = mmToDots(page.heightMm, dpi);
  const gap = mmToDots(page.gapMm ?? 2, dpi);
  const { parts, warnings } = tsplParts(els, dpi);

  const head: string[] = [
    'CLS',                                   // 清缓冲
    `SIZE ${w} ${h}`,                        // 标签尺寸（dots）
    `DIRECTION ${orientation === 0 ? 0 : 1}`,// 走纸方向
    `GAP ${gap} 0`,                          // 标签间距
  ];
  const tail = `PRINT ${page.copies ?? 1},1`;

  const chunks: Buffer[] = [];
  for (const line of [...head, ...parts, tail]) {
    if (typeof line === 'string') chunks.push(Buffer.from(line + '\r\n', 'utf8'));
    else {
      chunks.push(Buffer.from(line.head, 'utf8'));  // 指令头自带结尾逗号
      chunks.push(line.bin);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  return { buffer: Buffer.concat(chunks), warnings };
}

/** 码制归一化 → TSPL 码型；能力矩阵以外的码制返回 undefined（调用方出 warning） */
export function tsplCodeOf(sym: string): string | undefined {
  return TSPL_CODE_TYPE[normSym(sym)];
}

/** TSPL 文本按双引号包裹，内部双引号按 TSC 习惯成对转义 */
function esc(s: string): string { return s.replace(/"/g, '""'); }
