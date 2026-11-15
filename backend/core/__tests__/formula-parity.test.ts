// =============================================================================
// formula-parity.test.ts —— 前后端公式引擎一致性测试
//   背景：设计态用 apps/console/.../engine/context.ts 预览，打印态用本目录引擎求值。
//   二者一旦函数表或语义漂移，就会出现「预览对、打印错」。本测试用同一批表达式
//   同时跑两端并要求输出一致，任何一侧改动都必须先过这里。
//   运行：node --import tsx --test backend/core/__tests__/formula-parity.test.ts
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeEval, FORMULA_FUNCTIONS as BE_FUNCS } from '../formula-engine';
import {
  evalFormula,
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
