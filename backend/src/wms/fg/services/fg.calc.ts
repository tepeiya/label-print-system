// =============================================================================
// fg.calc.ts —— 成品入库的判定规则（纯函数，可单测穷举）
//
// 这里只做"能不能"的判断，不做 IO：
//   · 单号格式
//   · 完工作报告的数量校验（正数、可带精度）
//   · 累计入库不得超工单需求（超交是真实事故：多报数量=多算库存）
//   · 批次的初始质量状态（物料要检验 → PENDING，检验放行后才转 RELEASED）
//   · 状态机的动作许可
// =============================================================================

const EPS = 0.0005;

/** 单号 FG-YYYYMMDD-NNNN */
export function formatFgNo(d: Date, seq: number): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `FG-${ymd}-${String(seq).padStart(4, '0')}`;
}

export type FgStatus = 'CREATED' | 'POSTED' | 'CANCELLED';

export const FG_STATUS_TEXT: Record<string, string> = {
  CREATED: '待过账',
  POSTED: '已入库',
  CANCELLED: '已作废',
};

export const FG_LINE_STATUS_TEXT: Record<string, string> = {
  PENDING: '待过账',
  POSTED: '已入库',
  FAILED: '过账失败',
  CANCELLED: '已作废',
};

/** 新建入库单：只有待过账/已入库能过账；已入库不能再作废（库存已动过） */
export function assertCanPost(status: string): { ok: boolean; reason?: string } {
  if (status === 'CREATED') return { ok: true };
  if (status === 'POSTED') return { ok: false, reason: '该入库单已过账，不能重复过账' };
  if (status === 'CANCELLED') return { ok: false, reason: '已作废的入库单不能过账' };
  return { ok: false, reason: `未知单据状态：${status}` };
}

export function assertCanCancel(status: string): { ok: boolean; reason?: string } {
  if (status === 'CREATED') return { ok: true };
  if (status === 'POSTED') return { ok: false, reason: '已过账的入库单不能作废，请走退货或调整单' };
  return { ok: false, reason: '该入库单已作废' };
}

/** 数量合法性：必须 > 0，且最多 3 位小数 */
export function assertQty(qty: unknown, label = '数量'): { ok: boolean; value: number; reason?: string } {
  const n = Number(qty);
  if (!Number.isFinite(n)) return { ok: false, value: 0, reason: `${label}不是数字` };
  if (n <= 0) return { ok: false, value: 0, reason: `${label}必须大于 0` };
  const scaled = Number(n.toFixed(3));
  if (Math.abs(scaled - n) > 1e-9) return { ok: false, value: n, reason: `${label}最多 3 位小数` };
  return { ok: true, value: scaled };
}

/**
 * 累计入库不得超工单需求。
 * @param demand  工单需求数量（成品）
 * @param already 该工单此前已入库（含本单未过账）合计
 * @param adding  本次要入库的合计
 */
export function assertNotOverDemand(
  demand: number,
  already: number,
  adding: number,
): { ok: boolean; remaining: number; reason?: string } {
  const total = Math.round((already + adding) * 1000) / 1000;
  const remaining = Math.max(0, Math.round((demand - already) * 1000) / 1000);
  if (total - demand > EPS) {
    return {
      ok: false,
      remaining,
      reason: `累计入库 ${total} 超过工单需求 ${demand}（此前已入 ${already}，本次最多可入 ${remaining}）`,
    };
  }
  return { ok: true, remaining };
}

/** 建批次时的质量初始状态：要检验的物料给 PENDING，否则 RELEASED */
export function resolveQcStatus(qcRequired: boolean): 'PENDING' | 'RELEASED' {
  return qcRequired ? 'PENDING' : 'RELEASED';
}

/** 无 MES 时的完工口径：只有工单已发完料/已关单才允许报完工入库 */
export function assertWoReadyForCompletion(status: string): { ok: boolean; reason?: string } {
  if (status === 'ISSUED' || status === 'CLOSED') return { ok: true };
  if (status === 'ISSUING') {
    return { ok: false, reason: '工单仍在发料中，尚未完工，不能报完工入库' };
  }
  return { ok: false, reason: `工单状态 ${status} 不允许报完工入库（须先发料完成）` };
}
