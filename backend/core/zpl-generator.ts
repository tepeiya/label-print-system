// =============================================================================
// zpl-generator.ts —— ZPL II 指令生成器（斑马等 ZPL 打印机）
// 覆盖：文本 ^FO/^A0、条码 ^BC/^BY、二维码 ^BQ、图片 ^GF、流水号（由数据预填）。
// 坐标换算：所有 mm 在生成时按 printer.dpi 转 dots：dots = mm * dpi / 25.4。
//   - 203dpi → 8 dots/mm；300dpi → 11.81 dots/mm；600dpi → 23.62 dots/mm
// 注意：ZPL 原点在左上角；旋转用 ^FW 或元素级 ^A 的朝向参数。
// =============================================================================

import type { BarcodeSpec, QrcodeSpec } from './types';
// P7：能力判定/降级/warnings/几何约束一律委托单一真源，本文件只保留「指令语法」知识。
import {
  canonSym, describeUnsupported, resolveBarcodeGeometry,
  encodeGs1, gs1ToProtocol,
} from './symbology.capabilities';
// 第三层：MaxiCode 原生 ^BD 构造器（显式 opt-in，默认仍走位图警告）
import { buildMaxicodeZpl, type StructuredMaxicode } from './maxicode';

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
  /** 第三层：MaxiCode 原生 ^BD 结构化参数（仅 sym=MAXICODE 且显式提供时生效） */
  maxicode?: StructuredMaxicode | { mode?: 2 | 3 | 4 | 5 | 6; n?: number; t?: number };
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

// =============================================================================
// P7 重构：原本这里维护 SUPPORTED_ZPL_BARCODES / SUPPORTED_ZPL_QRCODES /
// ZPL_NO_NATIVE_BARCODES 三个 Set，与前端列表、TSPL 生成器、buildWarnings 共四处
// 各写一份，是「静默降级 / warnings 自相矛盾」的根因。现统一委托
// symbology.capabilities.ts，本文件只保留 ZPL 指令语法（^B 家族参数顺序）。
// =============================================================================

/**
 * 生成单个标签的完整 ZPL（不含作业头尾 ^XA/^XZ 由调用方包）。
 * @returns { text: string; warnings: string[] }
 *   text     —— 完整 ZPL 指令串
 *   warnings —— 不支持码制、参数异常等提示（不会抛异常，允许"能打多少打多少"）
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
      case 'barcode': {
        const b = e.barcode!;
        const sym = canonSym(b.sym);
        // P7：能力判定统一走单一真源（区分"手册无指令"与"暂未覆盖"，并支持显式降级）
        const support = describeUnsupported('zpl', sym);
        warnings.push(...support.warnings);
        if (support.skip) break;

        // P7.6 几何约束：模块宽对齐到整数 dot（防条宽不均译码失败）、静区按码制自动、
        // 旋转时明文方位反转（避开静区）。原理见 symbology.capabilities.ts。
        const geo = resolveBarcodeGeometry({
          sym, moduleWidthMm: b.moduleWidthMm, wideRatio: b.wideRatio, heightMm: b.heightMm,
          showText: b.showText, textPosition: b.textPosition, rotation: rot,
        }, dpi);
        const qz = geo.quietZone;
        // 静区通过 ^FO 起点偏移实现；bwip-js 预览侧同样自带静区，保证所见即所得一致
        const bx = x + mmToDots(qz.left, dpi);
        const by = y + mmToDots(qz.top, dpi);
        const bh = Math.max(1, mmToDots(b.heightMm, dpi));
        const byW = Math.max(1, geo.moduleDots);
        const ratio = Math.min(3, Math.max(2, Math.round(geo.wideRatio * 10) / 10));
        const human = b.showText ? 'Y' : 'N';
        const checksum = b.checksum === false ? 'N' : 'Y';
        // moduleWidth 对齐是静默规范化（与 mmToDots 取整同理，属预期行为），不进 warnings；
        // 对齐结果在 geo.moduleWidthMm / moduleDots 中，供验收脚本与前端属性面板回显。
        // warnings 只承载「需要用户行动」的事：不支持码制、高度过小、GS1 数据非法。
        if (geo.heightTooSmall) {
          warnings.push(`[ZPL] ${sym} 高度 ${b.heightMm}mm 偏小（建议 ≥ ${geo.suggestedHeightMm}mm，约 ${10}×模块宽），可能影响扫描`);
        }
        // P7.4：GS1-128 数据非法要显式告警，不静默吞掉。zplBarcodeLine 拿不到 warnings
        // 数组（只返回指令串），故在主循环这里统一校验；指令内仍退回可打的括号剥离形式。
        if (sym === 'GS1_128') {
          const g = encodeGs1(b.content);
          if (g.invalid.length) warnings.push(`[ZPL] GS1 数据存疑：${g.invalid.join('；')}（已按剥离括号的原始内容输出，请核对）`);
        }
        out.push(`^FO${bx},${by}^BY${byW},${ratio},${bh}`);
        out.push(...zplBarcodeLine(sym, orient, bh, human, checksum, b.content, geo.humanReadable.zplFlag as 'Y' | 'N'));
        break;
      }
      case 'qrcode': {
        const q = e.qrcode!;
        const key = canonSym(q.sym ?? 'QRCODE');
        // 第三层：MaxiCode 显式 opt-in 原生 ^BD。默认（无 e.maxicode）仍走下方
        // describeUnsupported → warning + 跳过（保留"预览仅"安全默认）；
        // 只有模板元素显式带 maxicode 结构/参数时才输出 ^BD 原生指令。
        if (key === 'MAXICODE' && (e as any).maxicode) {
          const mi = (e as any).maxicode as StructuredMaxicode | { mode?: 2 | 3 | 4 | 5 | 6; n?: number; t?: number };
          // 结构化对象走结构化构造；仅 {mode} 时用元素文本作自由数据
          const input = ('serviceClass' in mi) ? mi : (q.content ?? '');
          const r = buildMaxicodeZpl(input as any, { n: (mi as any).n, t: (mi as any).t, mode: (mi as any).mode });
          warnings.push(...r.warnings);
          if (r.ok) {
            const qx = x + mmToDots(2, dpi); // 固定符号约 1 英寸，静区按 2mm 经验偏移
            out.push(`^FO${qx},${y}${r.zpl}`);
          }
          break;
        }
        // P7：二维码能力同样委托单一真源
        const support = describeUnsupported('zpl', key);
        warnings.push(...support.warnings);
        if (support.skip) break;
        // 静区按码制自动（QR=4模块 / DM=1 / PDF417=2 / Aztec=0）
        const qz = resolveBarcodeGeometry({
          sym: key, moduleWidthMm: q.moduleSizeMm ?? 0.4, heightMm: e.hMm ?? 15,
          showText: false, textPosition: 'bottom', rotation: rot,
        }, dpi).quietZone;
        const qx = x + mmToDots(qz.left, dpi);
        const qy = y + mmToDots(qz.top, dpi);
        // GS1 DataMatrix：模板 content 是带括号的 HRI，直接塞进 ^FD 会把括号当数据编码，
        //   扫出来不是合法 GS1 元素串（UMDI/医院端解析不了）。必须转码：
        //   剥离括号 → 变长 AI 间插 FNC1（ZPL 用 `>8`）→ 前导 FNC1 标识 GS1 符号。
        //   非法 AI/字符集时按原内容输出并告警（不静默吞）。QR 的 GS1 语义未在此处理。
        const content = esc(zpl2DContent(key, q, warnings));
        const moduleDots = mmToDots(q.moduleSizeMm ?? 0.4, dpi);
        // ZPL 放大系数 1-10（每个模块 dots）
        const m = Math.min(10, Math.max(1, moduleDots));
        const bh = Math.max(1, mmToDots(e.hMm ?? 15, dpi));
        const eccMap: Record<string, string> = { H: 'H', Q: 'Q', M: 'M', L: 'L' };
        if (key.startsWith('DATA')) {
          // Data Matrix（含矩形版）：^BX o,h,s,e（e=200 为标准 ECC200）
          out.push(`^FO${qx},${qy}^BX${orient},${bh},${m},200^FD${content}^FS`);
        } else if (key.startsWith('PDF')) {
          // PDF417：^B2 o,h,f,g,e（f=N 不打印人类可读行）
          out.push(`^FO${qx},${qy}^B2${orient},${bh},N,N,Y^FD${content}^FS`);
        } else if (key.startsWith('AZTEC')) {
          // Aztec：^BO o,h,s,e
          out.push(`^FO${qx},${qy}^BO${orient},${bh},${m},0^FD${content}^FS`);
        } else {
          // QR / Micro QR：^BQ o,model,m,ecc（model 1=Micro QR / 2=标准 QR）
          const model = key === 'MICROQR' ? '1' : '2';
          out.push(`^FO${qx},${qy}^BQ${orient},${model},${m},${eccMap[q.ecc ?? 'M'] ?? 'M'}^FDQA,${content}^FS`);
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
  return { text: out.join('\n'), warnings };
}

/** 码制归一化：委托单一真源 canonSym（消除别名各处各写一份的漂移） */
function zplSymKey(sym: string): string {
  return canonSym(sym);
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
 *
 * ⚠️ 不支持的码制**不再统一回落 Code128**（违反 docs/05-api.md §8.3）。
 * 调用方在调用本函数前必须先用 SUPPORTED_ZPL_BARCODES 过滤，
 * 不支持的码制应出现在 warnings 里并跳过指令生成。
 */
function zplBarcodeLine(
  sym: string, orient: 'N' | 'R' | 'I' | 'B', bh: number,
  human: 'Y' | 'N', checksum: 'Y' | 'N', content: string,
  humanAbove: 'Y' | 'N' = 'N',
): string[] {
  const key = zplSymKey(sym);
  const fd = esc(content);
  switch (key) {
    case 'GS1_128': {
      // P7.4 GS1-128 = Code128 + FNC1：正确解析 AI、变长 AI 之间插 FNC1 分隔符（>8）。
      // 原理：GS1 以 FNC1 开头标识 GS1 系统；定长 AI 直接接续，变长 AI 必须靠 FNC1 断句，
      //       否则译码器无法区分 "(10)ABC(17)..." 的边界。encodeGs1 产出带 \u001D 占位的数据流。
      const g = encodeGs1(content);
      if (g.invalid.length) {
        // 数据不合规不静默吞掉：交回生成器 warnings 层（这里退回旧的括号剥离，保证可打）
        const data = String(content ?? '').replace(/[()]/g, '');
        return [`^BC${orient},${bh},${human},${humanAbove},Y^FD>;${esc(data)}^FS`];
      }
      const data = gs1ToProtocol(g.data, 'zpl');
      return [`^BC${orient},${bh},${human},${humanAbove},Y^FD>;${esc(data)}^FS`];
    }
    // 下列码制的第 4 个参数 g = "明文是否在条码上方"。P7.6：旋转 180/270° 时
    // humanReadablePlacement 会把 bottom 反转为 Y，避免明文压到静区/落到错误物理方位。
    case 'CODE39':
      return [`^B3${orient},${checksum},${bh},${human},${humanAbove}^FD${fd}^FS`];
    case 'CODE93':
      return [`^BA${orient},${bh},${human},${humanAbove},${checksum}^FD${fd}^FS`];
    case 'EAN13':
      return [`^BE${orient},${bh},${human},${humanAbove}^FD${fd}^FS`];
    case 'EAN8':
      return [`^B8${orient},${bh},${human},${humanAbove}^FD${fd}^FS`];
    case 'UPC':
      return [`^BU${orient},${bh},${human},${humanAbove},${checksum}^FD${fd}^FS`];
    case 'UPC_E':
      return [`^B9${orient},${bh},${human},${humanAbove},${checksum}^FD${fd}^FS`];
    case 'ITF14':
    case 'ITF':
      return [`^BI${orient},${bh},${human},${humanAbove}^FD${fd}^FS`];
    case 'CODABAR':
      return [`^BK${orient},${checksum},${bh},${human},${humanAbove}^FD${fd}^FS`];
    case 'MSI':
      return [`^BM${orient},${checksum},${bh},${human},${humanAbove}^FD${fd}^FS`];
    case 'CODE128':
      return [`^BC${orient},${bh},${human},${humanAbove},${checksum}^FD${fd}^FS`];
    default:
      // ⚠️ 显式 throw 让调用方知道能力真源与语法表漂移了；生产代码不应走到这里
      throw new Error(`zplBarcodeLine: 意外的码制 "${sym}"，请检查 symbology.capabilities 中声明为 ZPL native 的码制是否都有语法分支`);
  }
}

/**
 * 二维码（2D）内容 → ZPL 数据流。
 * · 非 GS1、或内容不是 HRI 形态（不以 "(AI)" 开头）→ 原样返回；
 * · GS1 DataMatrix（q.gs1=true 且内容为 HRI）→ `>8` 前导 + 变长 AI 间 `>8` 分隔，
 *   与 TSPL 侧 tspl2DContent（`~1`）保持同一口径；
 * · 数据非法（AI 未登记/定长位数不符/字符集）→ 原样输出并告警，不静默改内容。
 */
function zpl2DContent(key: string, q: QrcodeSpec, warnings: string[]): string {
  const raw = String(q.content ?? '');
  const gs1On = (q as any).gs1 === true && key.startsWith('DATA');
  if (!gs1On || !/^\(\d{2,4}\)/.test(raw)) return raw;
  const g = encodeGs1(raw);
  if (g.invalid.length) {
    warnings.push(`[ZPL] DataMatrix GS1 数据存疑：${g.invalid.join('；')}（已按原内容输出，请核对）`);
    return raw;
  }
  return '>8' + gs1ToProtocol(g.data, 'zpl');
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
