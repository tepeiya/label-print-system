// =============================================================================
// bitmap-blocks.ts —— 单色点阵在各协议里的下发格式（纯字符串，无第三方依赖）
//
// 与 raster.ts 分开的原因：指令生成器必须保持可被纯单测直接调用（仓库硬规定：
// 单测不引入重依赖），而点阵**生成**需要 bwip-js + sharp。
//   生成 → raster.ts（async）；下发格式 → 本文件（sync）。
// =============================================================================

import type { BitmapFallback } from './types';

/**
 * ZPL：^GFA 下发单色点阵。
 * 参数顺序按 Zebra ZPL II ^GF 定义（^GFa,b,c,d,data）：
 *   a = 编码格式（A = ASCII hex）
 *   b = 传输的字节数（ASCII 形式即解码后的字节数）
 *   c = 点阵总字节数（未压缩）——A/B 编码下 c == b
 *   d = 每行字节数（bytes per row）
 * 证据：ZPL II ^GF 参数表；三份互相一致的样例 `^GFA,11118,11118,17,<data>`、
 *   `^GFA,2748,2748,12,...`、`^GFA,48,48,2,...`（6 行 × 2 字节/行），
 *   第二、三位永远是「同一个总字节数」，最后才是每行字节数。
 * ⚠️ 这里以前写成 `total,heightDots,bytesPerRow`——把「行数」当成了点阵总字节数，
 *   固件按 b/c 收字节，行数和总字节数不等时图案会被截断或错位（且固件不报错）。
 */
export function zplGf(b: BitmapFallback): string {
  const total = b.bytesPerRow * b.heightDots;
  return `^GFA,${total},${total},${b.bytesPerRow},${b.hex}`;
}

/** TSPL：BITMAP 数据按行给出（每行 bytesPerRow 字节的 hex），供需要逐行拼接的调用方使用 */
export function tsplBitmapLines(b: BitmapFallback): string[] {
  const per = b.bytesPerRow * 2;
  const out: string[] = [];
  for (let y = 0; y < b.heightDots; y++) out.push(b.hex.slice(y * per, (y + 1) * per));
  return out;
}

/**
 * EPL2：GW（Direct Graphic Write）头部两个尺寸参数的单位都是「字节 / 行数」。
 * `GWx,y,widthBytes,heightBytes,DATA` —— DATA 是 widthBytes×heightBytes 个原始字节，
 * 必须按 latin1/binary 逐字节下发（按 utf8 会把 ≥0x80 的字节翻倍，行数就对不上了）。
 */
export function eplGraphicSize(b: BitmapFallback): { widthBytes: number; heightBytes: number } {
  return { widthBytes: b.bytesPerRow, heightBytes: b.heightDots };
}
