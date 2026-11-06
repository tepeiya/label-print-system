// =============================================================================
// context.ts —— 数据上下文 / 插值 / 日期 / 流水号 / 公式求值
//   从 web/js/render.js 原样搬迁，语义一条不改：
//   公式是白名单递归下降解析器，绝不使用 eval / new Function。
// =============================================================================

import type { ElementData, TemplateData } from '../types';

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
}

export function buildContext(
  template: TemplateData,
  row: Record<string, unknown> = {},
  extra: Partial<Pick<RenderContext, 'pageNo' | 'pageTotal' | 'copies' | 'serialNo' | 'now' | 'uuid' | 'printerName' | 'tenantName' | 'printUser'>> = {},
): RenderContext {
  return {
    row: row || {},
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
  };
}

function varValue(name: string, ctx: RenderContext): unknown {
  if (ctx.row && Object.prototype.hasOwnProperty.call(ctx.row, name)) return ctx.row[name];
  const v = ctx.vars.find((x) => x.name === name);
  return v ? v.defaultValue ?? '' : '';
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
  return String(str ?? '').replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, name: string) => {
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
    .replace(/MM/g, pad(d.getMonth() + 1, 2))
    .replace(/DD/g, pad(d.getDate(), 2))
    .replace(/HH/g, pad(d.getHours(), 2))
    .replace(/mm/g, pad(d.getMinutes(), 2))
    .replace(/ss/g, pad(d.getSeconds(), 2));
}

export function sysvarValue(key: unknown, ctx: RenderContext): string {
  const d = ctx.now || new Date();
  switch (String(key)) {
    case 'printDate': return fmtDateTime('YYYY-MM-DD', d);
    case 'printTime': return fmtDateTime('HH:mm:ss', d);
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

const FN: Record<string, Fn> = {
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
  ROUND: (n, d = 0) => {
    const p = 10 ** (Number(d) || 0);
    return Math.round((Number(n) || 0) * p) / p;
  },
  INT: (n) => Math.floor(Number(n) || 0),
  ABS: (n) => Math.abs(Number(n) || 0),
  NUM: (s) => {
    const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  },
  CONCAT: (...a) => a.map((x) => (x == null ? '' : String(x))).join(''),
  IF: (c, a, b) => (c ? a : b),
  PAD: (n, w) => pad(Number(n) || 0, Number(w) || 0),
};

export const FORMULA_FUNCTIONS = Object.keys(FN);

function evalExpr(src: string, ctx: RenderContext): unknown {
  // 变量替换：{{name}} → 字面量（数字或带引号字符串）
  const text = String(src ?? '').replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, name: string) => {
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
        const fn = FN[upper];
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
    case 'datetime': return fmtDateTime(el.datetime?.pattern, ctx.now);
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
    const m = /^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/.exec(p);
    if (!m) return { text: p, placeholder: false, resolved: p };
    const name = m[1];
    const val = varValue(name, ctx);
    const empty = val === '' || val == null;
    return { text: p, placeholder: true, name, resolved: empty ? p : String(val) };
  });
}
