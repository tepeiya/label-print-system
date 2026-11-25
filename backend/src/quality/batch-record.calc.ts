// =============================================================================
// 批记录纯计算（无装饰器、无 IO）
//   批记录是飞检第一份要看的材料：这批货用了什么料、过了哪几道工序、
//   每道工序谁做的、参数多少、结果如何。这里只做「齐不齐、能不能提交」的判定。
// =============================================================================

export interface StepPlain {
  seq: number;
  stepName: string;
  equipment?: string | null;
  operator?: string | null;
  startedAt?: string | Date | null;
  endedAt?: string | Date | null;
  params?: Record<string, any> | null;
  result: 'PASS' | 'FAIL' | 'NA';
  remark?: string | null;
}

export interface StepSummary {
  total: number;
  pass: number;
  fail: number;
  na: number;
  /** 缺操作人或工序名的步骤序号 */
  incomplete: number[];
  /** 时间倒挂的步骤序号（结束早于开始） */
  timeReversed: number[];
}

export function summarizeSteps(steps: StepPlain[]): StepSummary {
  const incomplete: number[] = [];
  const timeReversed: number[] = [];
  for (const s of steps) {
    if (!String(s.stepName ?? '').trim() || !String(s.operator ?? '').trim()) incomplete.push(s.seq);
    if (s.startedAt && s.endedAt) {
      const st = new Date(s.startedAt).getTime();
      const en = new Date(s.endedAt).getTime();
      if (Number.isFinite(st) && Number.isFinite(en) && en < st) timeReversed.push(s.seq);
    }
  }
  return {
    total: steps.length,
    pass: steps.filter((s) => s.result === 'PASS').length,
    fail: steps.filter((s) => s.result === 'FAIL').length,
    na: steps.filter((s) => s.result === 'NA').length,
    incomplete,
    timeReversed,
  };
}

export interface SubmitCheck { ok: boolean; reason: string; warnings: string[] }

/**
 * 能不能提交批记录。
 * 硬性：至少 1 道工序、每道工序有名称与操作人、时间不能倒挂、FAIL 必须写备注。
 * 软性（warning，不阻塞）：工序里没有 NA 之外的记录（提示补全）、无灭菌类工序（按产品类型人工判断）。
 */
export function checkBeforeSubmit(steps: StepPlain[]): SubmitCheck {
  const warnings: string[] = [];
  if (!steps.length) return { ok: false, reason: '批记录还没有任何工序，不能提交', warnings };
  const sum = summarizeSteps(steps);
  if (sum.incomplete.length) {
    return { ok: false, reason: `第 ${sum.incomplete.join('、')} 道工序缺少工序名称或操作人，不能提交`, warnings };
  }
  if (sum.timeReversed.length) {
    return { ok: false, reason: `第 ${sum.timeReversed.join('、')} 道工序结束时间早于开始时间，请核对`, warnings };
  }
  const failNoRemark = steps.filter((s) => s.result === 'FAIL' && !String(s.remark ?? '').trim());
  if (failNoRemark.length) {
    return {
      ok: false,
      reason: `第 ${failNoRemark.map((s) => s.seq).join('、')} 道工序判定 FAIL 但未写备注（不合格事实必须记录）`,
      warnings,
    };
  }
  if (sum.fail > 0) {
    warnings.push(`本批有 ${sum.fail} 道工序不合格，提交后需 QA 判定是否放行`);
  }
  if (sum.na === sum.total) {
    warnings.push('全部工序结论均为 NA，请确认是否都已执行');
  }
  return { ok: true, reason: '', warnings };
}

/** 能不能批准：只有已提交（SUBMITTED）的批记录可批准 */
export function checkBeforeApprove(status: string): { ok: boolean; reason: string } {
  if (status === 'SUBMITTED') return { ok: true, reason: '' };
  if (status === 'APPROVED') return { ok: false, reason: '批记录已批准，无需重复操作' };
  if (status === 'OPEN') return { ok: false, reason: '批记录还在记录中，先提交再批准' };
  return { ok: false, reason: `批记录状态为 ${status}，不能批准（退回后需修改再提交）` };
}

/** 工序号自动递增（新增步骤时用） */
export function nextSeq(steps: Array<{ seq: number }>): number {
  return steps.reduce((m, s) => Math.max(m, Number(s.seq) || 0), 0) + 1;
}
