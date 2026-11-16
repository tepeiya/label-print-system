// =============================================================================
// formula-parity.test.ts —— 前后端公式引擎一致性测试
//   背景：设计态用 apps/console/.../engine/context.ts 预览，打印态用本目录引擎求值。
//   二者一旦函数表或语义漂移，就会出现「预览对、打印错」。本测试用同一批表达式
//   同时跑两端并要求输出一致，任何一侧改动都必须先过这里。
//   运行：node --import tsx --test backend/core/__tests__/formula-parity.test.ts
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeEval, detectCircularDeps, FORMULA_FUNCTIONS as BE_FUNCS } from '../formula-engine';
import { resolveComputedVars as beComputed } from '../computed-vars';
import {
  evalFormula,
  resolveComputedVars as feComputed,
  detectComputedCycle,
  FORMULA_FUNCTIONS as FE_FUNCS,
  type RenderContext,
} from '../../../apps/console/src/views/designer/engine/context';

const NOW = new Date('2026-06-15T10:30:20');

function feCtx(row: Record<string, unknown>): RenderContext {
  return { row, vars: [], pageNo: 1, pageTotal: 1, copies: 1, serialNo: 1, now: NOW };
}

/** 后端返回原始值、前端 evalFormula 返回字符串，统一成可比较的字符串 */
function norm(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number(v.toFixed(3)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const ROW = {
  a: 3,
  b: 4,
  price: 12.5,
  sku: 'AB12345',
  name: '  hello  ',
  n: -1.6,
  s: 'a-b-c',
  d1: '2026-06-01',
  d2: '2026-06-15',
};

// [表达式, 期望值] —— 期望值由后端语义确定，前端必须给出相同结果
const CASES: Array<[string, string]> = [
  // 文本（8）
  ['LEN({{sku}})', '7'],
  ['UPPER("abc")', 'ABC'],
  ['LOWER("ABC")', 'abc'],
  ['TRIM({{name}})', 'hello'],
  ['LEFT({{sku}}, 2)', 'AB'],
  ['RIGHT({{sku}}, 3)', '345'],
  ['RIGHT({{sku}}, 0)', ''],
  ['MID({{sku}}, 3, 3)', '123'],
  ['REPLACE({{s}}, "-", "_")', 'a_b_c'],
  ['CONCAT({{sku}}, "-", {{a}})', 'AB12345-3'],
  // 数值（10）
  ['{{a}} + {{b}} * 2', '11'],
  ['({{a}} + {{b}}) * 2', '14'],
  ['{{b}} / {{a}}', '1.333'],
  ['{{a}} % 2', '1'],
  ['ROUND({{price}}, 1)', '12.5'],
  ['FLOOR({{n}})', '-2'],
  ['CEIL({{n}})', '-1'],
  ['ABS({{n}})', '1.6'],
  ['INT({{n}})', '-1'],
  ['NUM("￥1,234.50")', '1234.5'],
  ['FORMAT({{price}}, "0.00")', '12.50'],
  ['PAD({{a}}, 5)', '00003'],
  ['PADLEFT("7", 3, "0")', '007'],
  ['PADRIGHT("7", 3, "0")', '700'],
  // 逻辑（8）
  ['IF({{a}} > 2, "yes", "no")', 'yes'],
  ['AND({{a}} > 0, {{b}} > 0)', 'true'],
  ['OR({{a}} > 9, {{b}} > 0)', 'true'],
  ['NOT({{a}} > 9)', 'true'],
  ['ISEMPTY("")', 'true'],
  ['ISEMPTY({{sku}})', 'false'],
  ['{{a}} > 2 && {{b}} < 5', 'true'],
  ['!{{a}}', 'false'],
  // 日期（2）
  ['DATEFORMAT(DATE(2026, 6, 15), "YYYY/MM/DD")', '2026/06/15'],
  ['DATEDIFF({{d2}}, {{d1}}, "day")', '14'],
  ['DATEDIFF("2026-06-15T12:00:00", "2026-06-15T10:00:00", "hour")', '2'],
  // 校验位（2）
  ['CHECKSUM("EAN13", "690123456789")', '2'],
  ['CHECKSUM("CODE39", "ABC")', 'X'],
];

test('前后端公式函数名单完全一致', () => {
  assert.deepEqual([...BE_FUNCS].sort(), [...FE_FUNCS].sort());
  assert.equal(BE_FUNCS.length, 30, '函数表应为 30 个');
});

test('前后端公式求值结果一致（逐表达式比对）', () => {
  const failed: string[] = [];
  for (const [expr, expected] of CASES) {
    const be = safeEval(expr, ROW);
    const fe = evalFormula(expr, feCtx(ROW));
    const beVal = be.ok ? norm(be.value) : null;
    if (beVal !== expected) failed.push(`后端  ${expr}: 期望 ${expected} 实际 ${beVal} (${be.error ?? ''})`);
    if (norm(fe) !== expected) failed.push(`前端  ${expr}: 期望 ${expected} 实际 ${norm(fe)}`);
    if (beVal !== norm(fe)) failed.push(`漂移  ${expr}: 后端 ${beVal} / 前端 ${norm(fe)}`);
  }
  assert.deepEqual(failed, [], `共 ${CASES.length} 条用例：\n${failed.join('\n')}`);
});

test('前后端错误口径一致：未知函数与未定义变量都判失败', () => {
  for (const expr of ['NOPE(1)', '{{undefinedVar}} + 1']) {
    assert.equal(safeEval(expr, ROW).ok, false, `后端应失败: ${expr}`);
    assert.equal(evalFormula(expr, feCtx(ROW)), null, `前端应失败: ${expr}`);
  }
});

// ------------------------- 计算变量（VariableSpec.expr） -------------------------
type CV = { name: string; expr?: string; defaultValue?: string | number | null };

test('计算变量：前后端按依赖顺序求值一致（含链式依赖）', () => {
  const vars: CV[] = [
    { name: 'amount', expr: '{{price}} * {{qty}}', defaultValue: '0' },
    { name: 'discount', expr: '{{amount}} * 0.9', defaultValue: '0' },
    { name: 'label', expr: 'CONCAT("AMT", PAD({{amount}}, 6))' },
  ];
  const row = { price: 12.5, qty: 12 };
  const be = beComputed(vars, row);
  const fe = feComputed(vars, row, NOW);
  assert.equal(be.cycle.length, 0, '不应有环');
  assert.deepEqual(fe.cycle, be.cycle);
  assert.deepEqual(fe.row, be.row, '前后端计算变量结果必须完全一致');
  assert.equal(be.row.amount, '150');
  assert.equal(be.row.discount, '135');
  assert.equal(be.row.label, 'AMT000150');
});

test('计算变量：循环依赖检测与兜底前后端一致', () => {
  const vars: CV[] = [
    { name: 'cA', expr: '{{cB}} + 1', defaultValue: 'FALLBACK_A' },
    { name: 'cB', expr: '{{cA}} + 1', defaultValue: 'FALLBACK_B' },
  ];
  const be = beComputed(vars, {});
  const fe = feComputed(vars, {}, NOW);
  assert.deepEqual(fe.cycle, be.cycle, '环检测结果必须一致');
  assert.ok(be.cycle.length === 2, '应识别出两个环上变量');
  assert.deepEqual(fe.row, be.row, '兜底值必须一致');
  assert.equal(be.row.cA, 'FALLBACK_A');
  assert.equal(be.row.cB, 'FALLBACK_B');
});

test('计算变量：求值失败用 defaultValue 兜底，前后端一致', () => {
  const vars: CV[] = [{ name: 'bad', expr: '{{noSuchField}} + 1', defaultValue: 'SAFE' }];
  const be = beComputed(vars, {});
  const fe = feComputed(vars, {}, NOW);
  assert.deepEqual(fe.row, be.row);
  assert.equal(be.row.bad, 'SAFE');
});

test('中文变量名：插值、公式与计算变量前后端口径一致', () => {
  const row = { 产品名称: '有机苹果', 单价: 12.5, 数量: 3 };
  assert.equal(evalFormula('{{产品名称}}', feCtx(row)), '有机苹果');
  assert.equal(norm(evalFormula('{{产品名称}} + "x"', feCtx(row))), '有机苹果x');
  const be = safeEval('{{产品名称}} + "x"', row);
  assert.ok(be.ok);
  assert.equal(norm(be.value), '有机苹果x');

  const fe = feComputed([{ name: '金额', expr: '{{单价}} * {{数量}}' }], row, NOW);
  const beCalc = beComputed([{ name: '金额', expr: '{{单价}} * {{数量}}' }], row);
  assert.equal(fe.row.金额, '37.5');
  assert.equal(beCalc.row.金额, '37.5');
});

test('计算变量：环检测函数前后端口径一致（含自环）', () => {
  const graphs: Array<Record<string, string>> = [
    { a: '{{b}}+1', b: '{{a}}+1' },
    { a: '{{a}}+1' },
    { a: '{{b}}', b: '{{c}}', c: '{{b}}' },
    { a: '{{b}}', b: '1' },
  ];
  for (const fields of graphs) {
    assert.deepEqual(detectComputedCycle(fields), detectCircularDeps(fields), `环检测漂移: ${JSON.stringify(fields)}`);
  }
});
