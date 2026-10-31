// =============================================================================
// formula-engine.ts —— 公式引擎（自研递归下降 + 运算符优先级 Pratt 解析）
// 关键约束：
//   * 严禁 eval / Function / vm.runInContext —— 全部通过词法→语法→AST→求值，零注入。
//   * 变量引用采用 {{name}} 占位，解析时抽取依赖，便于循环依赖检测。
//   * 函数表注册式扩展（LEN/IF/CONCAT/CHECKSUM…），白名单之外一律拒绝。
//   * 求值出错时返回错误占位（不抛断整单），由调用方记录日志。
// =============================================================================

import { checksum } from './checksum';

// ----------------------------- 词法分析 -----------------------------
type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }     // 函数名
  | { t: 'var'; v: string }       // {{name}}
  | { t: 'op'; v: string }        // + - * / % ( ) , < > = ! & |
  | { t: 'eof'; v?: undefined };

const OPS = new Set(['+', '-', '*', '/', '%', '(', ')', ',', '<', '>', '=', '!', '&', '|']);

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    // 变量占位 {{name}}
    if (c === '{' && src[i + 1] === '{') {
      const end = src.indexOf('}}', i + 2);
      if (end === -1) throw new Error('变量占位符未闭合: ' + src.slice(i));
      toks.push({ t: 'var', v: src.slice(i + 2, end).trim() });
      i = end + 2; continue;
    }
    // 字符串字面量 "..." 或 '...'
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end === -1) throw new Error('字符串未闭合');
      toks.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1; continue;
    }
    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    // 标识符（函数名，仅字母开头）
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'ident', v: src.slice(i, j) });
      i = j; continue;
    }
    // 运算符（支持 && || <= >= == !=）
    if (OPS.has(c)) {
      let op = c;
      if ((c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) { op += src[i + 1]; i++; }
      else if ((c === '<' || c === '>' || c === '=') && src[i + 1] === '=') { op += '='; i++; }
      else if (c === '!' && src[i + 1] === '=') { op += '='; i++; }
      toks.push({ t: 'op', v: op });
      i++; continue;
    }
    throw new Error(`无法识别字符: '${c}'`);
  }
  toks.push({ t: 'eof' });
  return toks;
}

// ----------------------------- 语法分析（Pratt） -----------------------------
// AST 节点
type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'var'; v: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'unary'; op: string; r: Node }
  | { k: 'binary'; op: string; l: Node; r: Node };

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek() { return this.toks[this.p]; }
  private next() { return this.toks[this.p++]; }

  parse(): Node { const n = this.expr(0); if (this.peek().t !== 'eof') throw new Error('多余字符'); return n; }

  private expr(minPrec: number): Node {
    let left = this.unary();
    while (true) {
      const tk = this.peek();
      if (tk.t !== 'op' || !(tk.v in BIN_PREC)) break;
      const prec = BIN_PREC[tk.v as string];
      if (prec < minPrec) break;
      this.next();
      // 右结合仅逻辑/比较可，这里统一左结合（足够）
      const right = this.expr(prec + 1);
      left = { k: 'binary', op: tk.v as string, l: left, r: right };
    }
    return left;
  }

  private unary(): Node {
    const tk = this.peek();
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '!')) {
      this.next();
      return { k: 'unary', op: tk.v, r: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const tk = this.next();
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'var') return { k: 'var', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') {
      const e = this.expr(0);
      if (this.next().v !== ')') throw new Error('缺少 )');
      return e;
    }
    if (tk.t === 'ident') {
      if (this.peek().t === 'op' && this.peek().v === '(') {
        this.next();
        const args: Node[] = [];
        if (!(this.peek().t === 'op' && this.peek().v === ')')) {
          args.push(this.expr(0));
          while (this.peek().t === 'op' && this.peek().v === ',') { this.next(); args.push(this.expr(0)); }
        }
        if (this.next().v !== ')') throw new Error('函数缺少 )');
        return { k: 'call', name: tk.v, args };
      }
      throw new Error(`未知标识符: ${tk.v}`);
    }
    throw new Error('语法错误');
  }
}

// ----------------------------- 函数表（白名单） -----------------------------
const FUNCS: Record<string, (...a: any[]) => any> = {
  LEN: (s: string) => String(s ?? '').length,
  LEFT: (s: string, n: number) => String(s ?? '').slice(0, n),
  RIGHT: (s: string, n: number) => String(s ?? '').slice(-n),
  MID: (s: string, a: number, b: number) => String(s ?? '').substring(a, a + b),
  UPPER: (s: string) => String(s ?? '').toUpperCase(),
  LOWER: (s: string) => String(s ?? '').toLowerCase(),
  TRIM: (s: string) => String(s ?? '').trim(),
  REPLACE: (s: string, a: string, b: string) => String(s ?? '').split(a).join(b),
  CONCAT: (...a: any[]) => a.map(String).join(''),
  FORMAT: (v: any, fmt: string) => formatNumber(v, fmt),
  ROUND: (v: number, d = 0) => { const p = 10 ** d; return Math.round(v * p) / p; },
  FLOOR: (v: number) => Math.floor(v),
  CEIL: (v: number) => Math.ceil(v),
  ABS: (v: number) => Math.abs(v),
  INT: (v: number) => Math.trunc(v),
  NOW: () => new Date(),
  TODAY: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; },
  DATE: (y: number, m: number, d: number) => new Date(y, m - 1, d),
  DATEDIFF: (a: Date, b: Date, unit = 'day') => diffDate(a, b, unit),
  DATEFORMAT: (d: Date, fmt: string) => formatDate(d, fmt),
  IF: (c: any, t: any, f: any) => (truthy(c) ? t : f),
  AND: (...a: any[]) => a.every(truthy),
  OR: (...a: any[]) => a.some(truthy),
  NOT: (c: any) => !truthy(c),
  ISEMPTY: (v: any) => v === undefined || v === null || String(v).length === 0,
  PADLEFT: (s: string, n: number, ch = ' ') => String(s ?? '').padStart(n, ch),
  PADRIGHT: (s: string, n: number, ch = ' ') => String(s ?? '').padEnd(n, ch),
  // 条码校验位（接 checksum.ts）
  CHECKSUM: (scheme: string, data: string) => checksum(String(scheme), String(data)),
};
function truthy(v: any) { return v !== false && v != null && v !== '' && v !== 0; }

// ----------------------------- 求值 -----------------------------
const CtxEmpty = Symbol('empty');
export class EvalError extends Error {}

export function evaluate(node: Node, ctx: Record<string, any>): any {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'var': {
      if (!(node.v in ctx)) throw new EvalError(`未定义变量: ${node.v}`);
      return ctx[node.v];
    }
    case 'unary':
      return node.op === '-' ? -evaluate(node.r, ctx) : !truthy(evaluate(node.r, ctx));
    case 'binary': {
      const l = evaluate(node.l, ctx);
      // 短路
      if (node.op === '&&') return truthy(l) && truthy(evaluate(node.r, ctx));
      if (node.op === '||') return truthy(l) || truthy(evaluate(node.r, ctx));
      const r = evaluate(node.r, ctx);
      switch (node.op) {
        case '+': return (typeof l === 'number' && typeof r === 'number') ? l + r : String(l) + String(r);
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? NaN : l / r;
        case '%': return l % r;
        case '==': return l === r;
        case '!=': return l !== r;
        case '<': return l < r;
        case '>': return l > r;
        case '<=': return l <= r;
        case '>=': return l >= r;
        default: throw new EvalError('未知运算符 ' + node.op);
      }
    }
    case 'call': {
      const fn = FUNCS[node.name.toUpperCase()];
      if (!fn) throw new EvalError(`未知函数: ${node.name}`);
      const args = node.args.map((a) => {
        try { return evaluate(a, ctx); } catch (e) { return CtxEmpty; } // 参数缺失标记
      });
      return fn(...args);
    }
  }
}

// ----------------------------- 依赖抽取 & 循环检测 -----------------------------
/** 从表达式中抽取 {{name}} 依赖（静态扫描，无需完整求值） */
export function extractVars(expr: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.add(m[1].trim());
  return [...out];
}

/**
 * 循环依赖检测：fields 为 { 字段名: 表达式 }。
 * 构图后 DFS 三色标记，发现回边即存在环。返回参与的字段名数组（无环返回 []）。
 */
export function detectCircularDeps(fields: Record<string, string>): string[] {
  const graph: Record<string, string[]> = {};
  for (const [name, expr] of Object.entries(fields)) graph[name] = extractVars(expr);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  let cycle: string[] = [];

  const dfs = (n: string): boolean => {
    color[n] = GRAY; stack.push(n);
    for (const dep of graph[n] || []) {
      if (color[dep] === GRAY) { cycle = stack.slice(stack.indexOf(dep)); return true; }
      if (color[dep] === WHITE && dfs(dep)) return true;
    }
    color[n] = BLACK; stack.pop();
    return false;
  };
  for (const n of Object.keys(graph)) { color[n] = WHITE; }
  for (const n of Object.keys(graph)) {
    if (color[n] === WHITE && dfs(n)) break;
  }
  return cycle;
}

// ----------------------------- 公共入口 -----------------------------
export interface EvalResult { ok: boolean; value?: any; error?: string; }

/**
 * 安全求值单个表达式。出错不抛，返回 {ok:false,error}，供调用方占位+记日志。
 */
export function safeEval(expr: string, ctx: Record<string, any>): EvalResult {
  try {
    const ast = new Parser(tokenize(expr)).parse();
    const value = evaluate(ast, ctx);
    // 除零/溢出会得到 NaN/Infinity，视为错误（元素显示占位而非脏数据）
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new EvalError('计算结果非法（除零或溢出）');
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ----------------------------- 格式化辅助 -----------------------------
function formatNumber(v: any, fmt: string): string {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (/^0*\.\d+$/.test(fmt)) { const d = fmt.split('.')[1].length; return n.toFixed(d); }
  if (/^0+$/.test(fmt)) { const len = fmt.length; return n.toFixed(0).padStart(len, '0'); }
  return String(n);
}
function formatDate(d: Date, fmt: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', p(d.getMonth() + 1))
    .replace('DD', p(d.getDate()))
    .replace('HH', p(d.getHours()))
    .replace('mm', p(d.getMinutes()))
    .replace('ss', p(d.getSeconds()));
}
function diffDate(a: Date, b: Date, unit: string): number {
  const ms = a.getTime() - b.getTime();
  const day = 86_400_000;
  if (unit === 'hour') return ms / 3_600_000;
  if (unit === 'minute') return ms / 60_000;
  return ms / day;
}
