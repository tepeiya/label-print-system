// 打印时表单（prompt-at-print）——纯函数，便于单测。
//
// 场景：同一张标签模板常年复用，但每次打印要换批号/有效期/序列号/工单号。让操作员
// 在打印动作里填，而不是回设计器改模板（改模板会留版本、要重新发布，车间也改不了）。
//
// 字段来源：模板 variables 里 `atPrint: true` 的变量。这样"只有一个变量定义表"，
// 不会出现「设计器变量」和「打印表单字段」两套口径互相漂移。

export type PrintFieldType = 'text' | 'number' | 'integer' | 'date';

export interface PrintFormField {
  name: string;
  label: string;
  type: PrintFieldType;
  required: boolean;
  defaultValue?: string;
  /** 变量上的校验规则原样透传（nonempty / number / integer / unique / regex） */
  validation?: string;
  regex?: string;
  /** 内置 UDI 模板用的是 validation:{maxLength} 对象形式，这里归一成字段上限 */
  maxLength?: number;
}

export interface PrintFormError {
  field: string;
  label: string;
  message: string;
}

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const DATE_GS1 = /^\d{6}$/;
const NUM = /^-?\d+(\.\d+)?$/;
const INT = /^-?\d+$/;

/** 变量定义 → 打印表单字段（只取 atPrint 的；计算变量 expr 不算，它的值由公式产出） */
export function buildPrintFields(variables: any[] | undefined | null): PrintFormField[] {
  const list = Array.isArray(variables) ? variables : [];
  return list
    .filter((v) => v && v.atPrint === true && !v.expr && String(v.name ?? '').trim())
    .map((v) => {
      const type: PrintFieldType =
        v.validation === 'number' ? 'number'
          : v.validation === 'integer' ? 'integer'
            : v.type === 'date' ? 'date'
              : 'text';
      const field: PrintFormField = {
        name: String(v.name).trim(),
        label: String(v.label ?? '').trim() || String(v.name).trim(),
        type,
        required: v.validation === 'nonempty' || v.required === true,
      };
      if (v.defaultValue != null && String(v.defaultValue) !== '') field.defaultValue = String(v.defaultValue);
      if (typeof v.validation === 'string' && v.validation) field.validation = v.validation;
      if (v.validation === 'regex' && v.regex) field.regex = String(v.regex);
      // 对象式 validation（内置模板的既有写法）：pattern→正则规则，maxLength→长度上限
      const rule = v.validation && typeof v.validation === 'object' ? v.validation : null;
      if (rule?.pattern) {
        field.validation = field.validation ?? 'regex';
        field.regex = String(rule.pattern);
      }
      if (rule?.maxLength && Number(rule.maxLength) > 0) field.maxLength = Number(rule.maxLength);
      if (v.type === 'number' && !field.validation) field.validation = 'number';
      return field;
    });
}

/** 校验一份表单值；空值只在必填时才报错，未填的可选字段不阻断 */
export function validateFormValues(fields: PrintFormField[], values: Record<string, any> | undefined | null): { ok: boolean; errors: PrintFormError[] } {
  const v = values && typeof values === 'object' ? values : {};
  const errors: PrintFormError[] = [];
  for (const f of fields) {
    const raw = v[f.name];
    const text = raw == null ? '' : String(raw).trim();
    const missing = text === '';
    if (f.required && missing) {
      errors.push({ field: f.name, label: f.label, message: '必填，本次没填' });
      continue;
    }
    if (missing) continue;
    if (f.type === 'number' && !NUM.test(text)) {
      errors.push({ field: f.name, label: f.label, message: `要填数字，当前是「${text}」` });
      continue;
    }
    if (f.type === 'integer' && !INT.test(text)) {
      errors.push({ field: f.name, label: f.label, message: `要填整数，当前是「${text}」` });
      continue;
    }
    if (f.type === 'date' && !DATE_ISO.test(text) && !DATE_GS1.test(text)) {
      errors.push({ field: f.name, label: f.label, message: `日期要 YYYY-MM-DD 或 YYMMDD，当前是「${text}」` });
      continue;
    }
    if (f.maxLength && text.length > f.maxLength) {
      errors.push({ field: f.name, label: f.label, message: `最长 ${f.maxLength} 个字符，当前 ${text.length}` });
      continue;
    }
    if (f.validation === 'regex' && f.regex) {
      let re: RegExp;
      try {
        re = new RegExp(f.regex);
      } catch {
        // 模板里的正则写坏了属于配置错误，要说清楚是模板的问题，不是操作员填错
        errors.push({ field: f.name, label: f.label, message: `模板里的正则「${f.regex}」无效，请回设计器改` });
        continue;
      }
      if (!re.test(text)) errors.push({ field: f.name, label: f.label, message: `不符合模板要求 ${f.regex}，当前是「${text}」` });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 表单值并入数据行：表单值优先（操作员当场键入的就是本次要印的），空值不覆盖已有行值 */
export function mergeFormValues(row: Record<string, any>, values: Record<string, any> | undefined | null, fields?: PrintFormField[]): Record<string, any> {
  const out: Record<string, any> = { ...(row ?? {}) };
  if (!values || typeof values !== 'object') return out;
  const defaults: Record<string, string> = {};
  for (const f of fields ?? []) if (f.defaultValue != null) defaults[f.name] = f.defaultValue;
  for (const [k, v] of Object.entries({ ...defaults, ...values })) {
    if (v == null || String(v).trim() === '') continue;
    out[k] = v;
  }
  return out;
}

/** 缺项提示用一句话（异常 message 里直接给操作员看） */
export function describePrintFormErrors(errors: PrintFormError[]): string {
  return errors.map((e) => `${e.label}（${e.field}）：${e.message}`).join('；');
}

/** 预览/指令导出共用：把表单值并入每一行（不校验，允许半填预览） */
export function applyFormToRows(rows: any[] | undefined | null, variables: any[] | undefined | null, formValues: Record<string, any> | undefined | null): Record<string, any>[] {
  const fields = buildPrintFields(variables);
  const list = Array.isArray(rows) && rows.length ? rows : [{}];
  return list.map((r) => mergeFormValues(r ?? {}, formValues, fields));
}

const hasVal = (v: any) => v != null && String(v).trim() !== '';

/**
 * 逐行校验：打印时的必填字段在"最终要印的每一行"里都得有值。
 * 打印页表单会把值并进每行；pack-print / WMS 自动打印则由数据行直接给值——
 * 两条入口共用这一道关，谁都不许打出带空变量的标签。
 */
export function validateRows(fields: PrintFormField[], rows: Record<string, any>[]): { ok: boolean; errors: PrintFormError[] } {
  const errors: PrintFormError[] = [];
  if (!fields.length) return { ok: true, errors };
  const list = Array.isArray(rows) && rows.length ? rows : [{}];
  for (const f of fields) {
    const missing: number[] = [];
    const badMsg: string[] = [];
    list.forEach((r, i) => {
      const v = (r ?? {})[f.name];
      if (!hasVal(v)) { missing.push(i + 1); return; }
      const one = validateFormValues([f], { [f.name]: v });
      if (!one.ok) badMsg.push(`第 ${i + 1} 行：${one.errors[0].message}`);
    });
    if (missing.length) {
      const where = missing.length === list.length ? '整批都没有值' : `缺在 ${missing.slice(0, 3).map((n) => `第 ${n} 行`).join('、')}${missing.length > 3 ? '…' : ''}`;
      errors.push({ field: f.name, label: f.label, message: `必填，${where}` });
    } else if (badMsg.length) {
      errors.push({ field: f.name, label: f.label, message: badMsg.slice(0, 2).join('；') + (badMsg.length > 2 ? '…' : '') });
    }
  }
  return { ok: errors.length === 0, errors };
}
