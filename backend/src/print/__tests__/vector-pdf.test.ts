// 第二层：真矢量 PDF 导出单测（buildVectorDoc + parseBarcodeSegments + renderVectorPdf）
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { encodeGrayPng } from '../../../core/png';
import { mmToPt } from '../pdf-export';
import {
  buildVectorDoc, parseBarcodeSegments, renderVectorPdf, DEFAULT_TEXT_RASTER_DPI,
  type DrawOp,
} from '../vector-pdf';

const tinyPng = () => Buffer.from(encodeGrayPng(4, 4, new Uint8Array(16).fill(255)));

const fakeQrSvg = '<svg viewBox="0 0 126 126" xmlns="http://www.w3.org/2000/svg"><path d="M0 0L42 0L42 42L0 42Z"/></svg>';
const opts = {
  barcodeSvg: () => '<svg viewBox="0 0 100 100"><path stroke-width="3" d="M10 90L10 10M30 90L30 10M50 90L50 10"/></svg>',
  qrcodeSvg: () => fakeQrSvg,
  rasterizeQrcode: async () => tinyPng(),
  rasterizeText: async () => tinyPng(),
};

const tpl = (extra: any[] = []) => ({
  page: { widthMm: 50, heightMm: 30 },
  elements: [
    { type: 'text', x: 2, y: 2, w: 40, h: 6, text: 'SKU-A1', font: { size: 10 } },
    ...extra,
  ],
});

test('parseBarcodeSegments：解析 bwip 描边 path 的竖线与 x 范围', () => {
  const r = parseBarcodeSegments('M2 58L2 0M54 58L54 0M90 58L90 0');
  assert.equal(r.segments.length, 3);
  assert.deepEqual(r.segments[0], [2, 58, 2, 0]);
  assert.equal(r.bbox.minX, 2);
  assert.equal(r.bbox.maxX, 90);
  assert.deepEqual(parseBarcodeSegments('').segments, []);
});

test('buildVectorDoc：文本/图形/条码/二维码 → 结构化指令', () => {
  const doc = buildVectorDoc({
    templateContent: tpl([
      { type: 'rect', x: 1, y: 1, w: 48, h: 28, fill: '#FFFFFF', stroke: { color: '#000', width: 0.3 } },
      { type: 'barcode', x: 2, y: 10, w: 30, h: 8, barcode: { sym: 'CODE128', content: 'A1', showText: false } },
      { type: 'qrcode', x: 35, y: 10, w: 10, h: 10, qrcode: { sym: 'QRCODE', content: 'X' } },
    ]),
    rows: [{ sku: 'V' }],
  }, opts);
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.labelCount, 1);
  assert.equal(doc.pages[0].widthMm, 50);
  assert.equal(doc.pages[0].heightMm, 30);
  const kinds = doc.pages[0].ops.map((o) => o.kind);
  assert.deepEqual(kinds, ['text', 'rect', 'barcode', 'qrcode']);
  const qr = doc.pages[0].ops.find((o) => o.kind === 'qrcode') as any;
  assert.equal(qr.svg, fakeQrSvg);
});

test('buildVectorDoc：变量求值 + collate 顺序 + 拼版分页', () => {
  const varTpl = {
    page: { widthMm: 50, heightMm: 30 },
    elements: [{ type: 'text', x: 2, y: 2, w: 40, h: 6, text: 'SKU-{{sku}}', font: { size: 10 } }],
  };
  const doc = buildVectorDoc({
    templateContent: varTpl, rows: [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }], copies: 2,
  }, opts);
  assert.equal(doc.labelCount, 6);
  assert.equal(doc.pages.length, 6, '未配拼版时一标签一页');
  const texts = doc.pages.map((p) => (p.ops[0] as any).text);
  assert.deepEqual(texts, ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-A', 'SKU-B', 'SKU-C'], '默认逐份交叉');
  const stacked = buildVectorDoc({
    templateContent: varTpl, rows: [{ sku: 'A' }, { sku: 'B' }], copies: 2, collate: false,
  }, opts);
  assert.deepEqual(stacked.pages.map((p) => (p.ops[0] as any).text), ['SKU-A', 'SKU-A', 'SKU-B', 'SKU-B']);
});

test('buildVectorDoc：拼版 2×2 把 4 标签排到一页，坐标按行列偏移', () => {
  const doc = buildVectorDoc({
    templateContent: {
      page: { widthMm: 20, heightMm: 10, columns: 2, rows: 2, gapXMm: 2, gapYMm: 1, marginMm: 1 },
      elements: [{ type: 'text', x: 0, y: 0, w: 10, h: 5, text: 'X', font: { size: 8 } }],
    },
    rows: [{}, {}, {}, {}],
  }, opts);
  assert.equal(doc.pages.length, 1);
  assert.equal(doc.pages[0].widthMm, 44); // 1*2 + 20*2 + 2*1
  assert.equal(doc.pages[0].heightMm, 23); // 1*2 + 10*2 + 1*1
  const xs = doc.pages[0].ops.map((o) => (o as any).x);
  assert.deepEqual(xs, [1, 23, 1, 23], '列偏移：1 / 1+20+2=23');
  const ys = doc.pages[0].ops.map((o) => (o as any).y);
  assert.deepEqual(ys, [1, 1, 12, 12], '行偏移：1 / 1+10+1=12');
});

test('buildVectorDoc：_skip / visible=false 跳过；CJK 文本给 warning', () => {
  const doc = buildVectorDoc({
    templateContent: {
      page: { widthMm: 30, heightMm: 20 },
      elements: [
        { type: 'text', x: 1, y: 1, w: 10, h: 4, text: 'HIDDEN', visible: false },
        { type: 'text', x: 1, y: 6, w: 20, h: 4, text: '中文标签', font: { size: 9 } },
      ],
    },
    rows: [{}],
  }, opts);
  assert.equal(doc.pages[0].ops.length, 1);
  assert.ok(doc.warnings.some((w) => w.includes('CJK')));
});

test('renderVectorPdf：生成合法 PDF，页尺寸 mm→pt，矢量而非位图', async () => {
  const doc = buildVectorDoc({ templateContent: tpl(), rows: [{}] }, opts);
  const pdf = await renderVectorPdf(doc, { title: 'T' });
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdf.pageCount, 1);
  const loaded = await PDFDocument.load(pdf.bytes);
  const size = loaded.getPage(0).getSize();
  assert.equal(size.width, mmToPt(50));
  assert.equal(size.height, mmToPt(30));
  assert.ok(pdf.warnings.some((w) => w.includes('矢量')));
  // 纯文本+注入栅格化：PDF 很小（矢量文字），不是 600dpi 整页位图
  assert.ok(pdf.bytes.length < 8000, `矢量 PDF 应远小于栅格化版本，实际 ${pdf.bytes.length}`);
});

test('renderVectorPdf：CJK 文本与二维码通过注入栅格化嵌入，不抛错', async () => {
  let rasterQrCalls = 0, rasterTextCalls = 0;
  const rasterizeQrcode = async () => { rasterQrCalls++; return tinyPng(); };
  const rasterizeText = async () => { rasterTextCalls++; return tinyPng(); };
  const doc = buildVectorDoc({
    templateContent: tpl([
      { type: 'text', x: 2, y: 10, w: 20, h: 5, text: '中文', font: { size: 9 } },
      { type: 'qrcode', x: 30, y: 10, w: 10, h: 10, qrcode: { sym: 'QRCODE', content: '中' } },
    ]),
    rows: [{}],
  }, opts);
  const pdf = await renderVectorPdf(doc, { rasterizeQrcode, rasterizeText });
  assert.equal(pdf.pageCount, 1);
  assert.equal(rasterQrCalls, 1, '二维码走栅格化');
  assert.equal(rasterTextCalls, 1, 'CJK 文本走栅格化');
});

test('renderVectorPdf：空页 / 超上限抛错', async () => {
  await assert.rejects(() => renderVectorPdf({ pages: [], warnings: [], labelCount: 0 }), /没有可导出的页面/);
  const many = Array.from({ length: 201 }, () => ({ widthMm: 10, heightMm: 10, ops: [] as DrawOp[] }));
  await assert.rejects(() => renderVectorPdf({ pages: many, warnings: [], labelCount: 201 }), /超过上限/);
});

test('buildVectorDoc：缺 templateContent 抛错', () => {
  assert.throws(() => buildVectorDoc({ templateContent: {} as any }), /缺少 page/);
});
