// =============================================================================
// vision-rectify.ts —— 透视矫正 / 自动裁边
//
// 方案：Vision LLM 检测标签图的 4 个角点 → 取最小外接矩形 bbox → sharp extract 裁剪
// 说明：sharp 0.35 只支持 affine 2×2（仿射变换），不支持真正的 perspective homography。
//      本模块做的是「自动定位 + 自动裁边」，对整体倾斜 / 有空白边缘的标签图够用。
//      极端"歪"（非平行四边形 → 矩形透视矫正）需引 opencv-wasm 或 Python 服务。
// =============================================================================

import sharp from 'sharp';

export interface Point { x: number; y: number }
export interface Corners { tl: Point; tr: Point; br: Point; bl: Point }
export interface RectifyResult {
  buf: Buffer;                 // 裁剪后的图片
  bbox: { left: number; top: number; width: number; height: number };
  originalSize: { w: number; h: number };
  marginPx: number;
  cornersPx: Corners;          // LLM 返回的原始 4 角（用于调试验证）
}

/** 从 4 个角点取最小外接矩形 bbox + 安全 margin */
export function cornersToBbox(corners: Corners, imgW: number, imgH: number, marginRatio = 0.01) {
  const all = [corners.tl, corners.tr, corners.br, corners.bl];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of all) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const margin = Math.round(Math.min(imgW, imgH) * marginRatio);
  const left = Math.max(0, Math.round(minX) - margin);
  const top = Math.max(0, Math.round(minY) - margin);
  const width = Math.min(imgW - left, Math.round(maxX - minX) + 2 * margin);
  const height = Math.min(imgH - top, Math.round(maxY - minY) + 2 * margin);
  return { left, top, width: Math.max(1, width), height: Math.max(1, height), marginPx: margin };
}

/** sharp 裁剪图片 */
export async function extractBbox(buf: Buffer, bbox: { left: number; top: number; width: number; height: number }) {
  return sharp(buf)
    .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
    .png()
    .toBuffer();
}

/** 把 Vision LLM 返回的 corners（各种字段名）规范化为 Corners */
export function normalizeCorners(raw: any): Corners | null {
  if (!raw || typeof raw !== 'object') return null;
  const cornerPairs: Array<[string, keyof Corners]> = [
    ['tl', 'tl'], ['tr', 'tr'], ['br', 'br'], ['bl', 'bl'],
  ];
  const out = { tl: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } };
  for (const [srcKey, dstKey] of cornerPairs) {
    const found = raw[srcKey] ?? raw[srcKey.toUpperCase()];
    if (!found || typeof found !== 'object') return null;
    const x = Number(found.x ?? found.X ?? found[0]);
    const y = Number(found.y ?? found.Y ?? found[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out[dstKey] = { x, y };
  }
  return out;
}
