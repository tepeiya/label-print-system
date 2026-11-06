// =============================================================================
// Prompt 库可测逻辑（P6.5）：模板校验 / 占位符渲染 / 系统默认与租户覆盖的合并
//
// 纯函数，不 import TypeORM（单测跑 node --test + tsx，见 docs/10 §10.15.6）。
//
// 口径：
//   · 系统提示词（SYSTEM_PROMPTS）的权威副本在代码里，租户**不改系统行**，只新增「同名的租户行」覆盖；
//     删除租户行即回落到系统默认——这样既有开箱即用，又不会因为租户改坏而没有兜底。
//   · 正文用 `{{arg}}` 占位符，占位符必须出现在 arguments 里（拼错名字直接 400，不做静默保留）。
//   · 只做文本替换，不做条件分支/表达式：提示词一旦能执行逻辑，就会变成第二个模板引擎。
// =============================================================================

export const PROMPT_NAME_RE = /^[a-z][a-z0-9_.-]{2,63}$/;
export const ARG_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/;
export const MAX_CONTENT = 20_000;
export const MAX_ARGS = 12;

export interface PromptArg {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface PromptInput {
  title: string;
  description?: string;
  content: string;
  arguments?: PromptArg[];
  enabled?: boolean;
  sortOrder?: number;
}

/** 系统默认或租户行（合并前的形状） */
export interface PromptSourceDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArg[];
  content: string;
  enabled?: boolean;
  sortOrder?: number;
  updatedAt?: any;
}

export interface MergedPrompt extends PromptSourceDef {
  enabled: boolean;
  sortOrder: number;
  /** system = 代码内置；custom = 租户自己的行（含覆盖系统同名） */
  source: 'system' | 'custom';
  /** 是否覆盖了同名系统提示词 */
  overridden: boolean;
}

const str = (v: any, max: number) => String(v ?? '').trim().slice(0, max);

/** 归一化 arguments：丢掉未知字段、重复名保留第一条；坏名字单独报错 */
export function normalizeArguments(raw: any): { args: PromptArg[]; errors: string[] } {
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { args: [], errors };
  if (!Array.isArray(raw)) return { args: [], errors: ['arguments 必须是数组'] };
  if (raw.length > MAX_ARGS) errors.push(`参数最多 ${MAX_ARGS} 个（当前 ${raw.length}）`);
  const seen = new Set<string>();
  const args: PromptArg[] = [];
  for (const [i, item] of raw.slice(0, MAX_ARGS).entries()) {
    const name = str(item?.name, 32);
    if (!ARG_NAME_RE.test(name)) { errors.push(`第 ${i + 1} 个参数名不合法：${name || '(空)'}`); continue; }
    if (seen.has(name)) { errors.push(`参数名重复：${name}`); continue; }
    seen.add(name);
    const out: PromptArg = { name };
    if (item?.title) out.title = str(item.title, 60);
    if (item?.description) out.description = str(item.description, 300);
    if (item?.required) out.required = true;
    if (item?.default !== undefined && item?.default !== null) out.default = str(item.default, 200);
    args.push(out);
  }
  return { args, errors };
}

/** 正文里用到的占位符（去重、保持出现顺序） */
export function extractPlaceholders(content: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(content ?? '')))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: { name: string; title: string; description: string; content: string; arguments: PromptArg[]; enabled: boolean; sortOrder: number };
}

/** 全量校验（name 来自 URL，单独传；正文/参数/开关一起判，错误一次给全） */
export function validatePromptInput(name: string, input: PromptInput): ValidationResult {
  const errors: string[] = [];
  // 不截断：截断会让「超长名字」变成另一个合法名字，静默改写比报错更危险
  const n = String(name ?? '').trim();
  if (!PROMPT_NAME_RE.test(n)) errors.push('提示词名需为小写字母开头，可含 a-z0-9_.-，长度 3–64（如 inventory.health_check）');
  const title = str(input?.title, 120);
  if (title.length < 2) errors.push('标题至少 2 个字');
  const description = str(input?.description, 500);
  const content = String(input?.content ?? '');
  if (content.trim().length < 10) errors.push('正文至少 10 个字符');
  if (content.length > MAX_CONTENT) errors.push(`正文最多 ${MAX_CONTENT} 字符（当前 ${content.length}）`);

  const { args, errors: argErrors } = normalizeArguments((input as any)?.arguments);
  errors.push(...argErrors);
  const used = extractPlaceholders(content);
  const known = new Set(args.map((a) => a.name));
  const unknown = used.filter((p) => !known.has(p));
  if (unknown.length) errors.push(`正文里有未声明的占位符：${unknown.join('、')}（请先在参数里定义）`);
  // 声明了但正文没用：多半是改正文时忘了删参数，提醒但不拦（空参数也合法）
  const unused = args.filter((a) => !used.includes(a.name)).map((a) => a.name);

  const value = {
    name: n,
    title,
    description,
    content,
    arguments: args,
    enabled: input?.enabled !== false,
    sortOrder: Number.isFinite(Number(input?.sortOrder)) ? Number(input?.sortOrder) : 100,
  };
  if (unused.length) (value as any).unusedArgs = unused;
  return { ok: errors.length === 0, errors, value: errors.length ? undefined : value };
}

/** 参数补默认值 + 必填校验（preview 与 MCP prompts/get 共用同一口径） */
export function resolveArgs(defs: PromptArg[], args: Record<string, any>): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const d of defs ?? []) {
    const raw = args?.[d.name];
    const v = raw === undefined || raw === null ? '' : String(raw).trim();
    if (v) values[d.name] = v;
    else if (d.default !== undefined && d.default !== '') values[d.name] = d.default;
    else if (d.required) missing.push(d.name);
    else values[d.name] = '';
  }
  return { values, missing };
}

export interface RenderResult { ok: boolean; text?: string; reason?: string; missing?: string[] }

/** 渲染：缺必填参数直接失败；占位符按参数值替换（未传且无默认 → 空串） */
export function renderPromptContent(content: string, defs: PromptArg[], args: Record<string, any>): RenderResult {
  const { values, missing } = resolveArgs(defs, args);
  if (missing.length) return { ok: false, reason: `缺少必填参数：${missing.join('、')}`, missing };
  const text = String(content ?? '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_all, k: string) => values[k] ?? '');
  return { ok: true, text };
}

/**
 * 合并系统默认与租户行：
 *   · 同名租户行覆盖系统默认（保留系统排序位置，标 overridden）；
 *   · 租户独有的行追加在后面，按 sortOrder / name 排序；
 *   · enabled=false 的覆盖行仍然出现在管理列表里（否则用户没法再打开），但 agent 侧要过滤。
 */
export function mergePromptList(system: PromptSourceDef[], tenantRows: PromptSourceDef[]): MergedPrompt[] {
  const byName = new Map<string, PromptSourceDef>();
  for (const r of tenantRows) byName.set(r.name, r);
  const out: MergedPrompt[] = [];
  for (const [i, s] of system.entries()) {
    const t = byName.get(s.name);
    byName.delete(s.name);
    out.push({
      ...(t ? { ...s, ...t, name: s.name, content: t.content } : s),
      enabled: t ? t.enabled !== false : s.enabled !== false,
      sortOrder: t?.sortOrder ?? s.sortOrder ?? i,
      source: t ? 'custom' : 'system',
      overridden: !!t,
    });
  }
  const extras = [...byName.values()].sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || a.name.localeCompare(b.name));
  for (const e of extras) {
    out.push({ ...e, enabled: e.enabled !== false, sortOrder: e.sortOrder ?? 100, source: 'custom', overridden: false });
  }
  return out;
}

/** Agent 侧只下发启用项（禁用 = 从 prompts/list 消失，但管理列表仍可见） */
export function enabledPrompts(list: MergedPrompt[]): MergedPrompt[] {
  return list.filter((p) => p.enabled);
}
