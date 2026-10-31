// =============================================================================
// render.test.ts —— 渲染管线测试（模板+变量+公式+流水号 → 单行元素）
// 运行：node --import tsx --test backend/core/__tests__/render.test.ts
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RenderService } from '../../src/print/render.service';

test('渲染-变量占位替换', () => {
  const svc = new RenderService();
  const els: any[] = [{ id: 'e1', type: 'text', text: 'SKU: {{sku}}' }];
  const out = svc.renderRow(els, { sku: 'A100' }, {}, {});
  assert.equal(out[0].text, 'SKU: A100');
});

test('渲染-公式元素（出错显示占位不阻断）', () => {
  const svc = new RenderService();
  const els: any[] = [
    { id: 'f1', type: 'formula', formula: { expr: 'UPPER({{name}})' } },
    { id: 'f2', type: 'formula', formula: { expr: '1/0' } },
  ];
  const out = svc.renderRow(els, { name: 'abc' }, {}, {});
  assert.equal(out[0].rendered, 'ABC');
  assert.equal(out[1].rendered, '{{ERROR}}'); // 除零不阻断整单
});

test('渲染-流水号按行切片', () => {
  const svc = new RenderService();
  const els: any[] = [{ id: 's1', type: 'serial', serial: { sequenceRef: 'SN' } }];
  const serials = { s1: ['NO00001', 'NO00002', 'NO00003'] };
  const rows = [{}, {}, {}];
  rows.forEach((row, i) => {
    const out = svc.renderRow(els, row, serials, {}, i);
    assert.equal(out[0].rendered, serials.s1[i]);
  });
});
