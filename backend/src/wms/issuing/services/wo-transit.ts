// =============================================================================
// wo-transit.ts —— 工单状态机（纯函数，docs/16 §4）
//
// 状态：CREATED → RELEASED → ISSUING → ISSUED → CLOSED；CREATED/RELEASED 可 CANCELLED。
// 守卫（与状态分离，便于单测穷举）：
//   RELEASE 需 有行 + 已做过齐套检查；ISSUE_DONE 需 全部行 DONE 或 force；CLOSE 需 无未结退料。
// 不发 SQL 判断，服务层只认这里的结果。
// =============================================================================

export const WO_STATUS = ['CREATED', 'RELEASED', 'ISSUING', 'ISSUED', 'CLOSED', 'CANCELLED'] as const;
export type WoStatus = (typeof WO_STATUS)[number];

export const WO_ACTION = [
  'RELEASE', 'CANCEL', 'EDIT', 'ISSUE_START', 'ISSUE_POST', 'ISSUE_DONE', 'RETURN', 'CLOSE',
] as const;
export type WoAction = (typeof WO_ACTION)[number];

export interface TransitContext {
  /** 明细行数量（RELEASE 守卫） */
  lineCount?: number;
  /** 是否已做过齐套检查（RELEASE 守卫；缺料也允许，但必须有检查记录） */
  kitChecked?: boolean;
  /** 是否所有行都已发满（ISSUE_DONE 守卫） */
  allDone?: boolean;
  /** 人工强制放行（ISSUE_DONE / ISSUE_POST 用，必须留审计） */
  force?: boolean;
  /** 未结退料数量（CLOSE 守卫必须为 0） */
  openReturns?: number;
}

export interface TransitResult {
  ok: boolean;
  from: string;
  action: string;
  to: string | null;
  /** 不通过时的中文原因，服务层直接转 409 */
  reason?: string;
  /** 是否属于"强制放行"路径（服务层须写审计） */
  forced?: boolean;
}

const TABLE: Record<WoStatus, Partial<Record<WoAction, WoStatus>>> = {
  CREATED: { RELEASE: 'RELEASED', CANCEL: 'CANCELLED', EDIT: 'CREATED' },
  RELEASED: { ISSUE_START: 'ISSUING', CANCEL: 'CANCELLED' },
  ISSUING: { ISSUE_POST: 'ISSUING', ISSUE_DONE: 'ISSUED' },
  ISSUED: { RETURN: 'ISSUING', CLOSE: 'CLOSED' },
  CLOSED: {},
  CANCELLED: {},
};

/** 合法流转 + 守卫判定 */
export function canTransit(from: string, action: string, ctx: TransitContext = {}): TransitResult {
  const base: TransitResult = { ok: false, from, action, to: null };
  if (!WO_STATUS.includes(from as WoStatus)) {
    return { ...base, reason: `未知工单状态：${from}` };
  }
  if (!WO_ACTION.includes(action as WoAction)) {
    return { ...base, reason: `未知动作：${action}` };
  }
  const to = TABLE[from as WoStatus][action as WoAction] ?? null;
  if (!to) {
    return { ...base, reason: `状态 ${from} 不允许执行 ${action}` };
  }
  switch (action as WoAction) {
    case 'RELEASE': {
      if (!(Number(ctx.lineCount ?? 0) > 0)) return { ...base, reason: '工单没有明细行，不能下发' };
      if (!ctx.kitChecked) return { ...base, reason: '下发前必须先做齐套检查（缺料可下发，但须有检查记录）' };
      return { ...base, ok: true, to };
    }
    case 'EDIT': {
      return { ...base, ok: true, to };      // 服务层另判"仅 CREATED"
    }
    case 'ISSUE_DONE': {
      if (ctx.allDone) return { ...base, ok: true, to };
      if (ctx.force) return { ...base, ok: true, to, forced: true };
      return { ...base, reason: '仍有未发满的明细行（可用 force=true 强制放行并留审计）' };
    }
    case 'CLOSE': {
      if (Number(ctx.openReturns ?? 0) > 0) {
        return { ...base, reason: `还有 ${ctx.openReturns} 笔未结退料，不能关单` };
      }
      return { ...base, ok: true, to };
    }
    default:
      return { ...base, ok: true, to };
  }
}

/** 终态判定（不可再流转） */
export function isFinalStatus(status: string): boolean {
  return status === 'CLOSED' || status === 'CANCELLED';
}
