// =============================================================================
// udi.trace.calc.ts —— UDI 追溯纯函数层（无库、可单测）
//
// 职责：状态机、包装层级树、留痕报表聚合、CSV 序列化。
// 约定：所有函数不做 IO；服务层负责取数后调用这里，保证规则可被单测穷举。
// =============================================================================
import { gtinCheckDigit } from '../../core/checksum';

/** 单品生命周期状态（UDI 单元级） */
export const UDI_STATUS = ['REGISTERED', 'PRINTED', 'RECEIVED', 'ISSUED', 'SHIPPED', 'VOID'] as const;
export type UdiStatus = (typeof UDI_STATUS)[number];

/** 追溯事件类型 */
export const UDI_EVENT = [
  'BUILD', 'PRINT', 'PRINT_FAIL', 'RECEIVE', 'ISSUE', 'SHIP', 'RETURN', 'VOID', 'REPACK',
] as const;
export type UdiEventType = (typeof UDI_EVENT)[number];

/** 包装层级 */
export const UDI_PACK_LEVEL = ['UNIT', 'CARTON', 'PALLET'] as const;
export type UdiPackLevel = (typeof UDI_PACK_LEVEL)[number];

export interface TransitionResult {
  ok: boolean;
  status: UdiStatus;
  reason?: string;
}

/**
 * 状态迁移：事件 + 当前状态 → 下一状态。
 * 不可迁移时 ok=false，status 保持原值，reason 说明原因（服务层转成 409）。
 * REPACK 只改包装归属，不动状态，返回 status=current。
 */
export function nextStatus(current: string, event: string): TransitionResult {
  const cur = current as UdiStatus;
  if (!UDI_STATUS.includes(cur)) {
    return { ok: false, status: 'REGISTERED', reason: `未知当前状态：${current}` };
  }
  if (!UDI_EVENT.includes(event as UdiEventType)) {
    return { ok: false, status: cur, reason: `未知事件类型：${event}` };
  }
  if (cur === 'VOID' && event !== 'VOID') {
    return { ok: false, status: cur, reason: '已作废的单元不可再流转' };
  }
  switch (event as UdiEventType) {
    case 'BUILD':
      return cur === 'REGISTERED'
        ? { ok: true, status: 'REGISTERED' }
        : { ok: false, status: cur, reason: `当前状态 ${cur} 不可再建档` };
    case 'PRINT':
      return { ok: true, status: 'PRINTED' };
    case 'PRINT_FAIL':
      return { ok: true, status: cur === 'PRINTED' ? 'PRINTED' : 'REGISTERED' };
    case 'RECEIVE':
      return cur === 'VOID'
        ? { ok: false, status: cur, reason: '已作废单元不可收货' }
        : { ok: true, status: 'RECEIVED' };
    case 'ISSUE':
      return cur === 'RECEIVED' || cur === 'ISSUED'
        ? { ok: true, status: 'ISSUED' }
        : { ok: false, status: cur, reason: `状态 ${cur} 不可发料（需先收货 RECEIVED）` };
    case 'SHIP':
      return cur === 'RECEIVED' || cur === 'ISSUED' || cur === 'SHIPPED'
        ? { ok: true, status: 'SHIPPED' }
        : { ok: false, status: cur, reason: `状态 ${cur} 不可出库（需先收货或发料）` };
    case 'RETURN':
      return cur === 'SHIPPED'
        ? { ok: true, status: 'RECEIVED' }
        : { ok: false, status: cur, reason: `状态 ${cur} 无退货可退（仅 SHIPPED 可退）` };
    case 'VOID':
      return { ok: true, status: 'VOID' };
    case 'REPACK':
      return { ok: true, status: cur };
    default:
      return { ok: false, status: cur, reason: `未处理的事件：${event}` };
  }
}

/**
 * GS1 6 位日期（YYMMDD，DD=00 表示当月最后一天）→ ISO YYYY-MM-DD。
 * 世纪窗口按 GS1 实践：YY<50 视为 20YY，否则 19YY（有效期/生产日期不会落在 2050+）。
 * 注意：udi_key 里仍保留 6 位原值（与 UdiService.encode 产出的 unitKey 保持一字不差），
 *       本函数只用于落库 DATE 列与报表展示。
 */
export function gs1DateToIso(v?: string | null): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{6}$/.test(s)) return null;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const year = yy < 50 ? 2000 + yy : 1900 + yy;
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  const day = dd === 0 ? lastDay : dd;
  if (day > lastDay) return null;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p2(mm)}-${p2(day)}`;
}

/** SSCC（18 位，含校验位）：校验位按 GS1 模 10 算法，与 GTIN 同规则 */
export function validateSscc(sscc: string): { ok: boolean; normalized: string; reason?: string } {
  const s = String(sscc ?? '').replace(/[\s-]/g, '');
  if (!/^\d{18}$/.test(s)) return { ok: false, normalized: s, reason: 'SSCC 必须是 18 位数字' };
  const body = s.slice(0, 17);
  const digit = String(gtinCheckDigit(body));
  if (digit !== s[17]) {
    return { ok: false, normalized: s, reason: `SSCC 校验位应为 ${digit}` };
  }
  return { ok: true, normalized: s };
}

export interface PackRow {
  sscc: string;
  level: string;
  parentSscc?: string | null;
  qty?: number;
  gtin?: string | null;
}

export interface PackNode extends PackRow {
  children: PackNode[];
}

/** 把扁平包装行组装成层级树（父缺失的行作为根） */
export function buildPackTree(rows: PackRow[]): PackNode[] {
  const nodes = new Map<string, PackNode>();
  for (const r of rows) nodes.set(r.sscc, { ...r, children: [] });
  const roots: PackNode[] = [];
  for (const r of rows) {
    const n = nodes.get(r.sscc)!;
    if (r.parentSscc && nodes.has(r.parentSscc)) nodes.get(r.parentSscc)!.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** 目标包装的祖先链（根 → 目标，含目标自身）；parentMap 为 sscc → parentSscc */
export function ancestorsOf(sscc: string, parentMap: Map<string, string | null>): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = sscc;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    out.push(cur);
    cur = parentMap.get(cur) ?? null;
  }
  return out.reverse();
}

/** 目标包装的直接与间接子包装（广度优先，不含自身） */
export function descendantsOf(sscc: string, rows: PackRow[]): string[] {
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentSscc) continue;
    const list = children.get(r.parentSscc) ?? [];
    list.push(r.sscc);
    children.set(r.parentSscc, list);
  }
  const out: string[] = [];
  const queue = [...(children.get(sscc) ?? [])];
  const guard = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (guard.has(cur)) continue;
    guard.add(cur);
    out.push(cur);
    queue.push(...(children.get(cur) ?? []));
  }
  return out;
}

export interface PrintAuditRow {
  eventType: string;
  day: string;          // YYYY-MM-DD
  templateCode?: string | null;
  unitKey?: string | null;
}

export interface PrintAuditSummary {
  totals: { printed: number; failed: number; units: number };
  byDay: Array<{ day: string; printed: number; failed: number; units: number }>;
  byTemplate: Array<{ templateCode: string; printed: number; failed: number }>;
}

/** 打印留痕聚合：按天、按模板统计成功/失败次数与去重单元数 */
export function summarizePrintAudit(rows: PrintAuditRow[]): PrintAuditSummary {
  const totals = { printed: 0, failed: 0, units: 0 };
  const dayMap = new Map<string, { printed: number; failed: number; units: Set<string> }>();
  const tplMap = new Map<string, { printed: number; failed: number }>();
  const allUnits = new Set<string>();

  for (const r of rows) {
    const ok = r.eventType === 'PRINT';
    const bad = r.eventType === 'PRINT_FAIL';
    if (!ok && !bad) continue;
    if (ok) totals.printed += 1;
    if (bad) totals.failed += 1;
    if (r.unitKey) allUnits.add(r.unitKey);

    const d = dayMap.get(r.day) ?? { printed: 0, failed: 0, units: new Set<string>() };
    if (ok) d.printed += 1;
    if (bad) d.failed += 1;
    if (r.unitKey) d.units.add(r.unitKey);
    dayMap.set(r.day, d);

    const t = tplMap.get(r.templateCode ?? '(未标注模板)') ?? { printed: 0, failed: 0 };
    if (ok) t.printed += 1;
    if (bad) t.failed += 1;
    tplMap.set(r.templateCode ?? '(未标注模板)', t);
  }

  totals.units = allUnits.size;
  return {
    totals,
    byDay: [...dayMap.entries()]
      .map(([day, v]) => ({ day, printed: v.printed, failed: v.failed, units: v.units.size }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    byTemplate: [...tplMap.entries()]
      .map(([templateCode, v]) => ({ templateCode, ...v }))
      .sort((a, b) => b.printed - a.printed),
  };
}

export interface CsvColumn { key: string; title: string }

/** RFC4180 单元格转义：含引号/逗号/换行时加双引号并转义内部引号；同时防 CSV 注入 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // 防公式注入：以 = + - @ 开头时前置单引号
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 生成 CSV 文本。默认带 UTF-8 BOM（Excel 直接打开中文不乱码）。
 * 行数上限由调用方控制，这里只做序列化。
 */
export function toCsv(columns: CsvColumn[], rows: Array<Record<string, unknown>>, opts: { bom?: boolean } = {}): string {
  const bom = opts.bom !== false ? '\uFEFF' : '';
  const head = columns.map((c) => csvCell(c.title)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(',')).join('\r\n');
  return `${bom}${head}\r\n${body}${body ? '\r\n' : ''}`;
}

/** 留痕报表文件名：udi-print-audit-YYYYMMDD-YYYYMMDD.csv */
export function reportFileName(prefix: string, since?: string, until?: string): string {
  const compact = (s?: string) => (s ? String(s).replace(/[^\d]/g, '').slice(0, 8) : 'all');
  return `${prefix}-${compact(since)}-${compact(until)}.csv`;
}
