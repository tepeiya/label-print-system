// 几何原语检测：水平/垂直线、彩色区域（logo/产品图）
// 纯 CPU 手写，不引入 opencv 原生依赖。
import sharp from 'sharp';

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface DetectedLine {
  orientation: 'h' | 'v';
  /** 线段两端（px） */
  x0: number; y0: number; x1: number; y1: number;
  /** 线宽（px） */
  thickness: number;
}

export interface DetectedRegion {
  bboxPx: Box;
  /** 平均饱和度 0-1，用于判断是否彩色图 */
  saturation: number;
  /** 区域内文字占比（0-1），高则不是图片 */
  textDensity: number;
}

/** Otsu 阈值 */
function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, max = 0, threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; threshold = i; }
  }
  return threshold;
}

/**
 * 检测长直线。
 * 做法：二值化后逐行/逐列找"最长连续暗像素段"，超过阈值即为线；相邻行合并同一条线。
 */
export function detectLines(gray: Uint8Array, width: number, height: number): DetectedLine[] {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const thr = Math.max(40, Math.min(220, otsu(hist, gray.length)));
  const isDark = (v: number) => v <= thr;

  const minRunH = Math.max(30, Math.floor(width * 0.25));
  const minRunV = Math.max(30, Math.floor(height * 0.25));

  const lines: DetectedLine[] = [];

  // ---- 水平线 ----
  const hRows: { y: number; start: number; end: number }[] = [];
  for (let y = 0; y < height; y += 1) {
    let runStart = -1;
    let best = { s: 0, e: 0, len: 0 };
    for (let x = 0; x <= width; x++) {
      const dark = x < width && isDark(gray[y * width + x]);
      if (dark && runStart < 0) runStart = x;
      if ((!dark || x === width) && runStart >= 0) {
        const len = x - runStart;
        if (len > best.len) best = { s: runStart, e: x, len };
        runStart = -1;
      }
    }
    if (best.len >= minRunH) hRows.push({ y, start: best.s, end: best.e });
  }
  // 合并相邻行（同一根线可能 2-6px 厚）
  for (const group of groupAdjacent(hRows, 2)) {
    const y0 = group[0].y;
    const y1 = group[group.length - 1].y;
    const thickness = y1 - y0 + 1;
    if (thickness > Math.max(8, height * 0.05)) continue; // 太厚不是线
    const start = Math.min(...group.map((g) => g.start));
    const end = Math.max(...group.map((g) => g.end));
    lines.push({ orientation: 'h', x0: start, y0: (y0 + y1) / 2, x1: end, y1: (y0 + y1) / 2, thickness });
  }

  // ---- 垂直线 ----
  const vCols: { x: number; start: number; end: number }[] = [];
  for (let x = 0; x < width; x += 1) {
    let runStart = -1;
    let best = { s: 0, e: 0, len: 0 };
    for (let y = 0; y <= height; y++) {
      const dark = y < height && isDark(gray[y * width + x]);
      if (dark && runStart < 0) runStart = y;
      if ((!dark || y === height) && runStart >= 0) {
        const len = y - runStart;
        if (len > best.len) best = { s: runStart, e: y, len };
        runStart = -1;
      }
    }
    if (best.len >= minRunV) vCols.push({ x, start: best.s, end: best.e });
  }
  for (const group of groupAdjacent(vCols, 2)) {
    const x0 = group[0].x;
    const x1 = group[group.length - 1].x;
    const thickness = x1 - x0 + 1;
    if (thickness > Math.max(8, width * 0.05)) continue;
    const start = Math.min(...group.map((g) => g.start));
    const end = Math.max(...group.map((g) => g.end));
    lines.push({ orientation: 'v', x0: (x0 + x1) / 2, y0: start, x1: (x0 + x1) / 2, y1: end, thickness });
  }

  return lines;
}

function groupAdjacent<T extends { y?: number; x?: number }>(rows: T[], gap: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const r of rows) {
    const key = (r.y ?? r.x) as number;
    const prev = cur.length ? ((cur[cur.length - 1].y ?? cur[cur.length - 1].x) as number) : NaN;
    if (cur.length && key - prev <= gap) cur.push(r);
    else { if (cur.length) out.push(cur); cur = [r]; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 检测大面积彩色区域（logo / 产品图）。
 * 做法：降采样到 ~120px 宽，按饱和度 + 亮度阈值标记前景，四连通求连通域。
 */
export async function detectColorRegions(buf: Buffer): Promise<DetectedRegion[]> {
  const TARGET_W = 120;
  const meta = await sharp(buf).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  if (!srcW || !srcH) return [];
  const ratio = srcW / TARGET_W;
  const w = TARGET_W;
  const h = Math.max(1, Math.round(srcH / ratio));

  const { data } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sat = new Float32Array(w * h);
  const val = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 3] / 255, g = data[i * 3 + 1] / 255, b = data[i * 3 + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    sat[i] = max === 0 ? 0 : (max - min) / max;
    val[i] = max;
  }

  const visited = new Uint8Array(w * h);
  const regions: DetectedRegion[] = [];
  const stack: number[] = [];
  const minArea = w * h * 0.01;

  for (let i = 0; i < w * h; i++) {
    if (visited[i]) continue;
    // 前景：有颜色（饱和度够）或明显非白
    const colorful = sat[i] > 0.18 && val[i] > 0.12;
    if (!colorful) { visited[i] = 1; continue; }

    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0, satSum = 0;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w, py = (p / w) | 0;
      count++; satSum += sat[p];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      const nb = [p - 1, p + 1, p - w, p + w];
      for (let k = 0; k < 4; k++) {
        const q = nb[k];
        if (q < 0 || q >= w * h) continue;
        if (k === 0 && px === 0) continue;
        if (k === 1 && px === w - 1) continue;
        if (visited[q]) continue;
        if (!(sat[q] > 0.18 && val[q] > 0.12)) { visited[q] = 1; continue; }
        visited[q] = 1;
        stack.push(q);
      }
    }

    if (count < minArea) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 8 || bh < 8) continue;
    // 极细长的区域更可能是色带/线条，不是图片
    const fill = count / (bw * bh);
    if (fill < 0.25) continue;

    regions.push({
      bboxPx: {
        x0: Math.round(minX * ratio),
        y0: Math.round(minY * ratio),
        x1: Math.round((maxX + 1) * ratio),
        y1: Math.round((maxY + 1) * ratio),
      },
      saturation: satSum / count,
      textDensity: 0,
    });
  }

  // 大区域优先，最多保留 4 个
  return regions.sort((a, b) => area(b.bboxPx) - area(a.bboxPx)).slice(0, 4);
}

function area(b: Box) { return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0); }

/** 两个矩形是否重叠（含容差） */
export function overlaps(a: Box, b: Box, tol = 0): boolean {
  return !(a.x1 < b.x0 - tol || b.x1 < a.x0 - tol || a.y1 < b.y0 - tol || b.y1 < a.y0 - tol);
}

/** a 是否大部分落在 b 内 */
export function insideRatio(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const aArea = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
  return inter / aArea;
}
