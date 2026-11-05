// =============================================================================
// billing.calc.ts —— P3 计费纯函数（单测直接 import，不碰 TypeORM 实体：
// tsx 不产出装饰器元数据，实体一进 import 链就 ColumnTypeUndefinedError，同 expire.util.ts 的模式）
// =============================================================================

/** JS Date → 'YYYY-MM-DD'（UTC，与 PG date 列对齐用 ISO 切片） */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 当前计费窗口起点（month → 本月 1 号，day → 今天）。返回 'YYYY-MM-DD'，用于 usage_daily 的 day >= ? */
export function windowStart(period: 'month' | 'day', now: Date = new Date()): string {
  if (period === 'day') return dayKey(now);
  return `${dayKey(now).slice(0, 7)}-01`;
}

export interface QuotaRow {
  softLimit: string | number | null;
  hardLimit: string | number | null;
  period: 'month' | 'day';
}

export type QuotaDecision =
  | { kind: 'ok' }
  | { kind: 'warn'; softLimit: number; usedAfter: number }
  | { kind: 'exceeded'; hardLimit: number; used: number };

/**
 * 配额判定（§11.7）：hard 拦在「本次会超过上限」上（used + qty > hard），
 * 而不是「已经超过」——否则超限后 0 张的空任务也能通过。
 * soft 只告警。两者都为 null/缺省 → 不限。
 */
export function checkQuota(used: number, quantity: number, q: QuotaRow | null | undefined): QuotaDecision {
  if (!q) return { kind: 'ok' };
  const usedAfter = Number(used) + Number(quantity);
  const hard = q.hardLimit === null || q.hardLimit === undefined ? null : Number(q.hardLimit);
  const soft = q.softLimit === null || q.softLimit === undefined ? null : Number(q.softLimit);
  if (hard !== null && usedAfter > hard) {
    return { kind: 'exceeded', hardLimit: hard, used: Number(used) };
  }
  if (soft !== null && usedAfter > soft) {
    return { kind: 'warn', softLimit: soft, usedAfter };
  }
  return { kind: 'ok' };
}

/** 账单号：INV-<tenantId>-<yymm>-<seq>（seq 3 位补零，同一租户同一月内递增） */
export function invoiceNumber(tenantId: number, date: Date, seq: number): string {
  const yymm = dayKey(date).slice(2, 4) + dayKey(date).slice(5, 7);
  return `INV-${tenantId}-${yymm}-${String(seq).padStart(3, '0')}`;
}

/** 从 'INV-7-2511-003' 解析该月已有最大 seq（解析失败按 0）；用于生成下一个号 */
export function maxSeqOf(numbers: string[], tenantId: number, date: Date): number {
  const prefix = `INV-${tenantId}-`;
  const yymm = invoiceNumber(tenantId, date, 0).split('-')[2];
  let max = 0;
  for (const n of numbers) {
    if (!n || !n.startsWith(prefix)) continue;
    const parts = n.split('-');
    if (parts[2] !== yymm) continue;
    const seq = parseInt(parts[3] ?? '', 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

/** 收款是否已覆盖账单：累计 >= 应付（多收按已付处理，退款走红字账单，V1 不做） */
export function isSettled(totalPaidCents: number, amountCents: number): boolean {
  return Number(totalPaidCents) >= Number(amountCents);
}

/** 账单项求和（分）；行缺 amountCents 时按 qty * unitPriceCents 计算 */
export function sumLineCents(items: Array<{ qty?: number; unitPriceCents?: number; amountCents?: number }>): number {
  return (items ?? []).reduce((acc, it) => {
    if (it.amountCents !== undefined && it.amountCents !== null) return acc + Number(it.amountCents);
    return acc + Number(it.qty ?? 0) * Number(it.unitPriceCents ?? 0);
  }, 0);
}

/** 自然月账单周期：给定月份 → [period_start, period_end]（首日 / 末日，'YYYY-MM-DD'） */
export function monthPeriod(date: Date = new Date()): { periodStart: string; periodEnd: string } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const start = `${dayKey(date).slice(0, 7)}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { periodStart: start, periodEnd: `${start.slice(0, 7)}-${String(lastDay).padStart(2, '0')}` };
}
