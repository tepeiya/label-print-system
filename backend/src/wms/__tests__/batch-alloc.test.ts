// 批次分配单测（D5：手工批次优先 / 自动 FIFO→近效期 / 跨批拆分）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateBatches, isExpired } from '../issuing/services/batch-alloc.calc';

const NOW = new Date('2026-11-23T08:00:00Z');

test('自动分配：有效期早的先发（近效期优先）', () => {
  const r = allocateBatches([
    { batchNo: 'B-LATE', qty: 100, expiresAt: '2027-12-31', createdAt: '2026-01-01' },
    { batchNo: 'B-SOON', qty: 100, expiresAt: '2026-12-31', createdAt: '2026-06-01' },
  ], 50, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.allocations.length, 1);
  assert.equal(r.allocations[0].batchNo, 'B-SOON');
});

test('自动分配：跨批次拆分，余量不足报 shortage', () => {
  const r = allocateBatches([
    { batchNo: 'B1', qty: 30, expiresAt: '2026-12-01' },
    { batchNo: 'B2', qty: 40, expiresAt: '2027-01-01' },
  ], 60, { now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.allocations.map((a) => [a.batchNo, a.qty]), [['B1', 30], ['B2', 30]]);
  assert.equal(r.allocated, 60);
  assert.equal(r.shortage, 0);

  const short = allocateBatches([{ batchNo: 'B1', qty: 10, expiresAt: '2026-12-01' }], 25, { now: NOW });
  assert.equal(short.ok, false);
  assert.equal(short.shortage, 15);
  assert.match(short.reason!, /还缺 15/);
});

test('已过期批次排最后（仍可发，但要标 expiredPicked 供审计）', () => {
  const r = allocateBatches([
    { batchNo: 'B-EXP', qty: 100, expiresAt: '2026-10-01' },
    { batchNo: 'B-OK', qty: 100, expiresAt: '2027-05-01' },
  ], 10, { now: NOW });
  assert.equal(r.allocations[0].batchNo, 'B-OK');

  const onlyExp = allocateBatches([{ batchNo: 'B-EXP', qty: 50, expiresAt: '2026-10-01' }], 10, { now: NOW });
  assert.equal(onlyExp.ok, true);
  assert.deepEqual(onlyExp.expiredPicked, ['B-EXP']);
});

test('无有效期批次排在有有效期之后，按入库先后', () => {
  const r = allocateBatches([
    { batchNo: 'B-NULL', qty: 100, expiresAt: null, createdAt: '2025-01-01' },
    { batchNo: 'B-DATE', qty: 100, expiresAt: '2027-06-01', createdAt: '2026-09-01' },
  ], 1, { now: NOW });
  assert.equal(r.allocations[0].batchNo, 'B-DATE');
});

test('无有效期时按入库时间 FIFO', () => {
  const r = allocateBatches([
    { batchNo: 'B-NEW', qty: 100, createdAt: '2026-10-01' },
    { batchNo: 'B-OLD', qty: 100, createdAt: '2025-03-01' },
  ], 1, { now: NOW });
  assert.equal(r.allocations[0].batchNo, 'B-OLD');
});

test('手工指定批次：命中即只用该批次', () => {
  const r = allocateBatches([
    { batchNo: 'B1', qty: 100, expiresAt: '2026-12-01' },
    { batchNo: 'B2', qty: 100, expiresAt: '2026-11-30' },
  ], 20, { batchNo: 'B1', now: NOW });
  assert.equal(r.manual, true);
  assert.deepEqual(r.allocations.map((a) => a.batchNo), ['B1']);
});

test('手工指定批次：不存在/余量不足明确拒绝并给缺口', () => {
  const none = allocateBatches([{ batchNo: 'B1', qty: 100 }], 10, { batchNo: 'B9', now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.reason!, /无可用库存/);

  const short = allocateBatches([{ batchNo: 'B1', qty: 5 }], 10, { batchNo: 'B1', now: NOW });
  assert.equal(short.ok, false);
  assert.equal(short.allocated, 5);
  assert.equal(short.shortage, 5);
});

test('零/负库存批次被忽略；need<=0 直接拒绝', () => {
  const r = allocateBatches([{ batchNo: 'B0', qty: 0 }, { batchNo: 'B1', qty: 10 }], 5, { now: NOW });
  assert.deepEqual(r.allocations.map((a) => a.batchNo), ['B1']);
  assert.equal(allocateBatches([{ batchNo: 'B1', qty: 10 }], 0, { now: NOW }).ok, false);
});

test('效期当天仍可用，次日起算过期', () => {
  assert.equal(isExpired('2026-11-23', NOW.getTime()), false);
  assert.equal(isExpired('2026-11-22', NOW.getTime()), true);
  assert.equal(isExpired(null, NOW.getTime()), false);
});

test('分配数量三位小数：0.1+0.2 类浮点不产生残差', () => {
  const r = allocateBatches([{ batchNo: 'B1', qty: 0.3 }, { batchNo: 'B2', qty: 1 }], 0.3, { now: NOW });
  assert.equal(r.allocated, 0.3);
  assert.equal(r.shortage, 0);
});
