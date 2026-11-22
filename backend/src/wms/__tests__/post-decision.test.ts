// 过账决策纯函数测试（无 entity/Nest 依赖，node:test 可直接跑）
// 覆盖文档 13.2 集成场景中的关键规则：幂等键、库存落点硬约束、超收/短收、打印变量组装。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  receiptIdemKey, reprintIdemKey, stockIdemKey, assertStockLocation, calcDiff, buildReceiptVariables,
} from '../inbound/services/post-decision.calc';

test('幂等键口径：收货/补打/库存三方互不冲突', () => {
  assert.equal(receiptIdemKey('GRN202611220001', 1), 'GRN:GRN202611220001:1');
  assert.equal(stockIdemKey('GRN202611220001', 1), 'STOCK:GRN:GRN202611220001:1');
  assert.equal(reprintIdemKey('GRN202611220001', 1, 1), 'GRN:GRN202611220001:1:reprint:1');
  assert.notEqual(receiptIdemKey('G', 1), reprintIdemKey('G', 1, 1), '补打必须用新键，不覆盖原打印');
  assert.notEqual(reprintIdemKey('G', 1, 1), reprintIdemKey('G', 1, 2), '多次补打序号递增');
});

test('库存落点硬约束（C5）：无库位一律拒绝过账', () => {
  assert.equal(assertStockLocation(10), 10);
  assert.throws(() => assertStockLocation(null), /无可用库位|禁止过账/);
  assert.throws(() => assertStockLocation(undefined), /无可用库位|禁止过账/);
  assert.throws(() => assertStockLocation(NaN), /无可用库位|禁止过账/);
  assert.throws(() => assertStockLocation(0), /无可用库位|禁止过账/);
  assert.equal(assertStockLocation(10, '自定义原因'), 10);
});

test('超收/短收差异计算（含扫码累加场景）', () => {
  assert.deepEqual(calcDiff(100, 60), { diffType: 'SHORT', diffQty: 40 });
  assert.deepEqual(calcDiff(100, 100), { diffType: null, diffQty: 0 });
  assert.deepEqual(calcDiff(100, 120), { diffType: 'OVER', diffQty: 20 });
  // 未设预期数量的盲收行（expected=0）不产生差异
  assert.deepEqual(calcDiff(0, 5), { diffType: null, diffQty: 0 });
});

test('打印变量由 WMS 组装：字段完整、批次为空归一为空串', () => {
  const v = buildReceiptVariables({
    skuCode: 'MAT-001', skuName: '轴承 6204', unit: 'PCS', batchNo: null,
    qty: 120, receiptNo: 'GRN001', lineNo: 1, supplierName: 'XX 供应商',
  });
  assert.equal(v.skuCode, 'MAT-001');
  assert.equal(v.skuName, '轴承 6204');
  assert.equal(v.batchNo, '');
  assert.equal(v.qty, 120);
  assert.equal(v.unit, 'PCS');
  assert.equal(v.receiptNo, 'GRN001');
  assert.equal(v.lineNo, 1);
  assert.equal(v.supplierName, 'XX 供应商');
});
