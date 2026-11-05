/**
 * 到期提醒的纯函数部分（P2「到期提醒任务」，docs/11 §11.11）。
 * 单独成文件：单测只 import 这里，不连带实体类（tsx 不产出 decorator metadata，
 * 实体进 TypeORM 会炸 ColumnTypeUndefinedError，见 docs/10 §10.15.6 脚注）。
 */

export const DAY_MS = 86_400_000;
/** 试用/订阅到期提前提醒窗口 */
export const EXPIRE_WARN_DAYS = 3;

export interface TenantLike {
  id: number;
  code: string;
  name: string;
  subscriptionStatus: string | null;
  trialEndsAt: string | Date | null;
}

/** trial 订阅、endsAt 落在 days 天内的租户（窗口右闭：正好第 N 天的算进来） */
export function filterExpiring(tenants: TenantLike[], days = EXPIRE_WARN_DAYS) {
  const now = Date.now();
  const horizon = now + days * DAY_MS;
  return tenants
    .filter((t) => t.subscriptionStatus === 'trial' && t.trialEndsAt)
    .filter((t) => { const at = new Date(t.trialEndsAt as any).getTime(); return at > now && at <= horizon; })
    .map((t) => ({ id: t.id, code: t.code, name: t.name, trialEndsAt: t.trialEndsAt }));
}
