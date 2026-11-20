// 第二层：交叉合并 collate 与 PDF 拆分单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildLabelPlan, splitPdfBytes, splitPdfEvery } from '../impose';
import { buildExportSvgs } from '../vector-renderer';

test('buildLabelPlan：collate=true 逐份交叉 ABC/ABC', () => {
  const plan = buildLabelPlan(3, 2, true);
  assert.deepEqual(plan.map((p) => p.rowIndex), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(plan.map((p) => p.copyIndex), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(plan.map((p) => p.index), [0, 1, 2, 3, 4, 5]);
});

test('buildLabelPlan：collate=false 按行堆叠 AA/BB/CC', () => {
  const plan = buildLabelPlan(3, 2, false);
  assert.deepEqual(plan.map((p) => p.rowIndex), [0, 0, 1, 1, 2, 2]);
  assert.deepEqual(plan.map((p) => p.copyIndex), [0, 1, 0, 1, 0, 1]);
});

test('buildLabelPlan：边界 rows/copies=0 返回空，默认 collate', () => {
  assert.deepEqual(buildLabelPlan(0, 3), []);
  assert.deepEqual(buildLabelPlan(3, 0), []);
  assert.deepEqual(buildLabelPlan(2, 1).map((p) => p.rowIndex), [0, 1]);
  assert.equal(buildLabelPlan(2, 1).length, buildLabelPlan(2, 1, true).length, '默认即 collate');
});

const tpl = () => ({
  page: { widthMm: 30, heightMm: 20 },
  elements: [{ id: 't', type: 'text', x: 1, y: 1, w: 20, h: 5, text: '{{sku}}', font: { size: 9 } }],
});

test('buildExportSvgs：collate 默认交叉顺序与显式 true 一致', () => {
  const rows = [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }];
  const def = buildExportSvgs({ templateContent: tpl(), rows, copies: 2 });
  const yes = buildExportSvgs({ templateContent: tpl(), rows, copies: 2, collate: true });
  assert.deepEqual(def.sheets, yes.sheets, '默认未改变既有输出');
  assert.match(def.sheets[0], /SKU-A|A/);
  assert.ok(def.sheets[0].includes('>A<'), '第一张是 A');
  assert.ok(def.sheets[1].includes('>B<'), '第二张是 B');
  assert.ok(def.sheets[3].includes('>A<'), '第四张回到 A（逐份）');
});

test('buildExportSvgs：collate=false 堆叠顺序改变标签内容排布', () => {
  const rows = [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }];
  const out = buildExportSvgs({ templateContent: tpl(), rows, copies: 2, collate: false });
  assert.ok(out.sheets[0].includes('>A<'), '第一张 A');
  assert.ok(out.sheets[1].includes('>A<'), '第二张仍 A（同行两份）');
  assert.ok(out.sheets[2].includes('>B<'), '第三张才 B');
  assert.ok(out.warnings.some((w) => w.includes('按行堆叠')));
});

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([100, 100]);
    p.drawText(`P${i + 1}`, { x: 10, y: 80, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

test('splitPdfBytes：按页范围拆分，越界夹取', async () => {
  const pdf = await makePdf(6);
  const parts = await splitPdfBytes(pdf, [{ from: 1, to: 2 }, { from: 5, to: 99 }]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].pageCount, 2);
  assert.equal(parts[1].pageCount, 2, '第 5~6 页，99 夹到 6');
  assert.equal(parts[1].from, 5);
  assert.equal(parts[1].to, 6);
  const doc = await PDFDocument.load(parts[0].bytes);
  assert.equal(doc.getPageCount(), 2);
});

test('splitPdfEvery：按固定页数均分，末份可不足', async () => {
  const pdf = await makePdf(7);
  const parts = await splitPdfEvery(pdf, 3);
  assert.deepEqual(parts.map((p) => p.pageCount), [3, 3, 1]);
  assert.deepEqual(parts.map((p) => [p.from, p.to]), [[1, 3], [4, 6], [7, 7]]);
});
