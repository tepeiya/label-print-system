/**
 * 租户数据导出 / 删除（D12 保留期）的纯函数部分。
 * 单独成文件：单测只 import 这里，不连带实体（tsx 不产出 decorator metadata，见 docs/10 §10.15.6 脚注）。
 *
 * 规则来源 docs/11：
 *   · D12：canceled 后 90 天平台可硬删；删除前 7 天开始提醒（看板里给 daysLeft）。
 *   · §11.2 / D3：删除/导出这类跨表批操作要跑在带 app.tenant_id 的 RLS 连接上，
 *     即使表清单过期或漏写 where，也只能伤到自己那一份。
 */

export const DAY_MS = 86_400_000;
/** D12 保留期 */
export const RETENTION_DAYS = 90;
/** 进入「删除前 7 天提醒」窗口（写进合同模板的那条） */
export const PURGE_WARN_DAYS = 7;
/** 单表导出上限：超过就标记 truncated，避免一次导出把内存打爆 */
export const EXPORT_ROW_CAP = 50_000;

export interface RetentionView {
  /** 可硬删的最早时间 = canceled_at + RETENTION_DAYS */
  hardDeleteAt: Date | null;
  /** 还剩几天可删（负数=已过期，null=未退订） */
  daysLeft: number | null;
  /** 到保留期了（可以硬删） */
  due: boolean;
  /** 进入 7 天提醒窗口 */
  warn: boolean;
}

/** 没退订（canceledAt 为空/脏值）→ 一律视为「不可删」，不抛错，交给 assertPurgeAllowed 拒 */
export function retentionOf(canceledAt: string | Date | null | undefined, now = new Date()): RetentionView {
  const at = canceledAt ? new Date(canceledAt as any) : null;
  if (!at || Number.isNaN(at.getTime())) return { hardDeleteAt: null, daysLeft: null, due: false, warn: false };
  const hardDeleteAt = new Date(at.getTime() + RETENTION_DAYS * DAY_MS);
  const daysLeft = Math.floor((hardDeleteAt.getTime() - now.getTime()) / DAY_MS);
  return {
    hardDeleteAt,
    daysLeft,
    due: daysLeft <= 0,
    warn: daysLeft > 0 && daysLeft <= PURGE_WARN_DAYS,
  };
}

export interface PurgeGateInput {
  code: string;
  canceledAt: string | Date | null | undefined;
  /** 运营显式勾选「不等保留期，立即删」 */
  force?: boolean;
  /** 二次确认串：必须逐字等于租户 code，防手滑传错 id */
  confirm?: string;
  now?: Date;
}

export type PurgeGate = { ok: true } | { ok: false; reason: string };

/**
 * 硬删闸门。顺序：先确认串（对谁都一样严），再看保留期。
 * 未退订的租户只能靠 force + confirm 双条件，且 reason 会写清后果 —— 平台侧不留「静默删光」的路。
 */
export function assertPurgeAllowed(input: PurgeGateInput): PurgeGate {
  const { code, canceledAt, force } = input;
  const now = input.now ?? new Date();
  if (!code) return { ok: false, reason: '租户不存在或 code 为空，拒绝删除' };
  if (String(input.confirm ?? '').trim() !== code) {
    return { ok: false, reason: `确认串不匹配：请把租户 code「${code}」原样填进 confirm` };
  }
  const r = retentionOf(canceledAt, now);
  if (!r.hardDeleteAt) {
    if (!force) return { ok: false, reason: '该租户尚未退订（canceled_at 为空）。要先走退订，或明确带 force=true 立即删除' };
    return { ok: true };
  }
  if (!r.due && !force) {
    return { ok: false, reason: `还在 ${r.daysLeft} 天保留期内（D12=${RETENTION_DAYS} 天），到期时间 ${r.hardDeleteAt.toISOString()}。确需提前删请带 force=true` };
  }
  return { ok: true };
}

/**
 * 删除顺序：**子表先删，父表后删**（外键 child→parent 的语义是「child 必须先于 parent 删除」）。
 * 输入 tables=本次要清的表，edges=外键 {child, parent}（只在 tables 范围内考虑）。
 * 环（互相引用）无法靠顺序解决 → 剩下的按原顺序追加，并在返回的 cyclic 里列出，
 * 让调用方知道「这里可能要靠 deferred constraint 或人工处理」，不假装成功。
 */
export function deleteOrder(tables: string[], edges: { child: string; parent: string }[]): { ordered: string[]; cyclic: string[] } {
  const set = new Set(tables);
  // indeg[X] = 还有多少张「必须先于 X 删除」的子表没被摘掉 → 0 才能删 X
  const indeg = new Map<string, number>();
  tables.forEach((t) => indeg.set(t, 0));
  const parentsOf = new Map<string, string[]>();   // child → 它引用的父表清单
  for (const e of edges) {
    if (!set.has(e.child) || !set.has(e.parent) || e.child === e.parent) continue;
    indeg.set(e.parent, (indeg.get(e.parent) ?? 0) + 1);
    const list = parentsOf.get(e.child) ?? [];
    list.push(e.parent);
    parentsOf.set(e.child, list);
  }
  const ordered: string[] = [];
  const left = new Set(tables);
  const initial = [...tables];
  while (left.size) {
    let picked = false;
    for (const t of initial) {
      if (!left.has(t)) continue;
      if ((indeg.get(t) ?? 0) === 0) {
        ordered.push(t); left.delete(t); picked = true;
        // 摘掉 t 之后，t 引用的父表少了一个前置约束
        for (const p of parentsOf.get(t) ?? []) if (left.has(p)) indeg.set(p, (indeg.get(p) ?? 1) - 1);
        break;                       // 一次只摘一个，保证确定性
      }
    }
    if (!picked) break;              // 成环
  }
  const cyclic = initial.filter((t) => left.has(t));
  return { ordered: [...ordered, ...cyclic], cyclic };
}

/**
 * 表清单裁剪：去掉不该进导出/删除的表。
 * 排除原因写在调用方，这里只做集合运算，方便单测。
 */
export function filterTables(tables: string[], exclude: string[]): string[] {
  const ex = new Set(exclude);
  return tables.filter((t) => !ex.has(t));
}

/** 导出包名（也是下载文件名）：<code>-<kind>-<日期>.json.gz */
export function backupName(code: string, kind: 'export' | 'purge-pre', now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `${code}-${kind}-${d}`;
}
