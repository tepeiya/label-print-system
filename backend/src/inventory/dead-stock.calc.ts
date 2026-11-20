// =============================================================================
// 呆滞 / 效期判定：纯函数，零依赖，便于单测（与 kit.calc / field-defs.calc 同风格）。
// 库龄维度用「批次入库日」到今天；动销维度用「最近一次出库日」到今天，两者取较大值
// 作为呆滞天数——长期有出库的不算呆滞，久未动销的即使刚入库批次也暴露。
// 效期维度用到期日距今天数；已过期按 critical 处理。
// =============================================================================

export type AlertType = 'dead_stock' | 'expiring';
export type Severity = 'warning' | 'critical';

/** 批次判定输入（服务层从 stock_batches + 最近出库台账聚合而来） */
export interface BatchSnapshot {
  materialId: number;
  warehouseId: number;
  batchNo: string;
  qty: number;
  /** 入库日（批次 created_at 的 YYYY-MM-DD） */
  inboundDate: string;
  /** 最近出库日（YYYY-MM-DD 或 null） */
  lastOutDate: string | null;
  /** 到期日（YYYY-MM-DD 或 null） */
  expiresAt: string | null;
}

/** 规则阈值（出参已 Number 化） */
export interface RuleLike {
  type: AlertType;
  idleDays: number;
  criticalDays: number;
  expiryDays: number;
  minQty: number;
}

/** 判定结果 */
export interface Verdict {
  hit: boolean;
  severity: Severity | null;
  /** 呆滞天数（入库/最近出库取大） */
  ageDays: number;
  /** 距最近出库天数（无出库 = 距入库天数） */
  lastOutDays: number;
  /** 距到期天数（负数=已过期） */
  daysToExpire: number | null;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD → UTC 零点时间戳；非法返回 null */
function dayStamp(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? t : null;
}

/** 从「日期」到 now 的天数（向下取整，负数按 0）；date 非法返回 null */
function daysSince(date: string | null | undefined, now: Date): number | null {
  const stamp = dayStamp(date);
  if (stamp == null) return null;
  const nowStamp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((nowStamp - stamp) / DAY_MS));
}

/** 事件指纹：同一租户+规则+物料+仓库+批次只保留一条，扫描更新而非重复插入 */
export function eventFingerprint(
  tenantId: number, ruleId: number, b: Pick<BatchSnapshot, 'materialId' | 'warehouseId' | 'batchNo'>,
): string {
  return `${tenantId}|${ruleId}|${b.materialId}|${b.warehouseId}|${b.batchNo || ''}`;
}

/**
 * 判定单个批次是否命中预警。
 * - 数量 <= minQty 直接跳过（过滤尾数/零库存）。
 * - dead_stock：以「距最近动销天数」判定（有出库=距最近出库；无出库=距入库）。近期有出库即为活跃，
 *   不因批次库龄大而误报；库龄 ageDays 仅作为展示指标一并返回。>= idleDays 命中，>= criticalDays 升级 critical。
 * - expiring：daysToExpire <= expiryDays 命中；已过期（<0）或 <= warning 缓冲的一半视为 critical。
 */
export function evaluateBatch(b: BatchSnapshot, rule: RuleLike, now: Date = new Date()): Verdict {
  const ageDays = daysSince(b.inboundDate, now) ?? 0;          // 库龄（入库至今）
  const lastOutDays = b.lastOutDate ? (daysSince(b.lastOutDate, now) ?? ageDays) : ageDays;
  const idleDays = lastOutDays;                               // 距最近动销：呆滞判定依据
  const daysToExpire = (() => {
    const e = dayStamp(b.expiresAt);
    if (e == null) return null;
    const nowStamp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.floor((e - nowStamp) / DAY_MS);
  })();

  const base: Verdict = {
    hit: false, severity: null, ageDays, lastOutDays, daysToExpire, reason: '',
  };

  if (!Number.isFinite(b.qty) || b.qty <= Number(rule.minQty || 0)) {
    return { ...base, reason: '数量低于阈值，忽略' };
  }

  if (rule.type === 'expiring') {
    if (daysToExpire == null) return { ...base, reason: '无到期日，忽略' };
    if (daysToExpire > rule.expiryDays) {
      return { ...base, reason: '未到临期窗口，忽略' };
    }
    const critical = daysToExpire < 0 || daysToExpire <= Math.floor(rule.expiryDays / 2);
    return {
      hit: true, severity: critical ? 'critical' : 'warning',
      ageDays, lastOutDays, daysToExpire,
      reason: daysToExpire < 0 ? `已过期 ${-daysToExpire} 天` : `距到期 ${daysToExpire} 天`,
    };
  }

  // dead_stock
  if (idleDays < rule.idleDays) {
    return { ...base, reason: '近期有动销，未达呆滞阈值' };
  }
  const critical = idleDays >= rule.criticalDays;
  return {
    hit: true, severity: critical ? 'critical' : 'warning',
    ageDays, lastOutDays, daysToExpire: null,
    reason: critical ? `呆滞 ${idleDays} 天（严重）` : `呆滞 ${idleDays} 天`,
  };
}

/** 规则阈值规范化：范围钳制，非法回退默认；criticalDays 至少 >= idleDays */
export function normalizeRule(raw: {
  type?: unknown; idleDays?: unknown; criticalDays?: unknown; expiryDays?: unknown; minQty?: unknown;
}): RuleLike {
  const type: AlertType = raw.type === 'expiring' ? 'expiring' : 'dead_stock';
  const clamp = (v: unknown, dflt: number, lo: number, hi: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const idleDays = clamp(raw.idleDays, 90, 1, 3650);
  const minQtyRaw = Number(raw.minQty);
  return {
    type,
    idleDays,
    criticalDays: Math.max(idleDays, clamp(raw.criticalDays, 180, 1, 3650)),
    expiryDays: clamp(raw.expiryDays, 30, 1, 365),
    minQty: Number.isFinite(minQtyRaw) ? Math.max(0, minQtyRaw) : 0,
  };
}

/** severity 排序权重（用于前端/列表排序） */
export const severityRank = (s: Severity): number => (s === 'critical' ? 2 : 1);
