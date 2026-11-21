// =============================================================================
// rich-text.ts —— 富文本 runs 单一真源（第四层 · 设计器交互精度；与后端 core/rich-text.ts parity）
//
// 数据模型：富文本元素 richtext 的正文是一个 RichTextRun[]，每个 run 携带自己的
//   字重/斜体/下划线/颜色/字号/上下标覆盖；元素级 font 作为默认样式兜底。
// 纯函数、零依赖，render.service / 各渲染器 / 前端 engine 共用同一语义。
//
// 诚实声明：指令通道（ZPL/TSPL/EPL）无富文本概念，统一降级为纯文本（runsToPlainText），
//   只保留内容不保留样式；矢量 PDF 的逐 run 样式用多段 drawText 近似。
//   本文件是 backend/core/rich-text.ts 的 parity 副本，两端由 layer4-parity.test.ts 锁定。
// =============================================================================

/** 单个富文本片段：text 为正文，其余为对元素级 font 的覆盖 */
export interface RichTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  /** 字号覆盖（pt）；未填则用元素 font.size */
  size?: number;
  /** 上下标（HTML: <sub>/<sup>；PDF: 缩小字号并偏移基线；指令通道忽略） */
  script?: 'sub' | 'super';
}

/** 元素级默认字体（与 types.ts#FontSpec 同形状，按需取用） */
export interface RichBaseFont {
  family?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const MAX_RUNS = 200;
const MAX_TEXT = 4000;

/** 归一化 runs：过滤非法项、合并空文本、钳制长度；旧纯文本回退为单 run */
export function normalizeRuns(input: unknown, baseText = ''): RichTextRun[] {
  const clean = (s: unknown) => String(s ?? '').slice(0, MAX_TEXT);
  if (!Array.isArray(input) || input.length === 0) {
    const t = clean(baseText);
    return t ? [{ text: t }] : [];
  }
  const out: RichTextRun[] = [];
  for (const raw of input) {
    if (out.length >= MAX_RUNS) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const text = clean(r.text);
    if (!text) continue;
    const run: RichTextRun = { text };
    if (r.bold === true) run.bold = true;
    if (r.italic === true) run.italic = true;
    if (r.underline === true) run.underline = true;
    if (typeof r.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(r.color)) run.color = r.color;
    if (typeof r.size === 'number' && Number.isFinite(r.size) && r.size > 0 && r.size <= 400) run.size = r.size;
    if (r.script === 'sub' || r.script === 'super') run.script = r.script;
    out.push(run);
  }
  return out;
}

/** 纯文本降级：指令通道 / 搜索 / 无富文本能力渲染器用 */
export function runsToPlainText(runs: RichTextRun[]): string {
  return (runs ?? []).map((r) => String(r.text ?? '')).join('');
}

/** 兼容读取：有 runs 用 runs，否则回退 baseText */
export function runsOf(runs: unknown, baseText = ''): RichTextRun[] {
  return Array.isArray(runs) && runs.length ? normalizeRuns(runs) : normalizeRuns(null, baseText);
}

export interface RenderRunsOptions {
  /** 占位符插值函数（设计态/打印态各异）；默认原样返回 */
  interp?: (s: string) => string;
  /** HTML 转义函数；默认转义 & < > " ' */
  esc?: (s: string) => string;
  /** run 字号相对 base 的缩放（上下标用 0.7），默认 0.7 */
  scriptScale?: number;
}

const defaultEsc = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 渲染 runs 为 HTML <span> 片段串（不含外层容器）。
 * run 覆盖优先于 base font；script 用 <sub>/<sup> 包裹并缩小字号。
 */
export function renderRunsHtml(runs: RichTextRun[], base: RichBaseFont = {}, opts: RenderRunsOptions = {}): string {
  const esc = opts.esc ?? defaultEsc;
  const interp = opts.interp ?? ((s: string) => s);
  const scale = opts.scriptScale ?? 0.7;
  return (runs ?? []).map((r) => {
    const css: string[] = [];
    const bold = r.bold ?? base.bold;
    const italic = r.italic ?? base.italic;
    const underline = r.underline ?? base.underline;
    if (bold) css.push('font-weight:bold');
    if (italic) css.push('font-style:italic');
    if (underline) css.push('text-decoration:underline');
    const color = r.color ?? base.color;
    if (color) css.push(`color:${color}`);
    const size = r.size ?? base.size;
    if (r.script && size) css.push(`font-size:${+(size * scale).toFixed(2)}pt`);
    else if (r.size && r.size !== base.size) css.push(`font-size:${r.size}pt`);
    const txt = esc(interp(String(r.text ?? '')));
    const style = css.length ? ` style="${css.join(';')}"` : '';
    if (r.script === 'sub') return `<sub${style}>${txt}</sub>`;
    if (r.script === 'super') return `<sup${style}>${txt}</sup>`;
    return css.length ? `<span${style}>${txt}</span>` : txt;
  }).join('');
}

/** 校验：返回问题数组（空=合法），供编辑器与 AI 模板校验共用 */
export function validateRuns(runs: unknown): string[] {
  const errs: string[] = [];
  if (runs == null) return errs;
  if (!Array.isArray(runs)) return ['runs 必须是数组'];
  if (runs.length > MAX_RUNS) errs.push(`runs 数量超过 ${MAX_RUNS}`);
  runs.forEach((r, i) => {
    if (!r || typeof r !== 'object') { errs.push(`runs[${i}] 不是对象`); return; }
    const rr = r as Record<string, unknown>;
    if (typeof rr.text !== 'string') errs.push(`runs[${i}].text 必须是字符串`);
    if (rr.color != null && (typeof rr.color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(rr.color))) errs.push(`runs[${i}].color 非法`);
    if (rr.script != null && rr.script !== 'sub' && rr.script !== 'super') errs.push(`runs[${i}].script 只能是 sub/super`);
  });
  return errs;
}
