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

/**
 * 多 GTIN 匹配：物料挂了单品/中包/托盘多个码时，扫到任意一个都算对。
 * 全部为空 → 跳过；列表里有非法码 → 该条忽略但其余仍可比（不因一条脏数据拦住整组）。
 */
export function matchMaterialGtins(materialGtins: Array<string | null | undefined> | null | undefined, scannedGtin: string | null | undefined): GtinMatch {
  const list = (materialGtins ?? []).map((g) => String(g ?? '').trim()).filter(Boolean);
  if (!list.length) return { ok: true, skipped: true };
  const scanned = String(scannedGtin ?? '').trim();
  if (!scanned) return { ok: false, skipped: false, reason: '扫到的码里没有 GTIN(01)，无法与物料比对' };
  const norm = list.map((g) => normalizeMaterialGtin(g)).filter((g) => g.ok && g.gtin14).map((g) => g.gtin14!);
  if (!norm.length) return { ok: false, skipped: false, reason: `物料登记的 GTIN 全部非法：${list.join('、')}` };
  if (!norm.includes(scanned)) {
    return { ok: false, skipped: false, reason: `GTIN 不符：物料 ${norm.join('/')}，扫到 ${scanned}（疑似扫错料）` };
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
  /** 多 GTIN（单品/中包/托盘）；给了就优先按整组匹配 */
  materialGtins?: Array<string | null | undefined> | null;
  udiRequired?: boolean;
  codeGtin?: string | null;
  hasCode: boolean;
  force?: boolean;
}): { ok: boolean; skipped?: boolean; reason?: string } {
  if (p.force) return { ok: true, skipped: true };
  const req = checkUdiRequired(!!p.udiRequired, p.hasCode);
  if (!req.ok) return { ok: false, reason: req.reason };
  if (!p.hasCode) return { ok: true, skipped: true };
  const m = p.materialGtins?.length
    ? matchMaterialGtins(p.materialGtins, p.codeGtin)
    : matchMaterialGtin(p.materialGtin, p.codeGtin);
  return { ok: m.ok, skipped: m.skipped, reason: m.reason };
}


// ---------------------------------------------------------------- U5.3 拆箱换算
export interface PackRow { gtin: string; packLevel: string; packQty: number }

function round3(n: number): number { return Math.round(Number(n) * 1000) / 1000; }

/** 从物料整组 GTIN 里找出扫码命中的包装行（含级别与折算量） */
export function matchPack(rows: Array<PackRow | null | undefined> | null | undefined, scannedGtin: string | null | undefined): PackRow | null {
  const scanned = String(scannedGtin ?? '').trim();
  if (!scanned) return null;
  for (const row of rows ?? []) {
    if (!row) continue;
    if (String(row.gtin).trim() === scanned) {
      return { gtin: scanned, packLevel: row.packLevel ?? 'UNIT', packQty: Number(row.packQty) || 1 };
    }
  }
  return null;
}

/**
 * D4：一次"扫包"→ 单品件数（收货/发料共用同一口径，避免两边算法漂移）。
 * @param packRows 物料整组 GTIN（UNIT/CARTON/PALLET + packQty）
 * @param udiCode  扫到的码（GS1 或纯 GTIN；GTIN 提取由调用方用 udiKeyFromCode 完成）
 * @param packCount 扫了几包（默认 1）
 * @returns null=码不在物料包装表里（调用方决定是否拦截）；否则给出折算结果
 */
export function resolvePackUnits(
  packRows: Array<PackRow | null | undefined> | null | undefined,
  codeGtin: string | null | undefined,
  packCount = 1,
): { gtin: string; packLevel: string; packQty: number; units: number } | null {
  const matched = matchPack(packRows, codeGtin);
  if (!matched) return null;
  return {
    gtin: matched.gtin,
    packLevel: matched.packLevel,
    packQty: matched.packQty,
    units: convertToUnits(packCount, matched.packQty, matched.packLevel),
  };
}

/** 包装数量 → 单品件数：扫 N 包 × 每包件数；UNIT 级不折算 */
export function convertToUnits(packCount: number, packQty: number, packLevel?: string): number {
  const count = round3(Number(packCount) || 0);
  const qty = round3(Number(packQty) || 1);
  return packLevel && packLevel !== 'UNIT' ? round3(count * qty) : count;
}
