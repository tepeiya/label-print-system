// =============================================================================
// impose.ts —— 交叉合并（collate）与 PDF 拆分（第二层 · 印刷级输出）
//
// · buildLabelPlan：把「数据行 × 份数」展开成带顺序的标签计划。
//     collate=true （逐份/交叉，默认）：ABC / ABC —— 每份是完整一套数据行
//     collate=false（堆叠/分组）      ：AA / BB / CC —— 同行标签排在一起
//   现有 buildExportSvgs 的行为等价于 collate=true，故默认保持兼容。
// · splitPdfBytes / splitPdfEvery：把已有 PDF 按页范围 / 固定页数拆成多份。
//
// 纯函数/IO 仅依赖 pdf-lib；不依赖 NestJS，可 node --test 直跑。
// =============================================================================
import { PDFDocument } from 'pdf-lib';

export interface LabelPlanEntry {
  /** 全局标签序号 0..count-1 */
  index: number;
  /** 该标签取第几行数据 0..rowsCount-1 */
  rowIndex: number;
  /** 该标签属于第几份 0..copies-1 */
  copyIndex: number;
}

/**
 * 展开标签顺序计划。
 * @param collate true=逐份交叉（ABCABC，默认），false=按行堆叠（AABBCC）
 */
export function buildLabelPlan(rowsCount: number, copies: number, collate = true): LabelPlanEntry[] {
  const rows = Math.max(0, Math.floor(rowsCount));
  const cps = Math.max(0, Math.floor(copies));
  const out: LabelPlanEntry[] = [];
  if (!rows || !cps) return out;
  if (collate) {
    // 逐份：外层 copy、内层 row
    for (let copy = 0; copy < cps; copy++) {
      for (let row = 0; row < rows; row++) {
        out.push({ index: out.length, rowIndex: row, copyIndex: copy });
      }
    }
  } else {
    // 堆叠：外层 row、内层 copy
    for (let row = 0; row < rows; row++) {
      for (let copy = 0; copy < cps; copy++) {
        out.push({ index: out.length, rowIndex: row, copyIndex: copy });
      }
    }
  }
  return out;
}

/** 页范围（1-based，含首尾），如 {from:1,to:3} 表示第 1~3 页 */
export interface PdfSplitRange {
  from: number;
  to: number;
}

export interface PdfPart {
  bytes: Buffer;
  pageCount: number;
  from: number;
  to: number;
}

/** 把 PDF 按页范围拆成多份。越界范围会被夹取到实际页数；空范围跳过。 */
export async function splitPdfBytes(bytes: Buffer, ranges: PdfSplitRange[]): Promise<PdfPart[]> {
  const src = await PDFDocument.load(bytes);
  const total = src.getPageCount();
  const out: PdfPart[] = [];
  for (const r of ranges ?? []) {
    const from = Math.max(1, Math.min(total, Math.floor(r.from)));
    const to = Math.max(from, Math.min(total, Math.floor(r.to)));
    if (from > total) continue;
    const indices: number[] = [];
    for (let p = from; p <= to; p++) indices.push(p - 1); // pdf-lib 0-based
    if (!indices.length) continue;
    const part = await PDFDocument.create();
    const copied = await part.copyPages(src, indices);
    copied.forEach((page) => part.addPage(page));
    out.push({ bytes: Buffer.from(await part.save()), pageCount: copied.length, from, to });
  }
  return out;
}

/** 按固定页数均分 PDF。每 partSize 页一份，最后一份可能不足。 */
export async function splitPdfEvery(bytes: Buffer, partSize: number): Promise<PdfPart[]> {
  const doc = await PDFDocument.load(bytes);
  const total = doc.getPageCount();
  const size = Math.max(1, Math.floor(partSize));
  const ranges: PdfSplitRange[] = [];
  for (let from = 1; from <= total; from += size) {
    ranges.push({ from, to: Math.min(total, from + size - 1) });
  }
  return splitPdfBytes(bytes, ranges);
}
