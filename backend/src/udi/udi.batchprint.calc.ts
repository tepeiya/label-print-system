// =============================================================================
// udi.batchprint.calc.ts —— 主从批次打印的纯计算（无 IO，便于单测）
//
// 场景：一个箱（carton）装 N 个单件（unit）。每件一条 UDI（DI 相同、批号/有效期相同、
// 序列号各不相同），箱一条 SSCC。商场做法是「输入件数与起号 → 一次出 N 张单件标 + 1 张箱标」，
// 编号与装箱关系同时进台账。这里只负责：序列号展开、单件行/箱标行的构造、SSCC 递增。
//
// 与 udi.trace.service 的分工：本文件不碰数据库；它产出的 rows 直接喂给
// registerUnits（写 udi_units）与 print.createJob（出标签），两处共用同一份数据，
// 避免「打出来的号和台账里的号不是一批」。
// =============================================================================

import { buildSscc, isValidSscc, normalizePrefix } from './udi.sscc.calc';

export class BatchPrintError extends Error {}

/** 单次主从打印上限；500 张单件标已是产线一次换卷的量级，再大应拆批 */
export const MAX_UNIT_QTY = 500;

export interface SerialPlan {
  mode: 'auto' | 'list';
  /** auto：起始号，允许带前缀（如 SN0001 / 0001） */
  from?: string;
  /** auto：不写在 from 里时单独给前缀 */
  prefix?: string;
  /** auto：数字位数（补零宽度）；不给则取 from 尾部数字的长度 */
  padding?: number;
  /** list：显式给的号列表 */
  list?: string[];
  /** 期望数量（auto 必填；list 时若给了则必须与 list.length 一致） */
  count?: number;
}

/**
 * 展开序列号。
 * auto 规则：把 from 拆成「前缀 + 尾部连续数字」，逐号 +1，按 padding 补零，前缀原样保留。
 * 常见写法都能吃：0001→0001..; SN-0001→SN-0002..; 20261101→20261102..
 * 明确拒绝：from 里没有数字（无从递增）、位数溢出（不做静默进位到 4 位变 5 位）。
 */
export function planSerials(plan: SerialPlan): string[] {
  if (plan.mode === 'list') {
    const raw = (plan.list ?? []).map((s) => String(s ?? '').trim());
    if (!raw.length) throw new BatchPrintError('序列号清单为空');
    if (raw.length > MAX_UNIT_QTY) throw new BatchPrintError(`序列号清单 ${raw.length} 条，超过单次上限 ${MAX_UNIT_QTY}`);
    if (plan.count != null && plan.count !== raw.length) {
      throw new BatchPrintError(`件数 ${plan.count} 与序列号清单 ${raw.length} 条不一致`);
    }
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const s of raw) {
      if (!s) throw new BatchPrintError('序列号清单里存在空值');
      if (seen.has(s)) dup.push(s);
      seen.add(s);
    }
    if (dup.length) throw new BatchPrintError(`序列号重复：${[...new Set(dup)].slice(0, 6).join('、')}`);
    return raw;
  }

  const count = Number(plan.count);
  if (!Number.isInteger(count) || count < 1) throw new BatchPrintError(`件数必须是 1~${MAX_UNIT_QTY} 的整数`);
  if (count > MAX_UNIT_QTY) throw new BatchPrintError(`件数 ${count} 超过单次上限 ${MAX_UNIT_QTY}，请拆分批次`);

  const from = String(plan.from ?? '').trim();
  if (!from) throw new BatchPrintError('自动编号需要起始序列号（如 SN0001）');
  const m = /^(.*?)(\d+)$/.exec(from);
  if (!m) throw new BatchPrintError(`起始序列号「${from}」里没有数字，无法递增`);
  // 给了 prefix 就拼在 from 的中间部分前面（SN-0001 + 前缀 P → PSN-0001）；不给就沿用 from 自己的前缀
  const head = plan.prefix ? `${plan.prefix}${m[1] ?? ''}` : (m[1] ?? '');
  const digits = m[2];
  const width = plan.padding ?? digits.length;
  if (!Number.isInteger(width) || width < 1 || width > 20) throw new BatchPrintError(`补零位数必须是 1~20（当前 ${width}）`);
  if (width < digits.length) throw new BatchPrintError(`补零位数 ${width} 小于起始号位数 ${digits.length}，会截断号段`);

  const start = Number(digits);
  const end = start + count - 1;
  if (end > Number.MAX_SAFE_INTEGER) throw new BatchPrintError('号段超出安全整数范围');
  if (String(end).length > width) {
    throw new BatchPrintError(
      `号段溢出：${digits} 起 ${count} 件会到 ${end}，超过 ${width} 位。请增加补零位数或减小件数（不做静默进位）`,
    );
  }
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${head}${String(i).padStart(width, '0')}`);
  return out;
}

/** 号段摘要，用于回执与界面提示：SN0001 ~ SN0100（100 件） */
export function serialSummary(serials: string[]): string {
  if (!serials.length) return '';
  const first = serials[0];
  const last = serials[serials.length - 1];
  return serials.length === 1 ? first : `${first} ~ ${last}（${serials.length} 件）`;
}

/** 模板变量名映射：模板里叫什么，这里就映射成什么；默认沿用标准字段名 */
export interface FieldMap {
  gtin?: string; lot?: string; expiry?: string; serial?: string; sscc?: string; qty?: string;
  /** 额外附加到每一行上的固定字段（如 productName/lineName） */
  extra?: Record<string, string | number>;
}

export const DEFAULT_FIELD_MAP: Required<Pick<FieldMap, 'gtin' | 'lot' | 'expiry' | 'serial' | 'sscc' | 'qty'>> = {
  gtin: 'gtin', lot: 'lot', expiry: 'expiry', serial: 'serial', sscc: 'sscc', qty: 'qty',
};

export interface UnitRowInput {
  gtin14: string;
  lot: string;
  /** GS1 6 位 YYMMDD；无有效期传空 */
  expiryGs1: string;
  /** ISO 日期，便于模板直接印人眼可读格式 */
  expiryIso: string;
  quantityInCarton: number;
  fieldMap?: FieldMap;
}

/**
 * 单件行：每行一件，序列号不同；同时给出 gtin / di / expiry(YYMMDD) / expiryDate(ISO) 三套别名，
 * 模板写 {{expiry}} 得到 YYMMDD（GS1 HRI 口径），写 {{expiryDate}} 得到 2026-12-31。
 */
export function buildUnitRows(serials: string[], input: UnitRowInput): Array<Record<string, unknown>> {
  const fm = { ...DEFAULT_FIELD_MAP, ...(input.fieldMap ?? {}) };
  const common: Record<string, unknown> = {
    ...(input.fieldMap?.extra ?? {}),
    [fm.gtin]: input.gtin14,
    di: input.gtin14,
    [fm.lot]: input.lot,
    [fm.expiry]: input.expiryGs1,
    expiryDate: input.expiryIso,
    [fm.qty]: input.quantityInCarton,
  };
  return serials.map((s) => ({ ...common, [fm.serial]: s, serial: s }));
}

/** 箱标行：一行一箱；SSCC 与箱内件数一起给出，箱标模板据此印 (00) 与数量 */
export function buildCartonRow(input: {
  sscc: string;
  gtin14: string;
  lot: string;
  expiryGs1: string;
  expiryIso: string;
  qtyInBox: number;
  serialFrom: string;
  serialTo: string;
  fieldMap?: FieldMap;
}): Record<string, unknown> {
  const fm = { ...DEFAULT_FIELD_MAP, ...(input.fieldMap ?? {}) };
  return {
    ...(input.fieldMap?.extra ?? {}),
    [fm.sscc]: input.sscc,
    sscc: input.sscc,
    [fm.gtin]: input.gtin14,
    di: input.gtin14,
    [fm.lot]: input.lot,
    [fm.expiry]: input.expiryGs1,
    expiryDate: input.expiryIso,
    [fm.qty]: input.qtyInBox,
    qtyInBox: input.qtyInBox,
    serialFrom: input.serialFrom,
    serialTo: input.serialTo,
  };
}

/**
 * 下一个 SSCC 序列号：传入同租户已用过的 SSCC 列表，取其中 9 位流水最大值 +1。
 * 不依赖自增表，重装/换库后也不会重号（以库里的实际记录为准）。
 */
export function nextSsccSerial(usedSscc: string[], prefix?: string | null): number {
  const p = normalizePrefix(prefix);
  let max = 0;
  for (const s of usedSscc) {
    const clean = String(s ?? '').replace(/\D/g, '');
    if (clean.length !== 18) continue;
    // 结构：扩展位(1) + 前缀(7) + 流水(9) + 校验位(1)
    if (clean.slice(1, 8) !== p) continue;
    const serial = Number(clean.slice(8, 17));
    if (Number.isFinite(serial) && serial > max) max = serial;
  }
  return max + 1;
}

/** 给定的 SSCC 是否可被本租户用作新箱码：格式合法 + 前缀匹配 */
export function assertSsccUsable(sscc: string, prefix?: string | null): string {
  const clean = String(sscc ?? '').replace(/\D/g, '');
  if (!isValidSscc(clean)) throw new BatchPrintError(`SSCC「${sscc}」校验位或长度不合法（需 18 位数字）`);
  const p = normalizePrefix(prefix);
  if (clean.slice(1, 8) !== p) throw new BatchPrintError(`SSCC「${clean}」的前缀 ${clean.slice(1, 8)} 与配置的公司前缀 ${p} 不一致`);
  return clean;
}

export { buildSscc };
