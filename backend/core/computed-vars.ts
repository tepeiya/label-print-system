// =============================================================================
// computed-vars.ts —— 计算变量（VariableSpec.expr）求值
//   与前端 apps/console/.../engine/context.ts#resolveComputedVars 同口径：
//     * 按 {{...}} 依赖拓扑序求值，依赖缺失/成环时用 defaultValue 兜底
//     * 值归一化与前端 evalFormula 完全一致（整数去小数、小数保留 3 位）
//   由 formula-parity.test.ts 逐条比对锁定，改动任一端都必须过测试。
// =============================================================================

import { safeEval, extractVars, detectCircularDeps } from './formula-engine';

export interface ComputedVariable {
  name: string;
  expr?: string;
  defaultValue?: string | number | null;
}

export interface ComputedVarsResult {
  row: Record<string, any>;
  cycle: string[];
}

/** 与前端 evalFormula 的返回归一化一致 */
export function normalizeComputedValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number(v.toFixed(3)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/**
 * 求值所有计算变量，返回并入结果的新 row（不修改入参）。
 * cycle 非空表示存在循环依赖，环上变量已用 defaultValue 兜底。
 */
export function resolveComputedVars(
  variables: ComputedVariable[] | undefined,
  row: Record<string, any>,
): ComputedVarsResult {
  const fields: Record<string, string> = {};
  for (const v of variables ?? []) {
    if (v.expr && String(v.expr).trim()) fields[v.name] = String(v.expr);
  }
  const names = Object.keys(fields);
  if (!names.length) return { row, cycle: [] };

  const cycle = detectCircularDeps(fields);
  const working: Record<string, any> = { ...row };

  let pending = new Set(names);
  while (pending.size) {
    let progressed = false;
    for (const name of [...pending]) {
      const deps = extractVars(fields[name]).filter((d) => names.includes(d) && d !== name);
      if (deps.some((d) => pending.has(d))) continue;
      const r = safeEval(fields[name], working);
      const fallback = (variables ?? []).find((v) => v.name === name)?.defaultValue ?? '';
      working[name] = r.ok ? (normalizeComputedValue(r.value) ?? fallback) : fallback;
      pending.delete(name);
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const name of pending) {
    working[name] = (variables ?? []).find((v) => v.name === name)?.defaultValue ?? '';
  }
  return { row: working, cycle };
}
