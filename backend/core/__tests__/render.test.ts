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

test('渲染-GS1 空值 AI 段剔除（条码与 HRI 同步）', () => {
  const svc = new RenderService();
  const els: any[] = [
    { id: 'dm', type: 'qrcode', qrcode: { gs1: true, sym: 'DATAMATRIX', content: '(01){{gtin}}(17){{expiry}}(10){{lot}}(21){{serial}}' } },
    { id: 'hri', type: 'text', text: '(01){{gtin}}\n(17){{expiry}}\n(10){{lot}}\n(21){{serial}}' },
  ];
  const out = svc.renderRow(els, { gtin: '06901234567892', expiry: '271031', lot: 'PF2601', serial: '' }, {}, {});
  assert.equal(out[0].qrcode.content, '(01)06901234567892(17)271031(10)PF2601');
  assert.equal(out[1].text, '(01)06901234567892\n(17)271031\n(10)PF2601');
  // 填了序列号则保留 (21)
  const out2 = svc.renderRow(els, { gtin: '06901234567892', expiry: '271031', lot: 'PF2601', serial: 'SN9001' }, {}, {});
  assert.match(out2[0].qrcode.content, /\(21\)SN9001$/);
});

test('渲染-GS1 码整段无值时元素不打印（箱标不填 SSCC）', () => {
  const svc = new RenderService();
  const els: any[] = [
    { id: 'sscc', type: 'barcode', barcode: { sym: 'GS1_128', content: '(00){{sscc}}' } },
    { id: 'sscc-hri', type: 'text', text: '(00){{gtin}}\n(00){{sscc}}' },
  ];
  const out = svc.renderRow(els, { sscc: '' }, {}, {});
  assert.equal(out[0]._skip, true);
  assert.equal(out[1]._skip, true, 'HRI 只剩空 AI 段时整块不打印');
  // 给了 SSCC 就照常打
  const out2 = svc.renderRow(els, { sscc: '069012340000000016', gtin: '06901234567892' }, {}, {});
  assert.equal(out2[0]._skip, undefined);
  assert.equal(out2[0].barcode.content, '(00)069012340000000016');
});
