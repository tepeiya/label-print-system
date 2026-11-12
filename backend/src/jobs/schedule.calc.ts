// =============================================================================
// schedule.calc.ts —— 定时任务调度计划纯函数（docs/10 §10.20 B2.4）
//
// 【为什么单独一层】定时任务最容易写成「一堆 cron + 散落在 service 里的 if」，
// 边界条件（正好第 7 天算不算、过期单该不该回写、幂等行保留多久）没法单测，
// 上线后只能靠等一天看结果。这里把**所有判定与文案**抽成纯函数，
// MaintenanceService 只负责查库/写库/发通知，Processor 只负责分发 job.name。
//
// 【不变式】
//   1. 不 import Nest / TypeORM / bullmq，tsx 单测可直接跑；
//   2. 所有时间判定显式接收 now，绝不读系统时钟（测试可冻时间）；
//   3. 通知必须带 dedupeKey，重复跑任务不会重复骚扰租户（cron 重放/多实例并发都安全）；
//   4. 跨租户扫描是**平台级任务的例外**：结果不返回给终端用户，
//      每条写回（通知）都显式携带 tenant_id，见 MaintenanceService 注释。
// =============================================================================
import { isStale } from '../agent/approval.calc';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** D12 合同口径：订阅到期前 7 天提醒 */
export const RENEWAL_REMIND_DAYS = 7;
/** 幂等表保留期：超过即清理（避免长跑无限攒行），写操作重放窗口以 30 天为界 */
export const IDEMPOTENCY_TTL_DAYS = 30;
/** 审批过期回写单批上限，防止一次 sweep 拖住队列 */
export const APPROVAL_SWEEP_BATCH = 500;

export const MAINTENANCE_QUEUE = 'maintenance';

/**
 * repeatable job 定义。BullMQ 的 cron 按 **UTC** 解释，这里换算成北京时间标注：
 *   UTC 01:00 = 北京 09:00（续费提醒，工作时段发）
 *   UTC 19:00 = 北京 03:00（幂等清理，低峰跑）
 * 审批过期每 15 分钟一次（读时判定已兜住正确性，回写只是让列表状态一致）。
 */
export const MAINTENANCE_JOBS = [
  { name: 'subscription.renewal_reminder', pattern: '0 1 * * *', localTime: '每天 09:00', desc: '订阅到期前 7 天站内信提醒' },
  { name: 'approval.expire_sweep', pattern: '*/15 * * * *', localTime: '每 15 分钟', desc: '把过期 pending/approved 审批批量回写 expired' },
  { name: 'idempotency.ttl_cleanup', pattern: '0 19 * * *', localTime: '每天 03:00', desc: '清理超过 30 天的 tool_idempotency 行' },
] as const;

export type MaintenanceJobName = typeof MAINTENANCE_JOBS[number]['name'];

export function isKnownJob(name: string): name is MaintenanceJobName {
  return MAINTENANCE_JOBS.some((j) => j.name === name);
}

/** 时间归一化：脏值/空值返回 null，绝不抛异常打断批量任务 */
function toTime(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- 订阅到期提醒

export interface SubscriptionLike {
  tenantId: number;
  status: string;
  endsAt: Date | string | null | undefined;
}

export interface RenewalReminder {
  tenantId: number;
  endsAt: string;
  daysLeft: number;
  dedupeKey: string;
  category: 'renewal';
  title: string;
  body: string;
  metadata: Record<string, any>;
}

/** 只提醒 active / trial；ends_at 为空（永久订阅）不提醒；已过期不提醒 */
export function dueForReminder(
  sub: SubscriptionLike, now: Date, windowDays: number = RENEWAL_REMIND_DAYS,
): boolean {
  if (sub.status !== 'active' && sub.status !== 'trial') return false;
  const t = toTime(sub.endsAt);
  if (t === null) return false;
  const delta = t - now.getTime();
  // 含边界：正好第 7 天算；第 7 天 + 1ms 不算；已过期（delta < 0）不算
  return delta >= 0 && delta <= windowDays * DAY_MS;
}

/** 剩余天数向上取整（还有 1 小时也算 1 天，文案不会出现「0 天」） */
export function daysUntil(endsAt: Date | string, now: Date): number {
  const t = toTime(endsAt);
  if (t === null) return 0;
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS));
}

/** 稳定去重键：同租户 + 同到期日只发一次（cron 重放/多实例并发都不会重复打扰） */
export function notificationDedupeKey(kind: string, tenantId: number, naturalKey: string): string {
  return `${kind}:${tenantId}:${String(naturalKey).slice(0, 120)}`.slice(0, 160);
}

/** 续费提醒文案（纯函数，避免中文文案散落在 service 里） */
export function renewalText(daysLeft: number, endsAtIso: string): { title: string; body: string } {
  const when = endsAtIso.slice(0, 10);
  return {
    title: daysLeft === 0 ? '订阅今日到期' : `订阅将在 ${daysLeft} 天后到期`,
    body: `当前套餐将于 ${when} 到期。请在到期前完成续费，到期后模块订阅与 Agent 调用将受限。` +
          `如需协助请联系平台运营。`,
  };
}

/** 从一批订阅算出本次要发的提醒（去重 + 文案 + 去重键），供 service 逐条 publish */
export function renewalReminderPlan(
  subs: SubscriptionLike[], now: Date, windowDays: number = RENEWAL_REMIND_DAYS,
): RenewalReminder[] {
  const seen = new Set<string>();
  const out: RenewalReminder[] = [];
  for (const s of subs ?? []) {
    if (!dueForReminder(s, now, windowDays)) continue;
    const t = toTime(s.endsAt);
    if (t === null) continue;
    const iso = new Date(t).toISOString();
    const dedupeKey = notificationDedupeKey('renewal', s.tenantId, iso.slice(0, 10));
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const left = daysUntil(new Date(t), now);
    const { title, body } = renewalText(left, iso);
    out.push({
      tenantId: s.tenantId, endsAt: iso, daysLeft: left, dedupeKey,
      category: 'renewal', title, body,
      metadata: { ends_at: iso, days_left: left },
    });
  }
  return out;
}

// ---------------------------------------------------------------- 审批过期回写

export interface ApprovalRowLike {
  id: number;
  status: string;
  expiresAt: Date | string | null | undefined;
}

/** 批量回写候选：复用 approval.calc.isStale，保证「读时判定」与「定时任务」同一口径 */
export function expiredApprovalIds(
  rows: ApprovalRowLike[], now: Date, limit: number = APPROVAL_SWEEP_BATCH,
): number[] {
  const ids = (rows ?? [])
    .filter((r) => isStale(r as any, now))
    .map((r) => Number(r.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  return ids.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------- 幂等 TTL 清理

/** 清理截止时刻：created_at < cutoff 视为可删（正好 30 天可删，边界确定性） */
export function idempotencyCutoff(
  now: Date, ttlDays: number = IDEMPOTENCY_TTL_DAYS,
): Date {
  const days = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : IDEMPOTENCY_TTL_DAYS;
  return new Date(now.getTime() - days * DAY_MS);
}

export function isIdempotencyExpired(
  createdAt: Date | string, now: Date, ttlDays: number = IDEMPOTENCY_TTL_DAYS,
): boolean {
  const t = toTime(createdAt);
  if (t === null) return false;              // 脏数据不删，避免误清理
  return t <= idempotencyCutoff(now, ttlDays).getTime();
}
