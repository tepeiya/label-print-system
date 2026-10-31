// =============================================================================
// barcode-renderer.ts —— 条码/二维码 渲染适配层（自包含，零第三方依赖可出图）
// 服务端：用内置 encoder + png.ts 生成 PNG 位图（供打印/缩略图/第三方集成）。
// 前端：同一套“规格”喂给 jsbarcode / qrcode 在 Konva 画布实时预览。
// 坐标系：对外 mm；渲染时按目标 dpi 转像素：px = mm * dpi / 25.4。
// =============================================================================

import type { BarcodeSpec, QrcodeSpec } from './types';
import { encodeCode128, encodeEAN13, patternToBits } from './barcode-encoder';
import { encodeGrayPng } from './png';

/** mm → 像素（按 dpi）。原理：1 英寸=25.4mm，故 px = mm * dpi / 25.4 */
export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

// ----------------------------- 字符集/长度校验 -----------------------------
const RULES: Record<string, { maxLen?: number; charset?: RegExp; note: string }> = {
  CODE128: { note: '支持 ASCII 全字符' },
  CODE39: { charset: /^[0-9A-Z\-.$/+% ]*$/, note: '仅 0-9 A-Z 及 - . $ / + % 空格' },
  EAN13: { maxLen: 13, charset: /^\d{12,13}$/, note: '12 位数字（第13位为校验位）' },
  EAN8: { maxLen: 8, charset: /^\d{7,8}$/, note: '7 位数字' },
  UPC_A: { maxLen: 12, charset: /^\d{11,12}$/, note: '11 位数字' },
  ITF14: { maxLen: 14, charset: /^\d{13,14}$/, note: '13 位数字（GTIN-14）' },
  GS1_128: { note: '支持 (AI) 应用标识符' },
  CODABAR: { charset: /^[0-9$:/.+\-]+$/, note: '数字及 $ : / . + -' },
  MSI: { charset: /^\d+$/, note: '仅数字' },
  QR: { maxLen: 2000, note: '建议 ≤ 2000 字符' },
  DATAMATRIX: { maxLen: 1500, note: '建议 ≤ 1500 字符' },
  PDF417: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
  AZTEC: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
};

export function validateBarcode(sym: string, content: string): { ok: boolean; error?: string } {
  const r = RULES[sym];
  if (!r) return { ok: false, error: `不支持的条码类型: ${sym}` };
  if (r.charset && !r.charset.test(content))
    return { ok: false, error: `内容不符合 ${sym} 字符集（${r.note}）` };
  if (r.maxLen && content.length > r.maxLen)
    return { ok: false, error: `${sym} 内容超长，最大 ${r.maxLen}（${r.note}）` };
  return { ok: true };
}

// ----------------------------- 服务端出图（自包含） -----------------------------
/** 把模块序列按 scale 放大为像素行，并叠加上下静区，返回灰度 PNG 缓冲 */
function renderPatternToGray(
  seq: { width: number; black: boolean }[],
  scale: number,
  barHeightPx: number,
  quietModules: number,
): Buffer {
  const { row, width } = patternToBits(seq);
  const totalW = width + quietModules * 2;
  const totalWpx = totalW * scale;
  const pixels = new Uint8Array(totalWpx * barHeightPx);
  for (let y = 0; y < barHeightPx; y++) {
    for (let mx = 0; mx < totalW; mx++) {
      const black = mx < quietModules || mx >= quietModules + width
        ? false
        : row[mx - quietModules] === 1;
      const fill = black ? 0 : 255;
      for (let s = 0; s < scale; s++) pixels[y * totalWpx + mx * scale + s] = fill;
    }
  }
  return encodeGrayPng(totalWpx, barHeightPx, pixels);
}

/**
 * 生成一维码 PNG（真实可解码位图）。
 * 支持 Code128 / EAN13（自包含编码器）；其余类型由调用方接入 @bwip-js 等库。
 */
export function renderBarcodeToPng(spec: BarcodeSpec, dpi: number): Buffer {
  const v = validateBarcode(spec.sym, spec.content);
  if (!v.ok) throw new Error(v.error);

  // 窄条宽 → 每模块像素；Code128 模块宽=窄条宽，EAN 模块宽≈窄条宽
  const scale = Math.max(1, Math.round(mmToPx(spec.moduleWidthMm, dpi)));
  const barHeightPx = Math.max(1, mmToPx(spec.heightMm, dpi));

  let seq: { width: number; black: boolean }[];
  let quiet = 10;
  switch (spec.sym) {
    case 'CODE128':
    case 'GS1_128':
      seq = encodeCode128(spec.content); quiet = 10; break;
    case 'EAN13':
    case 'EAN8':
      seq = encodeEAN13(spec.content); quiet = 11; break;
    default:
      throw new Error(`${spec.sym} 服务端内置编码器未实现，请接入 @bwip-js/node`);
  }
  return renderPatternToGray(seq, scale, barHeightPx, quiet);
}

/** 二维码出图：真实环境用 @bwip-js/node / qrcode 生成；此处留出统一入口 */
export function renderQrcodeToPng(spec: QrcodeSpec, dpi: number): Buffer {
  const v = validateBarcode(spec.sym, spec.content);
  if (!v.ok) throw new Error(v.error);
  // 真实实现：const png = await bwip.toBuffer({ bcid:'qrcode', text:spec.content, scale, eclevel:spec.ecc });
  throw new Error('二维码服务端出图请接入 @bwip-js/node（前端可用 qrcode 库实时预览）');
}

// ----------------------------- 前端预览适配（在浏览器执行，仅供参考） -----------------------------
/**
 * 前端设计器调用示例（不在此文件执行）：
 *   import JsBarcode from 'jsbarcode';
 *   import QRCode from 'qrcode';
 *   JsBarcode(canvas, spec.content, { format: 'CODE128', width: mmToPx(spec.moduleWidthMm,300), height: mmToPx(spec.heightMm,300), displayValue: spec.showText });
 *   const url = await QRCode.toDataURL(spec.content, { errorCorrectionLevel: spec.ecc });
 * 关键点：前端用屏幕 dpi 预览，导出/打印时由服务端按 printer.dpi 重新出图。
 */
export const frontendPreviewHint = '见上方注释：JsBarcode + qrcode 在 Konva 画布实时渲染';
