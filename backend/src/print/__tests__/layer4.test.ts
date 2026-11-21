// =============================================================================
// layer4.test.ts —— 第四层（设计器交互精度）集成回归
//   富文本 runs / 表格合并 mergedCells / DB 字段元素 的注入与全链路渲染
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderService } from '../render.service';
import { renderPrintHtml } from '../html-renderer';
import { renderLabelSvg } from '../vector-renderer';
import { buildVectorDoc, renderVectorPdf } from '../vector-pdf';

const PAGE = {
  widthMm: 60, heightMm: 40, dpi: 203, orientation: 0, unit: 'mm',
  columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0, copies: 1, duplex: false,
  mediaType: 'gap', gapMm: 2, blackMarkMm: 3, offsetXMm: 0, offsetYMm: 0,
  calibrateXMm: 0, calibrateYMm: 0, guides: [],
} as any;

function content(elements: any[], variables: any[] = []) {
  return { schemaVersion: 1, page: PAGE, variables, elements } as any;
}

// ------------------------------ 注入层 ------------------------------
test('render.service：富文本 runs 逐段插值，样式字段保留', () => {
  const svc = new RenderService();
  const els: any[] = [{
    id: 'rt', type: 'richtext', x: 1, y: 1, w: 30, h: 8, font: { size: 10 },
    runs: [
      { text: 'SKU:', bold: true },
      { text: '{{sku}}', color: '#ff0000' },
    ],
  }];
  const out = svc.renderRow(els, { sku: 'A-100' }, {}, {});
  assert.equal(out[0].runs[0].text, 'SKU:');
  assert.equal(out[0].runs[0].bold, true);
  assert.equal(out[0].runs[1].text, 'A-100', '占位符被插值');
  assert.equal(out[0].runs[1].color, '#ff0000', '样式保留');
});

test('render.service：DB 字段元素按数据行取值 + 格式 + 空值占位', () => {
  const svc = new RenderService();
  const els: any[] = [
    { id: 'd1', type: 'dbField', dbField: { field: '{{productName}}' } },
    { id: 'd2', type: 'dbField', dbField: { field: 'price', format: 'num:2' } },
    { id: 'd3', type: 'dbField', dbField: { field: 'missing', fallback: '—' } },
    { id: 'd4', type: 'dbField', dbField: { field: 'name', format: 'upper' } },
  ];
  const out = svc.renderRow(els, { productName: '苹果', price: 19.9, name: 'abc' }, {}, {});
  assert.equal(out[0].rendered, '苹果');
  assert.equal(out[1].rendered, '19.90');
  assert.equal(out[2].rendered, '—');
  assert.equal(out[3].rendered, 'ABC');
});

test('render.service：指令通道（ZPL/TSPL/EPL）富文本降级为纯文本', () => {
  const svc = new RenderService();
  const rendered = svc.renderRow([{
    id: 'rt', type: 'richtext', x: 1, y: 1, w: 30, h: 8,
    runs: [{ text: 'A', bold: true }, { text: 'B' }],
  }] as any, {}, {}, {});
  const zpl = svc.toZplElements(rendered);
  const tspl = svc.toTsplElements(rendered);
  const epl = svc.toEplElements(rendered);
  assert.equal(zpl[0].text, 'AB');
  assert.equal(tspl[0].text, 'AB');
  assert.equal(epl[0].text, 'AB');
});

// ------------------------------ HTML 渲染层 ------------------------------
test('HTML：富文本逐 run span + 表格合并跳格 + DB 字段', () => {
  const { html } = renderPrintHtml({
    templateContent: content([
      {
        id: 'rt', type: 'richtext', x: 1, y: 1, w: 30, h: 8, font: { size: 10 },
        runs: [{ text: '粗', bold: true }, { text: '细', italic: true }],
      },
      {
        id: 't', type: 'table', x: 1, y: 12, w: 40, h: 20, rows: 2, cols: 2,
        cells: ['A', 'B', 'C', 'D'], mergedCells: [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }],
        showBorder: true, borderWidth: 0.2,
      },
      { id: 'db', type: 'dbField', x: 1, y: 34, w: 20, h: 5, dbField: { field: '{{sku}}' } },
    ], [{ name: 'sku', defaultValue: 'SKU-9' }]),
    rows: [{ sku: 'SKU-9' }],
  });
  assert.match(html, /font-weight:bold/, '富文本粗体 span');
  assert.match(html, /font-style:italic/, '富文本斜体 span');
  // 表格 (0,0) 跨 2 行 → 主格高度 = 2 倍单格；被覆盖格 C 不单独绘制
  assert.ok(html.includes('height:159.84px'), '合并主格高度为单格 2 倍（159.84px vs 79.92px）');
  assert.ok(!html.includes('>C<'), '被合并覆盖的格 C 不单独绘制');
  assert.ok(html.includes('>D<'), '合并区外格 D 正常绘制');
  assert.match(html, /SKU-9/, 'DB 字段注入值');
});

// ------------------------------ 矢量渲染层 ------------------------------
test('SVG 矢量：富文本降级为纯文本并给 warning；表格合并按 span 画框', () => {
  const { svg, warnings } = renderLabelSvg([
    { id: 'rt', type: 'richtext', x: 1, y: 1, w: 30, h: 8, runs: [{ text: '你好', bold: true }, { text: '世界' }] },
    {
      id: 't', type: 'table', x: 1, y: 12, w: 40, h: 20, rows: 2, cols: 2,
      cells: ['A', 'B', 'C', 'D'], mergedCells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }], showBorder: true,
    },
  ], { widthMm: 60, heightMm: 40 });
  assert.ok(svg.includes('你好世界'), 'SVG 富文本降级为拼接文本');
  assert.ok(warnings.some((w: string) => /富文本.*降级/.test(w)), '给出降级 warning');
  assert.match(svg, /width="40"/, '合并单元格主格宽度应为整行');
});

test('矢量 PDF：富文本降级为纯文本并给 warning', async () => {
  const doc = buildVectorDoc({
    templateContent: content([
      { id: 'rt', type: 'richtext', x: 1, y: 1, w: 30, h: 8, runs: [{ text: 'A', bold: true }, { text: 'B' }] },
    ]),
    rows: [{}],
  });
  assert.ok(doc.warnings.some((w) => /富文本.*降级/.test(w)), 'PDF 富文本降级 warning');
  const { bytes } = await renderVectorPdf(doc, {});
  assert.ok(bytes.length > 100, 'PDF 字节有效');
});
