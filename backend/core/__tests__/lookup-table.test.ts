// =============================================================================
// lookup-table.test.ts —— 查表函数族纯函数单测（第五层）
//   覆盖：JSON 对象 / JSON 行数组 / 紧凑 KV 文本 / 类型归一化 / 边界与 fallback
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTable, lookup, vlookup } from '../lookup-table';
import { safeEval, FORMULA_FUNCTIONS } from '../formula-engine';

test('parseTable：JSON 对象字符串 → key→单列', () => {
  const t = parseTable('{"A100":12.5,"B200":9.9}');
  assert.deepEqual(t.get('A100'), [12.5]);
  assert.deepEqual(t.get('B200'), [9.9]);
});

test('parseTable：JSON 行数组字符串 → 首列 key，其余为数据列', () => {
  const t = parseTable('[["A100","MAT1","E"],["B200","MAT2","W"]]');
  assert.deepEqual(t.get('A100'), ['MAT1', 'E']);
  assert.deepEqual(t.get('B200'), ['MAT2', 'W']);
});

test('parseTable：紧凑 KV 文本（分号/换行 + =/: 分隔，值多列）', () => {
  const t = parseTable('A100=7.5;B200=8.8; C300:MAT3|W');
  assert.deepEqual(t.get('A100'), [7.5]);
  assert.deepEqual(t.get('B200'), [8.8]);
  assert.deepEqual(t.get('C300'), ['MAT3', 'W']);
  const nl = parseTable('X=1\nY=2');
  assert.deepEqual(nl.get('X'), [1]);
  assert.deepEqual(nl.get('Y'), [2]);
});

test('parseTable：直接传对象/数组（{{var}} 为 JSON 字符串时内部递归）', () => {
  assert.deepEqual(parseTable({ a: 1, b: 'two' }).get('b'), ['two']);
  assert.deepEqual(parseTable([['k', 'v1', 'v2']]).get('k'), ['v1', 'v2']);
  assert.deepEqual(parseTable(['solo']).get('solo'), ['solo']);
});

test('parseTable：值类型归一化（数字/布尔/空/字符串）', () => {
  const t = parseTable('{"n":-3.14,"zero":0,"t":true,"f":false,"s":"  abc  ","e":""}');
  assert.deepEqual(t.get('n'), [-3.14]);
  assert.deepEqual(t.get('zero'), [0]);
  assert.deepEqual(t.get('t'), [true]);
  assert.deepEqual(t.get('f'), [false]);
  assert.deepEqual(t.get('s'), ['abc']);
  assert.deepEqual(t.get('e'), ['']);
});

test('parseTable：非法/空输入返回空表，不抛错', () => {
  for (const bad of [null, undefined, 42, '', '   ', 'no-separator-line']) {
    assert.equal(parseTable(bad).size, 0, `输入 ${JSON.stringify(bad)} 应为空表`);
  }
});

test('lookup：命中取首列、未命中回退、空值回退', () => {
  const t = parseTable('{"A":1,"EMPTY":""}');
  assert.equal(lookup(t, 'A'), 1);
  assert.equal(lookup(t, 'A ', 'fb'), 1, 'key trim');
  assert.equal(lookup(t, 'MISS', 'fb'), 'fb');
  assert.equal(lookup(t, 'MISS'), '');
  assert.equal(lookup(t, 'EMPTY', 'fb'), 'fb', '空值也回退');
});

test('vlookup：列选择（1-based）、越界回退、默认首列', () => {
  const t = parseTable('[["A","M1","E"],["B","M2","W"]]');
  assert.equal(vlookup(t, 'A'), 'M1', '默认首数据列');
  assert.equal(vlookup(t, 'A', 1), 'M1');
  assert.equal(vlookup(t, 'A', 2), 'E');
  assert.equal(vlookup(t, 'B', 3, 'N/A'), 'N/A', '越界回退');
  assert.equal(vlookup(t, 'Z', 1, '无'), '无');
});

test('safeEval：LOOKUP / VLOOKUP 在表达式里可直接参与运算', () => {
  const ctx = {
    sku: 'A100',
    prices: '{"A100":12.5,"B200":9.9}',
    mat: '[["A100","MAT1","E"],["B200","MAT2","W"]]',
    qty: 3,
  };
  const r1 = safeEval('LOOKUP({{sku}}, {{prices}}) * {{qty}}', ctx);
  assert.ok(r1.ok);
  assert.equal(r1.value, 37.5);
  const r2 = safeEval('VLOOKUP({{sku}}, {{mat}}, 2)', ctx);
  assert.ok(r2.ok);
  assert.equal(r2.value, 'E');
  const r3 = safeEval('LOOKUP("X", {{prices}}, "缺货")', ctx);
  assert.ok(r3.ok);
  assert.equal(r3.value, '缺货');
});

test('safeEval：查表函数白名单登记 + 非法表不抛断整单', () => {
  assert.ok(FORMULA_FUNCTIONS.includes('LOOKUP'));
  assert.ok(FORMULA_FUNCTIONS.includes('VLOOKUP'));
  const r = safeEval('LOOKUP({{sku}}, {{broken}})', { sku: 'A', broken: ':::not-a-table' });
  assert.ok(r.ok, '非法表返回空而非抛错');
  assert.equal(r.value, '');
});
