// =============================================================================
// rate.calc —— Agent 限流纯函数（docs/11 §11.7.7 护栏 5：Agent 维度 60 次/分）
// 只做「算 key / 算阈值 / 判定」，Redis 交互在 AgentRateService（单测不依赖 Redis）。
//
// 阈值来源优先级：feature_flags['agent.rate_limit'].rollout.rpm > 默认 60。
// 用 feature_flags 而不是新表/环境变量的原因：运营在平台后台 PUT /platform/tenants/:id/flags
// 即时生效，不需要改代码或重启（验收 M 段正是这样把 rpm 压到 1 触发 429 的）。
// =============================================================================

/** §11.7.7 默认口径：Agent 维度 60 次/分 */
export const DEFAULT_AGENT_RPM = 60;

/** 阈值下限 1、上限 600（防止误配成 0 把 Agent 全锁死，或配成天文数字失去保护） */
export const RPM_MIN = 1;
export const RPM_MAX = 600;

/** 单次调用批量上限（§11.7.7 护栏 5「单次批量 ≤ 500」） */
export const BATCH_MAX = 500;

/** 固定窗口长度：1 分钟 */
export const WINDOW_MS = 60 * 1000;

/** 窗口 key：留 60s + 5s 余量，避免边界窗口不过期堆积 */
export function rateLimitKey(tenantId: number, clientId: number, now: Date = new Date()): string {
  const bucket = Math.floor(now.getTime() / WINDOW_MS);
  return `lf:agent:rl:${tenantId}:${clientId}:${bucket}`;
}

export function rateLimitTtlMs(now: Date = new Date()): number {
  return WINDOW_MS - (now.getTime() % WINDOW_MS) + 5_000;
}

/** 从 feature_flags.rollout 里取 rpm；脏数据回退默认值 */
export function resolveRpm(rollout: Record<string, any> | null | undefined): number {
  const raw = rollout && typeof rollout === 'object' ? (rollout as any).rpm : undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AGENT_RPM;
  return Math.min(RPM_MAX, Math.max(RPM_MIN, n));
}

/** 判定：本窗口第 count 次调用（INCR 之后）是否放行 */
export function isLimited(count: number, rpm: number): boolean {
  return Number(count) > Number(rpm);
}

/** 剩余配额（用于 Retry-After / X-RateLimit 响应头与 warnings） */
export function remaining(count: number, rpm: number): number {
  return Math.max(0, rpm - count);
}

/**
 * 批量规模校验（§11.7.7 护栏 5）：返回超限说明，null 表示通过。
 * copies 与 rows 任一为 0/缺失按 1 计（与 PrintService 一致的口径）。
 */
export function batchOverLimit(copies: unknown, rows: unknown, max = BATCH_MAX): string | null {
  const c = Math.max(1, Math.floor(Number(copies ?? 1)) || 1);
  const r = Array.isArray(rows) && rows.length ? Math.floor(rows.length) : 1;
  if (c > max) return `单次份数 ${c} 超过上限 ${max}`;
  if (r > max) return `单次行数 ${r} 超过上限 ${max}`;
  return null;
}
