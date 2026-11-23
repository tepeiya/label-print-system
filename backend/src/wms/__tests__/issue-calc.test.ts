// 发料计算/幂等键/扫码校验单测（docs/16 §9.1）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lineRequiredQty, issueIdemKey, returnIdemKey, reprintIdemKey,
  checkOverIssue, lineStatus, verifyIssueScan,
} from '../issuing/services/issue-calc';

test('行需求量 = qty_per×(1+loss_rate)×demand（三位小数）', () => {
  assert.equal(lineRequiredQty(2, 0, 10), 20);
  assert.equal(lineRequiredQty(2, 0.05, 10), 21);
  assert.equal(lineRequiredQty(1.234, 0.025, 3), 3.795);   // 1.234×1.025×3=3.79455→3.795
  assert.equal(lineRequiredQty(0.3333, 0, 3), 1);   // 0.9999 → 四舍五入到三位为 1
});

test('幂等键格式与迁移注释一致', () => {
  assert.equal(issueIdemKey('WO20261123', 3), 'ISSUE:WO20261123:3');
  assert.equal(returnIdemKey('WO1', 2, 1), 'RETURN:WO1:2:1');
  assert.equal(reprintIdemKey('WO1', 2, 5), 'ISSUE:WO1:2:reprint:5');
});

test('超发检查：正好发满通过，超出拒绝并给出超出量', () => {
  const ok = checkOverIssue(8, 10, 2);
  assert.equal(ok.ok, true);
  assert.equal(ok.nextIssued, 10);

  const over = checkOverIssue(9, 10, 3);
  assert.equal(over.ok, false);
  assert.equal(over.over, 2);
  assert.match(over.reason!, /超发/);
});

test('超发检查：非正数本次量拒绝；浮点临界不误判', () => {
  assert.equal(checkOverIssue(0, 10, 0).ok, false);
  assert.equal(checkOverIssue(0, 10, -1).ok, false);
  // 累计 0.1+0.2 类型：需求 0.3，已发 0.1，本次 0.2 应通过
  assert.equal(checkOverIssue(0.1, 0.3, 0.2).ok, true);
});

test('行状态：PENDING / PARTIAL / DONE / SHORT', () => {
  assert.equal(lineStatus(0, 10, 0), 'PENDING');
  assert.equal(lineStatus(0, 10, 4, true), 'SHORT');
  assert.equal(lineStatus(4, 10, 6), 'PARTIAL');
  assert.equal(lineStatus(10, 10, 0), 'DONE');
  assert.equal(lineStatus(9.999, 10, 0.001), 'PARTIAL');
});

test('扫码校验：三项全对通过', () => {
  const v = verifyIssueScan(
    { materialCode: 'M001', batchNo: 'B1', locationId: 12 },
    { materialCode: 'M001', batchNo: 'B1', locationId: 12 },
  );
  assert.equal(v.ok, true);
  assert.equal(v.checked, 3);
  assert.match(v.message, /比对 3 项/);
});

test('扫码校验：扫错 SKU 拦截并说明期望/实际', () => {
  const v = verifyIssueScan({ materialCode: 'M001', batchNo: 'B1' }, { materialCode: 'M002', batchNo: 'B1' });
  assert.equal(v.ok, false);
  assert.equal(v.mismatches[0].field, 'material');
  assert.match(v.message, /物料 应为 M001，实际 M002/);
});

test('扫码校验：批次/库位不符都能单独拦截', () => {
  const b = verifyIssueScan({ materialCode: 'M001', batchNo: 'B1' }, { materialCode: 'M001', batchNo: 'B2' });
  assert.equal(b.ok, false);
  assert.equal(b.mismatches[0].field, 'batch');

  const l = verifyIssueScan({ materialCode: 'M001', locationCode: 'A-01' }, { materialCode: 'M001', locationCode: 'A-02' });
  assert.equal(l.ok, false);
  assert.equal(l.mismatches[0].field, 'location');

  const lid = verifyIssueScan({ locationId: 7 }, { locationId: 8 });
  assert.equal(lid.ok, false);
});

test('扫码校验：空扫描提示先扫码；未扫到的字段不误判', () => {
  const empty = verifyIssueScan({ materialCode: 'M001', batchNo: 'B1' }, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.checked, 0);
  assert.match(empty.message, /未扫到任何字段/);

  // 只扫了物料，批次没扫 → 不判批次
  const partial = verifyIssueScan({ materialCode: 'M001', batchNo: 'B1' }, { materialCode: 'M001' });
  assert.equal(partial.ok, true);
  assert.equal(partial.checked, 1);
});
