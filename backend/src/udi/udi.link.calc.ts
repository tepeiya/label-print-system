// =============================================================================
// udi.link.calc.ts —— UDI × WMS 联动纯函数（U5）
//
// 职责：收货/发料场景的幂等键、状态守卫、事件 detail 组装。
// 约定：不做 IO；服务层负责建档与事件落库，规则在此可被单测穷举。
// =============================================================================
import { parseUdi, normalizeGtin } from './udi.calc';

/** 事件幂等键长度上限（与 udi_events.idem_key VARCHAR(128) 对齐） */
export const LINK_KEY_MAX = 128;

export interface CodeKeyResult {
  ok: boolean;
  udiKey?: string;
  gtin?: string;
  lot?: string;
  serial?: string;
  expiry?: string;
  errors: string[];
}

/** 扫码内容 → 追溯键（与 udiUnitKey 同口径：GTIN14|批号|序列号|GS1 六位有效期） */
export function udiKeyFromCode(code: string): CodeKeyResult {
  const raw = String(code ?? '').trim();
  if (!raw) return { ok: false, errors: ['码为空'] };
  const p = parseUdi(raw);
  if (!p.ok || !p.udi?.gtin) return { ok: false, errors: p.errors?.length ? p.errors : ['码解析失败'] };
  const gtin = normalizeGtin(p.udi.gtin);
  if (gtin.errors.length) return { ok: false, errors: gtin.errors };
  const lot = p.udi.lot ?? '';
  const serial = p.udi.serial ?? '';
  const expiry = p.udi.expiry ?? '';
  return {
    ok: true,
    errors: [],
    udiKey: [gtin.gtin14, lot, serial, expiry].join('|'),
    gtin: gtin.gtin14, lot: lot || undefined, serial: serial || undefined, expiry: expiry || undefined,
  };
}

const cap = (k: string) => (k.length <= LINK_KEY_MAX ? k : k.slice(0, LINK_KEY_MAX));

/** 收货幂等键：同一收货单 + 同一 UDI 单元只记一次 RECEIVE */
export function receiveIdemKey(receiptNo: string, udiKey: string): string {
  return cap(`RECEIVE:${receiptNo}:${udiKey}`);
}

/** 发料幂等键：同一工单 + 行 + 单元只记一次 ISSUE（与发料记录键同前缀语义） */
export function issueIdemKey(woNo: string, lineNo: number | string, udiKey: string): string {
  return cap(`ISSUE:${woNo}:${lineNo}:${udiKey}`);
}

export interface Guard {
  ok: boolean;
  reason?: string;
}

/** 收货状态守卫：只有未流转/已打印的单元可首次收货；RECEIVED 的幂等回放由事件键兜底 */
export function checkUnitForReceive(status: string): Guard {
  switch (status) {
    case 'REGISTERED': case 'PRINTED': return { ok: true };
    case 'RECEIVED': return { ok: false, reason: '该单元已收货（重复收货请核对原收货单，同单重复扫码按幂等处理）' };
    case 'ISSUED': return { ok: false, reason: '该单元已发料，不可再收货' };
    case 'SHIPPED': return { ok: false, reason: '该单元已出库，不可再收货' };
    case 'VOID': return { ok: false, reason: '该单元已作废，不可收货' };
    default: return { ok: false, reason: `未知单元状态：${status}` };
  }
}

/** 发料状态守卫：必须先收货（RECEIVED）；已发料的幂等回放由事件键兜底 */
export function checkUnitForIssue(status: string): Guard {
  switch (status) {
    case 'RECEIVED': return { ok: true };
    case 'REGISTERED': case 'PRINTED': return { ok: false, reason: '该单元尚未收货，不可发料（请先入库收货）' };
    case 'ISSUED': return { ok: false, reason: '该单元已发料（重复发料请核对原工单，同单重复扫码按幂等处理）' };
    case 'SHIPPED': return { ok: false, reason: '该单元已出库，不可再发料' };
    case 'VOID': return { ok: false, reason: '该单元已作废，不可发料' };
    default: return { ok: false, reason: `未知单元状态：${status}` };
  }
}

/** RECEIVE 事件 detail：保留 WMS 侧定位信息，便于对账 */
export function receiveDetail(p: { receiptNo?: string; lineNo?: number; skuCode?: string; qty?: number; packCount?: number; packQty?: number; packLevel?: string }) {
  return {
    source: 'wms.receive-scan',
    receiptNo: p.receiptNo ?? null,
    lineNo: p.lineNo ?? null,
    skuCode: p.skuCode ?? null,
    qty: p.qty ?? null,
    ...(p.packCount != null ? { packCount: p.packCount, packQty: p.packQty ?? null, packLevel: p.packLevel ?? null } : {}),
  };
}

/** ISSUE 事件 detail：工单 + 行 + 物料，可与发料记录（wms_issue_records）互查 */
export function issueDetail(p: { woNo?: string; lineNo?: number | string; materialCode?: string; qty?: number }) {
  return {
    source: 'wms.issue',
    woNo: p.woNo ?? null,
    lineNo: p.lineNo ?? null,
    materialCode: p.materialCode ?? null,
    qty: p.qty ?? null,
  };
}

/** 批量联动结果汇总（给前端一次性提示"成功几件、几件失败"） */
export function summarizeLink(results: Array<{ ok: boolean; idempotent?: boolean; code?: string; reason?: string }>) {
  const created = results.filter((r) => r.ok && !r.idempotent).length;
  const replayed = results.filter((r) => r.ok && r.idempotent).length;
  const failed = results.filter((r) => !r.ok).length;
  return {
    total: results.length, created, replayed, failed,
    errors: results.filter((r) => !r.ok).map((r) => ({ code: r.code ?? null, reason: r.reason ?? '未知错误' })),
  };
}
