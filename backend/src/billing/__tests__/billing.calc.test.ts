// billing.calc 纯函数单测（不 import 实体：tsx 无装饰器元数据，见 expire.util.ts 同款约束）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkQuota, dayKey, invoiceNumber, isSettled, maxSeqOf, monthPeriod, sumLineCents, windowStart,
} from '../billing.calc';

test('windowStart: month 取本月1号，day 取今天', () => {
  const d = new Date('2026-11-05T08:00:00Z');
  assert.equal(windowStart('month', d), '2026-11-01');
  assert.equal(windowStart('day', d), '2026-11-05');
});

test('checkQuota: 无配额 / 未超限 → ok', () => {
  assert.deepEqual(checkQuota(100, 10, null), { kind: 'ok' });
  assert.deepEqual(checkQuota(100, 10, { softLimit: 200, hardLimit: 150, period: 'month' }), { kind: 'ok' });
});

test('checkQuota: 恰好打满 hard 不算超（used+qty <= hard 通过）', () => {
  assert.deepEqual(checkQuota(90, 10, { softLimit: null, hardLimit: 100, period: 'month' }), { kind: 'ok' });
});

test('checkQuota: 会突破 hard → exceeded，带上限与当前用量', () => {
  assert.deepEqual(checkQuota(95, 10, { softLimit: null, hardLimit: 100, period: 'month' }),
    { kind: 'exceeded', hardLimit: 100, used: 95 });
});

test('checkQuota: 超 soft 不超 hard → warn', () => {
  assert.deepEqual(checkQuota(50, 10, { softLimit: 50, hardLimit: 100, period: 'month' }),
    { kind: 'warn', softLimit: 50, usedAfter: 60 });
});

test('checkQuota: numeric 列读出的字符串也能比', () => {
  assert.deepEqual(checkQuota(95, 10, { softLimit: '80.00', hardLimit: '100.00', period: 'month' }),
    { kind: 'exceeded', hardLimit: 100, used: 95 });
});

test('invoiceNumber: INV-<t>-<yymm>-<seq 3位>', () => {
  assert.equal(invoiceNumber(7, new Date('2026-11-05T00:00:00Z'), 3), 'INV-7-2611-003');
  assert.equal(invoiceNumber(120, new Date('2026-01-09T00:00:00Z'), 12), 'INV-120-2601-012');
});

test('maxSeqOf: 只看同租户同月，非法号忽略', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  assert.equal(maxSeqOf(['INV-7-2611-001', 'INV-7-2611-009', 'INV-7-2610-099', 'INV-8-2611-050', 'bad'], 7, now), 9);
  assert.equal(maxSeqOf([], 7, now), 0);
});

test('isSettled: 累计收款 >= 应付即结清（多收也算）', () => {
  assert.equal(isSettled(99, 100), false);
  assert.equal(isSettled(100, 100), true);
  assert.equal(isSettled(120, 100), true);
});

test('sumLineCents: amountCents 优先，缺省 qty×unitPrice', () => {
  assert.equal(sumLineCents([
    { title: 'a', qty: 3, unitPriceCents: 100 },
    { title: 'b', amountCents: 250 },
  ]), 550);
  assert.equal(sumLineCents([]), 0);
});

test('monthPeriod: 自然月首末日（含闰年2月）', () => {
  assert.deepEqual(monthPeriod(new Date('2026-11-05T00:00:00Z')),
    { periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  assert.deepEqual(monthPeriod(new Date('2028-02-10T00:00:00Z')),
    { periodStart: '2028-02-01', periodEnd: '2028-02-29' });
  assert.deepEqual(monthPeriod(new Date('2026-12-31T23:59:59Z')),
    { periodStart: '2026-12-01', periodEnd: '2026-12-31' });
});

test('dayKey: UTC 日期串', () => {
  assert.equal(dayKey(new Date('2026-11-05T23:30:00+08:00')), '2026-11-05');
});
