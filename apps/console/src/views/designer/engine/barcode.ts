// =============================================================================
// barcode.ts —— bwip-js 封装（设计态 / 打印态共用，带 SVG 缓存）
//   原生版走 web/vendor/bwip.js 的 window.bwipjs，Vue 版直接 import bwip-js，
//   生成的 viewBox 与 scale 口径完全一致，所以同一份模板在两边出图相同。
//   走 /browser 子路径：包根的 exports 地图把 types 藏在 browser 条件里，
//   直接 import 'bwip-js' 在 bundler 解析下找不到 .d.ts。
// =============================================================================

import bwipjs from 'bwip-js/browser';

const PXMM = 96 / 25.4;

/** 与原生版同一个 SVG 放大倍数（viewBox 单位 = 模块宽 × 4） */
export const BWIP_SVG_SCALE = 4;

const CACHE = { qr: new Map<string, SvgResult>(), bc: new Map<string, SvgResult>() };

export interface SvgResult {
  svgStr: string;
  naturalWmm: number;
  naturalHmm?: number;
  modules?: number;
}

export interface BarcodeLikeOptions {
  sym?: string;
  content?: string;
  moduleWidthMm?: number;
  wideRatio?: number;
  heightMm?: number;
  showText?: boolean;
  textPosition?: string;
  checksum?: boolean;
  quietZoneMm?: number;
  textFont?: { family?: string; size?: number };
  ecc?: string;
  moduleSizeMm?: number;
}

/** UI 码制 → bwip-js bcid（与 render.js#BWIP_MAP 同表） */
const BWIP_MAP: Record<string, string> = {
  CODE128: 'code128', GS1_128: 'gs1-128', CODE39: 'code39', CODE93: 'code93',
  EAN13: 'ean13', EAN8: 'ean8', UPC: 'upca', UPC_A: 'upca', UPC_E: 'upce',
  ITF14: 'itf14', ITF: 'interleaved2of5', CODABAR: 'rationalizedCodabar',
  MSI: 'msi', PHARMACODE: 'pharmacode', CODE16K: 'code16k',
  QRCODE: 'qrcode', MICROQR: 'microqrcode', MICROQRCODE: 'microqrcode',
  DATAMATRIX: 'datamatrix', DATAMATRIX_RECT: 'datamatrixrectangular',
  PDF417: 'pdf417', AZTEC: 'azteccode', AZTECCODE: 'azteccode',
};

export function bcidOf(sym: unknown): string {
  return BWIP_MAP[String(sym || '').toUpperCase()] ?? 'code128';
}

export function is2dSym(sym: unknown): boolean {
  return /^(QR|MICRO|DATAMATRIX|PDF417|AZTEC)/i.test(String(sym || ''));
}

type BwipOptions = Record<string, unknown>;

function toSvg(opts: BwipOptions): string | null {
  try {
    return bwipjs.toSVG(opts as never);
  } catch (e) {
    console.warn('[bwip] 编码失败', (e as Error)?.message || e);
    return null;
  }
}

/** 从 SVG viewBox 推算物理尺寸（mm） */
function svgMetrics(svgStr: string, moduleMm: number) {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgStr || '');
  const w = m ? parseFloat(m[1]) : 100;
  const h = m ? parseFloat(m[2]) : 40;
  const modules = Math.max(1, w / BWIP_SVG_SCALE);
  return { naturalWmm: modules * moduleMm, naturalHmm: (h / BWIP_SVG_SCALE) * moduleMm };
}

/** 一维码 SVG；失败退化为「不可扫但保布局」的占位条纹（与原生版同一兜底） */
export function makeBarcodeSvg(spec: BarcodeLikeOptions | undefined, content: unknown): SvgResult {
  const s = spec || {};
  const key = `${s.sym}|${content}|${s.moduleWidthMm}|${s.heightMm}|${s.wideRatio}|${s.showText}`;
  const hit = CACHE.bc.get(key);
  if (hit) return hit;

  const bcid = bcidOf(s.sym);
  const moduleWidth = s.moduleWidthMm ?? 0.25;
  const heightMm = s.heightMm ?? 9;
  const barHeightPx = Math.max(20, Math.round((heightMm * PXMM) / moduleWidth));
  const opts: BwipOptions = {
    bcid,
    text: String(content ?? ''),
    scale: BWIP_SVG_SCALE,
    height: Math.round((heightMm / moduleWidth) * BWIP_SVG_SCALE) || barHeightPx,
    paddingwidth: 8,
    paddingheight: 4,
    backgroundcolor: 'FFFFFF',
    includetext: false,
  };
  if (s.wideRatio) opts.ratio = s.wideRatio;
  if (bcid === 'gs1-128') opts.parsefnc = true;

  const svgStr = toSvg(opts);
  if (svgStr) {
    const out: SvgResult = { svgStr, ...svgMetrics(svgStr, moduleWidth) };
    CACHE.bc.set(key, out);
    return out;
  }

  const w = Math.max(40, Math.round(moduleWidth * PXMM * 60));
  const h = Math.max(20, Math.round(heightMm * PXMM));
  let bars = '';
  let x = 0;
  let seed = 7;
  while (x < w) {
    seed = (seed * 73 + 17) % 101;
    const bw = 1 + (seed % 3);
    if (seed % 2 === 0) bars += `<rect x="${x}" y="0" width="${bw}" height="${h}" fill="#000"/>`;
    x += bw;
  }
  const out: SvgResult = {
    svgStr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${bars}</svg>`,
    naturalWmm: w / PXMM,
    naturalHmm: h / PXMM,
  };
  CACHE.bc.set(key, out);
  return out;
}

/** 二维码 / 矩阵码 SVG */
export function makeQrSvg(spec: BarcodeLikeOptions | undefined, content: unknown): SvgResult {
  const s = spec || {};
  const moduleSize = s.moduleSizeMm ?? 0.4;
  const key = `${s.sym}|${s.ecc}|${s.moduleSizeMm}|${s.quietZoneMm}|${content}`;
  const hit = CACHE.qr.get(key);
  if (hit) return hit;

  const bcid = bcidOf(s.sym);
  const opts: BwipOptions = {
    bcid,
    text: String(content ?? ''),
    scale: BWIP_SVG_SCALE,
    paddingwidth: 0,
    paddingheight: 0,
    backgroundcolor: 'FFFFFF',
  };
  if (bcid === 'qrcode' || bcid === 'microqrcode') opts.eclevel = s.ecc || 'M';
  if (bcid === 'pdf417') opts.compact = false;

  const svgStr = toSvg(opts);
  if (svgStr) {
    const metrics = svgMetrics(svgStr, moduleSize);
    const out: SvgResult = {
      svgStr,
      modules: Math.round(metrics.naturalWmm / moduleSize),
      naturalWmm: metrics.naturalWmm,
    };
    CACHE.qr.set(key, out);
    return out;
  }

  const n = 21;
  const out: SvgResult = {
    svgStr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"><rect width="${n}" height="${n}" fill="#eee"/><path d="M2 2h7v7h-7zM3 3h5v5h-5z" fill="#000" fill-rule="evenodd"/></svg>`,
    modules: n,
    naturalWmm: n * moduleSize,
  };
  CACHE.qr.set(key, out);
  return out;
}

/** 一维码明文是否在上方 */
export function showTextIsTop(spec: BarcodeLikeOptions | undefined): boolean {
  return String(spec?.textPosition || 'bottom').toLowerCase() === 'top';
}

/**
 * 设计态填充容器用的一维码 SVG：横向拉伸（bwip 出的 SVG 宽度即真实条码比例，
 * 拉不满会留白，所以这里和原生版一样 preserveAspectRatio="none"）。
 */
export function stretchSvg(svgStr: string): string {
  return svgStr.replace('<svg ', '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block" ');
}

/** 设计态二维码 SVG：等比缩放居中，避免矩阵码被压变形 */
export function containSvg(svgStr: string): string {
  return svgStr.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ');
}

// ---------------------------------------------------------------------------
// 码制字符集规则（前端预检，与 render.js#BC_RULES 同表）
// ---------------------------------------------------------------------------
interface Rule {
  re?: RegExp;
  maxLen?: number;
  note?: string;
}

const BC_RULES: Record<string, Rule> = {
  CODE128: { note: '支持 ASCII 全字符' },
  GS1_128: { note: '使用 (AI) 应用标识符，如 (01)12345678901231' },
  CODE39: { re: /^[0-9A-Za-z\-.$/+% ]*$/, note: '仅 0-9 A-Z a-z 及 - . $ / + % 空格' },
  CODE93: { note: '支持 ASCII 全字符' },
  CODE16K: { maxLen: 1500, note: 'Code 16K 多层码' },
  EAN13: { maxLen: 13, re: /^\d{12,13}$/, note: '12 位数字（第 13 位为校验位）' },
  EAN8: { maxLen: 8, re: /^\d{7,8}$/, note: '7 位数字（第 8 位为校验位）' },
  UPC: { maxLen: 12, re: /^\d{11,12}$/, note: '11 位数字（第 12 位为校验位）' },
  UPC_A: { maxLen: 12, re: /^\d{11,12}$/, note: '11 位数字（第 12 位为校验位）' },
  UPC_E: { maxLen: 8, re: /^\d{7,8}$/, note: '7 位数字（第 8 位为校验位）' },
  ITF14: { maxLen: 14, re: /^\d{13,14}$/, note: '13 位数字（GTIN-14）' },
  ITF: { re: /^\d+$/, note: '仅数字，偶数位' },
  CODABAR: { re: /^[0-9$:/.+-]+$/, note: '数字及 $ : / . + -' },
  MSI: { re: /^\d+$/, note: '仅数字' },
  PHARMACODE: { re: /^\d+$/, note: '仅数字' },
  QRCODE: { maxLen: 2953, note: '建议 ≤ 2000 字符' },
  MICROQR: { maxLen: 500, note: 'Micro QR 建议 ≤ 300 字符' },
  MICROQRCODE: { maxLen: 500, note: 'Micro QR 建议 ≤ 300 字符' },
  DATAMATRIX: { maxLen: 2000, note: '建议 ≤ 1500 字符' },
  DATAMATRIX_RECT: { maxLen: 2000, note: '建议 ≤ 1500 字符' },
  PDF417: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
  AZTEC: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
};

export interface BarcodeCheck {
  ok: boolean;
  error?: string;
  note?: string;
}

/** 校验条码内容；含 {{变量}} 占位时不报错（运行期才有值） */
export function validateBarcodeText(sym: unknown, content: unknown): BarcodeCheck {
  const key = String(sym || '').toUpperCase();
  const r = BC_RULES[key];
  if (!r) return { ok: false, error: `不支持的码制：${String(sym)}`, note: '' };
  const text = String(content ?? '');
  const hasVar = /\{\{[^}]+\}\}/.test(text);
  if (!text.trim()) return { ok: hasVar, error: hasVar ? '' : '内容为空', note: r.note ?? '' };
  if (hasVar) return { ok: true, note: r.note ?? '' };
  if (r.re && !r.re.test(text)) return { ok: false, error: `内容不符合 ${String(sym)} 字符集（${r.note}）`, note: r.note ?? '' };
  if (r.maxLen && text.length > r.maxLen) return { ok: false, error: `内容超长，最大 ${r.maxLen} 字符`, note: r.note ?? '' };
  return { ok: true, note: r.note ?? '' };
}

/** 条码在指定模块宽下的自然宽度（mm）；含占位符时返回 null */
export function barcodeNaturalWidth(spec: BarcodeLikeOptions | undefined, content: unknown): number | null {
  if (/\{\{[^}]+\}\}/.test(String(content ?? ''))) return null;
  return makeBarcodeSvg(spec, content).naturalWmm;
}
