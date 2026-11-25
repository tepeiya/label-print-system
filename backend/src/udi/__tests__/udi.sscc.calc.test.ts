// SSCC-18 生成与装箱计划单测（纯函数）
// 跑法：cd backend && node --test dist/src/udi/__tests__/udi.sscc.calc.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSscc, isValidSscc, planBoxes, normalizePrefix } from '../udi.sscc.calc';

test('buildSscc：结构 18 位，扩展位/前缀/序列/校验位正确', () => {
  const s = buildSscc('6901234', 1);
  assert.equal(s.length, 18);
  assert.equal(s.slice(0, 1), '0');
  assert.equal(s.slice(1, 8), '6901234');
  assert.equal(s.slice(8, 17), '000000001');
  assert.equal(isValidSscc(s), true);
});

test('buildSscc：连续序列号互不相同且都通过校验', () => {
  const s1 = buildSscc('6901234', 123456);
  const s2 = buildSscc('6901234', 123457);
  assert.notEqual(s1, s2);
  assert.equal(isValidSscc(s1), true);
  assert.equal(isValidSscc(s2), true);
});

test('buildSscc：非法入参抛错（不静默截断）', () => {
  assert.throws(() => buildSscc('690123', 1), /7 位/);
  assert.throws(() => buildSscc('6901234', 0), /1~999999999/);
  assert.throws(() => buildSscc('6901234', 1_000_000_000), /1~999999999/);
  assert.throws(() => buildSscc('6901234', 1, 12), /0~9/);
});

test('normalizePrefix：去非数字后必须 7 位', () => {
  assert.equal(normalizePrefix('69-01234'), '6901234');
  assert.throws(() => normalizePrefix('123'), /7 位/);
});

test('planBoxes：27 件 / 每箱 10 → 2 满箱 + 尾箱 7', () => {
  const p = planBoxes(27, 10);
  assert.equal(p.fullBoxes, 2);
  assert.equal(p.tailQty, 7);
  assert.deepEqual(p.boxes, [10, 10, 7]);
  assert.equal(p.hasTail, true);
});

test('planBoxes：正好整箱 → 无尾箱', () => {
  const p = planBoxes(1000, 1000);
  assert.equal(p.fullBoxes, 1);
  assert.equal(p.tailQty, 0);
  assert.deepEqual(p.boxes, [1000]);
  assert.equal(p.hasTail, false);
});

test('planBoxes：不足一箱 → 只有尾箱', () => {
  const p = planBoxes(8, 10);
  assert.equal(p.fullBoxes, 0);
  assert.equal(p.tailQty, 8);
  assert.deepEqual(p.boxes, [8]);
});

test('planBoxes：allowTail=false 且有尾箱 → 抛错', () => {
  assert.throws(() => planBoxes(27, 10, false), /尾箱 7 件/);
  assert.doesNotThrow(() => planBoxes(30, 10, false));
});

test('planBoxes：小数件数（按重量装箱）', () => {
  const p = planBoxes(11.5, 5);
  assert.equal(p.fullBoxes, 2);
  assert.equal(p.tailQty, 1.5);
  assert.deepEqual(p.boxes, [5, 5, 1.5]);
});

test('planBoxes：非法与上限', () => {
  assert.throws(() => planBoxes(0, 10), /正数/);
  assert.throws(() => planBoxes(10, 0), /正数/);
  assert.throws(() => planBoxes(10_000, 1, true, 1000), /超过单次上限/);
});
