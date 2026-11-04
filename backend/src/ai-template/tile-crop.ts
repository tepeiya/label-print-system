// =============================================================================
// tile-crop.ts —— 多联大图自动切分
//
// 场景：用户上传一张大图（A4 纸上排了 N×M 个相同的标签），
// 传入 rows/cols + gapMm（标签间的间距 mm），sharp 按格子切出一个个小图。
// =============================================================================

import sharp from 'sharp';

export interface TileSpec {
  rows: number;                // 纵向行数
  cols: number;                // 横向列数
  /** 标签之间的间距（mm）—— 先按 dpi 转 px 后再 crop */
  gapMm?: number;
  dpi?: number;
  /** 可选：每个标签的尺寸（mm）。不传时按 gap 等分 */
  tileWidthMm?: number;
  tileHeightMm?: number;
}

export interface TileResult {
  buf: Buffer;          // 子图 PNG buffer
  row: number;          // 0-based
  col: number;          // 0-based
  xMm: number;          // 子图在原图上的左上角 mm 坐标
  yMm: number;
}

/**
 * 按 spec 把大图切成 tiles。
 * 策略：在 gap 中心切——假设 gapMm 在标签间等宽，每行每列都有 gap。
 *  宽 = cols * tileWidthPx + (cols - 1) * gapPx
 *  高 = rows * tileHeightPx + (rows - 1) * gapPx
 *  crop tile 时：左偏 gap/2，右偏 gap/2（不切到 gap 里）
 */
export async function tileCrop(buf: Buffer, spec: TileSpec): Promise<TileResult[]> {
  const meta = await sharp(buf).metadata();
  const imgW = meta.width ?? 0, imgH = meta.height ?? 0;
  if (!imgW || !imgH) throw new Error('图片尺寸读取失败');

  const dpi = spec.dpi ?? 300;
  const mmToPx = dpi / 25.4;
  const gapPx = (spec.gapMm ?? 0) * mmToPx;

  let tileWPx: number;
  let tileHPx: number;

  if (spec.tileWidthMm && spec.tileHeightMm) {
    tileWPx = spec.tileWidthMm * mmToPx;
    tileHPx = spec.tileHeightMm * mmToPx;
  } else {
    // 按 gap 等分：tiles = (cols-1)*gap + cols*tileW 铺满宽图
    tileWPx = spec.cols > 1 ? (imgW - (spec.cols - 1) * gapPx) / spec.cols : imgW;
    tileHPx = spec.rows > 1 ? (imgH - (spec.rows - 1) * gapPx) / spec.rows : imgH;
  }
  tileWPx = Math.max(10, Math.round(tileWPx));
  tileHPx = Math.max(10, Math.round(tileHPx));
  const gapHalf = Math.round(gapPx / 2);

  const out: TileResult[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      // 左上角：第 r 行标签在 (r*tileH + r*gap) 上方 gapHalf 处
      //       再往右半 gap 让 gap 不进子图
      const left = Math.max(0, Math.round(c * (tileWPx + gapPx) - gapHalf));
      const top = Math.max(0, Math.round(r * (tileHPx + gapPx) - gapHalf));
      const right = Math.min(imgW, left + tileWPx + gapHalf + (c < spec.cols - 1 ? gapHalf : 0));
      const bottom = Math.min(imgH, top + tileHPx + gapHalf + (r < spec.rows - 1 ? gapHalf : 0));

      const extract = {
        left, top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };
      const tile = await sharp(buf).extract(extract).png().toBuffer();
      out.push({
        buf: tile, row: r, col: c,
        xMm: left / mmToPx, yMm: top / mmToPx,
      });
    }
  }
  return out;
}
