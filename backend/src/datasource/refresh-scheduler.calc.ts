// =============================================================================
// refresh-scheduler.calc.ts —— P8.4 数据源自动刷新调度「判定层单一真源」
//
// 【为什么单独一层】自动刷新最容易出现三类线上事故：
//   1. 配置改一次就多注册一个 repeatable job，几天后同一数据源被并发刷新 N 次；
//   2. 关掉刷新时只 add 不 remove，任务永远在跑，还会打到已删除的数据源；
//   3. 应用重启后不重新注册，调度「看起来配了」但从来没触发过。
// 这三类都和「何时 add / 何时 remove / 重启如何对齐」的判定有关，必须能冻时间、
// 不连 Redis 单测，所以判定全部放这里，Service 只做 BullMQ IO。
//
// 【不变式】
//   1. 不 import Nest / TypeORM / bullmq，tsx 单测可直接跑；
//   2. 调度参数唯一来源是 sql-driver.calc.refreshPlan().repeat，不在 Service 里另算一遍；
//   3. job name 显式带 tenant_id + source_id，跨租户永不串号；
//   4. 「相同 key 不重注册」保证配置重复保存 / 多实例同时 bootstrap 都是幂等的。
//
// 【验收边界（诚实标注，见 docs/10 §10.29）】
//   本文件与 Service 提供的是真实可接入的调度注册链路。沙盒无 Redis / 真数据库，
//   「job 到期 → Worker 消费 → 真执行 SQL」的端到端时序未在沙盒实跑，
//   只由纯函数单测 + 手动 refresh() 冒烟覆盖，真机验收清单见 P8.5。
// =============================================================================
import type { RefreshPlan } from './sql-driver.calc';
import { refreshPlan } from './sql-driver.calc';

/** 独立队列：与 maintenance / trigger / print 分开，刷新慢查询不拖住打印队列 */
export const REFRESH_QUEUE = 'datasource_refresh';
export const REFRESH_JOB_PREFIX = 'refresh_source';

/** 单次 bootstrap 最多注册多少个数据源，防止启动期一次性打满 Redis */
export const MAX_BOOTSTRAP_SOURCES = 500;
/** 开关：MAINTENANCE 同款，便于只让 worker 进程注册调度 */
export const REFRESH_SCHEDULER_ENV = 'DATASOURCE_REFRESH_SCHEDULER_ENABLED';

/** 与 refreshPlan 的 repeat 同构；null 表示「不调度」 */
export type RepeatSpec = { everyMs: number } | { pattern: string } | null;

/**
 * job name 显式带 tenant_id + source_id。
 * 用 ':' 分隔只用于 name（BullMQ 的 jobId 不允许冒号，所以我们不设自定义 jobId，
 * repeatable 的唯一性由 name + repeat 参数自动生成的 key 保证，天然幂等）。
 */
export function refreshJobName(tenantId: number, sourceId: number): string {
  return `${REFRESH_JOB_PREFIX}:${Number(tenantId)}:${Number(sourceId)}`;
}

/** 反解 job name；格式不合法返回 null（processor 用它做 fail-closed 校验） */
export function parseRefreshJobName(name: string): { tenantId: number; sourceId: number } | null {
  const m = /^refresh_source:(\d+):(\d+)$/.exec(String(name ?? ''));
  if (!m) return null;
  const tenantId = Number(m[1]);
  const sourceId = Number(m[2]);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  if (!Number.isInteger(sourceId) || sourceId <= 0) return null;
  return { tenantId, sourceId };
}

/** 稳定 key：用于判定「调度参数是否变化」，相同 key 不重注册 */
export function repeatKey(spec: RepeatSpec): string {
  if (!spec) return '';
  if ('pattern' in spec) return `pattern:${spec.pattern}`;
  return `every:${spec.everyMs}`;
}

/** refreshPlan().repeat → BullMQ RepeatOptions（只做形状转换，不再夹取时限） */
export function toBullRepeat(spec: RepeatSpec): { every: number } | { pattern: string } | null {
  if (!spec) return null;
  if ('pattern' in spec) return { pattern: spec.pattern };
  return { every: spec.everyMs };
}

/** BullMQ getRepeatableJobs() 返回项 → RepeatSpec，供 bootstrap 对齐既有调度 */
export function repeatFromBull(j: { every?: number | string; pattern?: string } | null | undefined): RepeatSpec {
  if (!j) return null;
  if (j.pattern) return { pattern: String(j.pattern) };
  const every = Number(j.every);
  if (Number.isFinite(every) && every > 0) return { everyMs: every };
  return null;
}

/** 从归一化后的刷新配置直接取调度参数（唯一真源） */
export function repeatOfPlan(plan: RefreshPlan): RepeatSpec {
  return plan.enabled ? (plan.repeat as RepeatSpec) : null;
}

export interface RepeatVerdict {
  action: 'none' | 'add' | 'remove' | 'replace';
  remove: boolean;
  add: boolean;
  reason: string;
}

/**
 * 对齐判定：把「Redis 里已有的调度」和「配置期望的调度」比一次。
 *   prev=null, next=null → none（本来就没启）
 *   prev=null, next=有   → add（新启用 / 重启后补注册）
 *   prev=有,   next=null → remove（关闭刷新 / 数据源删除）
 *   prev=有,   next=有，key 相同 → none（幂等，绝不重复注册）
 *   prev=有,   next=有，key 不同 → replace（先 remove 再 add，
 *                BullMQ 的 repeatable key 由 name+repeat 生成，改参数会生成新 key，
 *                不删旧的就会同时存在两套周期）
 */
export function reconcileRepeat(prev: RepeatSpec, next: RepeatSpec): RepeatVerdict {
  const pk = repeatKey(prev);
  const nk = repeatKey(next);
  if (!pk && !nk) return { action: 'none', remove: false, add: false, reason: '刷新未启用，无需调度' };
  if (!pk && nk) return { action: 'add', remove: false, add: true, reason: '首次启用自动刷新' };
  if (pk && !nk) return { action: 'remove', remove: true, add: false, reason: '刷新已关闭，撤销调度' };
  if (pk === nk) return { action: 'none', remove: false, add: false, reason: '调度参数未变化，保持幂等' };
  return {
    action: 'replace', remove: true, add: true,
    reason: `调度参数变化（${pk} → ${nk}），先撤销旧 key 再注册新 key`,
  };
}

// ---------------------------------------------------------------- 启动期对齐

/** 平台级扫描出来的原始行（catalog 原生 SQL 结果，结果不返回终端用户） */
export interface RefreshSourceRow {
  tenantId: number;
  sourceId: number;
  refresh?: any;
  dataSourceKey?: string | null;
}

export interface RefreshCandidate {
  tenantId: number;
  sourceId: number;
  plan: RefreshPlan;
  dataSourceKey: string | null;
}

/**
 * 从跨租户扫描结果中筛出「需要注册」的候选。
 * 判定全部走 refreshPlan()：脏配置（非法 cron / 超界 interval）在此被统一夹取，
 * 与 saveSql / setRefreshConfig 用的是同一个真源，不会出现「配的和跑的不一致」。
 * 显式跳过 tenantId/sourceId 非法的行，防止脏数据注册出串号任务。
 */
export function bootstrapCandidates(rows: RefreshSourceRow[], limit = MAX_BOOTSTRAP_SOURCES): RefreshCandidate[] {
  const out: RefreshCandidate[] = [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_BOOTSTRAP_SOURCES;
  for (const r of rows ?? []) {
    if (out.length >= cap) break;
    const tenantId = Number(r?.tenantId);
    const sourceId = Number(r?.sourceId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) continue;
    if (!Number.isInteger(sourceId) || sourceId <= 0) continue;
    const plan = refreshPlan(r.refresh);
    if (!plan.enabled || !plan.repeat) continue;
    out.push({
      tenantId, sourceId, plan,
      dataSourceKey: r.dataSourceKey ? String(r.dataSourceKey) : null,
    });
  }
  return out;
}

/** Worker 侧 job.data 的构造与校验（显式 tenant_id，禁止前端/事件隐式推断） */
export function refreshJobData(tenantId: number, sourceId: number, dataSourceKey: string | null) {
  return { tenantId: Number(tenantId), sourceId: Number(sourceId), dataSourceKey };
}

export function validRefreshJobData(data: any): boolean {
  const tenantId = Number(data?.tenantId);
  const sourceId = Number(data?.sourceId);
  return Number.isInteger(tenantId) && tenantId > 0 && Number.isInteger(sourceId) && sourceId > 0;
}
