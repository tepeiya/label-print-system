// 成品入库判定规则的单元测试（纯函数，无 IO）
// 覆盖：单号格式 / 数量精度 / 不超工单需求 / 质量初始状态 / 完工口径 / 状态机许可
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFgNo, assertQty, assertNotOverDemand, resolveQcStatus,
  assertWoReadyForCompletion, assertCanPost, assertCanCancel,
} from '../services/fg.calc';

test('单号：FG-YYYYMMDD-NNNN，序号补四位', () => {
  const d = new Date(2026, 10, 27);
  assert.equal(formatFgNo(d, 1), 'FG-20261127-0001');
  assert.equal(formatFgNo(d, 1234), 'FG-20261127-1234');
});

test('数量：必须为正、最多三位小数', () => {
  assert.equal(assertQty(12).ok, true);
  assert.equal(assertQty(0.125).ok, true);
  assert.equal(assertQty(0).ok, false);
  assert.equal(assertQty(-3).ok, false);
  assert.equal(assertQty('abc').ok, false);
  assert.equal(assertQty(1.23456).ok, false);
});

test('累计入库不得超工单需求，返回剩余可入', () => {
  // 需求 100，已入 60，本次 40 → 恰好用满
  const ok = assertNotOverDemand(100, 60, 40);
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 40);
  // 本次 45 → 超交拦截
  const bad = assertNotOverDemand(100, 60, 45);
  assert.equal(bad.ok, false);
  assert.equal(bad.remaining, 40);
  assert.match(String(bad.reason), /超过工单需求/);
  // 小数口径：60.5 + 39.5 = 100
  assert.equal(assertNotOverDemand(100, 60.5, 39.5).ok, true);
});

test('质量初始状态：要检验的物料建批次为待检', () => {
  assert.equal(resolveQcStatus(true), 'PENDING');
  assert.equal(resolveQcStatus(false), 'RELEASED');
});

test('完工口径：只有发料完成/已关单的工单能报完工入库', () => {
  assert.equal(assertWoReadyForCompletion('ISSUED').ok, true);
  assert.equal(assertWoReadyForCompletion('CLOSED').ok, true);
  const mid = assertWoReadyForCompletion('ISSUING');
  assert.equal(mid.ok, false);
  assert.match(String(mid.reason), /尚未完工/);
  assert.equal(assertWoReadyForCompletion('RELEASED').ok, false);
  assert.equal(assertWoReadyForCompletion('CREATED').ok, false);
});

test('单据状态机：已过账不能重复过账、不能作废', () => {
  assert.equal(assertCanPost('CREATED').ok, true);
  assert.equal(assertCanPost('POSTED').ok, false);
  assert.equal(assertCanPost('CANCELLED').ok, false);
  assert.equal(assertCanCancel('CREATED').ok, true);
  assert.equal(assertCanCancel('POSTED').ok, false);
});
