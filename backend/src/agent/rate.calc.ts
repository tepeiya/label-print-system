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

// =============================================================================
// B3（docs/10 §10.20 B3）：限流从「只有 agent 一维」扩到 tool / token 细分，
// 并产出标准响应头。全部是纯函数，Redis 交互仍在 AgentRateService。
//
// 兼容性红线：agent 维度 key 必须保持 `lf:agent:rl:<tenant>:<client>:<桶>` 不变，
// 验收 M 段会直接查这个 Redis key；新增维度用 t:/k: 前缀区分，不会撞桶。
//
// 默认口径：tool/token 维度**默认关闭**（阈值 0），只有租户在
// feature_flags['agent.rate_limit'].rollout 里显式配了 tool_rpm / token_rpm / per_tool 才生效。
// 理由：限流是"收紧"操作，默认开启会无预警改变所有存量租户的调用行为。
// =============================================================================

export type RateDimension = 'agent' | 'tool' | 'token';

/** 一次限流判定的完整结果（成功响应头与 429 都用它） */
export interface RateOutcome {
  rpm: number;
  count: number;
  remaining: number;
  /** 命中最紧的那个维度，写进 X-RateLimit-Scope 便于客户端定位 */
  scope: RateDimension;
  /** 窗口重置的 Unix 秒（X-RateLimit-Reset，标准做法用绝对时间戳） */
  resetSec: number;
}

/** 从 feature_flags.rollout 解析出的三维阈值计划；0 = 该维度未启用 */
export interface RatePlan {
  agent: number;
  tool: number;
  token: number;
  /** 工具级精确覆盖：{ 'print.submit_job': 5 }，优先于全局 tool */
  perTool: Record<string, number>;
}

function bucketOf(now: Date): number {
  return Math.floor(now.getTime() / WINDOW_MS);
}

/** key 里的工具名做白名单化，避免任意字符串把 Redis keyspace 打散/注入空格 */
function safeToolName(name: string): string {
  return String(name ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
}

/** tool 维度：同租户 + 同 client + 同工具，独立分钟窗口 */
export function toolRateLimitKey(
  tenantId: number, clientId: number, toolName: string, now: Date = new Date(),
): string {
  return `lf:agent:rl:t:${tenantId}:${clientId}:${safeToolName(toolName)}:${bucketOf(now)}`;
}

/** token 维度：同租户 + 同 token（跨 client 共享），独立分钟窗口 */
export function tokenRateLimitKey(
  tenantId: number, tokenId: number, now: Date = new Date(),
): string {
  return `lf:agent:rl:k:${tenantId}:${tokenId}:${bucketOf(now)}`;
}

/** 把任意值夹成合法 rpm；0/负数/脏值/缺省一律返回 0（表示"维度未启用"） */
function optionalRpm(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(RPM_MAX, Math.max(RPM_MIN, n));
}

/**
 * rollout 结构（全部可选，向后兼容旧配置 {"rpm":1}）：
 *   { rpm, tool_rpm, token_rpm, per_tool: { "<toolName>": N } }
 * 也接受 camelCase（toolRpm / tokenRpm / perTool），运营后台存法不统一时不会失效。
 */
export function resolveRatePlan(rollout: Record<string, any> | null | undefined): RatePlan {
  const r = rollout && typeof rollout === 'object' && !Array.isArray(rollout)
    ? rollout as Record<string, any> : {};
  const rawPerTool = r.per_tool ?? r.perTool;
  const perTool: Record<string, number> = {};
  if (rawPerTool && typeof rawPerTool === 'object' && !Array.isArray(rawPerTool)) {
    for (const [k, v] of Object.entries(rawPerTool)) {
      const n = optionalRpm(v);
      if (n > 0) perTool[k] = n;
    }
  }
  return {
    agent: resolveRpm(r),
    tool: optionalRpm(r.tool_rpm ?? r.toolRpm),
    token: optionalRpm(r.token_rpm ?? r.tokenRpm),
    perTool,
  };
}

/** 某工具的 tool 维度有效阈值：精确覆盖优先于全局 tool_rpm；0 = 不检查该维度 */
export function toolRpmFor(plan: RatePlan, toolName: string): number {
  const exact = plan.perTool?.[String(toolName)];
  return exact && exact > 0 ? exact : plan.tool;
}

/** 窗口重置的 Unix 秒（下一分钟桶起点） */
export function resetSecOf(now: Date = new Date()): number {
  return Math.ceil(((bucketOf(now) + 1) * WINDOW_MS) / 1000);
}

/** 构造一次判定结果（纯函数，方便 service 与单测共用同一口径） */
export function makeOutcome(
  dim: RateDimension, rpm: number, count: number, now: Date = new Date(),
): RateOutcome {
  return { rpm, count, remaining: remaining(count, rpm), scope: dim, resetSec: resetSecOf(now) };
}

/** 标准 X-RateLimit-* 响应头（成功与 429 都下发，客户端可提前退避） */
export function rateHeaders(o: RateOutcome): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(o.rpm),
    'X-RateLimit-Remaining': String(o.remaining),
    'X-RateLimit-Reset': String(o.resetSec),
    'X-RateLimit-Scope': o.scope,
    'X-RateLimit-Window': String(WINDOW_MS / 1000),
  };
}

/** 429 附加头：Retry-After 取到窗口重置的剩余秒数（至少 1 秒） */
export function retryAfterHeaders(o: RateOutcome, now: Date = new Date()): Record<string, string> {
  const sec = Math.max(1, o.resetSec - Math.floor(now.getTime() / 1000));
  return { 'Retry-After': String(sec) };
}

/**
 * 多个维度都通过时，响应头应反映**最紧**的那个（剩余比例最小），
 * 否则客户端看到 agent 剩余 59 会觉得可以随便打，实际 tool 维度只剩 1 次。
 */
export function tightestOutcome(list: RateOutcome[]): RateOutcome {
  if (!list.length) return makeOutcome('agent', DEFAULT_AGENT_RPM, 0);
  return list.reduce((best, cur) => {
    const ratio = (o: RateOutcome) => (o.rpm > 0 ? o.remaining / o.rpm : 1);
    if (ratio(cur) < ratio(best)) return cur;
    if (ratio(cur) === ratio(best) && cur.remaining < best.remaining) return cur;
    return best;
  });
}
