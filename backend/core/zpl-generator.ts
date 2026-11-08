// =============================================================================
// zpl-generator.ts —— ZPL II 指令生成器（斑马等 ZPL 打印机）
// 覆盖：文本 ^FO/^A0、条码 ^BY+^B 家族、二维码 ^BQ/^BX/^B7/^B0、位图回填 ^GF、
//       流水号（由数据预填）。
// 坐标换算：所有 mm 在生成时按 printer.dpi 转 dots：dots = mm * dpi / 25.4。
//   - 203dpi → 8 dots/mm；300dpi → 11.81 dots/mm；600dpi → 23.62 dots/mm
// 注意：ZPL 原点在左上角；旋转用 ^FW 或元素级 ^A 的朝向参数。
//
// 三条不可协商的规则（P7.3/P7.4/P7.6 的落点）：
//   1) 码制能不能原生输出、要不要位图回填，一律查 barcode-caps.ts 的 planChannel，
//      本文件不另写白名单（P7.2 之前 ^B2/^BI 用反、PDF417 用 ^B2、MicroQR 谎称原生，
//      根源就是白名单散落在生成器里）。
//   2) 拿不到位图点阵（调用方没预置 fallback）时**跳过 + 可执行 warning**，
//      绝不静默降级成另一种码制（docs/05-api.md §8.3）。
//   3) 几何参数（模块宽/宽窄比/高度/静区）来自 barcode-geometry，按打印点量化，
//      越界值钳制到协议允许范围并出 warning，而不是丢给固件报错。
// =============================================================================

import type { BarcodeSpec, BitmapFallback, QrcodeSpec } from './types';
import { capNote, planChannel } from './barcode-caps';
import { compute2dGeometry, computeGeometry, defaultRatio, normSym } from './barcode-geometry';
import { gs1ToZpl, parseGs1, validateGs1 } from './gs1';
import { zplGf } from './bitmap-blocks';

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
  imageData?: string;   // base64（PNG/JPG），由调用方预置；点阵在 fallback 里
  imgWmm?: number; imgHmm?: number;
  // 图形（矩形 / 直线 / 椭圆）
  wMm?: number; hMm?: number; x2Mm?: number; y2Mm?: number;
  borderMm?: number; strokeMm?: number;
  /**
   * 位图回填点阵（P7.3）。由 raster.attachBitmapFallbacks 在异步阶段预生成，
   * 生成器本身保持同步：拿到就出 ^GFA，拿不到就跳过 + warning。
   */
  fallback?: BitmapFallback;
}

/** 字体点阵高度（mm→dots），ZPL ^A0 高度以 dots 计 */
function fontDots(mm: number, dpi: number) { return mmToDots(mm, dpi); }

/** 元素旋转 → ZPL 朝向字符（N=0° R=90° I=180° B=270°） */
function zplOrient(rot: number): 'N' | 'R' | 'I' | 'B' {
  return ({ 90: 'R', 180: 'I', 270: 'B' } as const)[rot as 90 | 180 | 270] ?? 'N';
}

/**
 * 参数范围钳制：越界时出 warning。
 * 依据（ZPL II Command Summary / 各 ^B 命令参数表）：
 *   ^BY w（模块宽）1–35 点（早期固件上限 10 点）
 *   ^BY r（宽窄比）2.0–3.0，固定比例码制忽略该参数
 *   ^BQ h（放大系数）1–10；^B0/^BO（Aztec）1–20；^BX h 允许到标签宽度
 */
function clampDot(v: number, min: number, max: number, what: string, warnings: string[]): number {
  if (!Number.isFinite(v) || v < min) {
    if (Number.isFinite(v) && v !== min) warnings.push(`[参数] ${what} ${v} 低于下限，已抬到 ${min}`);
    return min;
  }
  if (v > max) {
    warnings.push(`[参数] ${what} ${v} 点超出 ZPL 允许上限 ${max} 点，已钳到 ${max}（如需更大物理尺寸，请提高 dpi 设定或缩小元素尺寸）`);
    return max;
  }
  return Math.round(v);
}

/**
 * 生成单个标签的完整 ZPL（不含作业头尾 ^XA/^XZ 由调用方包）。
 * @returns { text: string; warnings: string[] }
 *   text     —— 完整 ZPL 指令串
 *   warnings —— 不支持码制、几何量化、GS1 结构问题等提示（不抛异常，允许"能打多少打多少"）
 */
export function generateZpl(els: ZplElement[], dpi: number): { text: string; warnings: string[] } {
  const out: string[] = ['^XA', '^CI28', '^FH\\']; // 标签起始 + UTF-8 + 十六进制转义开关
  const warnings: string[] = [];

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
      case 'barcode':
        emitBarcode(out, warnings, e, dpi, x, y, orient);
        break;
      case 'qrcode':
        emitQrcode(out, warnings, e, dpi, x, y, orient);
        break;
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
        // P7.2 这里发出的是 `^GFA,len,len,,,w,h` 这种缺 bytesPerRow、缺数据的废指令。
        // 现在只有拿到真实点阵才下发，否则如实跳过。
        if (!e.fallback) {
          warnings.push('[图像] image 元素未预置点阵数据（调用方未走位图通道），该元素已跳过。建议：确认经 /print/commands 或 RawTcpProvider 打印（这两条路径会预生成 ^GFA 点阵）');
          break;
        }
        out.push(`^FO${x},${y}${zplGf(e.fallback)}^FS`);
        break;
      }
    }
  }

  out.push('^XZ'); // 标签结束
  return { text: out.join('\n'), warnings };
}

// =============================================================================
// 一维条码：^BY（模块宽/宽窄比/高度）+ 各码制自己的 ^B 命令
// =============================================================================
function emitBarcode(
  out: string[], warnings: string[], e: ZplElement, dpi: number,
  x: number, y: number, orient: 'N' | 'R' | 'I' | 'B',
): void {
  const b = e.barcode!;
  const sym = normSym(b.sym);
  const plan = planChannel(sym, 'zpl', b.content);
  if (plan.channel !== 'native') {
    // 一维码在本版本没有位图回填通道（bwip 一维缩放单位与打印点不成整数倍，
    // 重采样会破坏条空比例），所以 bitmap/previewOnly 一律如实跳过。
    warnings.push(
      `[码制] ZPL 无法原生输出 ${sym}：${plan.why ?? capNote(sym, 'zpl')}。该元素已跳过。`
      + `建议：①打印指令改用 protocol=image 走 bwip-js PNG；②换成业务上等效的常见码制（如 PHARMACODE→CODE128、CODE16K→CODE128）`,
    );
    return;
  }

  const geo = computeGeometry({
    sym, dpi,
    moduleWidthMm: b.moduleWidthMm, wideRatio: b.wideRatio, heightMm: b.heightMm,
    quietZoneMm: (b as any).quietZoneMm, content: b.content,
  });
  warnings.push(...geo.warnings);

  const wDots = clampDot(geo.xDots, 1, 35, `^BY 模块宽（${sym}）`, warnings);
  if (geo.xDots > 10) {
    warnings.push(`[参数] ^BY 模块宽 ${geo.xDots} 点：早期 ZPL 固件上限 10 点，若该机型拒打请把模块宽降到 ${(10 * 25.4 / dpi).toFixed(3)}mm 以内`);
  }
  const byRatio = zplByRatio(sym, geo.xDots, geo.wideDots, geo.fixedRatio, warnings);
  const hDots = clampDot(geo.heightDots, 1, 9999, `条码高度（${sym}）`, warnings);

  const data = zplBarcodeData(sym, b.content, warnings);
  if (data === undefined) return; // GS1 解析失败：已出 warning，跳过该元素

  const human = b.showText ? 'Y' : 'N';
  const above = b.showText && b.textPosition === 'top' ? 'Y' : 'N';
  const check = zplCheck(b, sym, warnings);

  out.push(`^FO${x},${y}^BY${wDots},${byRatio},${hDots}`);
  out.push(...zplBarcodeLines(sym, orient, hDots, human, above, check, data));
}

/**
 * ^BY 的宽窄比：ZPL 只接受 2.0–3.0（0.1 步长），且固定比例码制忽略它。
 * 几何模块已经算出「打印机真正能打出来的」wide/narrow 点数，这里换成协议参数。
 * 注意返回值不等于用户填的那个比例：它是 wideDots / xDots 反算出来的，
 * 例如 203dpi、模块宽 3 点、请求 2.5:1 时宽条只能落 8 点 ⇒ 输出 2.7。
 * 这是**自洽**的：^BY 的 w 与 r 在固件里相乘再取整，给 2.5 反而要赌固件是四舍五入还是截断。
 */
function zplByRatio(
  sym: string, xDots: number, wideDots: number, fixedRatio: boolean, warnings: string[],
): number {
  if (fixedRatio) {
    warnings.push(`[参数] ^BY 宽窄比对 ${sym} 无效（EAN/UPC 为固定比例码制，按 ZPL 手册忽略）`);
    return 2.0;
  }
  const eff = xDots > 0 ? wideDots / xDots : defaultRatio(sym);
  const stepped = Math.round(Math.min(3, Math.max(2, eff)) * 10) / 10;
  if (Math.abs(stepped - eff) > 0.05) {
    warnings.push(`[参数] ${sym} 宽窄比 ${eff.toFixed(2)}:1 超出 ZPL 的 2.0–3.0:1 范围，已按 ${stepped}:1 输出（实际宽条=${Math.round(xDots * stepped)} 点）`);
  }
  return stepped;
}

/** 校验位参数：默认与预览一致（不追加校验位），显式要求时才开，并提示预览/打印差异 */
function zplCheck(b: BarcodeSpec, sym: string, warnings: string[]): 'Y' | 'N' {
  if (b.checksum === true) {
    warnings.push(`[校验位] ${sym} 已要求打印机自动追加校验位：扫描结果会比预览数据多一位，确认下游系统按带校验位解析`);
    return 'Y';
  }
  return 'N';
}

/**
 * 条码字段数据。
 * · GS1-128 走 parseGs1 → gs1ToZpl：`>;` 起始 FNC1，变长 AI 之后 `>8`，
 *   结构性问题（定长 AI 位数不对、GTIN 非数字…）由 validateGs1 出 warning。
 * · Code128 家族里 `>` 是 FNC 转义引导符，字面量必须写成 `>>`，否则会被固件吃掉。
 * @returns 转义后的数据串；undefined 表示该元素应跳过（已写 warning）
 */
function zplBarcodeData(sym: string, content: string, warnings: string[]): string | undefined {
  if (sym === 'GS1_128') {
    let comps;
    try {
      comps = parseGs1(content);
    } catch (err: any) {
      warnings.push(`[GS1] GS1-128 内容解析失败：${err?.message ?? err}。该元素已跳过（不能凭猜测拼 FNC1）`);
      return undefined;
    }
    const errs = validateGs1(comps);
    if (errs.length) warnings.push(`[GS1] ${errs.join('；')}`);
    return gs1ToZpl(comps, c128Esc);
  }
  if (sym === 'ITF' || sym === 'ITF14') {
    const digits = String(content ?? '').replace(/\D/g, '');
    if (digits.length % 2 !== 0) {
      warnings.push(`[码制] ${sym} 数据为奇数位（${digits.length}）：Zebra 固件会自动前置一个 0 凑成偶数位，扫描结果将与预览不同`);
    }
  }
  return sym === 'CODE128' ? c128Esc(content) : esc(content);
}

/**
 * 按码制生成条码指令行。参数顺序逐条对照 ZPL II Command Summary：
 *   ^BC o,h,f,g,e      Code128（e=UCC 校验位）        ^B3 o,e,h,f,g     Code39
 *   ^BA o,h,f,g,e      Code93                        ^BE o,h,f,g       EAN-13
 *   ^B8 o,h,f,g        EAN-8                         ^BU o,h,f,g,e     UPC-A
 *   ^B9 o,h,f,g,e      UPC-E                         ^B2 o,h,f,g,e     Interleaved 2 of 5
 *   ^BK o,e,h,f,g      ANSI Codabar                  ^BM o,e,h,f,g     MSI（e=校验方式 A/B/C/D）
 * ⚠️ ^BI 是 Industrial 2 of 5、^BJ 是 Standard 2 of 5，都不是交叉二五码；
 *    ^B7 才是 PDF417（^B2 不是）。用错指令会打出另一种符号，且打印机不报错。
 * 调用方必须先用 planChannel 过滤，未列出的码制不允许走到这里。
 */
function zplBarcodeLines(
  sym: string, orient: 'N' | 'R' | 'I' | 'B', bh: number,
  human: 'Y' | 'N', above: 'Y' | 'N', check: 'Y' | 'N', data: string,
): string[] {
  const fd = `^FD${data}^FS`;
  switch (sym) {
    case 'CODE128': return [`^BC${orient},${bh},${human},${above},${check}`, fd];
    // GS1-128：FNC1 已在数据里（>; / >8），^BC 的 e 位是 UCC/EAN 复合码校验，不能开
    case 'GS1_128': return [`^BC${orient},${bh},${human},${above},N`, fd];
    case 'CODE39':  return [`^B3${orient},${check},${bh},${human},${above}`, fd];
    case 'CODE93':  return [`^BA${orient},${bh},${human},${above},${check}`, fd];
    case 'EAN13':   return [`^BE${orient},${bh},${human},${above}`, fd];
    case 'EAN8':    return [`^B8${orient},${bh},${human},${above}`, fd];
    case 'UPC': case 'UPC_A': return [`^BU${orient},${bh},${human},${above},${check}`, fd];
    case 'UPC_E':   return [`^B9${orient},${bh},${human},${above},${check}`, fd];
    case 'ITF': case 'ITF14': return [`^B2${orient},${bh},${human},${above},${check}`, fd];
    case 'CODABAR': return [`^BK${orient},${check},${bh},${human},${above}`, fd];
    // MSI 的第二位是「校验方式」而非 Y/N：A=无、B=1 Mod10、C=2 Mod10、D=Mod10+Mod11
    case 'MSI':     return [`^BM${orient},${check === 'Y' ? 'B' : 'A'},${bh},${human},${above}`, fd];
    default:
      // ⚠️ 显式 throw 让调用方知道过滤漏掉了；生产代码不应走到这里
      throw new Error(`zplBarcodeLines: 意外的码制 "${sym}"，调用方应先用 planChannel(sym,'zpl') 过滤`);
  }
}

// =============================================================================
// 二维码 / 位图回填
// =============================================================================
function emitQrcode(
  out: string[], warnings: string[], e: ZplElement, dpi: number,
  x: number, y: number, orient: 'N' | 'R' | 'I' | 'B',
): void {
  const q = e.qrcode!;
  const sym = normSym(q.sym ?? 'QRCODE');
  const plan = planChannel(sym, 'zpl', q.content);

  if (plan.channel !== 'native') {
    // 位图通道的点数/静区由 raster 按同一份 barcode-geometry 计算，这里不重复算
    if (!e.fallback) {
      warnings.push(`[码制] ZPL ${plan.channel === 'bitmap' ? '需位图回填但未拿到点阵' : '无法输出'}：${plan.why ?? capNote(sym, 'zpl')}。该元素已跳过`);
      return;
    }
    out.push(`^FO${x},${y}${zplGf(e.fallback)}^FS`);
    const mm = ((e.fallback.widthDots * 25.4) / dpi).toFixed(2);
    warnings.push(`[位图] ${plan.why ?? capNote(sym, 'zpl')}；已用 bwip-js 点阵经 ^GFA 下发（${e.fallback.widthDots}×${e.fallback.heightDots} 点 ≈ ${mm}mm 宽，含 ${e.fallback.moduleDots} 点/模块与四周静区），可扫但不是打印机原生符号`);
    return;
  }

  const geo = compute2dGeometry({
    sym, dpi, moduleSizeMm: q.moduleSizeMm, quietZoneMm: q.quietZoneMm,
  });
  warnings.push(...geo.warnings);
  const m = Math.max(1, geo.moduleDots);
  const ecc = ({ H: 'H', Q: 'Q', M: 'M', L: 'L' } as Record<string, 'H' | 'Q' | 'M' | 'L'>)[q.ecc ?? 'M'] ?? 'M';
  const content = esc(q.content);

  switch (sym) {
    case 'QRCODE': {
      // ^BQ：model 2 only（Micro QR / 混合模式 / 汉字模式无原生支持 → 位图通道）
      const mag = clampDot(m, 1, 10, '^BQ 放大系数（QR）', warnings);
      out.push(`^FO${x},${y}^BQ${orient},2,${mag},${ecc}^FDQA,${content}^FS`);
      break;
    }
    case 'DATAMATRIX': {
      // ^BX 的 h 是「每个符号元素的高度（点）」，quality 只用 200（ECC200）
      out.push(`^FO${x},${y}^BX${orient},${m},200^FD${content}^FS`);
      break;
    }
    case 'PDF417': {
      // ^B7 o,rowHeight,security[,columns,rows,truncate]：
      // 行高按 PDF417 规范取 3×模块；列/层留给固件按数据量自动，避免越界整块不打印。
      const rowH = Math.max(m, m * 3);
      const sec = PDF_SECURITY[q.ecc ?? 'M'] ?? 3;
      out.push(`^FO${x},${y}^BY${clampDot(m, 1, 35, '^BY 模块宽（PDF417）', warnings)},2,${rowH}`);
      out.push(`^B7${orient},${rowH},${sec}^FD${content}^FS`);
      break;
    }
    case 'AZTEC': {
      const mag = clampDot(m, 1, 20, '^B0 放大系数（Aztec）', warnings);
      out.push(`^FO${x},${y}^B0${orient},${mag}^FD${content}^FS`);
      break;
    }
    default:
      // 能力矩阵说 native 但这里没实现 —— 属于代码 bug，宁可停下来也不猜
      throw new Error(`emitQrcode: 能力矩阵标记 ${sym} 为 ZPL native，但生成器未实现该分支`);
  }
}

/** ECC 等级 → PDF417 安全级（纠错码字 1/2/4/8/16/32/64/128/256，取常用映射） */
const PDF_SECURITY: Record<string, number> = { L: 2, M: 3, Q: 5, H: 6 };

/** 转义 ZPL 控制字符（^ ~ \ 会与指令冲突，用 ^FH 十六进制转义） */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\5C')
    .replace(/\^/g, '\\5E')
    .replace(/~/g, '\\7E');
}

/** Code128 数据里 `>` 是 FNC 转义引导符，字面量要写成 `>>` */
function c128Esc(s: string): string {
  return esc(s).replace(/>/g, '>>');
}

/**
 * 完整作业（含张数 ^PQ）：用于 RawTcp Provider 直发。
 * @param labels 每张标签的 ZPL 片段数组
 * @param copies 每张打印份数
 */
export function buildJob(labels: string[], copies = 1): string {
  return labels.map((l) => l.replace('^XA', `^XA^PQ${copies}`)).join('\n');
}
