// =============================================================================
// barcode-renderer.ts —— 条码/二维码渲染适配层（@bwip-js/node，覆盖全部主流码制）
//   · SVG：给前端预览 / 打印 HTML / 模板缩略图（矢量、可扫描）
//   · PNG：给服务端归档 / 第三方集成（按 dpi 出图）
//   · validate：字符集/长度 + 真实编码器试编码，双保险
// 坐标系：对外 mm；位图 px = mm * dpi / 25.4。
// =============================================================================

import bwipjs from '@bwip-js/node';
import type { BarcodeSpec, QrcodeSpec } from './types';

/** mm → 像素（按 dpi） */
export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

/** 统一码制名（模板里可能是 CODE128 / QRCODE / UPC_A 等） → bwip-js bcid */
export const BWIP_MAP: Record<string, string> = {
  CODE128: 'code128',
  GS1_128: 'gs1-128',
  CODE39: 'code39',
  CODE93: 'code93',
  EAN13: 'ean13',
  EAN8: 'ean8',
  UPC: 'upca',
  UPC_A: 'upca',
  UPC_E: 'upce',
  ITF14: 'itf14',
  ITF: 'interleaved2of5',
  CODABAR: 'rationalizedCodabar',
  MSI: 'msi',
  PHARMACODE: 'pharmacode',
  CODE16K: 'code16k',
  QR: 'qrcode',
  QRCODE: 'qrcode',
  MICRO_QR: 'microqrcode',
  MICROQR: 'microqrcode',
  DATAMATRIX: 'datamatrix',
  DATAMATRIX_RECT: 'datamatrixrectangular',
  PDF417: 'pdf417',
  AZTEC: 'azteccode',
  AZTECCODE: 'azteccode',
};

export function bcidOf(sym: string): string {
  const bcid = BWIP_MAP[String(sym || '').toUpperCase()];
  if (!bcid) throw new Error(`不支持的条码类型: ${sym}`);
  return bcid;
}

/** 判断是否为二维码 */
export function is2d(sym: string): boolean {
  return /^(QR|QRCODE|MICRO|DATAMATRIX|PDF417|AZTEC)/i.test(String(sym));
}

// ----------------------------- 字符集/长度校验 -----------------------------
const RULES: Record<string, { maxLen?: number; charset?: RegExp; note: string }> = {
  CODE128: { note: '支持 ASCII 全字符' },
  GS1_128: { note: '使用 (AI) 应用标识符，如 (01)12345678901231' },
  CODE39: { charset: /^[0-9A-Za-z\-.$/+% ]*$/, note: '仅 0-9 A-Z a-z 及 - . $ / + % 空格' },
  CODE93: { note: '支持 ASCII 全字符' },
  CODE16K: { maxLen: 1500, note: 'Code 16K 多层码' },
  EAN13: { maxLen: 13, charset: /^\d{12,13}$/, note: '12 位数字（第 13 位为校验位）' },
  EAN8: { maxLen: 8, charset: /^\d{7,8}$/, note: '7 位数字（第 8 位为校验位）' },
  UPC: { maxLen: 12, charset: /^\d{11,12}$/, note: '11 位数字（第 12 位为校验位）' },
  UPC_A: { maxLen: 12, charset: /^\d{11,12}$/, note: '11 位数字（第 12 位为校验位）' },
  UPC_E: { maxLen: 8, charset: /^\d{7,8}$/, note: '7 位数字（第 8 位为校验位）' },
  ITF14: { maxLen: 14, charset: /^\d{13,14}$/, note: '13 位数字（GTIN-14）' },
  ITF: { charset: /^\d+$/, note: '仅数字，偶数位' },
  CODABAR: { charset: /^[0-9$:/.+\-]+$/, note: '数字及 $ : / . + -' },
  MSI: { charset: /^\d+$/, note: '仅数字' },
  PHARMACODE: { charset: /^\d+$/, note: '仅数字' },
  QR: { maxLen: 2953, note: '建议 ≤ 2000 字符' },
  QRCODE: { maxLen: 2953, note: '建议 ≤ 2000 字符' },
  MICRO_QR: { maxLen: 500, note: 'Micro QR 建议 ≤ 300 字符' },
  MICROQR: { maxLen: 500, note: 'Micro QR 建议 ≤ 300 字符' },
  DATAMATRIX: { maxLen: 2000, note: '建议 ≤ 1500 字符' },
  PDF417: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
  AZTEC: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
};

export interface BarcodeValidation {
  ok: boolean;
  error?: string;
  note?: string;
  quietZoneMm?: number;
}

/** 静态规则校验 */
export function validateBarcodeRules(sym: string, content: string): BarcodeValidation {
  const key = String(sym || '').toUpperCase();
  const r = RULES[key];
  if (!r) return { ok: false, error: `不支持的条码类型: ${sym}` };
  if (!content) return { ok: false, error: '条码内容为空', note: r.note };
  if (r.charset && !r.charset.test(content))
    return { ok: false, error: `内容不符合 ${sym} 字符集（${r.note}）`, note: r.note };
  if (r.maxLen && content.length > r.maxLen)
    return { ok: false, error: `${sym} 内容超长，最大 ${r.maxLen}（${r.note}）`, note: r.note };
  return { ok: true, note: r.note };
}

/** 完整校验：规则 + 真实编码器试渲染 */
export function validateBarcode(sym: string, content: string): BarcodeValidation {
  const base = validateBarcodeRules(sym, content);
  if (!base.ok) return base;
  try {
    bwipRenderOptions({ sym, content, moduleWidthMm: 0.25, heightMm: 8, showText: false } as any, { svg: true });
    return { ...base, ok: true };
  } catch (e: any) {
    return { ok: false, error: `编码失败：${e.message}`, note: base.note };
  }
}

// ----------------------------- bwip 参数 -----------------------------
interface RenderOpts {
  svg?: boolean;
  dpi?: number;
}

/** 模板条码规格 → bwip-js 参数（统一坐标/尺寸/明文/ECC） */
function bwipRenderOptions(spec: BarcodeSpec, opts: RenderOpts = {}): any {
  const bcid = bcidOf(spec.sym);
  const content = String(spec.content ?? '');
  const twoD = is2d(spec.sym);
  const dpi = opts.dpi ?? 300;
  const mm = spec.moduleWidthMm ?? 0.25;

  const o: any = {
    bcid,
    text: content,
    scale: opts.svg ? 3 : Math.max(1, mmToPx(mm, dpi)),
    // 静区：bwip 的 padding 单位与 scale 一致（模块数）
    paddingwidth: 8,
    paddingheight: 4,
    backgroundcolor: 'FFFFFF',
    ...(twoD ? {} : { height: Math.max(1, spec.heightMm ?? 9) }),
  };

  if (!twoD) {
    o.includetext = !!spec.showText;
    if (spec.showText) {
      o.textxalign = 'center';
      o.textsize = Math.max(6, Math.min(18, (spec.heightMm ?? 9) * 1.1));
    }
  }

  if (bcid === 'gs1-128') o.parsefnc = true;
  if (spec.wideRatio && bcid === 'code39') o.ratio = spec.wideRatio;
  if (bcid === 'qrcode' || bcid === 'microqrcode') {
    o.eclevel = (spec as any).ecc || 'M';
  }
  return o;
}

function qrRenderOptions(spec: QrcodeSpec, opts: RenderOpts = {}): any {
  const bcid = bcidOf(spec.sym);
  const dpi = opts.dpi ?? 300;
  const mm = spec.moduleSizeMm ?? 0.4;
  const o: any = {
    bcid,
    text: String(spec.content ?? ''),
    scale: opts.svg ? 3 : Math.max(1, mmToPx(mm, dpi)),
    paddingwidth: 0,
    paddingheight: 0,
    backgroundcolor: 'FFFFFF',
  };
  if (bcid === 'qrcode' || bcid === 'microqrcode') o.eclevel = spec.ecc || 'M';
  if (bcid === 'pdf417') o.compact = false;
  return o;
}

/** 生成 SVG 字符串（同步、矢量、含静区；前端可直接内联打印） */
export function renderBarcodeSvg(spec: BarcodeSpec): string {
  return bwipjs.toSVG(bwipRenderOptions(spec, { svg: true }));
}

export function renderQrcodeSvg(spec: QrcodeSpec): string {
  return bwipjs.toSVG(qrRenderOptions(spec, { svg: true }));
}

/** 生成 PNG（异步；按 dpi 出图，供存档/第三方集成） */
export async function renderBarcodeToPng(spec: BarcodeSpec, dpi: number): Promise<Buffer> {
  const v = validateBarcodeRules(spec.sym, spec.content);
  if (!v.ok) throw new Error(v.error);
  return bwipjs.toBuffer(bwipRenderOptions(spec, { dpi }));
}

export async function renderQrcodeToPng(spec: QrcodeSpec, dpi: number): Promise<Buffer> {
  const v = validateBarcodeRules(spec.sym, spec.content);
  if (!v.ok) throw new Error(v.error);
  return bwipjs.toBuffer(qrRenderOptions(spec, { dpi }));
}

/** 列出支持的码制（前端下拉/文档用） */
export function supportedSymbologies() {
  return {
    linear: ['CODE128', 'GS1_128', 'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPC', 'UPC_E', 'ITF14', 'ITF', 'CODABAR', 'MSI', 'PHARMACODE', 'CODE16K'],
    twod: ['QRCODE', 'MICROQR', 'DATAMATRIX', 'DATAMATRIX_RECT', 'PDF417', 'AZTEC'],
  };
}
