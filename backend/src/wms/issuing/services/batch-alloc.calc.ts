// =============================================================================
// batch-alloc.calc.ts —— 批次分配与发料量计算（纯函数，docs/16 §6 D5 / §9 issue-calc）
//
// 规则（D5）：手工指定批次优先（校验余量），否则自动 FIFO → 近效期：
//   1) 已过期批次排最后（可发但要留 warning，交服务层写审计）
//   2) 有效期早的先发；无有效期排在有有效期之后
//   3) 同有效期按入库时间（id/createdAt）先后
// 只做"选批 + 拆分数量"，不动库存。
// =============================================================================
import { round3 } from '../../../inventory/kit.calc';

export interface BatchRow {
  batchNo: string;
  qty: number;
  locationId?: number | null;
  expiresAt?: string | null;   // YYYY-MM-DD
  createdAt?: string | Date | null;
  id?: number;
}

export interface BatchAllocation {
  batchNo: string;
  qty: number;
  locationId?: number | null;
  expiresAt?: string | null;
}

export interface AllocResult {
  ok: boolean;
  manual: boolean;
  allocations: BatchAllocation[];
  allocated: number;
  shortage: number;
  /** 选中批次里的已过期批次（服务层据此写 warning 审计） */
  expiredPicked: string[];
  reason?: string;
}

const DAY = 86400000;

function expiryTs(v?: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * 分配批次。
 * @param rows 可用批次（同一 SKU + 仓库）
 * @param need 本次需发数量（>0）
 * @param opts.batchNo 手工指定批次（D5 覆盖自动）
 * @param opts.now 当前时间（测试注入）
 */
export function allocateBatches(
  rows: BatchRow[],
  need: number,
  opts: { batchNo?: string | null; now?: Date } = {},
): AllocResult {
  const needQty = round3(Number(need));
  if (!Number.isFinite(needQty) || needQty <= 0) {
    return { ok: false, manual: false, allocations: [], allocated: 0, shortage: 0, expiredPicked: [], reason: '需发数量必须为正数' };
  }
  const usable = (rows ?? [])
    .map((r) => ({ ...r, qty: round3(Number(r.qty) || 0) }))
    .filter((r) => r.qty > 0 && r.batchNo != null);
  const now = (opts.now ?? new Date()).getTime();
  const manual = !!(opts.batchNo && String(opts.batchNo).trim());

  if (manual) {
    const target = String(opts.batchNo).trim();
    const hit = usable.find((r) => r.batchNo === target);
    if (!hit) {
      return { ok: false, manual: true, allocations: [], allocated: 0, shortage: needQty, expiredPicked: [], reason: `指定批次 ${target} 在该仓库无可用库存` };
    }
    const take = Math.min(hit.qty, needQty);
    const expired = isExpired(hit.expiresAt, now);
    return {
      ok: take >= needQty,
      manual: true,
      allocations: [{ batchNo: hit.batchNo, qty: round3(take), locationId: hit.locationId ?? null, expiresAt: hit.expiresAt ?? null }],
      allocated: round3(take),
      shortage: round3(Math.max(0, needQty - take)),
      expiredPicked: expired ? [hit.batchNo] : [],
      reason: take >= needQty ? undefined : `指定批次 ${target} 可用 ${hit.qty}，不足需求 ${needQty}`,
    };
  }

  // 自动：过期最后 → 有效期升序（无有效期靠后）→ 入库顺序
  const sorted = [...usable].sort((a, b) => {
    const ea = isExpired(a.expiresAt, now) ? 1 : 0;
    const eb = isExpired(b.expiresAt, now) ? 1 : 0;
    if (ea !== eb) return ea - eb;
    const ta = expiryTs(a.expiresAt);
    const tb = expiryTs(b.expiresAt);
    if (ta !== tb) {
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    }
    const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (ca !== cb) return ca - cb;
    return Number(a.id ?? 0) - Number(b.id ?? 0);
  });

  const allocations: BatchAllocation[] = [];
  let left = needQty;
  const expiredPicked: string[] = [];
  for (const r of sorted) {
    if (left <= 0) break;
    const take = Math.min(r.qty, left);
    if (take <= 0) continue;
    allocations.push({
      batchNo: r.batchNo, qty: round3(take),
      locationId: r.locationId ?? null, expiresAt: r.expiresAt ?? null,
    });
    if (isExpired(r.expiresAt, now)) expiredPicked.push(r.batchNo);
    left = round3(left - take);
  }

  return {
    ok: left <= 0,
    manual: false,
    allocations,
    allocated: round3(needQty - Math.max(0, left)),
    shortage: round3(Math.max(0, left)),
    expiredPicked,
    reason: left > 0 ? `可用合计不足：还缺 ${round3(left)}` : undefined,
  };
}

export function isExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  const t = expiryTs(expiresAt);
  if (t == null) return false;
  // 效期当天仍可用 → 早于今天 0 点才算过期
  return t + DAY <= nowMs;
}
