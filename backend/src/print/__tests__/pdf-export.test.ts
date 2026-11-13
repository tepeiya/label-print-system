// P8.2 PDF 导出单测：mm→pt、页数、页面尺寸、栅格化失败不静默
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { encodeGrayPng } from '../../../core/png';
import { DEFAULT_PDF_DPI, MAX_PDF_SHEETS, mmToPt, sheetsToPdf } from '../pdf-export';

const tinyPng = (): Buffer => Buffer.from(encodeGrayPng(2, 2, new Uint8Array(4).fill(255)));
const sheet = (t: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="30mm" viewBox="0 0 40 30"><rect width="40" height="30" fill="#fff"/><text x="1" y="5">${t}</text></svg>`;

test('mmToPt：1mm = 72/25.4 pt，页面尺寸精确', () => {
  assert.equal(mmToPt(25.4), 72);
  assert.equal(mmToPt(0), 0);
  assert.equal(mmToPt(-1), 0);
  assert.equal(mmToPt(40), 113.3858);
});

test('sheetsToPdf：生成合法 PDF，页数与页面尺寸按 mm→pt 换算', async () => {
  const out = await sheetsToPdf([sheet('a')], 40, 30, { rasterize: async () => tinyPng() });
  assert.equal(out.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(out.pageCount, 1);
  const doc = await PDFDocument.load(out.bytes);
  assert.equal(doc.getPageCount(), 1);
  const size = doc.getPage(0).getSize();
  assert.equal(size.width, mmToPt(40));
  assert.equal(size.height, mmToPt(30));
  assert.ok(out.warnings.some((w) => w.includes('非矢量')), '必须如实声明 PDF 是位图');
  assert.ok(out.warnings.some((w) => w.includes(String(DEFAULT_PDF_DPI))));
});

test('sheetsToPdf：多 sheet → 多页', async () => {
  const out = await sheetsToPdf([sheet('a'), sheet('b'), sheet('c')], 40, 30, { rasterize: async () => tinyPng() });
  const doc = await PDFDocument.load(out.bytes);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(out.pageCount, 3);
});

test('sheetsToPdf：空页面 / 尺寸非法 直接抛错', async () => {
  await assert.rejects(() => sheetsToPdf([], 40, 30, { rasterize: async () => tinyPng() }), /没有可导出的页面/);
  await assert.rejects(() => sheetsToPdf([sheet('a')], 0, 30, { rasterize: async () => tinyPng() }), /页面尺寸非法/);
});

test('sheetsToPdf：栅格化全部失败抛错；部分失败如实计数', async () => {
  await assert.rejects(
    () => sheetsToPdf([sheet('a')], 40, 30, { rasterize: async () => { throw new Error('librsvg missing'); } }),
    /所有页面栅格化失败/,
  );
  let i = 0;
  const out = await sheetsToPdf([sheet('a'), sheet('b')], 40, 30, {
    rasterize: async () => { if (i++ === 0) throw new Error('one bad page'); return tinyPng(); },
  });
  assert.equal(out.pageCount, 1);
  assert.ok(out.warnings.some((w) => w.includes('1 页栅格化失败')));
});

test('sheetsToPdf：超过页上限截断并给 warning', async () => {
  const many = Array.from({ length: MAX_PDF_SHEETS + 2 }, () => sheet('x'));
  const out = await sheetsToPdf(many, 40, 30, { rasterize: async () => tinyPng() });
  assert.equal(out.pageCount, MAX_PDF_SHEETS);
  assert.ok(out.warnings.some((w) => w.includes('超过上限')));
});
