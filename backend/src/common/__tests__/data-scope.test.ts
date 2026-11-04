// =============================================================================
// data-scope.test.ts —— L3 数据范围合并与查询片段（§11.4.5）
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeDataScopes, scopeClause, dataScopeOf, SCOPE_ALL } from '../data-scope';

test('没有任何 data_scopes 记录 → all（对存量租户零行为变化）', () => {
  assert.deepEqual(mergeDataScopes([]), SCOPE_ALL);
});

test('出现 all 直接短路，不再累加具体值', () => {
  const s = mergeDataScopes([
    { scopeType: 'warehouse', scopeValue: '3' },
    { scopeType: 'all', scopeValue: null },
  ]);
  assert.deepEqual(s, { type: 'all', values: [] });
});

test('同类型多行 → 值去重合并', () => {
  const s = mergeDataScopes([
    { scopeType: 'warehouse', scopeValue: '3' },
    { scopeType: 'warehouse', scopeValue: '5' },
    { scopeType: 'warehouse', scopeValue: '3' },
  ]);
  assert.equal(s.type, 'warehouse');
  assert.deepEqual(s.values, ['3', '5']);
});

test('混合类型取最宽的（warehouse 盖过 self / dept）', () => {
  const s = mergeDataScopes([
    { scopeType: 'self', scopeValue: null },
    { scopeType: 'dept', scopeValue: '10' },
    { scopeType: 'warehouse', scopeValue: '7' },
  ]);
  assert.equal(s.type, 'warehouse');
  assert.deepEqual(s.values, ['7']);
});

test('self 且没配值 → 用当前用户 id 兜底', () => {
  const s = mergeDataScopes([{ scopeType: 'self', scopeValue: null }], 42);
  assert.deepEqual(s, { type: 'self', values: ['42'] });
});

test('scopeClause：all 不加条件，限定范围生成 IN 片段，没值时拒绝一切', () => {
  assert.deepEqual(scopeClause('t.tenant_id', SCOPE_ALL), { sql: '1 = 1', params: {} });
  const c = scopeClause('t.warehouse_id', { type: 'warehouse', values: ['3', '5'] });
  assert.equal(c.sql, 't.warehouse_id IN (:...dataScopeValues)');
  assert.deepEqual(c.params, { dataScopeValues: ['3', '5'] });
  assert.deepEqual(scopeClause('t.warehouse_id', { type: 'dept', values: [] }), { sql: '1 = 0', params: {} });
});

test('dataScopeOf 从上下文取，缺省回退 all', () => {
  assert.deepEqual(dataScopeOf({}), SCOPE_ALL);
  assert.deepEqual(dataScopeOf({ dataScopes: { type: 'self', values: ['9'] } }), { type: 'self', values: ['9'] });
});
