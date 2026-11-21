// =============================================================================
// context.ts —— 数据上下文 / 插值 / 日期 / 流水号 / 公式求值
//   从 web/js/render.js 原样搬迁，语义一条不改：
//   公式是白名单递归下降解析器，绝不使用 eval / new Function。
// =============================================================================

import type { ElementData, TemplateData } from '../types';
import { checksum } from './checksum';
import { parseTable, lookup, vlookup } from './lookup-table';

export interface RenderContext {
  row: Record<string, unknown>;
  vars: Array<{ name: string; defaultValue?: string | number | null }>;
  pageNo: number;
  pageTotal: number;
  copies: number;
  serialNo: number;
  now: Date;
  serialOffset?: number;
  printerName?: string;
  tenantName?: string;
  printUser?: string;
  uuid?: string;
  /** 主流水号元素配置，供 @serial 占位引用（使其与 serial 元素显示一致） */
  _serialSpec?: { prefix?: string; suffix?: string; digits?: number } | undefined;
}

export function buildContext(
  template: TemplateData,
  row: Record<string, unknown> = {},
  extra: Partial<Pick<RenderContext, 'pageNo' | 'pageTotal' | 'copies' | 'serialNo' | 'now' | 'uuid' | 'printerName' | 'tenantName' | 'printUser' | '_serialSpec'>> = {},
): RenderContext {
  const now = extra.now ?? new Date();
  // 计算变量在本行数据之上按依赖顺序求值，结果并入 row，
  // 使 {{amount}} 这类引用走 varValue 的 row 优先分支（普通变量/系统占位符语义不变）
  const { row: resolvedRow } = resolveComputedVars(template.variables, row || {}, now);
  return {
    row: resolvedRow,
    vars: template.variables ?? [],
    pageNo: extra.pageNo ?? 1,
    pageTotal: extra.pageTotal ?? 1,
    copies: extra.copies ?? 1,
    serialNo: extra.serialNo ?? 1,
    now: extra.now ?? new Date(),
    printerName: extra.printerName,
    tenantName: extra.tenantName,
    printUser: extra.printUser,
    uuid: extra.uuid,
    _serialSpec: extra._serialSpec,
  };
}

// ---------------------------------------------------------------------------
// 计算变量：VariableSpec.expr 有值时，按依赖顺序求值后并入 row，
// 让 {{amount}} 走 row 优先分支。环检测与值归一化口径与后端 computed-vars.ts 一致。
// ---------------------------------------------------------------------------

export interface ComputedVarsResult {
  row: Record<string, unknown>;
  cycle: string[];
}

function computedDeps(expr: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(expr ?? '')))) out.add(m[1].trim());
  return [...out];
}

/** 三色 DFS 环检测，算法与后端 formula-engine.ts#detectCircularDeps 相同 */
export function detectComputedCycle(fields: Record<string, string>): string[] {
  const graph: Record<string, string[]> = {};
  for (const [name, expr] of Object.entries(fields)) graph[name] = computedDeps(expr);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let cycle: string[] = [];
  const dfs = (n: string): boolean => {
    color[n] = GRAY; stack.push(n);
    for (const dep of graph[n] || []) {
      if (color[dep] === GRAY) { cycle = stack.slice(stack.indexOf(dep)); return true; }
      if ((color[dep] ?? WHITE) === WHITE && dfs(dep)) return true;
    }
    color[n] = BLACK; stack.pop();
    return false;
  };
  for (const n of Object.keys(graph)) color[n] = WHITE;
  for (const n of Object.keys(graph)) {
    if (color[n] === WHITE && dfs(n)) break;
  }
  return cycle;
}

/**
 * 求值所有计算变量：返回并入结果的新 row，不修改入参。
 * 依赖其他计算变量时按拓扑序求值；环上的变量用 defaultValue 兜底。
 */
export function resolveComputedVars(
  variables: Array<{ name: string; expr?: string; defaultValue?: string | number | null }> | undefined,
  row: Record<string, unknown>,
  now: Date,
): ComputedVarsResult {
  const fields: Record<string, string> = {};
  for (const v of variables ?? []) {
    if (v.expr && String(v.expr).trim()) fields[v.name] = String(v.expr);
  }
  const names = Object.keys(fields);
  if (!names.length) return { row, cycle: [] };

  const cycle = detectComputedCycle(fields);
  const working: Record<string, unknown> = { ...row };
  const resolved = new Set<string>();

  // 拓扑序：每轮取「依赖的计算变量都已解析」的项；剩余为环或缺失依赖
  let pending = new Set(names);
  while (pending.size) {
    let progressed = false;
    for (const name of [...pending]) {
      const deps = computedDeps(fields[name]).filter((d) => names.includes(d) && d !== name);
      if (deps.some((d) => pending.has(d))) continue;
      const value = evalFormula(fields[name], {
        row: working, vars: variables ?? [], pageNo: 1, pageTotal: 1,
        copies: 1, serialNo: 1, now,
      });
      working[name] = value ?? (variables ?? []).find((v) => v.name === name)?.defaultValue ?? '';
      pending.delete(name);
      resolved.add(name);
      progressed = true;
    }
    if (!progressed) break;
  }
  // 环上/无法解析的变量：用示例值兜底，保证不阻断整单
  for (const name of pending) {
    working[name] = (variables ?? []).find((v) => v.name === name)?.defaultValue ?? '';
  }
  return { row: working, cycle };
}

function varValue(name: string, ctx: RenderContext): unknown {
  // @系统占位符：在 {{}} 中以 @ 开头引用打印期上下文（日期/流水号/页码/UUID…）
  //   支持格式参数：{{@printDate:YYYYMMDD}} 会把冒号后的串作为日期格式（与后端同口径）
  if (name.startsWith('@')) {
    const body = name.slice(1);
    const ci = body.indexOf(':');
    const key = ci < 0 ? body : body.slice(0, ci);
    const rest = ci < 0 ? '' : body.slice(ci + 1).trim();
    // 格式与偏移用 | 分隔：{{@printDate:YYYYMMDD|+3d}}
    const pi = rest.indexOf('|');
    const pattern = pi < 0 ? rest : rest.slice(0, pi).trim();
    const offset = pi < 0 ? '' : rest.slice(pi + 1).trim();
    return systemPlaceholder(key, pattern, offset, ctx);
  }
  if (ctx.row && Object.prototype.hasOwnProperty.call(ctx.row, name)) return ctx.row[name];
  const v = ctx.vars.find((x) => x.name === name);
  return v ? v.defaultValue ?? '' : '';
}

/** 系统占位符 @xxx 的取值（与后端 render.service#systemPlaceholder 同口径） */
function systemPlaceholder(key: string, pattern: string, offset: string, ctx: RenderContext): unknown {
  switch (key) {
    case 'serial': return serialValue(ctx._serialSpec, ctx);
    case 'printDate':
    case 'printTime':
    case 'pageNo':
    case 'pageTotal':
    case 'uuid':
    case 'printerName':
    case 'tenantName':
    case 'printUser':
      return sysvarValue(key, ctx, pattern, offset);
    default: return '';
  }
}

/**
 * 设计态预览用的示例行：变量 → 示例值（app.js#selectSampleRow 的语义）。
 * 数据表格里有真实行时由调用方传第一行覆盖，这里只负责「没有数据也能预览」。
 */
export function sampleRowOf(template: TemplateData): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const v of template.variables ?? []) row[v.name] = v.defaultValue ?? '';
  return row;
}

/** 文本插值：{{var}} → 值 */
export function interpolate(str: unknown, ctx: RenderContext): string {
  return String(str ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name: string) => {
    const v = varValue(name, ctx);
    return v == null ? '' : String(v);
  });
}

export function hasPlaceholder(str: unknown): boolean {
  return /\{\{[^}]+\}\}/.test(String(str ?? ''));
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

export function fmtDateTime(pattern: unknown, date?: Date): string {
  const d = date || new Date();
  return String(pattern ?? '')
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, String(d.getFullYear()).slice(2))
    .replace(/MM/g, pad(d.getMonth() + 1, 2))
    .replace(/DD/g, pad(d.getDate(), 2))
    .replace(/HH/g, pad(d.getHours(), 2))
    .replace(/mm/g, pad(d.getMinutes(), 2))
    .replace(/ss/g, pad(d.getSeconds(), 2));
}

/**
 * 日期偏移（前后端同口径）：解析 [+-]n[unit] 串，unit ∈ y/M/w/d/h/m（月大写、分小写），
 * 可累加如 '+1M3d'；纯数字按天。月/年偏移做月末钳制：1/31 + 1M → 2/28。
 * 例：+3d / -7d / +1M / +1y / -2h / +30m / +1M15d
 */
export function shiftDate(base: Date, spec: string): Date {
  const s = String(spec ?? '').trim();
  if (!s) return base;
  const d = new Date(base.getTime());
  const re = /([+-]?)(\d+)([yMwdhm]?)/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(s))) {
    matched = true;
    const sign = m[1] === '-' ? -1 : 1;
    const n = sign * (parseInt(m[2], 10) || 0);
    const unit = m[3] || 'd';
    switch (unit) {
      case 'y': {
        const day = d.getDate();
        d.setDate(1);
        d.setFullYear(d.getFullYear() + n);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        break;
      }
      case 'M': {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + n);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        break;
      }
      case 'w': d.setDate(d.getDate() + n * 7); break;
      case 'd': d.setDate(d.getDate() + n); break;
      case 'h': d.setHours(d.getHours() + n); break;
      case 'm': d.setMinutes(d.getMinutes() + n); break;
    }
  }
  // 全串无合法片段（如 'abc'）时按原样返回，避免误伤
  return matched ? d : base;
}

export function sysvarValue(key: unknown, ctx: RenderContext, pattern = '', offset = ''): string {
  const d = shiftDate(ctx.now || new Date(), offset);
  switch (String(key)) {
    case 'printDate': return fmtDateTime(pattern || 'YYYY-MM-DD', d);
    case 'printTime': return fmtDateTime(pattern || 'HH:mm:ss', d);
    case 'pageNo': return String(ctx.pageNo ?? 1);
    case 'pageTotal': return String(ctx.pageTotal ?? 1);
    case 'printerName': return ctx.printerName ?? '未指定';
    case 'tenantName': return ctx.tenantName ?? '默认租户';
    case 'printUser': return ctx.printUser ?? 'admin';
    case 'uuid': return ctx.uuid ?? '—';
    default: return String(key);
  }
}

export function serialValue(spec: { prefix?: string; suffix?: string; digits?: number } | undefined, ctx: RenderContext): string {
  const n = (ctx.serialNo ?? 1) + (ctx.serialOffset ?? 0);
  return `${spec?.prefix ?? ''}${pad(n, spec?.digits ?? 5)}${spec?.suffix ?? ''}`;
}

// ---------------------------------------------------------------------------
// 公式求值（白名单递归下降解析，不使用 eval）
// ---------------------------------------------------------------------------
class FormulaError extends Error {}

type Token = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'ident'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') { out += src[j + 1]; j += 2; continue; }
        out += src[j];
        j++;
      }
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%()<>,!='.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new FormulaError(`不支持字符: ${c}`);
  }
  return tokens;
}

type Fn = (...args: any[]) => any;

// 与后端 backend/core/formula-engine.ts#truthy 同口径
function truthyFormula(v: unknown): boolean {
  return v !== false && v != null && v !== '' && v !== 0;
}

// 与后端 FORMAT / DATEFORMAT / DATEDIFF 同口径（预览所见即打印所得）
function formatNum(v: unknown, fmt: string): string {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (/^0*\.\d+$/.test(fmt)) return n.toFixed(fmt.split('.')[1].length);
  if (/^0+$/.test(fmt)) return n.toFixed(0).padStart(fmt.length, '0');
  return String(n);
}

function formatDateStr(d: Date, fmt: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = toDate(d);
  return String(fmt ?? '')
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', p(date.getMonth() + 1))
    .replace('DD', p(date.getDate()))
    .replace('HH', p(date.getHours()))
    .replace('mm', p(date.getMinutes()))
    .replace('ss', p(date.getSeconds()));
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v ?? ''));
}

function diffDate(a: unknown, b: unknown, unit: unknown): number {
  const ms = toDate(a).getTime() - toDate(b).getTime();
  if (unit === 'hour') return ms / 3_600_000;
  if (unit === 'minute') return ms / 60_000;
  return ms / 86_400_000;
}

/**
 * 函数表（白名单）——必须与 backend/core/formula-engine.ts#FUNCS 完全一致。
 * 依赖 ctx 的函数（NOW/TODAY）用工厂注入；设计态用 ctx.now 保证预览可复现，
 * 打印态后端用真实当前时间。两端函数名单与语义由 formula-parity 测试锁定。
 */
function makeFns(ctx: RenderContext): Record<string, Fn> {
  return {
    // 文本
    LEN: (s) => String(s ?? '').length,
    UPPER: (s) => String(s ?? '').toUpperCase(),
    LOWER: (s) => String(s ?? '').toLowerCase(),
    TRIM: (s) => String(s ?? '').trim(),
    LEFT: (s, n) => String(s ?? '').slice(0, Number(n) || 0),
    RIGHT: (s, n) => {
      const k = Number(n) || 0;
      return k <= 0 ? '' : String(s ?? '').slice(-k);
    },
    MID: (s, start, len) => String(s ?? '').substr((Number(start) || 1) - 1, Number(len) || 0),
    REPLACE: (s, a, b) => String(s ?? '').split(String(a ?? '')).join(String(b ?? '')),
    CONCAT: (...a) => a.map((x) => (x == null ? '' : String(x))).join(''),
    // 数值
    ROUND: (n, d = 0) => {
      const p = 10 ** (Number(d) || 0);
      return Math.round((Number(n) || 0) * p) / p;
    },
    FLOOR: (n) => Math.floor(Number(n) || 0),
    CEIL: (n) => Math.ceil(Number(n) || 0),
    ABS: (n) => Math.abs(Number(n) || 0),
    INT: (n) => Math.trunc(Number(n) || 0),
    NUM: (s) => {
      const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    },
    FORMAT: (v, fmt) => formatNum(v, String(fmt ?? '')),
    PAD: (n, w) => pad(Number(n) || 0, Number(w) || 0),
    PADLEFT: (s, n, ch = ' ') => String(s ?? '').padStart(Number(n) || 0, String(ch ?? ' ')),
    PADRIGHT: (s, n, ch = ' ') => String(s ?? '').padEnd(Number(n) || 0, String(ch ?? ' ')),
    // 逻辑
    IF: (c, a, b) => (truthyFormula(c) ? a : b),
    AND: (...a) => a.every(truthyFormula),
    OR: (...a) => a.some(truthyFormula),
    NOT: (c) => !truthyFormula(c),
    ISEMPTY: (v) => v === undefined || v === null || String(v).length === 0,
    // 日期
    NOW: () => ctx.now || new Date(),
    TODAY: () => {
      const d = new Date((ctx.now || new Date()).getTime());
      d.setHours(0, 0, 0, 0);
      return d;
    },
    DATE: (y, m, d) => new Date(Number(y), Number(m) - 1, Number(d)),
    DATEDIFF: (a, b, unit) => diffDate(a, b, unit),
    DATEFORMAT: (d, fmt) => formatDateStr(d, String(fmt ?? '')),
    // 条码校验位
    CHECKSUM: (scheme, data) => checksum(String(scheme ?? ''), String(data ?? '')),
    // 查表（第五层 · 变价表/物料映射）：与后端 formula-engine.ts#FUNCS 同语义
    LOOKUP: (key, table, fallback) => lookup(parseTable(table), key ?? '', fallback ?? ''),
    VLOOKUP: (key, table, col, fallback) => vlookup(parseTable(table), key ?? '', col, fallback ?? ''),
  };
}

export const FORMULA_FUNCTIONS = Object.keys(makeFns({} as RenderContext));

/** 公式内的 {{var}} 必须真实存在；系统占位符 @xxx 由 systemPlaceholder 兜底 */
function hasVar(name: string, ctx: RenderContext): boolean {
  if (name.startsWith('@')) return true;
  if (ctx.row && Object.prototype.hasOwnProperty.call(ctx.row, name)) return true;
  return ctx.vars.some((x) => x.name === name);
}

function evalExpr(src: string, ctx: RenderContext): unknown {
  const fns = makeFns(ctx);
  // 变量替换：{{name}} → 字面量（数字或带引号字符串）
  const text = String(src ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name: string) => {
    if (!hasVar(name, ctx)) throw new FormulaError(`未定义变量: ${name}`);
    const v = varValue(name, ctx);
    if (typeof v === 'number' && Number.isFinite(v)) return `(${v})`;
    const s = v == null ? '' : String(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });

  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v: string) => {
    const t = toks[p];
    if (!t || t.v !== v) throw new FormulaError(`缺少 ${v}`);
    p++;
  };

  function truthy(v: unknown): boolean {
    if (typeof v === 'string') return v.length > 0;
    return !!v;
  }

  function primary(): unknown {
    const t = next();
    if (!t) throw new FormulaError('表达式不完整');
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = expr();
      expect(')');
      return v;
    }
    if (t.t === 'op' && t.v === '-') return -Number(primary());
    if (t.t === 'op' && t.v === '+') return Number(primary());
    if (t.t === 'op' && t.v === '!') return !truthy(primary());
    if (t.t === 'ident') {
      const upper = t.v.toUpperCase();
      if (peek() && peek().v === '(') {
        p++;
        const args: unknown[] = [];
        if (peek() && peek().v !== ')') {
          args.push(expr());
          while (peek() && peek().v === ',') {
            p++;
            args.push(expr());
          }
        }
        expect(')');
        const fn = fns[upper];
        if (!fn) throw new FormulaError(`未知函数: ${t.v}`);
        return fn(...args);
      }
      if (upper === 'TRUE') return true;
      if (upper === 'FALSE') return false;
      throw new FormulaError(`未知标识: ${t.v}`);
    }
    throw new FormulaError(`语法错误: ${String(t.v)}`);
  }

  function unary() { return primary(); }

  function mul(): unknown {
    let v = unary();
    while (peek() && peek().t === 'op' && ['*', '/', '%'].includes(String(peek().v))) {
      const op = (next() as { v: string }).v;
      const rhs = Number(unary());
      if (op === '*') v = Number(v) * rhs;
      else if (op === '/') v = rhs === 0 ? 0 : Number(v) / rhs;
      else v = rhs === 0 ? 0 : Number(v) % rhs;
    }
    return v;
  }

  function add(): unknown {
    let v = mul();
    while (peek() && peek().t === 'op' && ['+', '-'].includes(String(peek().v))) {
      const op = (next() as { v: string }).v;
      const rhs = mul();
      // '+' 在原生 JS 里既做数值加也做字符串接，这里显式还原同一口径
      v = op === '+'
        ? (typeof v === 'number' && typeof rhs === 'number' ? v + rhs : `${String(v)}${String(rhs)}`)
        : Number(v) - Number(rhs);
    }
    return v;
  }

  function cmp(): unknown {
    let v = add();
    while (peek() && peek().t === 'op' && ['>', '<', '>=', '<=', '==', '!=', '='].includes(String(peek().v))) {
      const op = (next() as { v: string }).v;
      const rhs = add();
      switch (op) {
        case '>': v = Number(v) > Number(rhs); break;
        case '<': v = Number(v) < Number(rhs); break;
        case '>=': v = Number(v) >= Number(rhs); break;
        case '<=': v = Number(v) <= Number(rhs); break;
        case '!=': v = v !== rhs; break;
        default: v = v == rhs; // 松比较是刻意的：'5' 与 5 在原生表达式里相等
      }
    }
    return v;
  }

  function and(): unknown {
    let v = cmp();
    while (peek() && peek().t === 'op' && peek().v === '&&') {
      next();
      const rhs = cmp();
      v = truthy(v) && truthy(rhs);
    }
    return v;
  }

  function or(): unknown {
    let v = and();
    while (peek() && peek().t === 'op' && peek().v === '||') {
      next();
      const rhs = and();
      v = truthy(v) || truthy(rhs);
    }
    return v;
  }

  function expr(): unknown { return or(); }

  const out = expr();
  if (p < toks.length) throw new FormulaError('表达式存在多余内容');
  return out;
}

/** 求值；失败返回 null（调用方按 defaultOnError 兜底） */
export function evalFormula(expr: unknown, ctx: RenderContext): string | null {
  try {
    const v = evalExpr(String(expr ?? ''), ctx);
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number((v as number).toFixed(3)));
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 元素显示文本
// ---------------------------------------------------------------------------
export function elementText(el: ElementData, ctx: RenderContext): string {
  switch (el.type) {
    case 'text': return interpolate(el.text, ctx);
    case 'formula': {
      const v = evalFormula(el.formula?.expr ?? '', ctx);
      return v == null ? (el.formula?.defaultOnError || '#公式错误') : v;
    }
    case 'serial': return serialValue(el.serial ?? {}, ctx);
    case 'datetime': return fmtDateTime(el.datetime?.pattern, shiftDate(ctx.now, el.datetime?.offset ?? ''));
    case 'sysvar': return sysvarValue(el.sysvar?.key, ctx);
    default: return '';
  }
}

/** 把 {{占位}} 拆成片段，供画布高亮（原生版用 span.ph，Vue 版用它渲染高亮节点） */
export interface PlaceholderPart {
  text: string;
  placeholder: boolean;
  /** 占位片段解析出的变量名 */
  name?: string;
  /** 变量当前值，空值时回落到原始占位文本 */
  resolved: string;
}

export function splitPlaceholders(raw: unknown, ctx: RenderContext): PlaceholderPart[] {
  const parts = String(raw ?? '').split(/(\{\{[^}]+\}\})/g);
  return parts.filter((p) => p !== '').map((p) => {
    const m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(p);
    if (!m) return { text: p, placeholder: false, resolved: p };
    const name = m[1];
    const val = varValue(name, ctx);
    const empty = val === '' || val == null;
    return { text: p, placeholder: true, name, resolved: empty ? p : String(val) };
  });
}
