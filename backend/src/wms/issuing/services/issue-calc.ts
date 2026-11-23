// =============================================================================
// issue-calc.calc —— 发料数量/幂等键/扫码校验（纯函数，docs/16 §7 / §9.1）
//
// 幂等键口径（与 docs/16 §3.3 一致，改这里必须同步迁移注释）：
//   ISSUE:{woNo}:{lineNo}             —— 发料过账（woNo 自带 WO 前缀，如 WO20261123）
//   RETURN:{woNo}:{lineNo}:{seq}      —— 退料冲销
//   ISSUE:{woNo}:{lineNo}:reprint:{n} —— 发料标签补打
// =============================================================================
import { round3 } from '../../../inventory/kit.calc';

/** 行需求量：qty_per × (1 + loss_rate) × demand，三位小数 */
export function lineRequiredQty(qtyPer: number, lossRate: number, demand: number): number {
  const qp = Number(qtyPer);
  const lr = Number(lossRate) || 0;
  const d = Number(demand);
  if (!Number.isFinite(qp) || qp < 0) throw new Error('qtyPer 必须是非负数');
  if (!Number.isFinite(d) || d <= 0) throw new Error('demand 必须是正数');
  return round3(qp * (1 + lr) * d);
}

export function issueIdemKey(woNo: string, lineNo: number): string {
  return `ISSUE:${woNo}:${lineNo}`;
}

export function returnIdemKey(woNo: string, lineNo: number, seq: number): string {
  return `RETURN:${woNo}:${lineNo}:${seq}`;
}

export function reprintIdemKey(woNo: string, lineNo: number, n: number): string {
  return `ISSUE:${woNo}:${lineNo}:reprint:${n}`;
}

/** 累计已发（含本次），超发检查：不允许超过行需求（用 round3 容忍浮点） */
export function checkOverIssue(currentIssued: number, required: number, add: number): {
  ok: boolean; nextIssued: number; over: number; reason?: string;
} {
  const cur = round3(Number(currentIssued) || 0);
  const req = round3(Number(required) || 0);
  const delta = round3(Number(add) || 0);
  if (delta <= 0) return { ok: false, nextIssued: cur, over: 0, reason: '本次发料数量必须为正数' };
  const next = round3(cur + delta);
  if (round3(next - req) > 0.0005) {
    return { ok: false, nextIssued: cur, over: round3(next - req), reason: `超发：行需求 ${req}，已发 ${cur}，本次 ${delta}` };
  }
  return { ok: true, nextIssued: next, over: 0 };
}

/** 行状态：DONE（发满）/ PARTIAL（部分）/ SHORT（有缺料标记且未发满）/ PENDING（未发） */
export function lineStatus(qtyIssued: number, qtyRequired: number, qtyShortage: number, hadKitCheck = false): string {
  const issued = round3(Number(qtyIssued) || 0);
  const required = round3(Number(qtyRequired) || 0);
  if (issued > 0 && round3(required - issued) <= 0.0005) return 'DONE';
  if (issued > 0) return 'PARTIAL';
  if (hadKitCheck && Number(qtyShortage) > 0) return 'SHORT';
  return 'PENDING';
}

// ---------------------------------------------------------------- 扫码校验
export interface ScanExpectation {
  materialCode?: string;
  batchNo?: string;
  locationId?: number | null;
  locationCode?: string;
}
export interface ScanActual {
  materialCode?: string;
  batchNo?: string;
  locationId?: number | null;
  locationCode?: string;
}
export interface ScanVerdict {
  ok: boolean;
  mismatches: Array<{ field: 'material' | 'batch' | 'location'; expected: string; actual: string }>;
  /** 是否三项都扫到了（没扫到的项不判，交服务层提示） */
  checked: number;
  message: string;
}

/**
 * PDA 扫码校验（D1）：扫错 SKU / 批次 / 库位不许过账；调用方可用 force 放行并留审计。
 * 空字段视为"未扫到"，不参与比对（避免现场漏扫就阻断一切）。
 */
export function verifyIssueScan(expected: ScanExpectation, scanned: ScanActual): ScanVerdict {
  const mismatches: ScanVerdict['mismatches'] = [];
  let checked = 0;

  if (scanned.materialCode) {
    checked += 1;
    const exp = String(expected.materialCode ?? '').trim();
    if (exp && exp !== String(scanned.materialCode).trim()) {
      mismatches.push({ field: 'material', expected: exp, actual: String(scanned.materialCode).trim() });
    }
  }
  if (scanned.batchNo) {
    checked += 1;
    const exp = String(expected.batchNo ?? '').trim();
    if (exp && exp !== String(scanned.batchNo).trim()) {
      mismatches.push({ field: 'batch', expected: exp, actual: String(scanned.batchNo).trim() });
    }
  }
  if (scanned.locationId != null || scanned.locationCode) {
    checked += 1;
    const expId = expected.locationId != null ? String(expected.locationId) : '';
    const actId = scanned.locationId != null ? String(scanned.locationId) : '';
    const expCode = String(expected.locationCode ?? '').trim();
    const actCode = String(scanned.locationCode ?? '').trim();
    // 判定优先级：两边都有 ID 比 ID → 否则两边都有编码比编码 → 否则无足够信息不判
    const bad = (expId && actId) ? expId !== actId : (expCode && actCode && expCode !== actCode);
    if (bad) {
      mismatches.push({ field: 'location', expected: expId || expCode, actual: actId || actCode });
    }
  }

  if (!checked) {
    return { ok: false, mismatches, checked: 0, message: '未扫到任何字段：请扫描物料码 / 批次码 / 库位码' };
  }
  if (mismatches.length) {
    const fieldName = { material: '物料', batch: '批次', location: '库位' } as const;
    return {
      ok: false, mismatches, checked,
      message: `扫码不符：${mismatches.map((m) => `${fieldName[m.field]} 应为 ${m.expected}，实际 ${m.actual}`).join('；')}`,
    };
  }
  return { ok: true, mismatches, checked, message: `校验通过（比对 ${checked} 项）` };
}
