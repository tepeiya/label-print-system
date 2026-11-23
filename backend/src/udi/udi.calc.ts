// =============================================================================
// udi.calc —— UDI（医疗器械唯一标识）数据构造与解析（纯函数层）
//
// 【解决什么】医疗行业客户要的不是"能打印条码"，而是"打出来的码符合 UDI 规则、
//   扫码枪能解出 DI/PI、追溯与飞检能取证"。本文件把 UDI 的数据规则做成单一真源：
//   GTIN 补位与校验位、GS1 日期、批号/序列号、元素串（含 FNC1）、HRI、反向解析。
//
// 【单一真源】不复制 GS1 规则：
//   · 校验位走 core/checksum.gtinCheckDigit
//   · 字段长度/字符集/日期/校验位走 core/gs1-ai.validateAiValue
//   · 元素串与 FNC1 分隔走 core/gs1-ai.validateGs1
//   本文件只负责"UDI 业务语义"：哪些 AI 组成 DI、哪些组成 PI、顺序、必填与互斥。
//
// 【边界（诚实）】
//   · 只做数据层，不做打印质量等级（ISO/IEC 15415 需硬件验证仪）；
//   · 不承诺自动上报国家 UDI 数据库（导出格式另做）；
//   · 日期按 2 位年输出，跨世纪判定由调用方业务约定（与 GS1 手册一致，不做猜测）。
//
// 【无依赖约束】不 import Nest / TypeORM，可直接被单测（node --test + tsx）与
//   前端逻辑复用（与 core/kit.calc 同一类纯函数层）。
// =============================================================================

import { gtinCheckDigit } from '../../core/checksum';
import { lookupAi, validateAiValue, validateGs1 } from '../../core/gs1-ai';

/** UDI 用到的 AI（GS1 定义） */
export const UDI_AI = {
  DI: '01',
  PRODUCTION: '11',
  EXPIRY: '17',
  LOT: '10',
  SERIAL: '21',
} as const;

/** UDI 组装顺序：GS1 推荐 DI 在前，日期在批号/序列号前（扫码器按序断句更稳） */
export const UDI_ORDER = ['01', '11', '17', '10', '21'] as const;

export interface UdiInput {
  /** GTIN：接受 8 / 12 / 13 / 14 位（不足 14 位左补零，校验位保持有效） */
  gtin: string;
  /** 有效期：YYYY-MM-DD / YYYYMMDD / YYMMDD / YYYY-MM（DD=00 表示月末） */
  expiry?: string;
  /** 生产日期：同有效期格式 */
  production?: string;
  /** 批号（AI 10，最长 20） */
  lot?: string;
  /** 序列号（AI 21，最长 20） */
  serial?: string;
  /** 其它 AI（如 240/30/37），按给定顺序追加在 21 之后 */
  extra?: Array<{ ai: string; value: string }>;
}

export interface UdiField {
  ai: string;
  title: string;
  value: string;
  group: string;
}

export interface UdiBuildResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 规范化后的 GTIN-14（AI 01 的值） */
  gtin14: string;
  /** 输入自带校验位是否正确 */
  checkDigitOk: boolean;
  /** 人可读串： (01)…(17)…(10)…(21)… */
  hri: string;
  /** 已编码元素串（变长 AI 后含 FNC1 \u001D）；供 DataMatrix/指令通道使用 */
  elementString: string;
  /** DI（器械标识）：AI 01 段 */
  di: string;
  /** PI（生产标识）：11/17/10/21 段拼接 */
  pi: string;
  /** 是否含至少一个 PI 字段 */
  hasPi: boolean;
  fields: UdiField[];
}

export interface UdiParseResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  fields: UdiField[];
  hri: string;
  /** 提取后的 UDI 关键字段（缺失为 null） */
  udi: { gtin: string | null; expiry: string | null; production: string | null; lot: string | null; serial: string | null };
  di: string;
  pi: string;
}

/** GTIN 规范化：左补零到 14 位 + 校验位判定（补零不改变模 10 权重） */
export function normalizeGtin(raw: string): { gtin14: string; checkDigitOk: boolean; errors: string[]; inputLen: number } {
  const errors: string[] = [];
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  if (!digits) return { gtin14: '', checkDigitOk: false, errors: ['GTIN 为空或含非数字字符'], inputLen: 0 };
  const allowed = [8, 12, 13, 14];
  if (!allowed.includes(digits.length)) {
    errors.push(`GTIN 长度应为 8/12/13/14 位（当前 ${digits.length} 位）；UDI 场景请使用 14 位 GTIN`);
  return { gtin14: digits.padStart(14, '0'), checkDigitOk: false, errors, inputLen: digits.length };
  }
  const gtin14 = digits.padStart(14, '0');
  let expected = '';
  try {
    expected = gtinCheckDigit(digits.slice(0, -1));
  } catch (e: any) {
    return { gtin14, checkDigitOk: false, errors: [`GTIN 校验位计算失败：${e?.message ?? e}`], inputLen: digits.length };
  }
  const ok = expected === digits.slice(-1);
  if (!ok) errors.push(`GTIN 模 10 校验位错误：应为 ${expected}，实际 ${digits.slice(-1)}（完整 GTIN-14 应为 ${digits.slice(0, -1)}${expected}）`);
  return { gtin14, checkDigitOk: ok, errors, inputLen: digits.length };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * GS1 日期格式化 → YYMMDD。
 * 接受 YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD / YYMMDD / YYYY-MM。
 * GS1 规则：AI 17 的 DD=00 表示"当月最后一天"，故 YYYY-MM 输出 YYMM00。
 */
export function formatGs1Date(input: string): { value: string | null; errors: string[] } {
  const errors: string[] = [];
  const s = String(input ?? '').trim();
  if (!s) return { value: null, errors: ['日期为空'] };

  // 已是 6 位：按 YYMMDD 校验（日 00–31，00 表示月末）
  if (/^\d{6}$/.test(s)) {
    const mm = +s.slice(2, 4);
    const dd = +s.slice(4, 6);
    if (mm < 1 || mm > 12) errors.push(`日期 ${s} 的月份不合法（YYMMDD）`);
    if (dd > 31) errors.push(`日期 ${s} 的日不合法（YYMMDD，00 表示月末）`);
    return { value: errors.length ? null : s, errors };
  }

  // YYYY-MM：输出 YYMM00（月末）
  const ym = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (ym) {
    const y = +ym[1];
    const m = +ym[2];
    if (m < 1 || m > 12) return { value: null, errors: [`月份不合法：${m}`] };
    return { value: pad2(y % 100) + pad2(m) + '00', errors };
  }

  // YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD
  const norm = s.replace(/[/.]/g, '-');
  let y: number, m: number, d: number;
  const dashed = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(norm);
  const plain8 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (dashed) {
    y = +dashed[1]; m = +dashed[2]; d = +dashed[3];
  } else if (plain8) {
    y = +plain8[1]; m = +plain8[2]; d = +plain8[3];
  } else {
    return { value: null, errors: [`日期格式无法识别：${s}（支持 YYYY-MM-DD / YYYYMMDD / YYMMDD / YYYY-MM）`] };
  }
  if (m < 1 || m > 12) errors.push(`月份不合法：${m}`);
  if (d < 1 || d > 31) errors.push(`日不合法：${d}`);
  if (!errors.length) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      errors.push(`日期不存在：${s}（如 2 月 30 日、闰年 2 月 29 日需核对）`);
    }
  }
  if (errors.length) return { value: null, errors };
  return { value: pad2(y % 100) + pad2(m) + pad2(d), errors };
}

function fieldOf(ai: string, value: string): UdiField {
  const def = lookupAi(ai);
  return { ai, title: def?.title ?? '未登记 AI', value, group: def?.group ?? '内部' };
}

/** 字段值校验（委托 GS1 单字段规则：长度/字符集/日期/校验位） */
function checkField(ai: string, value: string, errors: string[], warnings: string[]): void {
  const v = validateAiValue(ai, value);
  errors.push(...v.errors);
  warnings.push(...v.warnings);
}

/**
 * 构造 UDI：DI(01) + 生产/有效期(11/17) + 批号(10) + 序列号(21)。
 * 顺序固定为 01 → 11 → 17 → 10 → 21 → extra，与 GS1 推荐顺序一致。
 */
export function buildUdi(input: UdiInput): UdiBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fields: UdiField[] = [];

  // 1) GTIN（DI）
  const g = normalizeGtin(input.gtin);
  errors.push(...g.errors);
  if (g.gtin14) fields.push(fieldOf(UDI_AI.DI, g.gtin14));

  // 2) 日期（PI）
  const pushDate = (ai: string, raw?: string, label = '日期') => {
    if (!raw) return;
    const f = formatGs1Date(raw);
    if (!f.value) { errors.push(`AI(${ai}) ${label}：${f.errors.join('；')}`); return; }
    checkField(ai, f.value, errors, warnings);
    if (ai === UDI_AI.EXPIRY && f.value.endsWith('00')) {
      warnings.push(`AI(17) 使用 DD=00（当月最后一天）语义：${f.value}，请确认标签印刷口径`);
    }
    fields.push(fieldOf(ai, f.value));
  };
  pushDate(UDI_AI.PRODUCTION, input.production, '生产日期');
  pushDate(UDI_AI.EXPIRY, input.expiry, '有效期');

  // 3) 批号 / 序列号
  const pushText = (ai: string, raw?: string, label = '值') => {
    if (raw == null || raw === '') return;
    const v = String(raw).trim();
    if (v !== String(raw)) warnings.push(`AI(${ai}) ${label} 含首尾空格，已去除`);
    checkField(ai, v, errors, warnings);
    fields.push(fieldOf(ai, v));
  };
  pushText(UDI_AI.LOT, input.lot, '批号');
  pushText(UDI_AI.SERIAL, input.serial, '序列号');

  // 4) 附加 AI
  for (const e of input.extra ?? []) {
    const ai = String(e.ai ?? '').trim();
    const value = String(e.value ?? '');
    if (!lookupAi(ai)) { warnings.push(`AI(${ai}) 未登记，按宽松处理，请核对 GS1 手册`); }
    if (fields.some((f) => f.ai === ai)) { errors.push(`AI(${ai}) 重复出现，请合并`); continue; }
    checkField(ai, value, errors, warnings);
    fields.push(fieldOf(ai, value));
  }

  // 5) UDI 业务守卫
  const hasDi = fields.some((f) => f.ai === UDI_AI.DI);
  if (!hasDi) errors.push('缺少 DI（AI 01 GTIN）：UDI 必须包含器械标识');
  const hasPi = fields.some((f) => [UDI_AI.PRODUCTION, UDI_AI.EXPIRY, UDI_AI.LOT, UDI_AI.SERIAL].includes(f.ai as any));
  if (!hasPi) warnings.push('缺少 PI（11/17/10/21）：除免于实施情形外，UDI 应包含生产标识');
  if (input.lot && input.serial) {
    warnings.push('同时含批号(10)与序列号(21)：单件序列化产品通常两者并存，请按注册要求确认');
  }

  // 6) HRI + 元素串（FNC1 由 validateGs1 统一处理）
  const hri = fields.map((f) => `(${f.ai})${f.value}`).join('');
  const gs1 = validateGs1(hri);
  errors.push(...gs1.errors);
  warnings.push(...gs1.warnings);

  const di = fields.filter((f) => f.ai === UDI_AI.DI).map((f) => `(${f.ai})${f.value}`).join('');
  const pi = fields.filter((f) => [UDI_AI.PRODUCTION, UDI_AI.EXPIRY, UDI_AI.LOT, UDI_AI.SERIAL].includes(f.ai as any))
    .map((f) => `(${f.ai})${f.value}`).join('');

  return {
    ok: errors.length === 0,
    errors, warnings,
    gtin14: g.gtin14, checkDigitOk: g.checkDigitOk,
    hri, elementString: gs1.data,
    di, pi, hasPi, fields,
  };
}

/**
 * 原始 GS1 元素串解析（无括号、含 FNC1 \u001D 或 <GS> 占位）。
 * 断句规则：按字典定长优先，变长读到 FNC1/结尾。UDI 常见 AI 均为 2 位，歧义极低。
 */
export function parseElementString(raw: string): { fields: UdiField[]; errors: string[] } {
  const errors: string[] = [];
  const fields: UdiField[] = [];
  const s = String(raw ?? '').replace(/<GS>/g, '\u001D');
  let i = 0, guard = 0;
  while (i < s.length && guard++ < 200) {
    if (s[i] === '\u001D') { i++; continue; }
    if (!/\d/.test(s[i])) { errors.push(`位置 ${i} 不是 AI 数字起始：${s.slice(i, i + 12)}`); break; }
    // 依次尝试 2/3/4 位 AI，取字典中存在且后续长度可满足的最短者
    let ai = '', def: ReturnType<typeof lookupAi> = null;
    for (const len of [2, 3, 4]) {
      const cand = s.slice(i, i + len);
      if (cand.length < len || !/^\d+$/.test(cand)) break;
      const d = lookupAi(cand);
      if (d) { ai = cand; def = d; break; }
    }
    if (!def) { errors.push(`位置 ${i} 起的 AI 未登记：${s.slice(i, i + 4)}`); break; }
    i += ai.length;
    let value = '';
    if (def.fixedLen) {
      value = s.slice(i, i + def.fixedLen);
      i += def.fixedLen;
      if (value.length < def.fixedLen) errors.push(`AI(${ai}) 值长度不足 ${def.fixedLen}（实际 ${value.length}）`);
    } else {
      let j = i;
      while (j < s.length && s[j] !== '\u001D') j++;
      value = s.slice(i, j);
      i = j;
      if (def.maxLen && value.length > def.maxLen) errors.push(`AI(${ai}) 值超长（${value.length} > ${def.maxLen}）`);
    }
    if (!value) errors.push(`AI(${ai}) 的值为空`);
    const v = validateAiValue(ai, value);
    errors.push(...v.errors);
    fields.push(fieldOf(ai, value));
  }
  return { fields, errors };
}

/** 解析 UDI：输入可以是 HRI（带括号）或原始元素串（含 \u001D / <GS>） */
export function parseUdi(code: string): UdiParseResult {
  const s = String(code ?? '').trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!s) {
    return { ok: false, errors: ['内容为空'], warnings, fields: [], hri: '', udi: emptyUdi(), di: '', pi: '' };
  }
  let fields: UdiField[] = [];
  let hri = '';
  if (s.includes('(')) {
    const v = validateGs1(s);
    errors.push(...v.errors);
    warnings.push(...v.warnings);
    fields = v.fields.map((f) => ({ ai: f.ai, title: f.title, value: String((f as any).value ?? ''), group: f.group }));
    hri = v.humanReadable || s;
  } else {
    const p = parseElementString(s);
    errors.push(...p.errors);
    fields = p.fields;
    hri = fields.map((f) => `(${f.ai})${f.value}`).join('');
    if (!fields.length) errors.push('未解析出任何 AI 字段（扫码内容可能不是 GS1 码）');
  }
  const pick = (ai: string) => fields.find((f) => f.ai === ai)?.value ?? null;
  const udi = {
    gtin: pick(UDI_AI.DI),
    expiry: pick(UDI_AI.EXPIRY),
    production: pick(UDI_AI.PRODUCTION),
    lot: pick(UDI_AI.LOT),
    serial: pick(UDI_AI.SERIAL),
  };
  const di = udi.gtin ? `(01)${udi.gtin}` : '';
  const pi = fields.filter((f) => [UDI_AI.PRODUCTION, UDI_AI.EXPIRY, UDI_AI.LOT, UDI_AI.SERIAL].includes(f.ai as any))
    .map((f) => `(${f.ai})${f.value}`).join('');
  if (!udi.gtin) errors.push('解析结果缺少 AI 01（GTIN），不是标准 UDI');
  return { ok: errors.length === 0, errors, warnings, fields, hri, udi, di, pi };
}

function emptyUdi() {
  return { gtin: null, expiry: null, production: null, lot: null, serial: null };
}

/** 供打印/模板绑定使用的 DataMatrix 规格（gs1=true 时渲染器走 bwip 的 gs1datamatrix） */
export function udiBarcodeSpec(result: UdiBuildResult, opts: { heightMm?: number; moduleSizeMm?: number } = {}) {
  return {
    sym: 'DATAMATRIX',
    content: result.hri,
    gs1: true,
    moduleSizeMm: opts.moduleSizeMm ?? 0.3,
    heightMm: opts.heightMm ?? 12,
  };
}

/** 追溯/报表用的稳定键：用 DI + 批号/序列号 拼出"单品唯一键" */
export function udiUnitKey(result: Pick<UdiBuildResult, 'gtin14' | 'fields'>): string {
  const lot = result.fields.find((f) => f.ai === UDI_AI.LOT)?.value ?? '';
  const serial = result.fields.find((f) => f.ai === UDI_AI.SERIAL)?.value ?? '';
  const expiry = result.fields.find((f) => f.ai === UDI_AI.EXPIRY)?.value ?? '';
  return [result.gtin14, lot, serial, expiry].join('|');
}
