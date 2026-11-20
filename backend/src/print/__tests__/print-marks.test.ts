// 第二层：印刷工艺标记单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPrintMarks, hexToCmyk, hasAnyMarks, MAX_BLEED_MM } from '../print-marks';

const sheet = (w = 40, h = 30) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/><text x="1" y="5">A</text></svg>`;

test('hexToCmyk：标准色与非法值回退', () => {
  assert.deepEqual(hexToCmyk('#000000'), [0, 0, 0, 1]);
  assert.deepEqual(hexToCmyk('#FFFFFF'), [0, 0, 0, 0]);
  assert.deepEqual(hexToCmyk('not-a-color'), [0, 0, 0, 1]);
  const c = hexToCmyk('#FF0000');
  assert.equal(c[0], 0);
  assert.equal(c[1], 1);
  assert.equal(c[2], 1);
  assert.equal(c[3], 0);
});

test('hasAnyMarks：空选项不触发，任一标记触发', () => {
  assert.equal(hasAnyMarks({}), false);
  assert.equal(hasAnyMarks({ bleedMm: 0, cropMarks: false }), false);
  assert.equal(hasAnyMarks({ bleedMm: 2 }), true);
  assert.equal(hasAnyMarks({ registrationMarks: true }), true);
  assert.equal(hasAnyMarks({ colorBars: true }), true);
});

test('applyPrintMarks：无标记时页面尺寸不变，内容原样', () => {
  const out = applyPrintMarks([sheet()], 40, 30, {});
  assert.equal(out.sheetWidthMm, 40);
  assert.equal(out.sheetHeightMm, 30);
  assert.equal(out.bleedMm, 0);
  assert.equal(out.pdfOps.length, 0);
  assert.match(out.sheets[0], /width="40mm" height="30mm"/);
  assert.match(out.sheets[0], /translate\(0 0\)/);
});

test('applyPrintMarks：出血扩大页面并内移内容', () => {
  const out = applyPrintMarks([sheet()], 40, 30, { bleedMm: 3 });
  assert.equal(out.sheetWidthMm, 46);
  assert.equal(out.sheetHeightMm, 36);
  assert.equal(out.bleedMm, 3);
  assert.match(out.sheets[0], /width="46mm" height="36mm"/);
  assert.match(out.sheets[0], /translate\(3 3\)/);
  assert.match(out.sheets[0], /A/);
  assert.ok(out.warnings.some((w) => w.includes('出血 3mm')));
});

test('applyPrintMarks：出血被夹取到上限', () => {
  const out = applyPrintMarks([sheet()], 40, 30, { bleedMm: 999 });
  assert.equal(out.bleedMm, MAX_BLEED_MM);
  assert.equal(out.sheetWidthMm, 40 + 2 * MAX_BLEED_MM);
});

test('applyPrintMarks：裁切线生成 8 条线（四角×2）', () => {
  const out = applyPrintMarks([sheet()], 40, 30, { cropMarks: true });
  const lines = out.pdfOps.filter((o) => o.kind === 'line');
  assert.equal(lines.length, 8);
  assert.match(out.sheets[0], /<line /);
});

test('applyPrintMarks：套准线生成十字+圆环', () => {
  const out = applyPrintMarks([sheet()], 40, 30, { registrationMarks: true });
  const lines = out.pdfOps.filter((o) => o.kind === 'line');
  const circles = out.pdfOps.filter((o) => o.kind === 'circle');
  assert.equal(circles.length, 4, '四边中点各一个圆环');
  assert.equal(lines.length, 8, '四边中点各一个十字（2 线）');
  assert.match(out.sheets[0], /<circle /);
});

test('applyPrintMarks：色标含 CMYK 四块，专色以 CMYK 近似并警示', () => {
  const out = applyPrintMarks([sheet()], 40, 30, {
    colorBars: true,
    spotColors: [{ name: 'PANTONE-485', cmyk: [0, 0.95, 0.9, 0] }],
  });
  const rects = out.pdfOps.filter((o) => o.kind === 'rect');
  assert.equal(rects.length, 5, 'CMYK 四色 + 1 专色');
  assert.ok(out.warnings.some((w) => w.includes('PANTONE-485')));
  assert.ok(out.warnings.some((w) => w.includes('Separation')));
});

test('applyPrintMarks：多 sheet 全部施加标记，pdfOps 只汇总一份', () => {
  const out = applyPrintMarks([sheet(), sheet(), sheet()], 40, 30, { cropMarks: true });
  assert.equal(out.sheets.length, 3);
  assert.ok(out.sheets.every((s) => s.includes('<line')));
  assert.equal(out.pdfOps.filter((o) => o.kind === 'line').length, 8, '指令是一页的模板，非每页累加');
});
