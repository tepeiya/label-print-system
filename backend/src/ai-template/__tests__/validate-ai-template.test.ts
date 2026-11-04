// =============================================================================
// validate-ai-template.test.ts —— LLM 脏输出兜底（§10.9 #5 补测试）
// 覆盖：非对象输出 / 非法元素类型 / 坐标越界 / 码制纠偏 / 变量名纠偏 / 合并单元格钳制
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAiTemplate } from '../validate-ai-template';

const PAGE = { widthMm: 60, heightMm: 40, dpi: 300 };
const el = (o: any) => ({ x: 1, y: 1, w: 10, h: 5, ...o });
const run = (template: any) => validateAiTemplate({ template }, PAGE);

test('非对象输出直接抛错（不能静默产出空模板）', () => {
  assert.throws(() => validateAiTemplate(null, PAGE), /缺少 template/);
  assert.throws(() => validateAiTemplate(undefined, PAGE), /缺少 template/);
  assert.throws(() => validateAiTemplate('nonsense', PAGE), /缺少 template/);
  assert.throws(() => validateAiTemplate(42, PAGE), /缺少 template/);
});

test('兼容模型直接返回 template 本体（无外层包裹）', () => {
  const r = validateAiTemplate({ elements: [el({ type: 'text', text: 'hi' })] }, PAGE);
  assert.equal(r.template.elements.length, 1);
  assert.equal(r.template.elements[0].text, 'hi');
});

test('拿到一个毫无结构的对象时不抛错，而是空元素 + 回退 warning（上层走启发式）', () => {
  const r = validateAiTemplate({ foo: 1 }, PAGE);
  assert.equal(r.template.elements.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('未产出任何合法元素')));
});

test('页面尺寸以用户输入为准，模型给的尺寸被强制覆写', () => {
  const r = run({ page: { widthMm: 100, heightMm: 80 }, elements: [] });
  assert.equal(r.template.page.widthMm, 60);
  assert.equal(r.template.page.heightMm, 40);
  assert.equal(r.template.page.dpi, 300);
  assert.ok(r.fixedCount >= 1);
  assert.ok(r.warnings.some((w) => w.includes('页面尺寸')));
});

test('未知元素类型丢弃，合法类型保留', () => {
  const r = run({ elements: [el({ type: 'svg' }), el({ type: 'text', text: 'a' }), el({ type: '' })] });
  assert.equal(r.droppedCount, 2);
  assert.equal(r.template.elements.length, 1);
});

test('坐标越界丢弃（超出页面 5% 容差），边界内允许', () => {
  const r = run({ elements: [el({ type: 'text', x: 100 }), el({ type: 'text', y: 90 }), el({ type: 'text', x: 55, y: 38 })] });
  assert.equal(r.droppedCount, 2);
  assert.equal(r.template.elements.length, 1);
});

test('负坐标超出容差丢弃', () => {
  const r = run({ elements: [el({ type: 'text', x: -10 }), el({ type: 'text', x: -2 })] });
  assert.equal(r.droppedCount, 1);
});

test('宽高非正数：普通元素丢弃，line 例外（补最小尺寸）', () => {
  const r = run({ elements: [el({ type: 'text', w: 0 }), el({ type: 'line', w: 0, h: 0, x2: 20 })] });
  assert.equal(r.droppedCount, 1);
  assert.equal(r.template.elements.length, 1);
  assert.equal(r.template.elements[0].type, 'line');
  assert.equal(r.template.elements[0].x2, 20);
});

test('元素超出右/下边界时收缩宽高而不是丢', () => {
  const r = run({ elements: [el({ type: 'text', x: 55, y: 36, w: 30, h: 30 })] });
  const out = r.template.elements[0];
  assert.equal(out.w, 8);   // maxX = 60 * 1.05 = 63
  assert.equal(out.h, 6);   // maxY = 40 * 1.05 = 42
});

test('非数值坐标降级为 0，而不是 NaN 污染模板', () => {
  const r = run({ elements: [{ type: 'text', x: 'abc', y: null, w: 10, h: 5 }] });
  assert.equal(r.template.elements[0].x, 0);
  assert.equal(r.template.elements[0].y, 0);
});

test('二维码：QR 归一化为 QRCODE，非法 ecc 回落 M', () => {
  const r = run({ elements: [el({ type: 'qrcode', qrcode: { sym: 'QR', ecc: 'Z', content: 'x' } })] });
  assert.equal(r.template.elements[0].qrcode.sym, 'QRCODE');
  assert.equal(r.template.elements[0].qrcode.ecc, 'M');
});

test('二维码：未知码制回落 QRCODE 并计入 fixedCount', () => {
  const r = run({ elements: [el({ type: 'qrcode', qrcode: { sym: 'SMARC' } })] });
  assert.equal(r.template.elements[0].qrcode.sym, 'QRCODE');
  assert.ok(r.fixedCount >= 1);
});

test('一维码：code-128 / EAN-13 这类带连字符的写法能纠偏且不记 fix', () => {
  const r = run({ elements: [el({ type: 'barcode', barcode: { sym: 'code-128' } }), el({ type: 'barcode', x: 12, barcode: { sym: 'ean-13' } })] });
  assert.deepEqual(r.template.elements.map((e: any) => e.barcode.sym), ['CODE128', 'EAN13']);
});

test('一维码：完全未知的码制回落 CODE128 并计入 fixedCount', () => {
  const r = run({ elements: [el({ type: 'barcode', barcode: { sym: 'NOT-A-SYM' } })] });
  assert.equal(r.template.elements[0].barcode.sym, 'CODE128');
  assert.ok(r.fixedCount >= 1);
});

test('非法变量名替换为 varN，重名变量追加序号', () => {
  const r = run({
    variables: [{ name: '1abc' }, { name: '好' }, { name: 'sku' }, { name: 'sku' }],
    elements: [],
  });
  assert.deepEqual(r.template.variables.map((v: any) => v.name), ['var1', 'var2', 'sku', 'sku2']);
});

test('未声明的 {{var}} 自动补变量并给出 warning', () => {
  const r = run({ elements: [el({ type: 'text', text: '{{lot}} / {{qty}} 和 {{lot}}' })] });
  assert.deepEqual(r.template.variables.map((v: any) => v.name), ['lot', 'qty']);
  assert.ok(r.warnings.some((w) => w.includes('未声明的变量')));
});

test('非法变量类型回落 text，合法类型保留', () => {
  const r = run({ variables: [{ name: 'a', type: 'money' }, { name: 'b', type: 'number' }], elements: [] });
  assert.equal(r.template.variables[0].type, 'text');
  assert.equal(r.template.variables[1].type, 'number');
});

test('重复/缺失 id 的元素重新编号，保证前端选中态唯一', () => {
  const r = run({ elements: [el({ type: 'text', id: 'a' }), el({ type: 'text', id: 'a' }), el({ type: 'text' })] });
  const ids = r.template.elements.map((e: any) => e.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'a');
});

test('rotation/zIndex/opacity 纠偏：非法角度归 0，opacity 钳到 [0,1]，zIndex 升序排列', () => {
  const r = run({
    elements: [
      el({ type: 'text', zIndex: 5, opacity: 3, rotation: 45 }),
      el({ type: 'text', y: 6, zIndex: 1, opacity: -2 }),
    ],
  });
  assert.equal(r.template.elements[0].zIndex, 1);
  assert.equal(r.template.elements[1].zIndex, 5);
  assert.equal(r.template.elements[0].opacity, 0);
  assert.equal(r.template.elements[1].opacity, 1);
  assert.equal(r.template.elements[1].rotation, 0);
});

test('表格：行列数钳制、cells 补齐、mergedCells 越界收缩且 1×1 丢弃', () => {
  const r = run({
    elements: [{
      type: 'table', x: 1, y: 1, w: 50, h: 30,
      rows: 999, cols: 0,
      cells: [['a']],
      mergedCells: [
        { row: 0, col: 0, rowSpan: 99, colSpan: 99 },  // 钳到 rows/cols
        { row: 3, col: 3, rowSpan: 1, colSpan: 1 },    // 越界钳制后为 1×1 → 丢弃
        null,
      ],
    }],
  });
  const t = r.template.elements[0];
  assert.equal(t.rows, 50);
  assert.equal(t.cols, 1);
  assert.equal(t.cells.length, 50);
  assert.equal(t.cells[0], 'a');
  assert.deepEqual(t.mergedCells, [{ row: 0, col: 0, rowSpan: 50, colSpan: 1 }]);
});

test('公式/序列号元素补齐必填子对象，避免前端读 undefined', () => {
  const r = run({ elements: [el({ type: 'formula' }), el({ type: 'serial', x: 12 })] });
  assert.equal(typeof r.template.elements[0].formula.expr, 'string');
  assert.equal(r.template.elements[1].serial.digits, 5);
  assert.equal(r.template.elements[1].serial.sequenceRef, 'default');
});

test('全部元素非法时给出回退 warning（上层据此走启发式结果）', () => {
  const r = run({ elements: [el({ type: 'svg' })] });
  assert.equal(r.template.elements.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('未产出任何合法元素')));
});

test('输出结构固定：schemaVersion=1 + page/variables/elements 三件套', () => {
  const r = run({ elements: [] });
  assert.equal(r.template.schemaVersion, 1);
  assert.equal(r.template.page.unit, 'mm');
  assert.ok(Array.isArray(r.template.variables));
  assert.ok(Array.isArray(r.template.elements));
});
