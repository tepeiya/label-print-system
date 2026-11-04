// =============================================================================
// permission-match.test.ts —— 权限点通配匹配（§10.9 #5 补测试）
// 这套逻辑原先在 PermissionsService 和 PermissionGuard 各有一份，现已收敛到 common/permission-match
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchPermission, matchAnyPermission } from '../permission-match';

test('精确匹配放行', () => {
  assert.equal(matchPermission(['print:job:read'], 'print:job:read'), true);
});

test('* 全局通配放行任意权限点', () => {
  assert.equal(matchPermission(['*'], 'inventory:stock:adjust'), true);
});

test('模块通配 print:* 放行该模块下任意权限点', () => {
  assert.equal(matchPermission(['print:*'], 'print:job:submit'), true);
  assert.equal(matchPermission(['print:*'], 'print:printer:manage'), true);
});

test('资源通配 print:job:* 放行同资源任意动作', () => {
  assert.equal(matchPermission(['print:job:*'], 'print:job:cancel'), true);
});

test('两段式通配 template:* 放行三段式权限点（历史数据两种长度混用）', () => {
  assert.equal(matchPermission(['template:*'], 'template:read'), true);
});

test('跨模块不能越权', () => {
  assert.equal(matchPermission(['print:*'], 'inventory:stock:read'), false);
  assert.equal(matchPermission(['print:job:read'], 'print:job:submit'), false);
  assert.equal(matchPermission(['print:job:*'], 'print:printer:manage'), false);
});

test('空权限列表一律拒绝；空 wanted 视为无要求放行', () => {
  assert.equal(matchPermission([], 'print:job:read'), false);
  assert.equal(matchPermission(undefined as any, 'print:job:read'), false);
  assert.equal(matchPermission(['print:*'], ''), true);
});

test('matchAnyPermission 任一满足即通过', () => {
  const perms = ['template:read'];
  assert.equal(matchAnyPermission(perms, ['audit:export', 'template:read']), true);
  assert.equal(matchAnyPermission(perms, ['audit:export', 'backup:restore']), false);
  assert.equal(matchAnyPermission(perms, []), false);
});
