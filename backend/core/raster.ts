// =============================================================================
// raster.ts —— 位图回填通道（P7.3 的核心基建）
//
// 解决的问题：TSPL 没有 DataMatrix/PDF417/Aztec/MicroQR 原生指令，
// P7.2 的处理是"跳过 + 引导换协议"，用户换不了协议时就只能整块丢失。
// 位图通道让这些码制**真的能打**：bwip-js 按打印机分辨率出 1:1 点阵 →
// 单色打包 → 各家协议的图像指令下发。
//
// 精确性的落脚点（1 打印点 = 1 像素）：
//   bwip-js 的 2D 参数 `modulesize` 是「每模块像素数」、`padding` 是「像素」，
//   所以传 modulesize = 模块点数、padding = 静区模块数 × 模块点数，
//   出来的 PNG 就是打印机点阵本身，不需要任何重采样（重采样会破坏模块边界，
//   是"预览能扫、打印糊掉"的常见根因）。
//   ⚠️ 一维码的 bwip 缩放单位（scale/height）与点数不是整数倍关系，
//   重采样会破坏条空比例，所以小众一维码（PHARMACODE/CODE16K）不做位图回填，
//   在能力矩阵里如实标 previewOnly，由 warnings 引导换协议或换码制。
//
// 与预览的一致性（B6）：bwip 参数一律走 barcode-renderer 的同一份 option builder。
// =============================================================================

import sharp from 'sharp';
import bwipjs from '@bwip-js/node';
import type { BitmapFallback, QrcodeSpec } from './types';
import type { PrintProtocol } from './barcode-caps';
import { planChannel } from './barcode-caps';
import { qrcodeBwipOptions } from './barcode-renderer';
import { compute2dGeometry, normSym } from './barcode-geometry';

export interface MonoRaster extends BitmapFallback {
  /** 位图宽（点），已按 8 点对齐 */
  widthDots: number;
  heightDots: number;
  /** 每行字节数 */
  bytesPerRow: number;
  /** 每模块点数，供 warnings 说明实际物理尺寸 */
  moduleDots: number;
  /** 模板请求的每模块点数；与 moduleDots 不同说明为满足无损抽稀上调过档位 */
  moduleDotsRequested?: number;
  /** 目标物理宽高（mm），由调用方用于放置校验 */
  widthMm: number;
  heightMm: number;
}

/** 二值化阈值：bwip 边缘抗锯齿按 50% 归属 */
const THRESHOLD = 128;

/** 单色点阵打包：1=墨（黑），MSB 在左，行尾补 0 到字节边界 */
function packRows(pixels: Uint8Array, width: number, height: number, moduleDots: number, dpi: number): MonoRaster {
  const bytesPerRow = Math.ceil(width / 8);
  const parts: string[] = [];
  for (let y = 0; y < height; y++) {
    const bytes = new Uint8Array(bytesPerRow);
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] < THRESHOLD) bytes[x >> 3] |= 0x80 >> (x & 7);
    }
    parts.push(Buffer.from(bytes).toString('hex').toUpperCase());
  }
  return {
    widthDots: width, heightDots: height, bytesPerRow,
    hex: parts.join(''), moduleDots,
    widthMm: (width * 25.4) / dpi,
    heightMm: (height * 25.4) / dpi,
  };
}

/**
 * 二维符号位图回填。返回点阵严格 1 打印点 = 1 像素。
 *
 * 做法：bwip 的 2D 缩放是「1 档 = 2 像素/模块」，因此按 `moduleDots` 档出图
 * （= 2×moduleDots 像素/模块）再**隔行隔列抽稀**回目标点阵。
 * 抽稀是无损的（原图每个模块就是 2×2 的整数块），不存在 resize 带来的
 * 半模块灰边——那正是"预览能扫、打印糊掉"的根因。
 *
 * ⚠️ 「无损」的前提是整张图的宽高都能被抽稀因子整除，而 bwip 的符号网格
 * 不保证这一点：实测 PDF417 在 scale=1 时是 120×21（行高方向是奇数），
 * 于是 moduleDots 取奇数（203dpi 的 0.4mm/0.6mm、300dpi 的 0.4/0.6/0.8mm）
 * 就会出 396×99 这种奇数边——直接抽稀会切掉半行，宁可重出一档。
 * 处理方式：按实测档位 +1 重出一次（仍然整数、仍然无损），并把实际模块点数
 * 记在 `moduleDotsRequested` 里，由调用方如实提示「X 方向比模板值大了 1 点」。
 * 不做多数表决/重采样：那等于把「打印糊掉」重新请回来。
 * 内容含 (AI) 时 barcode-renderer 会改喂 `^FNC1` 文本，即 GS1 DataMatrix / GS1 QR。
 */
export async function qrcodeMonoRaster(spec: QrcodeSpec, dpi: number): Promise<MonoRaster> {
  const sym = normSym(spec.sym);
  const geo = compute2dGeometry({ sym, dpi, moduleSizeMm: spec.moduleSizeMm, quietZoneMm: spec.quietZoneMm });
  const requested = geo.moduleDots;
  let lastErr = '';
  // 最多往上调 2 档：+1 就能解决 bwip 奇数网格（PDF417 行高 21×档），再多就是配置有问题
  for (let dots = requested; dots <= requested + 2; dots++) {
    const r = await monoRasterAtDots(spec, sym, dpi, dots, geo.quietModules);
    if (r.ok) return r.raster.moduleDots === requested
      ? r.raster
      : { ...r.raster, moduleDotsRequested: requested };
    lastErr = r.error;
  }
  throw new Error(`位图点阵无法无损抽稀：${sym} 在 ${requested} 点/模块及其后两档都拿不到偶数点阵（${lastErr}）`);
}

async function monoRasterAtDots(
  spec: QrcodeSpec, sym: string, dpi: number, moduleDots: number, quietModules: number,
): Promise<{ ok: true; raster: MonoRaster } | { ok: false; error: string }> {
  const opts = qrcodeBwipOptions({ ...spec, sym } as QrcodeSpec, {
    dpi,
    pxPerModule: moduleDots * 2,
    paddingUnits: quietModules * moduleDots,
  });
  const png = await bwipjs.toBuffer(opts);
  const img = await sharp(png)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sw = img.info.width, sh = img.info.height;
  // 只校验抽稀因子，不校验模块整除：模块网格本身是否整除由 bwip 的符号尺寸决定，
  // 抽稀按 (0,0) 起点隔行隔列取点，模块边界对齐即可，整张图的模块数是否偶数无关。
  if (sw % 2 !== 0 || sh % 2 !== 0) {
    return { ok: false, error: `出图 ${sw}×${sh}，存在奇数边，模块边界落在半点上` };
  }
  const w = sw / 2, h = sh / 2;
  const px = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px[y * w + x] = img.data[(y * 2) * sw + (x * 2)];
  }
  const raster = packRows(px, w, h, moduleDots, dpi);
  return { ok: true, raster };
}

/** 任意来源位图（用户 logo / 外部图片 / AI 生成图）转打印点阵 */
export async function imageMonoRaster(buf: Buffer, widthDots: number, heightDots: number, dpi: number): Promise<MonoRaster> {
  const png = await sharp(buf, { failOn: 'none' })
    .flatten({ background: '#ffffff' })
    .resize(Math.max(1, Math.round(widthDots)), Math.max(1, Math.round(heightDots)), { fit: 'fill', kernel: 'lanczos3' })
    .grayscale().threshold(THRESHOLD).png().toBuffer();
  const img = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  return packRows(img.data as Uint8Array, img.info.width, img.info.height, 1, dpi);
}

// =============================================================================
// 预生成：把「哪些元素需要位图」交给 barcode-caps.planChannel 判定，
// 生成器保持同步，只认元素上的 fallback 字段。
// =============================================================================

/** attachBitmapFallbacks 能识别的元素形状（ZplElement / TsplElement / EplElement 都满足） */
export interface RasterTarget {
  type: string;
  qrcode?: QrcodeSpec;
  imageData?: Buffer | string;
  imgWmm?: number;
  imgHmm?: number;
  fallback?: BitmapFallback;
}

/** base64 / data:URL / Buffer → Buffer */
function toBuffer(src: Buffer | string): Buffer {
  if (Buffer.isBuffer(src)) return src;
  const s = String(src ?? '');
  const m = /^data:[^;]+;base64,([\s\S]*)$/i.exec(s.trim());
  return Buffer.from((m ? m[1] : s).replace(/\s+/g, ''), 'base64');
}

/**
 * 为需要位图通道的元素预生成点阵（P7.3）。
 * · 二维码制：planChannel 判为 bitmap 时（含「无原生指令」与「二维 + GS1 (AI)」两种情况）出点阵；
 *   一维码制不在这里处理 —— bwip 一维缩放单位与打印点不成整数倍，重采样会破坏条空比例，
 *   能力矩阵里它们一律 previewOnly，由生成器如实 warning 引导换协议/换码制。
 * · image 元素：按 imgWmm/imgHmm 缩到目标点阵。
 * 返回**浅拷贝**数组（原数组不改动），单个元素出图失败只出 warning，不影响其它元素。
 */
export async function attachBitmapFallbacks<T extends RasterTarget>(
  els: T[], dpi: number, protocol: PrintProtocol,
): Promise<{ els: T[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: T[] = [];

  for (const el of els) {
    if (el.type === 'qrcode' && el.qrcode) {
      const sym = normSym(el.qrcode.sym ?? 'QRCODE');
      const plan = planChannel(sym, protocol, el.qrcode.content);
      if (plan.channel === 'bitmap') {
        try {
          const raster = await qrcodeMonoRaster(el.qrcode, dpi);
          if (raster.moduleDotsRequested !== undefined && raster.moduleDotsRequested !== raster.moduleDots) {
            warnings.push(`[位图] ${sym} 每模块点数由 ${raster.moduleDotsRequested} 点上调到 ${raster.moduleDots} 点`
              + `（${((raster.moduleDotsRequested * 25.4) / dpi).toFixed(2)}mm → ${(raster.moduleDots * 25.4 / dpi).toFixed(2)}mm），`
              + `原因：bwip 出图在该档位是奇数点阵，隔行隔列抽稀会切掉半个模块。符号仍可扫，X-dim 略大于模板值。`);
          }
          out.push({ ...el, fallback: raster });
          continue;
        } catch (e: any) {
          warnings.push(`[位图] ${sym} 点阵生成失败：${e?.message ?? e}。该元素将被跳过（宁可不打，不打错码）`);
        }
      }
      out.push(el);
      continue;
    }

    if (el.type === 'image') {
      if (!el.imageData) {
        warnings.push('[图像] image 元素没有图片数据（src 为空），已跳过位图生成');
        out.push(el);
        continue;
      }
      const w = Math.max(1, Math.round(((Number(el.imgWmm) || 10) * dpi) / 25.4));
      const h = Math.max(1, Math.round(((Number(el.imgHmm) || 10) * dpi) / 25.4));
      try {
        out.push({ ...el, fallback: await imageMonoRaster(toBuffer(el.imageData), w, h, dpi) });
      } catch (e: any) {
        warnings.push(`[图像] 图片转打印点阵失败：${e?.message ?? e}，该元素将被跳过`);
        out.push(el);
      }
      continue;
    }

    out.push(el);
  }

  return { els: out, warnings };
}

// MonoRaster 即 BitmapFallback（多出的 moduleDots/widthMm/heightMm 只是诊断信息，
// 生成器只读 BitmapFallback 那五个字段）。各协议的图像指令封装在 bitmap-blocks.ts。
export type RasterWithMeta = MonoRaster & BitmapFallback;
