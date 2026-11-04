// =============================================================================
// module-deps.test.ts —— 模块依赖展开与停用保护（§11.3.4）
// 依赖关系：bom → inventory → masterdata；alert → inventory；agent → print
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expandWithDependencies, blockedByOnDisable, missingDependencies, ModuleDef,
} from '../module-deps';

const CATALOG: ModuleDef[] = [
  { code: 'print', isCore: true },
  { code: 'templates', isCore: true },
  { code: 'ai', dependsOn: ['print'] },
  { code: 'masterdata', isCore: true },
  { code: 'inventory', dependsOn: ['masterdata'] },
  { code: 'bom', dependsOn: ['inventory'] },
  { code: 'alert', dependsOn: ['inventory'] },
  { code: 'agent', dependsOn: ['print'] },
];

test('加购 bom 自动补齐 inventory + masterdata', () => {
  assert.deepEqual(expandWithDependencies(['bom'], CATALOG), ['bom', 'inventory', 'masterdata']);
});

test('多个入口只补一次，且不改变已有顺序', () => {
  assert.deepEqual(
    expandWithDependencies(['alert', 'bom'], CATALOG),
    ['alert', 'inventory', 'masterdata', 'bom'],
  );
});

test('依赖成环不会死循环（配置错误时的兜底）', () => {
  const cyclic: ModuleDef[] = [{ code: 'a', dependsOn: ['b'] }, { code: 'b', dependsOn: ['a'] }];
  assert.deepEqual(expandWithDependencies(['a'], cyclic), ['a', 'b']);
});

test('目录里没有的 code 视为无依赖，不让开通失败', () => {
  assert.deepEqual(expandWithDependencies(['unknown'], CATALOG), ['unknown']);
  assert.deepEqual(expandWithDependencies([], CATALOG), []);
});

test('停用时被依赖要拒绝，并指出该先停谁', () => {
  const active = ['inventory', 'bom', 'alert', 'print'];
  assert.deepEqual(blockedByOnDisable('inventory', active, CATALOG).sort(), ['alert', 'bom']);
  assert.deepEqual(blockedByOnDisable('print', active, CATALOG), []);
});

test('套餐配置校验：依赖没进目录时报出来（运营配错能在开通前发现）', () => {
  assert.deepEqual(missingDependencies(['bom'], CATALOG), []);
  const broken: ModuleDef[] = [{ code: 'bom', dependsOn: ['inventory'] }];
  assert.deepEqual(missingDependencies(['bom'], broken), ['inventory']);
});
