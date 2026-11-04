// =============================================================================
// html-renderer.test.ts —— 多联拼版端到端单元测试
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPrintHtml } from '../html-renderer';

const PAGE_60x40 = { widthMm: 60, heightMm: 40, dpi: 300 };

/** 最小模板：矩形边框 + 带占位符的文本 */
function tplWith(vars: string[] = []) {
  const text = vars.length ? `产品名 {{${vars[0]}}}` : '产品名';
  return {
    page: PAGE_60x40,
    elements: [
      { id: 'e1', type: 'text', x: 2, y: 2, w: 30, h: 6, text, font: { size: 10, family: 'Arial', color: '#000' } },
      { id: 'r1', type: 'rect', x: 2, y: 10, w: 56, h: 28, fill: '#fff', stroke: { width: 0.5, color: '#333' } },
    ],
  };
}

// ------------------------------ labelCount 基础 ------------------------------
test('单联 1×1：labelCount = rows.length × copies，与模板内容无关', () => {
  const out = renderPrintHtml({
    templateContent: tplWith(),
    rows: [{}, {}, {}],     // 3 行空数据
    copies: 2,              // 2 份
  });
  assert.equal(out.labelCount, 6, `应为 3 × 2 = 6，实际 ${out.labelCount}`);
  const lbls = (out.html.match(/class="lbl"/g) || []).length;
  assert.equal(lbls, 6);
});

test('默认参数：不传 rows / copies 时 labelCount = 1', () => {
  const out = renderPrintHtml({ templateContent: tplWith() });
  assert.equal(out.labelCount, 1);
  assert.ok(!out.html.includes('grid-template-columns')); // 1×1 不走拼版
});

// ------------------------------ 多联拼版 ------------------------------
test('2×3 拼版：grid CSS 正确 + sheet 尺寸正确', () => {
  const tpl = { ...tplWith(), page: { ...PAGE_60x40, columns: 2, rows: 3, gapXMm: 2, gapYMm: 3, marginMm: 5 } };
  const out = renderPrintHtml({ templateContent: tpl });
  const lbls = (out.html.match(/class="lbl"/g) || []).length;
  const sheets = (out.html.match(/class="sheet"/g) || []).length;
  assert.equal(out.labelCount, 1); // 没传 rows，默认 1 行
  assert.equal(lbls, 1);
  assert.equal(sheets, 1, '1 个 label 也会走拼版 sheet 逻辑');
  assert.ok(out.html.includes('grid-template-columns: repeat(2,'), 'grid 应为 2 列');
  // sheetWMm = margin*2 + w*cols + gapX*(cols-1) = 5*2 + 60*2 + 2 = 132mm
  // sheetHMm = margin*2 + h*rows + gapY*(rows-1) = 5*2 + 40*3 + 6 = 136mm
  assert.ok(out.html.includes('size: 132mm 136mm'),
    `sheet 尺寸应为 132mm × 136mm，实际没找到；html snippet: ${out.html.match(/size:[^;]+;/)}`);
});

test('2×2 拼版 + 超过一张 sheet：生成 N 张 sheet', () => {
  const tpl = { ...tplWith(), page: { ...PAGE_60x40, columns: 2, rows: 2, gapXMm: 1, gapYMm: 1, marginMm: 2 } };
  const out = renderPrintHtml({
    templateContent: tpl,
    rows: [{}, {}, {}, {}, {}], // 5 行 → 5 个 label；2×2 一 sheet 装 4 → 需要 2 张 sheet
  });
  const sheets = (out.html.match(/class="sheet"/g) || []).length;
  const lbls = (out.html.match(/class="lbl"/g) || []).length;
  assert.equal(lbls, 5);
  assert.equal(sheets, 2);
});

test('gap 和 margin 为 0：sheet 尺寸 = w*cols × h*rows', () => {
  const tpl = { ...tplWith(), page: { ...PAGE_60x40, columns: 2, rows: 2, gapXMm: 0, gapYMm: 0, marginMm: 0 } };
  const out = renderPrintHtml({ templateContent: tpl });
  assert.ok(out.html.includes('size: 120mm 80mm'), '无 gap/margin 时 sheet 应为 120×80mm');
});

test('只 columns / 只 rows 也能触发拼版', () => {
  const tpl = { ...tplWith(), page: { ...PAGE_60x40, columns: 3 } };
  const out = renderPrintHtml({ templateContent: tpl });
  assert.ok(out.html.includes('grid-template-columns: repeat(3,'), '只设 columns 也应拼版');
});

// ------------------------------ 变量渲染 ------------------------------
test('变量占位符渲染：{{varName}} 被替换为 row 中的值', () => {
  const out = renderPrintHtml({
    templateContent: tplWith(['productName']),
    rows: [{ productName: '可乐罐' }, { productName: '雪碧瓶' }],
  });
  assert.equal(out.labelCount, 2);
  assert.ok(out.html.includes('可乐罐'), '第一个 label 应渲染 "可乐罐"');
  assert.ok(out.html.includes('雪碧瓶'), '第二个 label 应渲染 "雪碧瓶"');
});

test('变量缺失时留空，不报错', () => {
  const out = renderPrintHtml({
    templateContent: tplWith(['sku']),
    rows: [{}, {}], // sku 未提供
  });
  assert.equal(out.labelCount, 2, '不应因变量缺失崩溃');
});

// ------------------------------ 基本元素渲染 ------------------------------
test('rect 元素：填充色 + 边框', () => {
  const out = renderPrintHtml({ templateContent: tplWith() });
  assert.ok(out.html.includes('background:#fff') || out.html.includes('background: #fff'));
  assert.ok(out.html.includes('border'));
});

test('text 元素：字体 + 颜色', () => {
  const out = renderPrintHtml({ templateContent: tplWith() });
  assert.ok(out.html.includes('font-family:Arial'));
  assert.ok(out.html.includes('color:#000'));
});
