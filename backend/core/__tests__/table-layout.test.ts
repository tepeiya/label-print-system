// 表格合并布局单一真源 + 前后端 parity
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMerges, buildTableLayout, cellIndexOf } from '../table-layout';
// @ts-ignore 前端 parity 副本
import * as fe from '../../../apps/console/src/views/designer/engine/table-layout.ts';

test('normalizeMerges：钳制边界、丢弃 1x1、去重、去重叠', () => {
  const out = normalizeMerges(3, 4, [
    { row: 0, col: 0, rowSpan: 1, colSpan: 2 },
    { row: 0, col: 1, rowSpan: 2, colSpan: 1 },  // 与上面重叠 → 剔除
    { row: 5, col: 5, rowSpan: 2, colSpan: 2 },  // 越界 → 钳制到 (2,3) 1x1 → 丢弃
    { row: 1, col: 1, rowSpan: 1, colSpan: 1 },  // 1x1 → 丢弃
    { row: 2, col: 0, rowSpan: 9, colSpan: 9 },  // 钳制到 1x4
    null,
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { row: 0, col: 0, rowSpan: 1, colSpan: 2 });
  assert.deepEqual(out[1], { row: 2, col: 0, rowSpan: 1, colSpan: 4 });
});

test('buildTableLayout：skip/spans 正确', () => {
  const l = buildTableLayout(3, 3, [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }]);
  assert.deepEqual(l.spans['0,0'], { rowSpan: 2, colSpan: 2 });
  assert.ok(l.skipped.includes('0,1'));
  assert.ok(l.skipped.includes('1,0'));
  assert.ok(l.skipped.includes('1,1'));
  assert.ok(!l.skipped.includes('2,0'), '合并区外不应 skip');
  assert.equal(l.merges.length, 1);
});

test('buildTableLayout：空合并时无 skip，所有格独立', () => {
  const l = buildTableLayout(2, 2, null);
  assert.deepEqual(l.skipped, []);
  assert.deepEqual(l.spans, {});
  assert.equal(cellIndexOf(1, 1, 2), 3);
});

test('parity：前后端 table-layout 输出一致', () => {
  const input = [
    { row: 0, col: 0, rowSpan: 2, colSpan: 2 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1 },
    { row: 2, col: 2, rowSpan: 5, colSpan: 5 },
  ];
  assert.deepEqual(fe.normalizeMerges(3, 3, input), normalizeMerges(3, 3, input));
  assert.deepEqual(fe.buildTableLayout(3, 3, input), buildTableLayout(3, 3, input));
});
