// 成品发运纯函数测试：单号、状态收敛、动作许可、过账数量口径
// 注意：只 import calc（不 import 实体），避免 tsx 无 decorator metadata 报 ColumnTypeUndefinedError
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatShipmentNo, nextPickStatus, assertCanPost, assertCanCancel, assertCanSign,
  assertPickQty, resolveShipQty, SHIP_TYPE_TEXT, SHIP_STATUS_TEXT,
} from '../outbound/services/shipment.calc';

test('formatShipmentNo：SH-YYYYMMDD-NNNN，序号补 4 位', () => {
  const d = new Date(2026, 10, 25);   // 2026-11-25
  assert.equal(formatShipmentNo(d, 1), 'SH-20261125-0001');
  assert.equal(formatShipmentNo(d, 12345), 'SH-20261125-12345');
});

test('nextPickStatus：无拣货 CREATED / 部分 PICKING / 全拣 PICKED', () => {
  assert.equal(nextPickStatus(['PENDING', 'PENDING']), 'CREATED');
  assert.equal(nextPickStatus(['PICKED', 'PENDING']), 'PICKING');
  assert.equal(nextPickStatus(['PICKED', 'PICKED']), 'PICKED');
  // 已出库的行算已拣
  assert.equal(nextPickStatus(['SHIPPED', 'PICKED']), 'PICKED');
  assert.equal(nextPickStatus([]), 'CREATED');
});

test('assertCanPost：已出库/已签收/已作废都拦', () => {
  assert.doesNotThrow(() => assertCanPost('CREATED'));
  assert.doesNotThrow(() => assertCanPost('PICKED'));
  assert.throws(() => assertCanPost('SHIPPED'), /不能重复过账/);
  assert.throws(() => assertCanPost('SIGNED'), /不能重复过账/);
  assert.throws(() => assertCanPost('CANCELLED'), /不能过账/);
});

test('assertCanCancel：已出库不许作废（库存已动）', () => {
  assert.doesNotThrow(() => assertCanCancel('CREATED'));
  assert.doesNotThrow(() => assertCanCancel('PICKED'));
  assert.throws(() => assertCanCancel('SHIPPED'), /退货入库/);
  assert.throws(() => assertCanCancel('SIGNED'), /退货入库/);
  assert.throws(() => assertCanCancel('CANCELLED'), /已作废/);
});

test('assertCanSign：只有 SHIPPED 能签收', () => {
  assert.doesNotThrow(() => assertCanSign('SHIPPED'));
  assert.throws(() => assertCanSign('PICKED'), /只有已出库/);
  assert.throws(() => assertCanSign('SIGNED'), /只有已出库/);
});

test('assertPickQty：必须正数且不超计划量', () => {
  assert.doesNotThrow(() => assertPickQty(10, 20, 1));
  assert.doesNotThrow(() => assertPickQty(20, 20, 1));
  assert.throws(() => assertPickQty(0, 20, 1), /必须为正数/);
  assert.throws(() => assertPickQty(-1, 20, 1), /必须为正数/);
  assert.throws(() => assertPickQty(21, 20, 1), /超过计划量/);
});

test('resolveShipQty：拣过按实拣 + 记缺量；没拣按计划量直发', () => {
  // 未拣货：按计划量出，无缺量
  assert.deepEqual(resolveShipQty({ qtyPlan: 100, qtyPicked: 0, status: 'PENDING' }), { qty: 100, short: 0 });
  // 已拣 60/100：出 60，缺 40（不假装发齐）
  assert.deepEqual(resolveShipQty({ qtyPlan: 100, qtyPicked: 60, status: 'PICKED' }), { qty: 60, short: 40 });
  // 拣满
  assert.deepEqual(resolveShipQty({ qtyPlan: 100, qtyPicked: 100, status: 'PICKED' }), { qty: 100, short: 0 });
  // 有 picked 数量但状态还停在 PENDING（PDA 只录数量未改状态）：也按实拣口径
  assert.deepEqual(resolveShipQty({ qtyPlan: 50, qtyPicked: 30, status: 'PENDING' }), { qty: 30, short: 20 });
});

test('文案表：类型与状态都有中文，避免前端漏映射', () => {
  assert.equal(SHIP_TYPE_TEXT.SALES, '销售出库');
  assert.equal(SHIP_TYPE_TEXT.TRANSFER, '调拨出库');
  for (const s of ['CREATED', 'PICKING', 'PICKED', 'SHIPPED', 'SIGNED', 'CANCELLED']) {
    assert.ok(SHIP_STATUS_TEXT[s]);
  }
});
