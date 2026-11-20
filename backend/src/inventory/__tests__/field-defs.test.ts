// 产品自定义字段：纯函数单测（零依赖）——字段定义校验 + 值规范化 + 打印占位符。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFieldDef, normalizeFieldKey, normalizeCustomValues, toPrintFields, type FieldDef,
} from '../field-defs.calc';

const defs: FieldDef[] = [
  { fieldKey: 'shelf_life', label: '保质期', type: 'text', required: true, options: [], sortOrder: 1 },
  { fieldKey: 'net_weight', label: '净重', type: 'number', required: false, options: [], sortOrder: 2 },
  { fieldKey: 'produced', label: '生产日期', type: 'date', required: false, options: [], sortOrder: 3 },
  { fieldKey: 'grade', label: '等级', type: 'select', required: false, options: ['A', 'B'], sortOrder: 4 },
  { fieldKey: 'tags', label: '标签', type: 'multiselect', required: false, options: ['冷链', '易碎'], sortOrder: 5 },
  { fieldKey: 'is_new', label: '新品', type: 'boolean', required: false, options: [], sortOrder: 6 },
];

test('字段标识规范化：大小写/空格/符号统一，保留合法下划线', () => {
  assert.equal(normalizeFieldKey('  Shelf Life '), 'shelf_life');
  assert.equal(normalizeFieldKey('净重'), ''); // 纯中文无法作为英文标识
  assert.equal(normalizeFieldKey('net.weight'), 'net_weight');
});

test('字段定义校验：合法定义通过，缺标识/内置冲突/选项为空被拒', () => {
  assert.deepEqual(
    assertFieldDef({ fieldKey: 'Shelf Life', label: '保质期', type: 'text', required: true }),
    { fieldKey: 'shelf_life', label: '保质期', type: 'text', required: true, options: [], sortOrder: 0 },
  );
  assert.throws(() => assertFieldDef({ fieldKey: '123bad', label: 'x', type: 'text' }), /字段标识/);
  assert.throws(() => assertFieldDef({ fieldKey: 'code', label: 'x', type: 'text' }), /内置字段冲突/);
  assert.throws(() => assertFieldDef({ fieldKey: 'x', label: 'x', type: 'select' }), /至少一个选项/);
  assert.throws(() => assertFieldDef({ fieldKey: 'x', label: 'x', type: 'nope' }), /字段类型/);
});

test('值规范化：按类型转换、必填拦截、选项校验', () => {
  const out = normalizeCustomValues(defs, {
    shelf_life: ' 12个月 ', net_weight: '2.5', produced: '2026-11-20',
    grade: 'A', tags: ['冷链', '易碎', '冷链'], is_new: 'true', unknown_key: 'drop-me',
  });
  assert.deepEqual(out, {
    shelf_life: '12个月', net_weight: 2.5, produced: '2026-11-20',
    grade: 'A', tags: ['冷链', '易碎'], is_new: true,
  }, '未定义的 key 应被丢弃，多选去重，数字/布尔转类型');

  assert.throws(() => normalizeCustomValues(defs, { net_weight: '1', grade: 'C' }), /必填/, '缺必填字段应报错');
  assert.throws(() => normalizeCustomValues(defs, { shelf_life: 'x', net_weight: 'abc' }), /数字/);
  assert.throws(() => normalizeCustomValues(defs, { shelf_life: 'x', produced: '2026/11/20' }), /日期格式/);
  assert.throws(() => normalizeCustomValues(defs, { shelf_life: 'x', tags: ['未知'] }), /选项/);
});

test('值规范化：空值非必填不落 key，停用字段的值被丢弃', () => {
  const withInactive = [...defs.map((d) => ({ ...d, active: true })),
    { fieldKey: 'legacy', label: '旧字段', type: 'text' as const, required: false, options: [], active: false }];
  const out = normalizeCustomValues(withInactive, { shelf_life: '6个月', legacy: 'old', net_weight: '' });
  assert.deepEqual(out, { shelf_life: '6个月' }, '空选填不落库，停用字段的值丢弃');
});

test('打印占位符：字段标识与中文名双 key，多选用逗号拼接', () => {
  const values = { shelf_life: '12个月', grade: 'A', tags: ['冷链', '易碎'] };
  const out = toPrintFields(defs, values);
  assert.equal(out['shelf_life'], '12个月');
  assert.equal(out['保质期'], '12个月');
  assert.equal(out['等级'], 'A');
  assert.equal(out['标签'], '冷链, 易碎');
  assert.equal(out['净重'], undefined, '没值的字段不产出占位符');
});
