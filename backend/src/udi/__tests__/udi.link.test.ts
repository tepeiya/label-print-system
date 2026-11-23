// UDI × WMS 联动纯函数单测（U5）：追溯键口径、幂等键、状态守卫、detail 组装
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  udiKeyFromCode, receiveIdemKey, issueIdemKey,
  checkUnitForReceive, checkUnitForIssue, receiveDetail, issueDetail,
  summarizeLink, LINK_KEY_MAX,
} from '../udi.link.calc';

const HRI = '(01)06901234567892(17)271231(10)LOT202611(21)SN0001';

test('追溯键：与 unitKey 同口径（GTIN14|批号|序列号|六位有效期）', () => {
  const r = udiKeyFromCode(HRI);
  assert.equal(r.ok, true);
  assert.equal(r.udiKey, '06901234567892|LOT202611|SN0001|271231');
  assert.equal(r.gtin, '06901234567892');
  assert.equal(r.expiry, '271231');
});

test('追溯键：脏码返回错误而不是半截键', () => {
  const r = udiKeyFromCode('not-a-gs1-code');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.equal(r.udiKey, undefined);
});

test('收货幂等键：单号 + 单元维度唯一', () => {
  const key = receiveIdemKey('GRN-001', '06901234567892|LOT202611|SN0001|271231');
  assert.equal(key, 'RECEIVE:GRN-001:06901234567892|LOT202611|SN0001|271231');
  assert.notEqual(key, receiveIdemKey('GRN-002', '06901234567892|LOT202611|SN0001|271231'));
});

test('发料幂等键：工单 + 行 + 单元维度唯一', () => {
  const key = issueIdemKey('WO20261123', 3, '06901234567892|LOT202611|SN0001|271231');
  assert.equal(key, 'ISSUE:WO20261123:3:06901234567892|LOT202611|SN0001|271231');
});

test('幂等键超长截断到 128（与 idem_key 列宽对齐）', () => {
  const long = 'X'.repeat(200);
  assert.equal(receiveIdemKey(long, long).length, LINK_KEY_MAX);
  assert.equal(issueIdemKey(long, 1, long).length, LINK_KEY_MAX);
});

test('收货守卫：只有未流转/已打印可首次收货', () => {
  assert.equal(checkUnitForReceive('REGISTERED').ok, true);
  assert.equal(checkUnitForReceive('PRINTED').ok, true);
  for (const s of ['RECEIVED', 'ISSUED', 'SHIPPED', 'VOID', 'UNKNOWN']) {
    const g = checkUnitForReceive(s);
    assert.equal(g.ok, false, `状态 ${s} 应拒绝`);
    assert.ok(g.reason && g.reason.length > 0);
  }
});

test('发料守卫：必须先收货；已发料/已出库/作废均拒绝', () => {
  assert.equal(checkUnitForIssue('RECEIVED').ok, true);
  for (const s of ['REGISTERED', 'PRINTED', 'ISSUED', 'SHIPPED', 'VOID']) {
    const g = checkUnitForIssue(s);
    assert.equal(g.ok, false, `状态 ${s} 应拒绝`);
    assert.ok(g.reason && g.reason.length > 0);
  }
});

test('detail 组装：RECEIVE 带收货单/行/SKU/数量', () => {
  const d = receiveDetail({ receiptNo: 'GRN-1', lineNo: 2, skuCode: 'FG-001', qty: 5 });
  assert.deepEqual(d, { source: 'wms.receive-scan', receiptNo: 'GRN-1', lineNo: 2, skuCode: 'FG-001', qty: 5 });
});

test('detail 组装：ISSUE 带工单/行/物料；缺省置 null', () => {
  const d = issueDetail({ woNo: 'WO-1', lineNo: 3, materialCode: 'RM-001' });
  assert.equal(d.source, 'wms.issue');
  assert.equal(d.woNo, 'WO-1');
  assert.equal(d.materialCode, 'RM-001');
  const empty = issueDetail({});
  assert.equal(empty.woNo, null);
});

test('批量汇总：成功/回放/失败分列', () => {
  const s = summarizeLink([
    { ok: true, code: 'A' }, { ok: true, idempotent: true, code: 'B' }, { ok: false, code: 'C', reason: '未收货' },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.created, 1);
  assert.equal(s.replayed, 1);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.errors, [{ code: 'C', reason: '未收货' }]);
});
