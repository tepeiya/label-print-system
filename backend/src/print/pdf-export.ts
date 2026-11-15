// =============================================================================
// pdf-export.ts —— P8.2 PDF 导出（pdf-lib + sharp，依赖均已在 package.json）
//
// 【诚实的技术边界，别对外说成「矢量 PDF」】
//   pdf-lib 不能直接嵌入 SVG；本实现把每张拼版 sheet 用 librsvg/sharp 按 600dpi
//   栅格化成高分辨率位图再嵌入 PDF。因此：
//     ✅ 页面尺寸精确（mm→pt 1:1）、多页拼版、无水印、600dpi 印刷可用；
//     ❌ PDF 内部不是矢量路径；CMYK/专色/出血/裁切线/字体嵌入均不支持。
//   真正的整标签矢量输出请用 /print/export/svg；这条限制同时写进 warnings 与 docs/10 §10.28.4。
//
// 【为什么不用 puppeteer/playwright】项目刻意不引入浏览器重依赖（见 thumbnail-renderer 注释），
//   sharp 已在依赖里且能栅格化 SVG，成本最低。
// =============================================================================
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

/** 1mm = 72/25.4 pt（PDF 用户空间单位） */
export const MM_TO_PT = 72 / 25.4;
export const MAX_PDF_SHEETS = 200;
export const DEFAULT_PDF_DPI = 600;

export function mmToPt(mm: number): number {
  return Number((Math.max(0, Number(mm) || 0) * MM_TO_PT).toFixed(4));
}

export interface PdfResult {
  bytes: Buffer;
  pageCount: number;
  warnings: string[];
}

export interface PdfOptions {
  dpi?: number;
  title?: string;
  /** 单测注入：避免真跑 librsvg */
  rasterize?: (svg: string, dpi: number) => Promise<Buffer>;
}

export async function sheetsToPdf(
  sheets: string[],
  widthMm: number,
  heightMm: number,
  opts: PdfOptions = {},
): Promise<PdfResult> {
  const list = (sheets ?? []).slice(0, MAX_PDF_SHEETS);
  const dpi = Math.max(72, Math.min(1200, Math.round(Number(opts.dpi ?? DEFAULT_PDF_DPI) || DEFAULT_PDF_DPI)));
  const warnings: string[] = [];
  if (!list.length) throw new Error('没有可导出的页面');
  if ((sheets ?? []).length > MAX_PDF_SHEETS) {
    warnings.push(`页数 ${sheets.length} 超过上限 ${MAX_PDF_SHEETS}，仅导出前 ${MAX_PDF_SHEETS} 页`);
  }

  const rasterize = opts.rasterize ?? (async (svg: string, d: number) =>
    sharp(Buffer.from(svg), { density: d }).png().toBuffer());

  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? 'LabelFlow Export');
  doc.setProducer('LabelFlow P8.2');
  doc.setCreator('LabelFlow');

  const wPt = mmToPt(widthMm), hPt = mmToPt(heightMm);
  if (wPt <= 0 || hPt <= 0) throw new Error('页面尺寸非法（widthMm/heightMm 必须为正）');

  let ok = 0;
  let firstError = '';
  for (const svg of list) {
    let png: Buffer;
    try { png = await rasterize(svg, dpi); }
    catch (e: any) {
      if (!firstError) firstError = String(e?.message ?? e);
      continue;   // 单页栅格化失败不拖垮整单，但要如实计数
    }
    const img = await doc.embedPng(png);
    const page = doc.addPage([wPt, hPt]);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    ok += 1;
  }
  if (!ok) throw new Error(`所有页面栅格化失败（${firstError || 'unknown'}）：请检查系统字体/SVG 合法性`);
  if (ok < list.length) warnings.push(`${list.length - ok} 页栅格化失败已跳过，原因：${firstError}`);
  warnings.push(`PDF 内部为 ${dpi}dpi 位图（非矢量）；整标签真矢量请用 /print/export/svg`);

  const bytes = Buffer.from(await doc.save());
  return { bytes, pageCount: ok, warnings };
}
