// =============================================================================
// 产品自定义字段：字段定义校验 + 值的规范化（纯函数，零依赖，便于单测）
// 字段定义存 material_field_definitions，产品值存 materials.custom_fields (JSONB)。
// 只保留「已定义且启用」的 key，杜绝前端塞垃圾数据；必填/类型/选项在写入前校验。
// =============================================================================

export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'boolean'] as const;
export type FieldType = typeof FIELD_TYPES[number];

export interface FieldDef {
  id?: number;
  fieldKey: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  sortOrder?: number;
  active?: boolean;
}

/** 字段 key：小写字母/数字/下划线，字母开头，1-40 位（同时作为模板占位符变量名） */
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function normalizeFieldKey(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
}

/** 内置字段占用名，禁止与自定义字段 key 冲突（与 printMaterial 的 base 对齐） */
const RESERVED = new Set([
  'code', 'sku', 'name', 'material', 'spec', 'unit', 'category', 'batchno', 'batch',
  'producedat', 'expiresat', 'qty', 'defaultwarehouseid', 'defaultlocationid',
  'productcode', 'productname',
]);

/** 校验单条字段定义，返回规范化后的定义；不合法直接抛错（message 可透传给前端） */
export function assertFieldDef(raw: {
  fieldKey?: unknown; label?: unknown; type?: unknown; required?: unknown;
  options?: unknown; sortOrder?: unknown;
}): FieldDef {
  const fieldKey = normalizeFieldKey(raw.fieldKey);
  if (!KEY_RE.test(fieldKey)) throw new Error('字段标识需以字母开头，仅含小写字母/数字/下划线（≤40位）');
  if (RESERVED.has(fieldKey)) throw new Error(`字段标识「${fieldKey}」与内置字段冲突，请换一个`);
  const label = String(raw.label ?? '').trim();
  if (!label || label.length > 60) throw new Error('字段名称必填且不超过 60 字符');
  const type = String(raw.type ?? 'text') as FieldType;
  if (!FIELD_TYPES.includes(type)) throw new Error(`字段类型须为 ${FIELD_TYPES.join('/')}`);
  const required = raw.required === true || raw.required === ('true' as any);
  const options = Array.isArray(raw.options)
    ? raw.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 100)
    : [];
  if ((type === 'select' || type === 'multiselect') && options.length === 0) {
    throw new Error('单选/多选字段必须提供至少一个选项');
  }
  const sortOrder = Number(raw.sortOrder ?? 0);
  return { fieldKey, label, type, required, options, sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0 };
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 按字段定义规范化产品自定义字段值。
 * - 只保留已定义且 active 的 key；未定义/停用的 key 一律丢弃（防脏数据）
 * - 必填校验；按类型转换/校验；单选/多选校验取值在选项内
 * - 返回规范化后的 { fieldKey: value }
 */
export function normalizeCustomValues(
  defs: Array<FieldDef & { active?: boolean }>,
  rawValues: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | string[]> {
  const active = defs.filter((d) => d.active !== false);
  const byKey = new Map(active.map((d) => [d.fieldKey, d]));
  const values = rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues) ? rawValues : {};
  const out: Record<string, string | number | boolean | string[]> = {};

  for (const def of active) {
    const v = (values as any)[def.fieldKey];
    if (isEmpty(v)) {
      if (def.required) throw new Error(`自定义字段「${def.label}」必填`);
      continue; // 空值且不要求必填 → 不落该 key（删除旧值时靠整体替换实现）
    }
    switch (def.type) {
      case 'text': {
        out[def.fieldKey] = String(v).trim().slice(0, 500);
        break;
      }
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`自定义字段「${def.label}」须为数字`);
        out[def.fieldKey] = n;
        break;
      }
      case 'date': {
        const s = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`自定义字段「${def.label}」日期格式须为 YYYY-MM-DD`);
        out[def.fieldKey] = s;
        break;
      }
      case 'select': {
        const s = String(v).trim();
        if (!def.options.includes(s)) throw new Error(`自定义字段「${def.label}」取值不在选项中`);
        out[def.fieldKey] = s;
        break;
      }
      case 'multiselect': {
        const arr = Array.isArray(v) ? v.map((x) => String(x).trim()) : [String(v).trim()];
        if (arr.some((x) => !def.options.includes(x))) throw new Error(`自定义字段「${def.label}」取值不在选项中`);
        out[def.fieldKey] = Array.from(new Set(arr));
        break;
      }
      case 'boolean': {
        out[def.fieldKey] = v === true || v === ('true' as any) || v === 1 || v === ('1' as any);
        break;
      }
    }
  }
  // 顺带丢弃未定义的 key（含被停用的字段），保证库里不残留孤儿值
  void byKey;
  return out;
}

/**
 * 生成打印占位符：把自定义字段值同时以「字段标识」和「中文名」两种 key 暴露给模板。
 * 例：{ shelf_life: '12个月', '保质期': '12个月' }，模板写 {{shelf_life}} 或 {{保质期}} 均可。
 */
export function toPrintFields(
  defs: Array<FieldDef & { active?: boolean }>,
  values: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const src = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  for (const def of defs.filter((d) => d.active !== false)) {
    const v = (src as any)[def.fieldKey];
    if (v == null || v === '') continue;
    out[def.fieldKey] = Array.isArray(v) ? v.join(', ') : v;
    out[def.label] = out[def.fieldKey];
  }
  return out;
}
