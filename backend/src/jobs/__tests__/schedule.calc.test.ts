// WP3 / B2.4 单测：定时任务调度计划（纯函数，冻时间，不连库不连 Redis）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS, RENEWAL_REMIND_DAYS, IDEMPOTENCY_TTL_DAYS, APPROVAL_SWEEP_BATCH,
  MAINTENANCE_JOBS, MAINTENANCE_QUEUE, isKnownJob,
  dueForReminder, daysUntil, notificationDedupeKey, renewalText, renewalReminderPlan,
  expiredApprovalIds, idempotencyCutoff, isIdempotencyExpired,
} from '../schedule.calc';

const NOW = new Date('2026-11-05T01:00:00.000Z');
const at = (d: number) => new Date(NOW.getTime() + d * DAY_MS).toISOString();

test('常量与 job 目录：三个 repeatable 任务齐全，名字可判定', () => {
  assert.equal(MAINTENANCE_QUEUE, 'maintenance');
  assert.equal(MAINTENANCE_JOBS.length, 3);
  assert.equal(RENEWAL_REMIND_DAYS, 7);
  assert.equal(IDEMPOTENCY_TTL_DAYS, 30);
  assert.equal(APPROVAL_SWEEP_BATCH, 500);
  assert.equal(isKnownJob('subscription.renewal_reminder'), true);
  assert.equal(isKnownJob('approval.expire_sweep'), true);
  assert.equal(isKnownJob('idempotency.ttl_cleanup'), true);
  assert.equal(isKnownJob('unknown.job'), false);
  assert.ok(MAINTENANCE_JOBS.every((j) => /^[\d*/,\-\s]+$/.test(j.pattern)), 'cron 表达式形态合法');
  assert.equal(new Set(MAINTENANCE_JOBS.map((j) => j.name)).size, 3);
});

test('dueForReminder: 正好第 7 天算，第 7 天+1ms 不算，已过期与无到期日不算', () => {
  const mk = (status: string, endsAt: any) => ({ tenantId: 1, status, endsAt });
  assert.equal(dueForReminder(mk('active', at(7)), NOW), true);
  assert.equal(dueForReminder(mk('active', new Date(NOW.getTime() + 7 * DAY_MS + 1).toISOString()), NOW), false);
  assert.equal(dueForReminder(mk('active', at(8)), NOW), false);
  assert.equal(dueForReminder(mk('active', at(0)), NOW), true, '当天到期也要提醒');
  assert.equal(dueForReminder(mk('active', at(-1)), NOW), false, '已过期交给订阅状态机，不重复提醒');
  assert.equal(dueForReminder(mk('trial', at(3)), NOW), true);
  assert.equal(dueForReminder(mk('canceled', at(3)), NOW), false);
  assert.equal(dueForReminder(mk('expired', at(3)), NOW), false);
  assert.equal(dueForReminder(mk('active', null), NOW), false);
  assert.equal(dueForReminder(mk('active', 'not-a-date'), NOW), false);
});

test('dueForReminder: 自定义窗口（低套餐收紧到 3 天）', () => {
  assert.equal(dueForReminder({ tenantId: 1, status: 'active', endsAt: at(3) }, NOW, 3), true);
  assert.equal(dueForReminder({ tenantId: 1, status: 'active', endsAt: at(5) }, NOW, 3), false);
});

test('daysUntil: 向上取整且不为负', () => {
  assert.equal(daysUntil(at(7), NOW), 7);
  assert.equal(daysUntil(new Date(NOW.getTime() + 3600_000).toISOString(), NOW), 1);
  assert.equal(daysUntil(at(0), NOW), 0);
  assert.equal(daysUntil('bad', NOW), 0);
});

test('renewalReminderPlan: 只收合规订阅、去重、文案与去重键稳定', () => {
  const plan = renewalReminderPlan([
    { tenantId: 11, status: 'active', endsAt: at(2) },
    { tenantId: 11, status: 'trial', endsAt: at(2) },        // 同租户同到期日 → 去重
    { tenantId: 12, status: 'active', endsAt: at(7) },
    { tenantId: 13, status: 'active', endsAt: at(9) },        // 超过窗口
    { tenantId: 14, status: 'canceled', endsAt: at(1) },      // 已取消
    { tenantId: 15, status: 'active', endsAt: null },         // 永久订阅
  ], NOW);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.tenantId), [11, 12]);
  assert.equal(plan[0].daysLeft, 2);
  assert.equal(plan[0].category, 'renewal');
  assert.match(plan[0].title, /2 天后到期/);
  assert.match(plan[0].body, /2026-11-07/);
  assert.equal(plan[0].dedupeKey, 'renewal:11:2026-11-07');
  assert.equal(plan[0].dedupeKey, renewalReminderPlan([{ tenantId: 11, status: 'active', endsAt: at(2) }], NOW)[0].dedupeKey);
  assert.equal(plan[0].metadata.days_left, 2);
});

test('renewalText: 当天到期文案不出现「0 天后」', () => {
  assert.equal(renewalText(0, at(0)).title, '订阅今日到期');
  assert.match(renewalText(3, at(3)).title, /3 天后到期/);
  assert.ok(renewalText(3, at(3)).body.includes('续费'));
});

test('notificationDedupeKey: 超长自然键被截断，总长 ≤160', () => {
  const k = notificationDedupeKey('renewal', 9, 'x'.repeat(500));
  assert.ok(k.startsWith('renewal:9:'));
  assert.ok(k.length <= 160);
});

test('expiredApprovalIds: 与 approval.calc.isStale 同口径，终态不回写，单批有上限', () => {
  const rows = [
    { id: 1, status: 'pending', expiresAt: at(-1) },     // 超时 → 回写
    { id: 2, status: 'approved', expiresAt: at(-0.01) }, // 超 5 分钟窗 → 回写
    { id: 3, status: 'approved', expiresAt: at(1) },     // 未到期 → 不回写
    { id: 4, status: 'consumed', expiresAt: at(-1) },    // 终态 → 不回写
    { id: 5, status: 'rejected', expiresAt: at(-1) },
    { id: 6, status: 'expired', expiresAt: at(-1) },
    { id: 7, status: 'pending', expiresAt: null },
    { id: 0, status: 'pending', expiresAt: at(-1) },     // 脏 id → 过滤
  ];
  assert.deepEqual(expiredApprovalIds(rows, NOW), [1, 2]);
  assert.deepEqual(expiredApprovalIds(rows, NOW, 1), [1]);
  assert.deepEqual(expiredApprovalIds([], NOW), []);
});

test('idempotencyCutoff / isIdempotencyExpired: 正好 30 天可删，脏数据保留', () => {
  const cutoff = idempotencyCutoff(NOW);
  assert.equal(cutoff.toISOString(), new Date(NOW.getTime() - 30 * DAY_MS).toISOString());
  assert.equal(isIdempotencyExpired(new Date(cutoff.getTime()).toISOString(), NOW), true, '边界含等号');
  assert.equal(isIdempotencyExpired(at(-31), NOW), true);
  assert.equal(isIdempotencyExpired(at(-29), NOW), false);
  assert.equal(isIdempotencyExpired('bad-date', NOW), false);
  assert.equal(isIdempotencyExpired(at(-100), NOW, 200), false, '自定义保留期生效');
});
