// =============================================================================
// 检验单纯计算（无装饰器、无 IO，便于 node:test 直测）
//   这里只回答「这张检验单能不能判合格」——判定口径写死在一处，前端/服务/PDA 共用。
// =============================================================================

export type QcVerdict = 'PASS' | 'FAIL' | 'NA';
export type QcResult = 'PASS' | 'FAIL';

export interface InspectionItemPlain {
  seq?: number;
  itemName: string;
  standard?: string | null;
  measured?: string | null;
  verdict: QcVerdict;
  remark?: string | null;
}

/** 检验结论 → 库存质量状态 */
export function qcStatusFromResult(result: QcResult): 'RELEASED' | 'REJECTED' {
  return result === 'PASS' ? 'RELEASED' : 'REJECTED';
}

/**
 * 判定合格前的校验（GMP 口径：全项合格才能放行，不能靠"没填"混过去）
 * 返回 {ok, reason}，reason 直接给操作人看。
 */
export function checkItemsForPass(items: InspectionItemPlain[]): { ok: boolean; reason: string } {
  if (!items.length) return { ok: false, reason: '检验单没有任何检验项，不能判合格' };
  const fail = items.filter((i) => i.verdict === 'FAIL');
  if (fail.length) {
    return { ok: false, reason: `存在不合格项：${fail.map((i) => i.itemName).join('、')}，不能判合格` };
  }
  const pass = items.filter((i) => i.verdict === 'PASS');
  if (!pass.length) return { ok: false, reason: '没有一项被判 PASS（全为 NA），不能判合格' };
  const noName = items.filter((i) => !String(i.itemName ?? '').trim());
  if (noName.length) return { ok: false, reason: '存在未填检验项目名称的项，不能判合格' };
  return { ok: true, reason: '' };
}

/** 判定不合格时的最低要求：至少录了一个 FAIL 项（避免"凭感觉判死"） */
export function checkItemsForFail(items: InspectionItemPlain[]): { ok: boolean; reason: string } {
  if (!items.length) return { ok: false, reason: '检验单没有任何检验项，不能判不合格' };
  if (!items.some((i) => i.verdict === 'FAIL')) {
    return { ok: false, reason: '判定不合格需要至少记录一项 FAIL，写明不合格事实' };
  }
  return { ok: true, reason: '' };
}

/** 检验项排序与序号归一（seq 从 1 连续，防空号/重号） */
export function normalizeItems(items: InspectionItemPlain[]): InspectionItemPlain[] {
  return items
    .map((i) => ({ ...i, itemName: String(i.itemName ?? '').trim() }))
    .filter((i) => i.itemName)
    .map((i, idx) => ({ ...i, seq: idx + 1 }));
}

/** 单号：QC-YYYYMMDD-NNNN（给定当天已有最大序号，返回下一个） */
export function nextDocNo(prefix: string, date: Date, lastSeq = 0): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  return `${prefix}-${day}-${String(lastSeq + 1).padStart(4, '0')}`;
}

/** 是否允许修改检验项（已判定/已作废的单一律锁死，保证记录不可回改） */
export function canEditInspection(status: string): { ok: boolean; reason: string } {
  if (status === 'DRAFT') return { ok: true, reason: '' };
  if (status === 'CANCELLED') return { ok: false, reason: '检验单已作废，不能修改' };
  return { ok: false, reason: '检验单已判定，记录不可回改（需复检请另开一张）' };
}
