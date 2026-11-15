// =============================================================================
// dedicated.ops.calc.ts —— P6.2 阶段 B：运维面与退库回收巡检（纯函数，B1.4 / B1.3）
//
// 现状（阶段 A）：独立库只有全局 `DB_DEDICATED_POOL=4`，没有 SSL、没有健康检查、
// 租户硬删之后库还在但没人知道。这里把「怎么配 / 怎么判健康 / 哪些库可回收」
// 全部抽成可单测的纯函数，真正的连接池在 TenantDataSourceManager 里消费。
// =============================================================================

export const POOL_MIN = 1;
export const POOL_MAX = 50;
export const POOL_DEFAULT = 4;

export interface PoolOptions {
  max: number;
  idleTimeoutMillis: number;
  connectTimeoutMS: number;
  /** 传给 pg 的 ssl 配置；undefined = 不启用 SSL */
  ssl?: { rejectUnauthorized: boolean };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** key → 环境变量名（a-z0-9- → A-Z0-9_），用于 per-key 池上限 */
export function poolEnvName(key: string): string {
  return `DB_DEDICATED_POOL_${String(key ?? '').toUpperCase().replace(/-/g, '_')}`;
}

/** 从 `DB_DEDICATED_POOLS={"acme":8}` 里读单 key 覆盖；坏 JSON 不影响其它 key */
function perKeyPool(key: string, env: NodeJS.ProcessEnv): number | null {
  const raw = env.DB_DEDICATED_POOLS;
  if (!raw) return null;
  try {
    const m = JSON.parse(String(raw));
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const n = Math.floor(Number(m[key]));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 每租户连接池参数。优先级：
 *   per-key 环境变量 > DB_DEDICATED_POOLS[key] > DB_DEDICATED_POOL 全局 > 4
 * SSL 由 DB_DEDICATED_SSL=1 打开，DB_DEDICATED_SSL_REJECT=0 才允许自签证书（默认严格校验）。
 */
export function dedicatedPoolOptions(key: string, env: NodeJS.ProcessEnv = process.env): PoolOptions {
  const global = clampInt(env.DB_DEDICATED_POOL, POOL_MIN, POOL_MAX, POOL_DEFAULT);
  const override = clampInt(env[poolEnvName(key)], POOL_MIN, POOL_MAX, 0)
    || clampInt(perKeyPool(key, env), POOL_MIN, POOL_MAX, 0);
  const max = override || global;
  const sslOn = ['1', 'true', 'yes'].includes(String(env.DB_DEDICATED_SSL ?? '').toLowerCase());
  return {
    max,
    idleTimeoutMillis: clampInt(env.DB_DEDICATED_IDLE_MS, 1000, 600_000, 30_000),
    connectTimeoutMS: clampInt(env.DB_DEDICATED_CONNECT_MS, 500, 30_000, 5000),
    ...(sslOn ? { ssl: { rejectUnauthorized: String(env.DB_DEDICATED_SSL_REJECT ?? '1') !== '0' } } : {}),
  };
}

export type HealthLevel = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthVerdict {
  level: HealthLevel;
  ok: boolean;
  message: string;
}

/** 健康检查：连不通/缺表直接 unhealthy；延迟或表数偏少降级 degraded，不假装健康 */
export function healthVerdict(input: {
  reachable: boolean;
  latencyMs?: number;
  tableCount?: number;
  missing?: string[];
  slowMs?: number;
  minTables?: number;
}): HealthVerdict {
  if (!input.reachable) return { level: 'unhealthy', ok: false, message: '连接失败或探活超时' };
  const missing = input.missing ?? [];
  if (missing.length) {
    return { level: 'unhealthy', ok: false, message: `目标库缺表：${missing.join('、')}` };
  }
  const slow = input.slowMs ?? 1000;
  const minTables = input.minTables ?? 6;
  const latency = Number(input.latencyMs ?? 0);
  const tables = Number(input.tableCount ?? 0);
  if (latency > slow) return { level: 'degraded', ok: true, message: `探活 ${latency}ms 超过 ${slow}ms` };
  if (tables < minTables) return { level: 'degraded', ok: true, message: `public 下只有 ${tables} 张表，疑似未初始化完整` };
  return { level: 'healthy', ok: true, message: `健康（${latency}ms / ${tables} 张表）` };
}

// ---------------------------------------------------------------- 退库回收巡检

export interface TenantRef { code: string; dataSourceKey: string | null }
export interface RegisteredKey { key: string; source: 'env' | 'api' }

export interface ReclaimScan {
  /** 已注册但**没有任何活跃租户**再引用 → 可回收（库还在、租户已删/迁走） */
  orphanKeys: { key: string; source: string; hint: string }[];
  /** 租户表里写着 key、进程里却没有连接池 → 这些租户会 503 */
  unregisteredRefs: { key: string; tenantCodes: string[] }[];
  /** 仍被租户占用，禁止回收 */
  inUseKeys: { key: string; tenantCodes: string[] }[];
}

/** 巡检（纯函数）：activeTenants 只传**未硬删**的租户；已硬删的不算占用 */
export function reclaimScan(
  registered: RegisteredKey[], activeTenants: TenantRef[],
): ReclaimScan {
  const byKey = new Map<string, string[]>();
  for (const t of activeTenants ?? []) {
    const k = String(t.dataSourceKey ?? '').trim();
    if (!k || k === 'default') continue;
    const list = byKey.get(k) ?? [];
    list.push(String(t.code));
    byKey.set(k, list);
  }
  const regKeys = new Set((registered ?? []).map((r) => r.key));
  const orphanKeys = (registered ?? [])
    .filter((r) => !byKey.has(r.key))
    .map((r) => ({
      key: r.key, source: r.source,
      hint: '无活跃租户引用：可注销连接池；物理库是否 DROP 需运维确认（编排器不会自动删库）',
    }));
  const inUseKeys = [...byKey.entries()].map(([key, tenantCodes]) => ({ key, tenantCodes }));
  const unregisteredRefs = inUseKeys
    .filter((r) => !regKeys.has(r.key))
    .map((r) => ({ key: r.key, tenantCodes: r.tenantCodes }));
  return { orphanKeys, unregisteredRefs, inUseKeys };
}

/** 硬删后是否可回收该 key：只有「再无其它活跃租户引用」才返回 true */
export function canReclaimAfterPurge(key: string, activeTenants: TenantRef[]): boolean {
  const k = String(key ?? '').trim();
  if (!k || k === 'default') return false;
  return !(activeTenants ?? []).some((t) => String(t.dataSourceKey ?? '') === k);
}
