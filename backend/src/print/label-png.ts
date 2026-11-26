// =============================================================================
// label-png.ts —— 整标签栅格化：已渲染元素 → PNG（image / png-base64 通道用）
//
// 为什么这样做：
//   ImageProvider 原来优先 node-canvas，装不上时回退「白底占位 PNG」，
//   打出来是空白纸——不能交付。这里改用系统已有的矢量层：
//     已渲染元素 → renderLabelSvg（条码/二维码内联 bwip 的 SVG 路径）→ sharp 栅格化
//   好处：不需要 canvas（也不需要为它在客户机上装原生依赖），
//   且条码是矢量转位图，边缘锐利、在 203/300/600dpi 下都不糊。
//
// 坐标契约：elements 用模板原生形态（x/y/w/h，单位 mm），
//   与模板 content.elements / RenderService.renderRow 输出一致；不是 ZPL 的 xMm/yMm。
// =============================================================================
import sharp from 'sharp';
import { renderLabelSvg } from './vector-renderer';

export interface LabelRasterInput {
  elements: any[];
  widthMm: number;
  heightMm: number;
  dpi: number;
}

export interface LabelRasterResult {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  /** 矢量层发现的问题（如富文本降级、条码编码失败），不阻塞出图 */
  warnings: string[];
}

/** 毫米 → 像素（与全系统同一公式：mm * dpi / 25.4，四舍五入） */
export function mmToPixel(mm: number, dpi: number): number {
  return Math.round((Number(mm) * Number(dpi)) / 25.4);
}

/**
 * 已渲染元素 → PNG 位图。
 * 失败（尺寸非法 / 渲染异常）直接抛错，由调用方返回 ok:false，不允许静默出白底。
 */
export async function renderLabelPng(input: LabelRasterInput): Promise<LabelRasterResult> {
  const widthMm = Number(input.widthMm);
  const heightMm = Number(input.heightMm);
  const dpi = Math.round(Number(input.dpi) || 300);
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error(`标签尺寸非法：${input.widthMm}×${input.heightMm}mm`);
  }
  if (dpi < 72 || dpi > 1200) throw new Error(`DPI 超出范围：${dpi}（支持 72~1200）`);

  const { svg, warnings } = renderLabelSvg(input.elements ?? [], { widthMm, heightMm });
  const widthPx = mmToPixel(widthMm, dpi);
  const heightPx = mmToPixel(heightMm, dpi);

  const png = await sharp(Buffer.from(svg), { density: dpi })
    .resize(widthPx, heightPx, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { png, widthPx, heightPx, warnings };
}
