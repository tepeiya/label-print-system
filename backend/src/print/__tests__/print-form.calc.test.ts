// 打印时表单（prompt-at-print）：字段派生 / 校验 / 并入数据行
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFormToRows, buildPrintFields, describePrintFormErrors, mergeFormValues, validateFormValues, validateRows,
} from '../print-form.calc';

test('buildPrintFields：只取 atPrint 且非计算变量，label 缺省用 name', () => {
  const fields = buildPrintFields([
    { name: 'lot', label: '批号', atPrint: true, validation: 'nonempty' },
    { name: 'expiry', atPrint: true },
    { name: 'total', expr: '{{a}} * {{b}}', atPrint: true }, // 计算变量不让人填
    { name: 'sku' }, // 没开 atPrint
    { name: '  ' }, // 空名
  ]);
  assert.deepEqual(fields.map((f) => f.name), ['lot', 'expiry']);
  assert.equal(fields[0].label, '批号');
  assert.equal(fields[1].label, 'expiry');
  assert.equal(fields[0].required, true, 'validation=nonempty 视为必填');
  assert.equal(fields[1].required, false);
});

test('buildPrintFields：类型映射 number/integer/date', () => {
  const fields = buildPrintFields([
    { name: 'qty', atPrint: true, validation: 'number' },
    { name: 'copies', atPrint: true, validation: 'integer' },
    { name: 'made', atPrint: true, type: 'date' },
  ]);
  assert.deepEqual(fields.map((f) => f.type), ['number', 'integer', 'date']);
});

test('validateFormValues：必填缺失被点名（中文 label）', () => {
  const fields = buildPrintFields([{ name: 'lot', label: '批号', atPrint: true, validation: 'nonempty' }]);
  const r = validateFormValues(fields, {});
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].field, 'lot');
  assert.match(r.errors[0].message, /必填/);
  assert.match(describePrintFormErrors(r.errors), /批号（lot）/);
});

test('validateFormValues：数字/整数/日期格式', () => {
  const fields = buildPrintFields([
    { name: 'n', label: '数量', atPrint: true, validation: 'number' },
    { name: 'i', label: '整数', atPrint: true, validation: 'integer' },
    { name: 'd', label: '日期', atPrint: true, type: 'date' },
  ]);
  const bad = validateFormValues(fields, { n: '1.5', i: '1.5', d: '2027' });
  assert.deepEqual(bad.errors.map((e) => e.field), ['i', 'd']);
  const good = validateFormValues(fields, { n: '1.5', i: '-12', d: '2027-10-31' });
  assert.equal(good.ok, true);
  const gs1Date = validateFormValues(fields, { n: '1', i: '2', d: '271031' });
  assert.equal(gs1Date.ok, true, 'GS1 的 YYMMDD 也接受');
});

test('validateFormValues：正则不符；模板正则写坏报"模板的问题"', () => {
  const f = buildPrintFields([{ name: 'di', label: 'DI', atPrint: true, validation: 'regex', regex: '^\\d{14}$' }]);
  assert.equal(validateFormValues(f, { di: '06901234567892' }).ok, true);
  assert.equal(validateFormValues(f, { di: '690123' }).ok, false);
  const broken = buildPrintFields([{ name: 'x', label: 'X', atPrint: true, validation: 'regex', regex: '([' }]);
  const r = validateFormValues(broken, { x: 'a' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /模板里的正则/);
});

test('validateFormValues：可选字段留空不报错', () => {
  const fields = buildPrintFields([{ name: 'note', atPrint: true }]);
  assert.equal(validateFormValues(fields, { note: '' }).ok, true);
  assert.equal(validateFormValues(fields, {}).ok, true);
});

test('mergeFormValues：表单值覆盖行值，空值不覆盖', () => {
  const fields = buildPrintFields([{ name: 'lot', atPrint: true }]);
  const row = { lot: '从数据源来的', sku: 'A-1', expiry: '271031' };
  assert.deepEqual(mergeFormValues(row, { lot: 'L2612A', expiry: '' }, fields), { lot: 'L2612A', sku: 'A-1', expiry: '271031' });
});

test('mergeFormValues：defaultValue 兜底（表单没填时用模板给的默认）', () => {
  const fields = buildPrintFields([{ name: 'made', atPrint: true, defaultValue: '2026-11-28' }]);
  assert.equal(mergeFormValues({}, {}, fields).made, '2026-11-28');
  assert.equal(mergeFormValues({}, { made: '2026-12-01' }, fields).made, '2026-12-01');
});

test('applyFormToRows：无 rows 时用表单值打 1 张；多行同享表单值', () => {
  const vars = [{ name: 'lot', atPrint: true }];
  const one = applyFormToRows(undefined, vars, { lot: 'L1' });
  assert.deepEqual(one, [{ lot: 'L1' }]);
  const many = applyFormToRows([{ sku: 'A' }, { sku: 'B' }], vars, { lot: 'L1' });
  assert.deepEqual(many, [{ sku: 'A', lot: 'L1' }, { sku: 'B', lot: 'L1' }]);
});

test('buildPrintFields：内置模板的对象式 validation（pattern/maxLength）也能识别', () => {
  const fields = buildPrintFields([
    { name: 'expiry', label: '有效期', required: true, atPrint: true, validation: { pattern: '^\\d{6}$' } },
    { name: 'lot', label: '批号', required: true, atPrint: true, validation: { maxLength: 20 } },
  ]);
  assert.equal(fields[0].regex, '^\\d{6}$');
  assert.equal(fields[0].required, true);
  assert.equal(fields[1].maxLength, 20);
  const bad = validateFormValues(fields, { expiry: '27-10-31', lot: 'x'.repeat(21) });
  assert.deepEqual(bad.errors.map((e) => e.field), ['expiry', 'lot']);
});

test('validateRows：无 rows 时整批缺必填 → 报错（打印页没填就提交）', () => {
  const fields = buildPrintFields([{ name: 'lot', label: '批号', atPrint: true, validation: 'nonempty' }]);
  const r = validateRows(fields, [{}]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /整批都没有值/);
});

test('validateRows：数据行已给值时放行（pack-print / WMS 自动打印不被打印表单挡）', () => {
  const fields = buildPrintFields([
    { name: 'expiry', label: '有效期', atPrint: true, validation: 'nonempty' },
    { name: 'lot', label: '批号', atPrint: true, validation: 'nonempty' },
  ]);
  assert.equal(validateRows(fields, [{ expiry: '271031', lot: 'L1' }]).ok, true);
  const partial = validateRows(fields, [{ expiry: '271031', lot: 'L1' }, { expiry: '271031' }]);
  assert.equal(partial.ok, false);
  assert.match(partial.errors[0].message, /第 2 行/);
});

test('validateRows：所有行都有值但有一行格式不对 → 点名行号', () => {
  const fields = buildPrintFields([{ name: 'expiry', label: '有效期', atPrint: true, validation: 'regex', regex: '^\\d{6}$' }]);
  const r = validateRows(fields, [{ expiry: '271031' }, { expiry: '2027-10-31' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /第 2 行/);
});

test('validateRows：没有 atPrint 字段的模板不做任何拦截', () => {
  assert.equal(validateRows(buildPrintFields([{ name: 'sku' }]), [{}]).ok, true);
});
