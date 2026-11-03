// 像素坐标 → 毫米坐标换算
// 依据：用户指定标签物理宽高(mm) 与图片像素宽高。
// scaleX / scaleY 分开算，容忍用户给的图轻微非等比。

export interface CoordMapper {
  x: (px: number) => number;
  y: (px: number) => number;
  w: (px: number) => number;
  h: (px: number) => number;
  /** px → mm 的平均比例 */
  scale: number;
}

export function createMapper(
  imagePx: { w: number; h: number },
  targetMm: { w: number; h: number },
): CoordMapper {
  const scaleX = imagePx.w > 0 ? targetMm.w / imagePx.w : 0;
  const scaleY = imagePx.h > 0 ? targetMm.h / imagePx.h : 0;
  const scale = (scaleX + scaleY) / 2;
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    x: (px) => r(px * scaleX),
    y: (px) => r(px * scaleY),
    w: (px) => r(px * scaleX),
    h: (px) => r(px * scaleY),
    scale,
  };
}

/** mm → pt（1pt = 1/72 inch = 25.4/72 mm） */
export const MM_PER_PT = 25.4 / 72;

export function mmToPt(mm: number): number {
  return Math.round((mm / MM_PER_PT) * 10) / 10;
}

/** 由文本行的像素高度估算字号（pt）：行高 ≈ 1.0em，取整并夹取到合理范围 */
export function estimateFontPt(lineHeightMm: number): number {
  const pt = lineHeightMm / MM_PER_PT;
  return Math.max(4, Math.min(48, Math.round(pt * 10) / 10));
}

/** 估算一维码模块宽度（mm）：CODE128 每字符约 11 模块 + 起始/终止共 ~35 模块 */
export function estimateModuleWidthMm(totalWidthMm: number, contentLength: number, format: string): number {
  const f = format.toLowerCase();
  let modules: number;
  if (f.includes('ean13') || f.includes('upca')) modules = 95;
  else if (f.includes('ean8')) modules = 67;
  else if (f.includes('itf')) modules = 12 + contentLength * 9 + 2;
  else if (f.includes('code39')) modules = (contentLength + 2) * 13 + 2;
  else modules = Math.max(40, contentLength * 11 + 35);
  const val = totalWidthMm / modules;
  return Math.max(0.12, Math.min(0.6, Math.round(val * 1000) / 1000));
}

/** 估算二维码模块尺寸（mm）：版本未知时按 25×25 模块起点，含 4 模块静区 */
export function estimateQrModuleSizeMm(totalWidthMm: number, contentLength: number): number {
  const modules = Math.min(177, Math.max(21, 21 + Math.ceil(Math.sqrt(Math.max(1, contentLength)) ) * 4));
  const val = totalWidthMm / (modules + 8);
  return Math.max(0.15, Math.min(1.2, Math.round(val * 1000) / 1000));
}
