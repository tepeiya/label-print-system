// =============================================================================
// barcode-geometry.ts —— 条码几何专业约束（P7.6）
//
// 目标：把「打印机做不到的尺寸」和「扫不出来的尺寸」在生成指令时就拦下，
// 而不是让用户打出一张能看不能扫的标签。
//
// 三条硬规则：
//   1) X-dimension（窄模块宽）必须是**整数个打印点**：一个点 = 25.4/dpi mm。
//      非整数点宽在热敏头上会被抖动成忽粗忽细，203dpi 下 0.2mm 请求会实际印成
//      2 点(0.251mm) 或 1 点(0.125mm)，用户以为的宽度和真实宽度不一致。
//   2) 固定比例码制（EAN/UPC 家族）的 wide 必须等于 narrow —— 模块宽度是唯一的，
//      给它 2.5 的宽窄比会直接印出非法符号（TSPL 的 wide 参数以「点」为单位，
//      所以这里要按码制强制）。
//   3) 静区按码制自动，不用统一的 2mm。EAN/UPC 由保护条承担、Code128 需 ≥10 模块、
//      QR 需 4 模块、DataMatrix 需 1 模块、PDF417/Aztec 需 2 模块。
// =============================================================================

import { capOf } from './barcode-caps';

/** 一个打印点的物理宽度（mm） */
export function dotPitchMm(dpi: number): number {
  const d = Number(dpi) > 0 ? Number(dpi) : 203;
  return 25.4 / d;
}

/** 各码族最小可用 X-dim（mm）。低于此值判为"扫不出来风险"，抬到 1 点并提示。 */
const MIN_X_MM: Record<string, number> = {
  EAN13: 0.293, EAN8: 0.293, UPC: 0.293, UPC_A: 0.293, UPC_E: 0.293, // GS1 37% 放大率下限
  CODE128: 0.249, GS1_128: 0.249, CODE39: 0.249, CODE93: 0.249, ITF: 0.249, ITF14: 0.249,
  CODABAR: 0.249, MSI: 0.249, PHARMACODE: 0.249, CODE16K: 0.249,
};

/** 固定比例（1:1）码制：宽条=窄条，不接受 wideRatio */
const FIXED_RATIO = new Set(['EAN13', 'EAN8', 'UPC', 'UPC_A', 'UPC_E', 'ISBN', 'ISSN']);

/** 静区模块数（左右各一份；2D 为四周） */
const QUIET_MODULES: Record<string, number> = {
  CODE128: 10, GS1_128: 10, CODE16K: 10,
  CODE39: 10, CODABAR: 10, MSI: 10, PHARMACODE: 10,
  CODE93: 12, ITF: 10, ITF14: 10,
  EAN13: 9, EAN8: 9, UPC: 9, UPC_A: 9, UPC_E: 9, // 由保护条/侧条承担
};

/** 二维码制四周静区（模块） */
const QUIET_MODULES_2D: Record<string, number> = {
  DATAMATRIX: 1, DATAMATRIX_RECT: 1,
  PDF417: 2, AZTEC: 2,
  QRCODE: 4, MICROQR: 4,
};

/** 一维码高度建议：不低于符号长度的 25%（GS1 建议），且不小于 10×X */
export const HEIGHT_RATIO_OF_LENGTH = 0.25;
export const MIN_HEIGHT_MODULES = 10;

export interface GeometryInput {
  sym: string;
  dpi: number;
  moduleWidthMm?: number;
  wideRatio?: number;
  heightMm?: number;
  /** 条码可用长度（mm），用于按 25% 规则建议高度；未给时由 content 估算 */
  symbolLengthMm?: number;
  /** 条码内容：symbolLengthMm 缺省时用它估算符号长度（仅用于提示） */
  content?: string;
  quietZoneMm?: number;
}

export interface BarcodeGeometry {
  /** 窄模块宽（整数点） */
  xDots: number;
  /** 宽元素（整数点），固定比例码制 === xDots */
  wideDots: number;
  heightDots: number;
  /** 单侧静区（点） */
  quietDots: number;
  fixedRatio: boolean;
  /** 换算回 mm，供前端与 warnings 文案复用 */
  xMm: number;
  warnings: string[];
}

/** 归一化码制标识（能力矩阵用大写全称） */
export function normSym(sym: string): string {
  const raw = String(sym ?? '').toUpperCase();
  const alias: Record<string, string> = {
    'CODE-128': 'CODE128', CODE128: 'CODE128', UCC128: 'GS1_128', 'GS1-128': 'GS1_128',
    'EAN-13': 'EAN13', 'EAN-8': 'EAN8', 'UPC-A': 'UPC', UPCA: 'UPC', 'UPC-E': 'UPC_E',
    UPCE: 'UPC_E', '2OF5': 'ITF', 'INTERLEAVED2OF5': 'ITF', 'ITF-14': 'ITF14',
    'CODE-39': 'CODE39', 'CODE-93': 'CODE93', NW7: 'CODABAR', 'CODABAR': 'CODABAR',
    '2D': 'MICROQR', MICRO_QR: 'MICROQR', DM: 'DATAMATRIX', QR: 'QRCODE',
  };
  return alias[raw] ?? raw.replace(/^CODE-?/, 'CODE');
}

/**
 * 一维码几何计算。所有向下取整都用 round（打印机固件按点走纸，round 比 floor 更接近意图），
 * 但保证 ≥1 点。返回的 warnings 会被生成器并入响应。
 */
export function computeGeometry(inp: GeometryInput): BarcodeGeometry {
  const dpi = Number(inp.dpi) > 0 ? Number(inp.dpi) : 203;
  const pitch = dotPitchMm(dpi);
  const sym = normSym(inp.sym);
  const warnings: string[] = [];

  const reqMm = Number(inp.moduleWidthMm) > 0 ? Number(inp.moduleWidthMm) : 0.25;
  let xDots = Math.round(reqMm / pitch);
  if (xDots < 1) {
    warnings.push(`[几何] ${sym} X-dim ${reqMm.toFixed(3)}mm 在 ${dpi}dpi 下不足 1 点（${pitch.toFixed(3)}mm/点），已抬到 1 点=${pitch.toFixed(3)}mm`);
    xDots = 1;
  }
  const minX = MIN_X_MM[sym];
  const xMm = xDots * pitch;
  if (minX && xMm < minX) {
    warnings.push(`[几何] ${sym} X-dim ${xMm.toFixed(3)}mm 低于该码制推荐下限 ${minX}mm，建议 ≥${minX}mm（提高打印分辨率或加宽模块）以保证识读`);
  }
  // 量化提示：只在偏差 ≥0.02mm 时报，避免 300dpi 下满屏噪音
  if (Math.abs(xMm - reqMm) >= 0.02) {
    warnings.push(`[几何] ${sym} X-dim 由 ${reqMm.toFixed(3)}mm 量化为 ${xMm.toFixed(3)}mm（${xDots} 点 × ${pitch.toFixed(3)}mm/点）`);
  }

  const fixedRatio = FIXED_RATIO.has(sym);
  let wideDots: number;
  if (fixedRatio) {
    wideDots = xDots;
    if (Number.isFinite(inp.wideRatio) && Number(inp.wideRatio) !== 1) {
      warnings.push(`[几何] ${sym} 为固定比例码制，宽窄比 ${inp.wideRatio} 已忽略（强制 1:1）`);
    }
  } else {
    const reqRatio = Number.isFinite(inp.wideRatio) ? Number(inp.wideRatio) : defaultRatio(sym);
    const clamped = Math.min(3.5, Math.max(1.5, reqRatio));
    const is128Family = sym === 'CODE128' || sym === 'GS1_128';
    // Code128 的宽元素必须是整数模块（规范上 2–4 模块），2.5 这种比例在指令里会被四舍五入
    // 成不确定的宽窄比，这里显式取最近整数并提示，避免"设计器里 2.5、打印机里 2"。
    const eff = is128Family ? Math.max(2, Math.min(4, Math.round(clamped))) : clamped;
    if (is128Family && Math.abs(eff - reqRatio) > 0.01 && Number.isFinite(inp.wideRatio)) {
      warnings.push(`[几何] Code128/GS1-128 宽元素必须为整数模块，宽窄比 ${reqRatio} 已取整为 ${eff}:1`);
    }
    wideDots = Math.max(xDots, Math.round(xDots * eff));
  }

  const heightDots = Math.max(1, Math.round((Number(inp.heightMm) > 0 ? Number(inp.heightMm) : 8) / pitch));
  // 符号长度：优先用调用方给的可用长度，否则按码制结构估算（只影响提示，不影响指令数值）
  const lenMm = Number(inp.symbolLengthMm) > 0
    ? Number(inp.symbolLengthMm)
    : estimateSymbolLengthMm(sym, inp.content ?? '', xMm, inp.wideRatio ?? defaultRatio(sym));
  if (lenMm > 0) {
    const minH = Math.min(
      lenMm * HEIGHT_RATIO_OF_LENGTH,
      // GS1 允许长条码按比例放宽，但不小于 10 模块
      Math.max(MIN_HEIGHT_MODULES * xMm, 1),
    );
    if (Number(inp.heightMm) > 0 && inp.heightMm! < minH) {
      warnings.push(`[几何] ${sym} 高度 ${inp.heightMm!.toFixed(2)}mm 低于该长度下建议下限 ${minH.toFixed(2)}mm（长度 25% / 10 模块取小，符号长度按 ${lenMm.toFixed(1)}mm 估算），扫描窗口可能不足以定位符号`);
    }
  }

  const qMods = QUIET_MODULES[sym] ?? 10;
  // 静区 = 规范要求的模块数 × 每模块点数
  let quietDots = Math.max(2, qMods * xDots);
  if (Number(inp.quietZoneMm) > 0) {
    const reqQ = Math.round(Number(inp.quietZoneMm) / pitch);
    if (reqQ < quietDots) {
      warnings.push(`[静区] 请求 ${Number(inp.quietZoneMm).toFixed(2)}mm（${reqQ} 点）小于 ${sym} 要求的 ${qMods} 模块（${quietDots} 点=${(quietDots * pitch).toFixed(2)}mm），已按规范放大`);
    } else quietDots = reqQ;
  }

  return { xDots, wideDots, heightDots, quietDots, fixedRatio, xMm, warnings };
}

/** 二维码制单模块点数 + 静区模块数 */
export function compute2dGeometry(inp: { sym: string; dpi: number; moduleSizeMm?: number; quietZoneMm?: number }):
  { moduleDots: number; quietModules: number; warnings: string[] } {
  const dpi = Number(inp.dpi) > 0 ? Number(inp.dpi) : 203;
  const pitch = dotPitchMm(dpi);
  const sym = normSym(inp.sym);
  const warnings: string[] = [];
  const req = Number(inp.moduleSizeMm) > 0 ? Number(inp.moduleSizeMm) : 0.4;
  let moduleDots = Math.round(req / pitch);
  if (moduleDots < 1) {
    warnings.push(`[几何] ${sym} 模块 ${req.toFixed(3)}mm 不足 1 点，已抬到 1 点=${pitch.toFixed(3)}mm`);
    moduleDots = 1;
  }
  // DataMatrix 在 1 点模块下边缘会糊，2D 建议 ≥2 点
  if (capOf(sym)?.twoD && moduleDots < 2) {
    warnings.push(`[几何] ${sym} 模块仅 1 点，二维符号建议 ≥2 点（0.25mm@203dpi）以保证定位图形清晰`);
  }
  return { moduleDots, quietModules: QUIET_MODULES_2D[sym] ?? 2, warnings };
}

/** 各码制默认宽窄比（对齐专业软件缺省值） */
export function defaultRatio(sym: string): number {
  const s = normSym(sym);
  if (FIXED_RATIO.has(s)) return 1;
  if (s === 'CODE128' || s === 'GS1_128') return 2;
  if (s === 'CODE39' || s === 'CODABAR' || s === 'MSI') return 2.5;
  if (s === 'ITF' || s === 'ITF14') return 2.5;
  if (s === 'CODE93') return 2;
  return 2;
}

/**
 * 符号长度估算（模块数）—— 只用于「25% 高度建议」和「宽度是否超出标签」这类提示，
 * 不参与任何指令数值，估不准也不会打错东西。
 * 依据各码制的符号结构：Code128 = 11×数据字符 + 35（起始+校验+终止+静区外）；
 * Code39 = (n+2) 个字符 ×（6 窄 + 3 宽 ×ratio）；EAN/UPC 为规范定值（EAN-13/UPC-A 95 模块）。
 *
 * 返回 0 = 「本模块估不出来」，它同时覆盖三种情况：内容为空、码制不在表内
 * （PHARMACODE / CODE16K / 各二维符号）、以及 ITF/MSI/CODABAR 这类只能给近似值的码制在
 * 内容异常时的退化。调用方一律以 `> 0` 为「有估算」，0 就**静默跳过高度建议**：
 * 宁可少提示一条，也不要拿猜出来的长度去劝用户改高度（那会让人怀疑本来正确的设置）。
 * 已知代价：CODE16K 这类没有估算的码制，25% 建议完全不出现，且响应里不会说明为什么。
 */
export function estimateModules(sym: string, content: string, ratio = 2.5): number {
  const s = normSym(sym);
  const n = String(content ?? '').length;
  if (!n) return 0;
  const r = Math.max(1.5, Math.min(3.5, ratio));
  switch (s) {
    case 'CODE128': return 11 * n + 35;
    // GS1-128：AI 数字也算字符
    case 'GS1_128': return 11 * n + 35;
    case 'CODE39': return (n + 2) * (6 + 3 * r);
    case 'CODE93': return 9 * (n + 2) + 9;
    case 'CODABAR': return (n + 2) * (5 + 2 * r);
    case 'MSI': case 'MSI10': case 'MSI11': return 12 * (n + 2) + 4 * r;
    case 'ITF': case 'ITF14': return 8 + Math.ceil(n / 2) * (7 + 3 * r);
    case 'EAN13': case 'UPC': case 'UPC_A': return 95;
    case 'EAN8': return 67;
    case 'UPC_E': return 51;
    default: return 0;
  }
}

/** 符号长度（mm，不含静区）；估不出来时返回 0 */
export function estimateSymbolLengthMm(sym: string, content: string, xMm: number, ratio = 2.5): number {
  const mods = estimateModules(sym, content, ratio);
  return mods > 0 ? mods * xMm : 0;
}

/**
 * 旋转后明文（HRT）的实际贴靠边 —— B4 里"旋转时明文位置会错"的正解。
 * 设计器里 textPosition 是**符号坐标系**的下/上；元素旋转后符号坐标系跟着转，
 * 屏幕坐标必须换算，否则 90° 旋转的条码明文会跑到条码侧边中间。
 */
export function textSideFor(rotation: 0 | 90 | 180 | 270, position: 'bottom' | 'top' = 'bottom'):
  'bottom' | 'top' | 'left' | 'right' {
  const base = position === 'top' ? 2 : 0; // 0=bottom 2=top
  const step = (base + rotation / 90) % 4;
  return (['bottom', 'left', 'top', 'right'] as const)[step];
}

/** 明文在旋转后是否应该按"宽度=条码高度"的方向绘制 */
export function isVerticalTextSide(side: 'bottom' | 'top' | 'left' | 'right'): boolean {
  return side === 'left' || side === 'right';
}
