// =============================================================================
// menu.catalog.test.ts —— 动态菜单裁剪（docs/11 §11.4.6 / P0 验收项「/auth/me 返回 menus」）
// 规则：菜单可见 = 模块已订阅（L2）&& 有入口权限点（L1）；分组节点子项全空则剔除。
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMenus, MENU_CATALOG } from '../menu.catalog';

const keys = (tree: any[]) => tree.map((n) => n.key);
const childKeys = (tree: any[], key: string) => keys(tree.find((n) => n.key === key)?.children ?? []);

test('订阅页永远可见，哪怕没有任何模块和权限', () => {
  assert.deepEqual(keys(buildMenus([], [])), ['subscription']);
});

test('模块订阅 + 权限点都齐时，返回完整菜单', () => {
  const modules = ['print', 'templates', 'datasource', 'users', 'audit', 'backup'];
  const permissions = [
    'print:stats:read', 'print:job:read', 'template:write', 'template:read',
    'datasource:read', 'sys:user:read', 'audit:read', 'backup:read',
  ];
  const tree = buildMenus(modules, permissions);
  assert.deepEqual(keys(tree), ['dashboard', 'print', 'data', 'system', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs', 'designer', 'templates']);
  assert.deepEqual(childKeys(tree, 'system'), ['users', 'audit', 'backups']);
});

test('AI 入口：订阅 ai 且有 ai:generate 才出现；只有模块没有权限点也不给入口', () => {
  const both = buildMenus(['ai'], ['ai:generate']);
  assert.ok(keys(both).includes('ai'));
  assert.equal(childKeys(both, 'ai').length, 0, 'AI 是叶子节点，不该带 children');

  const moduleOnly = buildMenus(['ai'], ['template:read']);
  assert.ok(!keys(moduleOnly).includes('ai'));

  const permOnly = buildMenus(['print'], ['ai:generate']);
  assert.ok(!keys(permOnly).includes('ai'), '未订阅 ai 模块时，有权限点也不该出现入口');
});

test('只订阅 print + print:job:read 时，设计器和模板库不可见，数据源/系统管理整组消失', () => {
  const tree = buildMenus(['print'], ['print:job:read']);
  assert.deepEqual(keys(tree), ['print', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs']);
});

test('权限点决定叶子：有 templates 模块但没有 template:write 时设计器被过滤', () => {
  const tree = buildMenus(['print', 'templates'], ['template:read']);
  assert.deepEqual(childKeys(tree, 'print'), ['templates']);
});

test('模块门决定叶子：有 template:read 权限但未订阅 templates 模块时仍不可见（模块是门，权限是钥匙）', () => {
  const tree = buildMenus(['print'], ['print:job:read', 'template:read']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs']);
});

test('通配权限 print:* 放行该模块下的读入口', () => {
  const tree = buildMenus(['print'], ['print:*']);
  assert.deepEqual(keys(tree), ['dashboard', 'print', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs']);
});

test('* 全局通配：权限维度假设成立，但模块门仍然限制未订阅的模块', () => {
  const tree = buildMenus(['print'], ['*']);
  assert.deepEqual(keys(tree), ['dashboard', 'print', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs']);
});

test('叶子节点不带 children 字段，分组节点保留 children', () => {
  const tree = buildMenus(['print', 'templates'], ['print:*', 'template:*']);
  const leaf = tree.find((n) => n.key === 'print');
  assert.ok(leaf.children && leaf.children.length > 0);
  for (const c of leaf.children!) assert.equal('children' in c, false);
});

test('裁剪不修改目录常量（前端可安全复用 MENU_CATALOG）', () => {
  const before = JSON.stringify(MENU_CATALOG);
  buildMenus(['print'], ['*']);
  buildMenus([], []);
  assert.equal(JSON.stringify(MENU_CATALOG), before);
});

test('入参为 null/undefined 时不抛异常，只返回订阅页', () => {
  const tree = buildMenus(undefined as any, null as any);
  assert.deepEqual(keys(tree), ['subscription']);
});

// -----------------------------------------------------------------------------
// 菜单目录 ↔ 前端路由一致性（P1 加的反向断言）
// 菜单是后端下发的，路由组件是前端静态声明的，两边靠 path 对齐。
// 只加目录不加路由 → 用户点了入口进 404/通配重定向；这类错误单测能提前抓到。
// -----------------------------------------------------------------------------
test('MENU_CATALOG 的每个叶子 path 都能在 console 路由表里找到', (t) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.resolve(__dirname, '../../../../apps/console/src/router/index.ts');
  if (!fs.existsSync(file)) {
    // 单独跑后端包（或没有前端源码的环境）时跳过，不能因此让 CI 变红
    t.skip(`${file} 不存在，跳过前后端路由一致性检查`);
    return;
  }
  const src = fs.readFileSync(file, 'utf8');

  const leaves: string[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.path) leaves.push(n.path);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(MENU_CATALOG);

  assert.ok(leaves.length >= 8, `目录里应有至少 8 个带 path 的节点，实际 ${leaves.length}`);
  for (const p of leaves) {
    const seg = p.replace(/^\//, '');
    // 路由表里子路由写成 { path: 'users', ... }（无前导斜杠）
    const hit = new RegExp(`path:\\s*['\"]${seg}['\"]`).test(src);
    assert.ok(hit, `菜单 path ${p} 在 apps/console/src/router/index.ts 里没有对应路由`);
  }
});
