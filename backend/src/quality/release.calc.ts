// =============================================================================
// 成品放行纯计算（无装饰器、无 IO）
//   核心口径：**未经放行不得出库**。放行必须有人签、有依据（检验单 PASS）。
// =============================================================================

export type ReleaseStatus = 'PENDING' | 'RELEASED' | 'REJECTED' | 'CANCELLED';

export interface ReleaseCheckInput {
  /** 放行单状态 */
  releaseStatus: string;
  /** 批次当前质量状态（PENDING/RELEASED/REJECTED/FROZEN） */
  batchStatus: string;
  /** 物料是否要求检验（materials.qc_required） */
  qcRequired: boolean;
  /** 关联检验单状态；undefined 表示未关联 */
  inspectionStatus?: 'DRAFT' | 'PASS' | 'FAIL' | 'CANCELLED' | null;
}

export interface Decision { ok: boolean; reason: string }

/**
 * 签批前校验：能不能放。
 * 规则（按 GMP「未经放行不得上市销售」倒推）：
 *  1. 放行单必须是 PENDING，重复签批无意义且会污染记录；
 *  2. 批次不能已经是 RELEASED（已放行过，再签等于二次放行）；
 *  3. 物料要求检验时，必须挂检验单且结论 PASS —— 没有检验报告的放行是空签；
 *  4. 关联了检验单就必须 PASS，不允许拿 FAIL/未完成 的单子放行。
 */
export function checkBeforeRelease(i: ReleaseCheckInput): Decision {
  if (i.releaseStatus !== 'PENDING') {
    return { ok: false, reason: `放行单当前状态为 ${i.releaseStatus}，只有待签批（PENDING）的才能签` };
  }
  if (i.batchStatus === 'RELEASED') {
    return { ok: false, reason: '该批次已是合格状态，无需重复放行（如需重新评估请先冻结）' };
  }
  if (i.batchStatus === 'FROZEN') {
    return { ok: false, reason: '该批次处于冻结状态，请先解冻并完成调查后再放行' };
  }
  if (i.inspectionStatus !== undefined && i.inspectionStatus !== null) {
    if (i.inspectionStatus !== 'PASS') {
      return { ok: false, reason: `关联检验单结论为 ${i.inspectionStatus}，未合格不能放行` };
    }
  } else if (i.qcRequired) {
    return { ok: false, reason: '该物料要求检验放行，但放行单未关联检验单（没有检验报告不能签批）' };
  }
  return { ok: true, reason: '' };
}

/** 签批决定 → 批次目标质量状态 */
export function targetBatchStatus(decision: 'APPROVE' | 'REJECT'): 'RELEASED' | 'REJECTED' {
  return decision === 'APPROVE' ? 'RELEASED' : 'REJECTED';
}

/** 签批意见的最低要求：驳回必须写原因（否则生产不知道该改什么） */
export function checkOpinion(decision: 'APPROVE' | 'REJECT', opinion?: string | null): Decision {
  const text = String(opinion ?? '').trim();
  if (decision === 'REJECT' && text.length < 2) {
    return { ok: false, reason: '驳回必须填写原因（至少 2 个字）' };
  }
  return { ok: true, reason: '' };
}

/** 待签批提醒：超过 N 天未签批的放行单（成品压在库里不能发） */
export function stalePending(releases: Array<{ submittedAt?: Date | string | null; status: string }>, days = 3, now = new Date()) {
  const ms = days * 86400000;
  return releases.filter((r) => {
    if (r.status !== 'PENDING' || !r.submittedAt) return false;
    return now.getTime() - new Date(r.submittedAt).getTime() > ms;
  });
}
