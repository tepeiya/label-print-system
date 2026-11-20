// 呆滞/效期判定：纯函数单测（零依赖）——库龄/动销双维度、分级、指纹、规则规范化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBatch, eventFingerprint, normalizeRule, severityRank,
  type BatchSnapshot, type RuleLike,
} from '../dead-stock.calc';

const NOW = new Date('2026-11-20T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

const deadRule: RuleLike = {
  type: 'dead_stock', idleDays: 90, criticalDays: 180, expiryDays: 30, minQty: 0,
};
const expRule: RuleLike = { ...deadRule, type: 'expiring' };

const batch = (over: Partial<BatchSnapshot> = {}): BatchSnapshot => ({
  materialId: 1, warehouseId: 1, batchNo: 'B001', qty: 10,
  inboundDate: daysAgo(30), lastOutDate: null, expiresAt: null, ...over,
});

test('库龄维度：未达阈值不命中，达到阈值 warning，达严重阈值 critical', () => {
  const fresh = evaluateBatch(batch({ inboundDate: daysAgo(30) }), deadRule, NOW);
  assert.equal(fresh.hit, false, '入库 30 天不呆滞');

  const warn = evaluateBatch(batch({ inboundDate: daysAgo(100) }), deadRule, NOW);
  assert.equal(warn.hit, true);
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.ageDays, 100);

  const crit = evaluateBatch(batch({ inboundDate: daysAgo(200) }), deadRule, NOW);
  assert.equal(crit.severity, 'critical');

  const edge = evaluateBatch(batch({ inboundDate: daysAgo(90) }), deadRule, NOW);
  assert.equal(edge.hit, true, '恰好 90 天命中（含边界）');
});

test('动销维度：取入库与最近出库天数较大者，近期出库则不呆滞', () => {
  // 入库 200 天但 5 天前刚出过库 → 按最近出库算，不呆滞
  const active = evaluateBatch(batch({ inboundDate: daysAgo(200), lastOutDate: daysAgo(5) }), deadRule, NOW);
  assert.equal(active.hit, false, '近期有出库不算呆滞');
  assert.equal(active.lastOutDays, 5);
  assert.equal(active.ageDays, 200, 'ageDays 仍暴露真实库龄');

  // 入库 30 天、最近出库 120 天前 → 按较近的出库日算不呆滞（无出库才有库龄 30 天）
  const staleOut = evaluateBatch(batch({ inboundDate: daysAgo(30), lastOutDate: daysAgo(20) }), deadRule, NOW);
  assert.equal(staleOut.hit, false);
});

test('数量阈值：qty <= minQty 直接忽略，过滤零库存与尾数', () => {
  const zero = evaluateBatch(batch({ qty: 0, inboundDate: daysAgo(300) }), deadRule, NOW);
  assert.equal(zero.hit, false);
  const tiny = evaluateBatch(batch({ qty: 2, inboundDate: daysAgo(300) }), { ...deadRule, minQty: 5 }, NOW);
  assert.equal(tiny.hit, false);
  const ok = evaluateBatch(batch({ qty: 6, inboundDate: daysAgo(300) }), { ...deadRule, minQty: 5 }, NOW);
  assert.equal(ok.hit, true);
});

test('效期维度：临期 warning、临界内 warning、已过期 critical、无到期日忽略', () => {
  const noExp = evaluateBatch(batch(), expRule, NOW);
  assert.equal(noExp.hit, false, '无到期日忽略');

  const far = evaluateBatch(batch({ expiresAt: daysAhead(60) }), expRule, NOW);
  assert.equal(far.hit, false, '60 天后到期未进 30 天窗口');

  const warn = evaluateBatch(batch({ expiresAt: daysAhead(20) }), expRule, NOW);
  assert.equal(warn.hit, true);
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.daysToExpire, 20);

  const crit = evaluateBatch(batch({ expiresAt: daysAhead(5) }), expRule, NOW);
  assert.equal(crit.severity, 'critical', '临界值一半以内升级 critical');

  const expired = evaluateBatch(batch({ expiresAt: daysAgo(3) }), expRule, NOW);
  assert.equal(expired.severity, 'critical');
  assert.equal(expired.daysToExpire, -3);
});

test('事件指纹：租户+规则+物料+仓库+批次唯一，批次空串稳定', () => {
  const b = batch({ batchNo: 'B001' });
  const fp = eventFingerprint(1, 2, b);
  assert.equal(fp, '1|2|1|1|B001');
  assert.equal(eventFingerprint(1, 2, batch({ batchNo: '' })), '1|2|1|1|');
  assert.notEqual(fp, eventFingerprint(1, 3, b), '不同规则指纹不同');
  assert.notEqual(fp, eventFingerprint(2, 2, b), '不同租户指纹不同');
});

test('规则规范化：范围钳制、非法回退默认、criticalDays 不低于 idleDays', () => {
  assert.deepEqual(normalizeRule({}), {
    type: 'dead_stock', idleDays: 90, criticalDays: 180, expiryDays: 30, minQty: 0,
  });
  const r = normalizeRule({ type: 'expiring', idleDays: 400, criticalDays: 100, expiryDays: 999, minQty: -5 });
  assert.equal(r.type, 'expiring');
  assert.equal(r.idleDays, 400);
  assert.equal(r.criticalDays, 400, 'critical 被抬到与 idle 相等');
  assert.equal(r.expiryDays, 365, 'expiry 上限 365');
  assert.equal(r.minQty, 0, '负数量回退 0');
  assert.equal(normalizeRule({ idleDays: 'abc', minQty: 'x' }).idleDays, 90);
});

test('severity 排序权重：critical > warning', () => {
  assert.equal(severityRank('critical'), 2);
  assert.equal(severityRank('warning'), 1);
  assert.ok(severityRank('critical') > severityRank('warning'));
});
