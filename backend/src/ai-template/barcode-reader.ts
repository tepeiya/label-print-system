// 条码 / 二维码识别：zxing-wasm（zxing-cpp 的 WASM 版）
// 精度远高于纯 JS 的 @zxing/library，且支持一次识别多个码 + 返回四角坐标。
import { readBarcodes } from 'zxing-wasm';
import sharp from 'sharp';

export interface DetectedBarcode {
  /** 解码文本 */
  text: string;
  /** zxing 码制名，如 Code128 / EAN13 / QRCode / DataMatrix / PDF417 */
  format: string;
  /** 像素包围盒（左上/右下） */
  bboxPx: { x0: number; y0: number; x1: number; y1: number };
  /** 四角点（用于透视矫正/角度判断） */
  corners: { x: number; y: number }[];
  /** 是否水平（宽 > 高） */
  horizontal: boolean;
  /** zxing 认为的有效性（部分码有校验位失败但仍可读） */
  valid: boolean;
}

/** 把任意图片 buffer 解码为 RGBA raw，供 zxing + OCR 共用 */
export async function toRgba(buf: Buffer): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })   // 透明底合成白底，否则整图变黑
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

/** 灰度 raw（几何检测用，单通道更省内存） */
export async function toGray(buf: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/**
 * 识别图中所有条码/二维码。
 * 先整图扫一遍；若无结果再按 2×2 / 3×3 分块扫描提升小码召回率。
 */
export async function detectBarcodes(buf: Buffer): Promise<DetectedBarcode[]> {
  const { data, width, height } = await toRgba(buf);

  const once = async (region?: { x: number; y: number; w: number; h: number }) => {
    let img = { data, width, height };
    if (region) img = cropRgba(data, width, height, region);
    try {
      const results = await readBarcodes(
        { data: img.data, width: img.width, height: img.height },
        { formats: ['All'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 12 },
      );
      return results
        .filter((r) => r.text)
        .map((r) => normalize(r, region));
    } catch {
      return [];
    }
  };

  let found = await once();
  if (!found.length) {
    // 分块扫描：小码在大图里常常整图识别不到
    for (const [gx, gy] of [[2, 2], [3, 3]] as const) {
      const cw = Math.floor(width / gx);
      const ch = Math.floor(height / gy);
      const acc: DetectedBarcode[] = [];
      for (let i = 0; i < gx; i++) {
        for (let j = 0; j < gy; j++) {
          acc.push(...await once({ x: i * cw, y: j * ch, w: cw, h: ch }));
        }
      }
      if (acc.length) { found = acc; break; }
    }
  }

  return dedupe(found);
}

/** zxing 结果 → 统一结构；region 用于把分块坐标还原到整图坐标 */
function normalize(r: any, region?: { x: number; y: number; w: number; h: number }): DetectedBarcode {
  const pts = [r.position?.topLeft, r.position?.topRight, r.position?.bottomRight, r.position?.bottomLeft]
    .filter(Boolean)
    .map((p: any) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const ox = region?.x ?? 0;
  const oy = region?.y ?? 0;
  const x0 = Math.min(...xs) + ox;
  const x1 = Math.max(...xs) + ox;
  const y0 = Math.min(...ys) + oy;
  const y1 = Math.max(...ys) + oy;
  return {
    text: String(r.text ?? ''),
    format: String(r.format ?? 'Unknown'),
    bboxPx: { x0, y0, x1, y1 },
    corners: pts.map((p) => ({ x: p.x + ox, y: p.y + oy })),
    horizontal: x1 - x0 >= y1 - y0,
    valid: r.isValid !== false,
  };
}

function cropRgba(data: Uint8ClampedArray, width: number, height: number, r: { x: number; y: number; w: number; h: number }) {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const srcStart = ((r.y + y) * width + r.x) * 4;
    out.set(data.subarray(srcStart, srcStart + r.w * 4), y * r.w * 4);
  }
  return { data: out, width: r.w, height: r.h };
}

/** 同一码在整图/分块中可能重复命中，按文本 + 位置去重 */
function dedupe(list: DetectedBarcode[]): DetectedBarcode[] {
  const out: DetectedBarcode[] = [];
  for (const b of list) {
    const dup = out.some((o) => o.text === b.text && Math.abs(o.bboxPx.x0 - b.bboxPx.x0) < 12 && Math.abs(o.bboxPx.y0 - b.bboxPx.y0) < 12);
    if (!dup) out.push(b);
  }
  return out;
}

/** zxing 码制名 → LabelFlow 模板 sym */
export function toBarcodeSym(format: string): string {
  const f = format.toLowerCase();
  if (f.includes('qr')) return 'QRCODE';
  if (f.includes('datamatrix')) return 'DATAMATRIX';
  if (f.includes('pdf417')) return 'PDF417';
  if (f.includes('aztec')) return 'AZTEC';
  if (f.includes('code128') || f.includes('code_128')) return 'CODE128';
  if (f.includes('code39') || f.includes('code_39')) return 'CODE39';
  if (f.includes('code93') || f.includes('code_93')) return 'CODE93';
  if (f.includes('ean13') || f.includes('ean_13')) return 'EAN13';
  if (f.includes('ean8') || f.includes('ean_8')) return 'EAN8';
  if (f.includes('upca') || f.includes('upc_a')) return 'UPC_A';
  if (f.includes('itf') || f.includes('interleaved')) return 'ITF14';
  if (f.includes('codabar')) return 'CODABAR';
  if (f.includes('msi')) return 'MSI';
  return 'CODE128';
}

/** 一维码统一暴露给前端/LLM 的可读名称 */
export function formatLabel(format: string): string {
  return format;
}
