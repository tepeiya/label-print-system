// =============================================================================
// frontend-print.test.ts —— 前端 console 打印引擎 (engine/print.ts) 的关键回归
//   前端无测试基建，这里借后端的 tsx runner 直接 import 前端纯 TS 模块，
//   锁死两类曾经出错的行为：旋转元素打印、双面输出。
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore 前端 TS 模块，tsx 可解析；bwip-js 依赖在 console node_modules
import { buildPrintHtml } from '../../../../apps/console/src/views/designer/engine/print.ts';

const PAGE = {
  widthMm: 50, heightMm: 30, dpi: 203, orientation: 0, unit: 'mm',
  columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0, copies: 1, duplex: false,
  mediaType: 'gap', gapMm: 2, blackMarkMm: 3, offsetXMm: 0, offsetYMm: 0,
  calibrateXMm: 0, calibrateYMm: 0, guides: [],
};

function tpl(elements: any[], duplex = false) {
  return {
    schemaVersion: 1,
    page: { ...PAGE, duplex },
    variables: [],
    elements,
  } as any;
}

// ------------------------------ 旋转修复 ------------------------------
test('旋转矩形：打印 HTML 带 transform:rotate（基线，boxStyle 分支）', () => {
  const html = buildPrintHtml(tpl([
    { id: 'r', type: 'rect', x: 1, y: 1, w: 20, h: 10, rotation: 90, fill: '#fff' },
  ]), [{}]);
  assert.ok(html.includes('transform:rotate(90deg)'), '矩形旋转应输出 transform');
});

test('旋转条码：打印 HTML 必须带 transform:rotate（曾遗漏的 bug）', () => {
  const html = buildPrintHtml(tpl([
    {
      id: 'b', type: 'barcode', x: 1, y: 1, w: 30, h: 12, rotation: 90,
      barcode: { type: 'CODE128', content: 'ABC-123', showText: false },
    },
  ]), [{}]);
  assert.ok(html.includes('transform:rotate(90deg)'), '条码旋转必须在打印 HTML 中输出，不能再漏转');
  assert.ok(html.includes('transform-origin:center center'), '旋转轴心应与设计态一致');
});

test('旋转二维码：打印 HTML 必须带 transform:rotate 且轴心为元素盒中心', () => {
  const html = buildPrintHtml(tpl([
    {
      id: 'q', type: 'qrcode', x: 5, y: 3, w: 20, h: 20, rotation: 180,
      qrcode: { content: 'https://example.com', quietZoneMm: 1 },
    },
  ]), [{}]);
  assert.ok(html.includes('transform:rotate(180deg)'), '二维码旋转必须输出');
  assert.ok(html.includes('transform-origin:center center'));
});

test('未旋转的条码/二维码：不输出 transform（无副作用）', () => {
  const html = buildPrintHtml(tpl([
    { id: 'b', type: 'barcode', x: 1, y: 1, w: 30, h: 12, barcode: { type: 'CODE128', content: 'X' } },
  ]), [{}]);
  assert.ok(!html.includes('rotate('), '未旋转不应出现 rotate');
});

// ------------------------------ 前端双面 ------------------------------
test('前端 duplex=false：无 label-back、无 scaleX', () => {
  const html = buildPrintHtml(tpl([{ id: 't', type: 'text', x: 1, y: 1, w: 20, h: 6, text: 'A' }]), [{}]);
  assert.ok(!html.includes('label-back'));
  assert.ok(!html.includes('scaleX(-1)'));
});

test('前端 duplex=true：正反面交替 + .label-back 镜像规则', () => {
  const html = buildPrintHtml(tpl([
    { id: 't', type: 'text', x: 1, y: 1, w: 20, h: 6, text: 'A' },
  ], true), [{}, {}]);
  assert.equal((html.match(/class="label"/g) || []).length, 2, '2 个正面');
  assert.equal((html.match(/class="label label-back"/g) || []).length, 2, '2 个背面');
  assert.ok(html.includes('.label-back { transform: scaleX(-1)'));
  const kinds = [...html.matchAll(/class="label( label-back)?"/g)].map((m) => m[1] ? 'B' : 'F');
  assert.deepEqual(kinds, ['F', 'B', 'F', 'B'], '正→背交替');
});

test('前端 duplex=true + 拼版：按 sheet 交替', () => {
  const page = { ...PAGE, duplex: true, columns: 2, rows: 1 };
  const html = buildPrintHtml({ schemaVersion: 1, page, variables: [],
    elements: [{ id: 't', type: 'text', x: 1, y: 1, w: 10, h: 6, text: 'A' }] } as any, [{}, {}]);
  const sheets = html.split('<div class="sheet">').slice(1);
  assert.equal(sheets.length, 2);
  assert.ok(!sheets[0].includes('label-back'));
  assert.ok(sheets[1].includes('label-back'));
});

// ------------------------------ 第四层：富文本 / 合并 / DB字段 ------------------------------
test('L4 富文本打印：逐 run 样式 span + 占位符插值', () => {
  const html = buildPrintHtml(tpl([
    {
      id: 'rt', type: 'richtext', x: 1, y: 1, w: 30, h: 8,
      runs: [{ text: 'SKU:', bold: true }, { text: '{{sku}}', color: '#ff0000' }],
      font: { size: 10 },
    },
  ]), [{ sku: 'A-100' }]);
  assert.match(html, /font-weight:bold/, '粗体 span');
  assert.match(html, /color:#ff0000/, '颜色 span');
  assert.ok(html.includes('A-100'), '占位符插值');
  assert.ok(!html.includes('{{sku}}'), '占位符不应残留');
});

test('L4 表格合并：主格 span 跨格 + 被覆盖格跳过', () => {
  const html = buildPrintHtml(tpl([
    {
      id: 't', type: 'table', x: 1, y: 1, w: 40, h: 20, rows: 2, cols: 2,
      cells: ['A', 'B', 'C', 'D'],
      mergedCells: [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }],
      showBorder: true,
    },
  ]), [{}]);
  assert.match(html, /grid-row:1\/span 2/, '主格跨 2 行');
  assert.ok(!/>C</.test(html), '被覆盖格 C 不绘制');
  assert.ok(/>[\s]*D[\s]*</.test(html), '区外格 D 绘制');
});

test('L4 DB 字段：字段取值 + 格式 + 空值占位', () => {
  const html = buildPrintHtml(tpl([
    { id: 'd1', type: 'dbField', x: 1, y: 1, w: 20, h: 6, dbField: { field: '{{sku}}' } },
    { id: 'd2', type: 'dbField', x: 1, y: 8, w: 20, h: 6, dbField: { field: '{{price}}', format: 'num:2' } },
    { id: 'd3', type: 'dbField', x: 1, y: 15, w: 20, h: 6, dbField: { field: '{{missing}}', fallback: '—' } },
  ], [
    { name: 'sku', defaultValue: '' }, { name: 'price', defaultValue: '' },
  ]), [{ sku: 'X-9', price: 7.5 }]);
  assert.ok(html.includes('X-9'), '字段值');
  assert.ok(html.includes('7.50'), 'num:2 格式');
  assert.ok(html.includes('—'), '空值占位');
});
