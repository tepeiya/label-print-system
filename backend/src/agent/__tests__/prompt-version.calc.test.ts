// Prompt 版本历史 / 角色分发 / 版本号纯函数测试（无 Nest/TypeORM 依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotOf, snapshotChanged, versionSummary, visibleToRoles, nextVersion,
  type PromptSnapshot,
} from '../prompt.calc';

const snap = (over: Partial<PromptSnapshot> = {}): PromptSnapshot => ({
  title: '库存健康检查', description: 'desc', content: '请分析库存 {{sku}} 的健康状况并给出建议',
  arguments: [{ name: 'sku', required: true }], enabled: true, sortOrder: 100, ...over,
});

test('snapshotOf 归一化：丢弃坏值、参数非数组归空、布尔与排序兜底', () => {
  const s = snapshotOf({ title: undefined, description: null, content: undefined,
    arguments: 'bad', enabled: undefined, sortOrder: NaN } as any);
  assert.equal(s.title, '');
  assert.equal(s.description, '');
  assert.equal(s.content, '');
  assert.deepEqual(s.arguments, []);
  assert.equal(s.enabled, true);
  assert.equal(s.sortOrder, 100);
});

test('snapshotChanged：内容相同不算变更，任一关键字段变化即算', () => {
  assert.equal(snapshotChanged(snap(), snap()), false);
  assert.equal(snapshotChanged(snap(), snap({ content: '换了正文内容超过十个字符' })), true);
  assert.equal(snapshotChanged(snap(), snap({ title: '新标题' })), true);
  assert.equal(snapshotChanged(snap(), snap({ enabled: false })), true);
  assert.equal(snapshotChanged(snap(), snap({ arguments: [] })), true);
});

test('versionSummary 输出可读变更摘要', () => {
  assert.ok(versionSummary(snap(), snap({ content: '新的正文内容足够长' }), 'upsert').includes('正文'));
  assert.ok(versionSummary(snap({ enabled: true }), snap({ enabled: false }), 'upsert').includes('停用'));
  assert.ok(versionSummary(snap(), snap(), 'rollback').includes('回滚'));
});

test('visibleToRoles：空 roles 全员可见，非空按角色命中', () => {
  const items = [
    { name: 'all', roles: [] },
    { name: 'mgr', roles: ['manager'] },
    { name: 'mgr-or-buyer', roles: ['manager', 'purchaser'] },
  ];
  assert.deepEqual(visibleToRoles(items, []).map((i) => i.name), ['all'], '无角色时只下发全员项（fail-closed）');
  assert.deepEqual(visibleToRoles(items, ['manager']).map((i) => i.name), ['all', 'mgr', 'mgr-or-buyer']);
  assert.deepEqual(visibleToRoles(items, ['purchaser']).map((i) => i.name), ['all', 'mgr-or-buyer']);
  assert.deepEqual(visibleToRoles(items, ['viewer']).map((i) => i.name), ['all']);
});

test('nextVersion：递增，坏值防御', () => {
  assert.equal(nextVersion(1), 2);
  assert.equal(nextVersion(7), 8);
  assert.equal(nextVersion(0), 2);
  assert.equal(nextVersion(NaN), 2);
  assert.equal(nextVersion('3'), 4);
});
