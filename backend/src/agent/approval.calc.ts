// =============================================================================
// approval.calc —— 审批流纯函数（docs/11 §11.7.6 / §11.7.7 护栏 3）
// 无 Nest / TypeORM 依赖，可被 tsx 单测直接引用（⚠️ 单测不能 import 实体类）。
//
// 状态机（agent_approvals.status）：
//   pending --员工确认--> approved --Agent 重试命中--> consumed
//     |                       |
//     +--员工驳回--> rejected  +--5 分钟未用 / 已被用过--> expired / consumed
//   pending / approved 超过 expires_at 视为 expired（读时判定，不依赖定时任务）
// =============================================================================
import { argsHash } from './agent.calc';

/** pending 状态存活时长：给员工留出响应时间（§11.7.6 只规定 approved 5 分钟一次性） */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** approved 后的可用窗口：5 分钟、一次性 */
export const USE_WINDOW_MS = 5 * 60 * 1000;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export interface ApprovalLike {
  status: string;
  expiresAt: Date | string | null | undefined;
  argsHash: string;
}

export type ApprovalReason =
  | 'ok'
  | 'not_found'
  | 'pending'
  | 'expired'
  | 'consumed'
  | 'rejected'
  | 'hash_mismatch';

/** 中文提示（直接进 need_approval / 拒绝响应，模型可读） */
export const APPROVAL_MESSAGES: Record<ApprovalReason, string> = {
  ok: '审批有效',
  not_found: '审批单不存在，或不属于当前租户与工具',
  pending: '审批还未被员工确认，请在租户后台「Agent 待确认」列表点确认后重试',
  expired: '审批已过期（批准后 5 分钟内有效），请重新发起该操作',
  consumed: '审批已被使用（一次性），请重新发起该操作',
  rejected: '审批被驳回，操作未执行',
  hash_mismatch: '审批绑定的参数与本次请求不一致（args_hash 校验失败），禁止执行',
};

/**
 * approval_id 不参与参数指纹：Agent 重试时必须把 approval_id 带回，
 * 若把它算进 hash 就永远对不上创建审批时那份参数。dry_run 参与（语义确实不同）。
 */
export function stripApprovalId(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === 'approval_id') continue;
    out[k] = v;
  }
  return out;
}

export function approvalArgsHash(args: Record<string, any>): string {
  return argsHash(stripApprovalId(args));
}

function toTime(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 待确认 → 到期时刻（pending 用） */
export function pendingExpiryAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + PENDING_TTL_MS);
}

/** 批准 → 5 分钟可用窗口 */
export function approvedExpiryAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + USE_WINDOW_MS);
}

/**
 * 审批判定（§11.7.6「有有效 approval_id → 校验 args_hash 一致 → 执行 → 置 consumed」）。
 * 只做纯判定，不改库；调用方负责 expired 回写与 consumed 置位。
 */
export function approvalVerdict(
  row: ApprovalLike | null | undefined, incomingArgsHash: string, now: Date = new Date(),
): ApprovalReason {
  if (!row) return 'not_found';
  const exp = toTime(row.expiresAt);
  const timedOut = exp !== null && exp <= now.getTime();
  switch (row.status) {
    case 'pending': return 'pending';
    case 'rejected': return 'rejected';
    case 'consumed': return 'consumed';
    case 'expired': return 'expired';
    case 'approved':
      if (timedOut) return 'expired';
      return row.argsHash === incomingArgsHash ? 'ok' : 'hash_mismatch';
    default: return 'not_found';   // 脏状态一律不放行
  }
}

/** 执行成功后置位 consumed（§11.7.6 一次性） */
export function shouldConsume(reason: ApprovalReason): boolean {
  return reason === 'ok';
}

/** 审批过期判定（列表/扫描用：approved 超窗或 pending 超时都视为 expired） */
export function isStale(row: ApprovalLike, now: Date = new Date()): boolean {
  if (row.status !== 'pending' && row.status !== 'approved') return false;
  const exp = toTime(row.expiresAt);
  return exp !== null && exp <= now.getTime();
}

/** 预览里的长文本（模板 JSON、批量行）折叠掉，避免审批列表塞满 UI */
export function compactPreview(args: Record<string, any>, maxString = 120): Record<string, any> {
  const fold = (v: any): any => {
    if (typeof v === 'string') {
      return v.length > maxString ? `${v.slice(0, maxString)}…（共 ${v.length} 字符）` : v;
    }
    if (Array.isArray(v)) {
      return { __array: v.length, sample: v.slice(0, 2).map(fold) };
    }
    if (v && typeof v === 'object') {
      const s = JSON.stringify(v);
      if (s.length > maxString * 2) return { __json: `${s.length} 字符`, keys: Object.keys(v).slice(0, 8) };
      const out: Record<string, any> = {};
      for (const [k, x] of Object.entries(v)) out[k] = fold(x);
      return out;
    }
    return v;
  };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(stripApprovalId(args ?? {}))) out[k] = fold(v);
  return out;
}

/** 高危工具是否允许 dry_run 预演（§11.7.4「高危可预演」；预演不产生副作用，免审批） */
export function isDryRun(args: Record<string, any>): boolean {
  return args?.dry_run === true;
}
