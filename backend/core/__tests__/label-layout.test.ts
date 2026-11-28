// A1：字段 → 标签版式（确定性排版引擎）单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLabelLayout, type LayoutField } from '../label-layout';

const F = (name: string, label: string, extra: Partial<LayoutField> = {}): LayoutField => ({ name, label, ...extra });

function boundsOf(t: any) {
  return { w: t.page.widthMm, h: t.page.heightMm, els: t.elements as any[] };
}

function assertInside(t: any, label: string) {
  const { w, h, els } = boundsOf(t);
  for (const e of els) {
    if (e.type === 'line') {
      assert.ok(e.x >= -0.01 && e.y >= -0.01 && e.x2 <= w + 0.01 && e.y2 <= h + 0.01, `${label} 直线越界 ${JSON.stringify(e)}`);
      continue;
    }
    assert.ok(e.x >= -0.01 && e.y >= -0.01, `${label} ${e.id} 左上越界`);
    assert.ok(e.x + e.w <= w + 0.01, `${label} ${e.id} 右侧越界 ${e.x}+${e.w}>${w}`);
    assert.ok(e.y + e.h <= h + 0.01, `${label} ${e.id} 底部越界 ${e.y}+${e.h}>${h}`);
  }
}

test('50×30 医疗单件标：标题 + 信息区 + 一维码，全部在纸内', () => {
  const r = buildLabelLayout({
    widthMm: 50, heightMm: 30, dpi: 203, style: 'medical',
    title: '一次性使用无菌注射器',
    footer: '某某医疗器械有限公司',
    fields: [
      F('spec', '规格', { emphasis: true, sample: '5ml' }),
      F('lot', '批号', { sample: 'PF2601' }),
      F('expiry', '有效期', { type: 'date', sample: '2027-10-31' }),
      F('qty', '数量', { type: 'number', sample: '100' }),
      F('barcodeText', '条码', { type: 'barcode', sample: '(01)06901234567892(10)PF2601(17)271031' }),
    ],
  });
  assertInside(r.template, '50×30');
  const ids = r.template.elements.map((e: any) => e.type);
  assert.ok(ids.includes('text') && ids.includes('barcode') && ids.includes('rect'));
  const bar = r.template.elements.find((e: any) => e.type === 'barcode');
  assert.equal(bar.barcode.content, '{{barcodeText}}');
  // 模块宽必须是该 dpi 的整点
  const step = 25.4 / 203;
  assert.ok(Math.abs(bar.barcode.moduleWidthMm / step - Math.round(bar.barcode.moduleWidthMm / step)) < 0.01);
  // 标题变量与信息字段都进了 variables
  const names = r.template.variables.map((v: any) => v.name);
  for (const n of ['spec', 'lot', 'expiry', 'qty', 'barcodeText']) assert.ok(names.includes(n), `缺变量 ${n}`);
});

test('100×70 工业标：字段 ≥4 且宽够 → 两列，二维码不压一维码', () => {
  const fields = Array.from({ length: 10 }, (_, i) => F(`f${i}`, `字段${i}`, { sample: `v${i}` }));
  const r = buildLabelLayout({
    widthMm: 100, heightMm: 70, dpi: 300, style: 'industrial',
    fields: [...fields, F('qr', '二维码', { type: 'qrcode', sample: 'UDI-1' }), F('bar', '条码', { type: 'barcode', sample: '6901234567892' })],
  });
  assertInside(r.template, '100×70');
  assert.equal(r.meta.columns, 2);
  const qr = r.template.elements.find((e: any) => e.type === 'qrcode');
  const bar = r.template.elements.find((e: any) => e.type === 'barcode');
  assert.ok(qr && bar);
  assert.ok(qr.y + qr.h <= bar.y + 0.01, `二维码(${qr.y}+${qr.h}) 压到一维码(y=${bar.y})`);
});

test('40×20 小标 + 8 字段：自动分两列仍放得下，但要提示字号偏小', () => {
  const fields = Array.from({ length: 8 }, (_, i) => F(`f${i}`, `字段${i}`));
  const r = buildLabelLayout({ widthMm: 40, heightMm: 20, dpi: 203, fields });
  assertInside(r.template, '40×20');
  assert.equal(r.meta.columns, 2, '放不下时先分两列而不是丢字段');
  assert.ok(r.warnings.some((w) => /字号/.test(w)), '字号偏小要提示');
  assert.ok(r.meta.rowHeightMm >= 2.4, '行高不低于可读下限');
});

test('字段远超容量：明确省略并报出被省略的字段名，绝不排到纸外', () => {
  const fields = Array.from({ length: 20 }, (_, i) => F(`f${i}`, `字段${i}`));
  const r = buildLabelLayout({ widthMm: 30, heightMm: 20, dpi: 203, fields });
  assertInside(r.template, '30×20');
  assert.ok(r.warnings.some((w) => /已省略/.test(w)), '应说明省略了几个字段');
  const placed = r.template.elements.filter((e: any) => e.type === 'text' && /^\{\{/.test(e.text)).length;
  assert.ok(placed < 20, '不该把 20 个字段全塞进去');
});

test('只给文本字段也能出成品：无码时不凭空造码', () => {
  const r = buildLabelLayout({ widthMm: 40, heightMm: 30, dpi: 203, fields: [F('productName', '产品名', { sample: '葡萄糖注射液' }), F('spec', '规格', { sample: '500ml' })] });
  assertInside(r.template, '40×30');
  assert.equal(r.template.elements.filter((e: any) => e.type === 'barcode' || e.type === 'qrcode').length, 0);
  assert.ok(r.template.elements.some((e: any) => e.type === 'text' && e.text === '{{productName}}'), '产品名进标题');
});

test('默认样式按字段名推断：含 lot/expiry → medical', () => {
  const r = buildLabelLayout({ widthMm: 60, heightMm: 40, dpi: 300, fields: [F('lot', '批号'), F('expiry', '有效期', { type: 'date' })] });
  assertInside(r.template, '60×40 默认样式');
  // medical 有左侧强调色条
  assert.ok(r.template.elements.some((e: any) => e.type === 'rect' && e.fill === '#1f6feb'));
});
