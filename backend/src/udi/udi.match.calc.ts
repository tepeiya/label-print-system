// =============================================================================
// udi.match.calc.ts —— 物料 GTIN × 扫码 GTIN 比对（U5.1）
//
// 职责：把"物料上登记的 GTIN"与"扫到的 UDI 码里的 GTIN"做一致性与必扫校验。
// 约定：不做 IO；空登记为"未启用比对"，不误拦未赋码物料。
// =============================================================================
import { normalizeGtin } from './udi.calc';

export interface GtinResult {
  ok: boolean;
  gtin14?: string;
  errors: string[];
}

/** 物料侧 GTIN 录入校验：接受 13/14 位，统一补位成 GTIN14 并校验校验位 */
export function normalizeMaterialGtin(input?: string | null): GtinResult {
  const raw = String(input ?? '').replace(/[\s-]/g, '');
  if (!raw) return { ok: true, gtin14: undefined, errors: [] };
  // 只收 13/14 位：8/12 位的校验位奇偶口径与 GTIN14 补位不一致，避免"录进去能用、比对时对不上"
  if (!/^\d{13,14}$/.test(raw)) {
    return { ok: false, errors: ['GTIN 必须是 13 或 14 位数字（UDI 场景建议 14 位）'] };
  }
  const r = normalizeGtin(raw);
  if (r.errors.length || r.checkDigitOk === false) {
    return { ok: false, errors: r.errors.length ? r.errors : ['GTIN 校验位错误'] };
  }
  return { ok: true, gtin14: r.gtin14, errors: [] };
}

export interface GtinMatch {
  ok: boolean;
  /** 物料未登记 GTIN → 跳过比对（不拦） */
  skipped: boolean;
  reason?: string;
}

/** 比对：物料 GTIN（可空）× 扫到的 GTIN（GTIN14） */
export function matchMaterialGtin(materialGtin: string | null | undefined, scannedGtin: string | null | undefined): GtinMatch {
  const mat = String(materialGtin ?? '').trim();
  if (!mat) return { ok: true, skipped: true };
  const scanned = String(scannedGtin ?? '').trim();
  if (!scanned) return { ok: false, skipped: false, reason: '扫到的码里没有 GTIN(01)，无法与物料比对' };
  const norm = normalizeMaterialGtin(mat);
  if (!norm.ok) return { ok: false, skipped: false, reason: `物料登记的 GTIN 非法：${norm.errors.join('；')}` };
  if (norm.gtin14 !== scanned) {
    return { ok: false, skipped: false, reason: `GTIN 不符：物料 ${norm.gtin14}，扫到 ${scanned}（疑似扫错料）` };
  }
  return { ok: true, skipped: false };
}

/** 必扫校验：物料标记 udi_required 时必须带码 */
export function checkUdiRequired(udiRequired: boolean, hasCode: boolean): { ok: boolean; reason?: string } {
  if (udiRequired && !hasCode) return { ok: false, reason: '该物料要求扫 UDI 码（udi_required=true），未扫到码' };
  return { ok: true };
}

/** 扫描判定总入口：必扫 → GTIN 比对（顺序有讲究：先说"没码"，再说"码不对"） */
export function judgeScanGtin(p: {
  materialGtin?: string | null;
  udiRequired?: boolean;
  codeGtin?: string | null;
  hasCode: boolean;
  force?: boolean;
}): { ok: boolean; skipped?: boolean; reason?: string } {
  if (p.force) return { ok: true, skipped: true };
  const req = checkUdiRequired(!!p.udiRequired, p.hasCode);
  if (!req.ok) return { ok: false, reason: req.reason };
  if (!p.hasCode) return { ok: true, skipped: true };
  const m = matchMaterialGtin(p.materialGtin, p.codeGtin);
  return { ok: m.ok, skipped: m.skipped, reason: m.reason };
}
