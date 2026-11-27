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
  /** GS1 模式（DataMatrix → gs1datamatrix），UDI 标签必须开 */
  gs1?: boolean;
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
  // P7.5：P8.4 工业码制。此前前端缺失导致这些"预览仅"码制 fallback 成 code128，
  // 预览图与所选码制不符（标了预览却给错误的码）。与后端 core/barcode-renderer.ts
  // 的 BWIP_MAP 同口径——那 6 个 bcid 已实测 bwip-js 可渲染。
  MAXICODE: 'maxicode',
  HIBC: 'hibccode128', HIBC_128: 'hibccode128',
  HIBC_CODE39: 'hibccode39',
  HIBC_DATAMATRIX: 'hibcdatamatrix',
  HIBC_QR: 'hibcqrcode',
  PZN: 'pzn',
};

export function bcidOf(sym: unknown): string {
  return BWIP_MAP[String(sym || '').toUpperCase()] ?? 'code128';
}

export function is2dSym(sym: unknown): boolean {
  const s = String(sym || '').toUpperCase();
  // P7.5：HIBC 家族按载体区分，MAXICODE 是二维；HIBC_128 / HIBC_CODE39 / PZN 是一维
  if (/^(MAXICODE|HIBC_QR|HIBC_DATAMATRIX|HIBC_QRCODE)/.test(s)) return true;
  return /^(QR|MICRO|DATAMATRIX|PDF417|AZTEC)/i.test(s);
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

/**
 * 静区模块数（与后端 core/barcode-renderer.ts 同口径）：
 * 一维 10X、DataMatrix/MaxiCode 1X、QR/Aztec 4X、PDF417 2X。
 * 实测 bwip 对所有码制默认都不加静区，必须显式 padding，否则码紧贴边、现场扫不出。
 */
function quietZoneModules(sym: string): number {
  const s = String(sym || '').toUpperCase();
  if (!is2dSym(s)) return 10;
  if (/PDF417/.test(s)) return 2;
  if (/AZTEC/.test(s)) return 4;
  if (/QR|MICRO/.test(s)) return 4;
  return 1;
}

/** bwip padding 单位 = scale=1 时的基础单位；一维 1 模块=1 单位，二维 1 模块=2 单位 */
function qzPad(modules: number, unitsPerModule: number): number {
  return Math.max(1, modules * unitsPerModule);
}

/** 从 SVG viewBox 推算物理尺寸（mm）；二维的模块在 bwip 里按 2 基础单位采样 */
function svgMetrics(svgStr: string, moduleMm: number, twoD: boolean) {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgStr || '');
  const w = m ? parseFloat(m[1]) : 100;
  const h = m ? parseFloat(m[2]) : 40;
  const unitsPerModule = twoD ? 2 : 1;
  const modules = Math.max(1, w / (BWIP_SVG_SCALE * unitsPerModule));
  return {
    naturalWmm: modules * moduleMm,
    naturalHmm: twoD ? (h / (BWIP_SVG_SCALE * unitsPerModule)) * moduleMm : undefined,
    modules: Math.round(modules),
  };
}

/** 一维码 SVG；失败退化为「不可扫但保布局」的占位条纹（与原生版同一兜底） */
export function makeBarcodeSvg(spec: BarcodeLikeOptions | undefined, content: unknown): SvgResult {
  const s = spec || {};
  const key = `${s.sym}|${content}|${s.moduleWidthMm}|${s.heightMm}|${s.wideRatio}|${s.showText}|${s.quietZoneMm}`;
  const hit = CACHE.bc.get(key);
  if (hit) return hit;

  const bcid = bcidOf(s.sym);
  const moduleWidth = s.moduleWidthMm ?? 0.25;
  const heightMm = s.heightMm ?? 9;
  const opts: BwipOptions = {
    bcid,
    text: String(content ?? ''),
    scale: BWIP_SVG_SCALE,
    // height 单位是 mm（不是模块数）：此前传 (heightMm/moduleWidthMm)*scale 会把条码放大约十几倍
    height: heightMm,
    // 静区：一维左右 ≥10X，上下 2 模块
    paddingwidth: s.quietZoneMm && s.quietZoneMm > 0
      ? Math.max(1, Math.round(s.quietZoneMm / moduleWidth))
      : qzPad(quietZoneModules(s.sym || ''), 1),
    paddingheight: 2,
    backgroundcolor: 'FFFFFF',
    includetext: false,
  };
  if (s.wideRatio) opts.ratio = s.wideRatio;
  if (bcid === 'gs1-128') opts.parsefnc = true;

  const svgStr = toSvg(opts);
  if (svgStr) {
    const out: SvgResult = { svgStr, ...svgMetrics(svgStr, moduleWidth, false), naturalHmm: heightMm };
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
  const key = `${s.sym}|${s.ecc}|${s.moduleSizeMm}|${s.quietZoneMm}|${s.gs1 ? 'gs1' : ''}|${content}`;
  const hit = CACHE.qr.get(key);
  if (hit) return hit;

  const bcid = bcidOf(s.sym);
  const opts: BwipOptions = {
    bcid,
    text: String(content ?? ''),
    scale: BWIP_SVG_SCALE,
    // 静区：四边按码制规范（DataMatrix 1X / QR、Aztec 4X / PDF417 2X）；2D 每模块 2 基础单位
    paddingwidth: s.quietZoneMm && s.quietZoneMm > 0
      ? Math.max(1, Math.round((s.quietZoneMm / moduleSize) * 2))
      : qzPad(quietZoneModules(s.sym || ''), 2),
    paddingheight: s.quietZoneMm && s.quietZoneMm > 0
      ? Math.max(1, Math.round((s.quietZoneMm / moduleSize) * 2))
      : qzPad(quietZoneModules(s.sym || ''), 2),
    backgroundcolor: 'FFFFFF',
  };
  if (bcid === 'qrcode' || bcid === 'microqrcode') opts.eclevel = s.ecc || 'M';
  if (bcid === 'pdf417') opts.compact = false;
  // UDI / GS1：与后端 core/barcode-renderer 同口径，DataMatrix 走 bwip 原生 gs1datamatrix
  // （内容按带括号 HRI 传入，bwip 自动落 FNC1）。不开这个开关，打出来的是普通 DataMatrix，
  // 扫码枪按 GS1 规则解不出来。
  if (s.gs1 && (bcid === 'datamatrix' || bcid === 'datamatrixrectangular')) {
    opts.bcid = 'gs1datamatrix';
  }

  const svgStr = toSvg(opts);
  if (svgStr) {
    const metrics = svgMetrics(svgStr, moduleSize, true);
    const out: SvgResult = {
      svgStr,
      modules: metrics.modules,
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
  // P7.5：P8.4 工业码制（预览仅，位图通道）。校验从宽，避免误拦合法 HIBC/GS1 载荷。
  MAXICODE: { maxLen: 138, note: 'MaxiCode（UPS），建议 ≤ 138 字符；仅图像通道可打' },
  HIBC: { note: 'HIBC，通常以 + 开头含 LIC/校验位；仅图像通道可打' },
  HIBC_128: { note: 'HIBC Code 128 载体；仅图像通道可打' },
  HIBC_CODE39: { note: 'HIBC Code 39 载体；仅图像通道可打' },
  HIBC_DATAMATRIX: { maxLen: 2000, note: 'HIBC Data Matrix；仅图像通道可打' },
  HIBC_QR: { maxLen: 2953, note: 'HIBC QR Code；仅图像通道可打' },
  PZN: { maxLen: 8, re: /^\d{6,8}$/, note: 'PZN 德国药品编号，6~8 位数字；仅图像通道可打' },
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
