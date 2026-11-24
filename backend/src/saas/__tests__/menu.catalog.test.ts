// =============================================================================
// menu.catalog.test.ts —— 动态菜单裁剪（docs/11 §11.4.6 / P0 验收项「/auth/me 返回 menus」）
// 规则：菜单可见 = 模块已订阅（L2）&& 有入口权限点（L1）；分组节点子项全空则剔除。
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMenus, MENU_CATALOG } from '../menu.catalog';

const keys = (tree: any[]) => tree.map((n) => n.key);
const childKeys = (tree: any[], key: string) => keys(tree.find((n) => n.key === key)?.children ?? []);

// print 分组下的两个「无门槛」叶子，断言里必须算上：
//   printers —— 目录里特意不挂 permission（docs/10 §11.12.1 保持 operator 原有能力），只认模块门；
//   print    —— 打印页，permission=print:job:write，只有通配（print:* / *）或显式授权才出现。

test('订阅页永远可见，哪怕没有任何模块和权限', () => {
  assert.deepEqual(keys(buildMenus([], [])), ['subscription']);
});

test('模块订阅 + 权限点都齐时，返回完整菜单', () => {
  const modules = ['print', 'templates', 'datasource', 'users', 'audit', 'backup', 'udi.compliance'];
  const permissions = [
    'print:stats:read', 'print:job:read', 'template:write', 'template:read',
    'datasource:read', 'sys:user:read', 'audit:read', 'backup:read',
  ];
  const tree = buildMenus(modules, permissions);
  assert.deepEqual(keys(tree), ['dashboard', 'print', 'template-center', 'data', 'udi', 'system', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs', 'printers']);
  // 医疗 UDI 走独立加购模块 udi.compliance（不随 print 套餐）
  assert.deepEqual(childKeys(tree, 'udi'), ['udi-trace', 'udi-compliance']);
  assert.deepEqual(childKeys(tree, 'template-center'), ['designer', 'templates']);
  assert.deepEqual(childKeys(tree, 'system'), ['users', 'audit', 'backups']);
});

test('AI 工作台分组：订阅 ai 且有 ai:generate 时出现「AI 生成模板」叶子', () => {
  const both = buildMenus(['ai'], ['ai:generate']);
  assert.deepEqual(keys(both), ['ai-hub', 'subscription']);
  assert.deepEqual(childKeys(both, 'ai-hub'), ['ai']);
  assert.equal(both.find((n) => n.key === 'ai-hub')?.children?.[0].path, '/ai');

  const moduleOnly = buildMenus(['ai'], ['template:read']);
  assert.ok(!keys(moduleOnly).includes('ai-hub'), '无任何 AI 权限点时整组消失');

  const permOnly = buildMenus(['print'], ['ai:generate']);
  assert.ok(!keys(permOnly).includes('ai-hub'), '未订阅 ai 模块时，有权限点也不该出现分组');
});

test('AI 工作台分组：只有 ai:models:manage 时只出现「AI 模型配置」', () => {
  const tree = buildMenus(['ai'], ['ai:models:manage']);
  assert.deepEqual(childKeys(tree, 'ai-hub'), ['ai-models']);
  assert.equal(tree.find((n) => n.key === 'ai-hub')?.children?.[0].path, '/ai-models');
});

test('只订阅 print + print:job:read 时，设计器和模板库不可见，数据源/系统管理/UDI 整组消失', () => {
  const tree = buildMenus(['print'], ['print:job:read']);
  assert.deepEqual(keys(tree), ['print', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs', 'printers']);
});

test('医疗 UDI 是独立加购模块：订阅 udi.compliance 才出现，print 不连带', () => {
  const noUdi = buildMenus(['print', 'templates'], ['*']);
  assert.ok(!keys(noUdi).includes('udi'), '未买 UDI 套件时整组不可见');

  const withUdi = buildMenus(['print', 'udi.compliance'], ['print:job:read']);
  assert.deepEqual(childKeys(withUdi, 'udi'), ['udi-trace', 'udi-compliance']);
  const group = withUdi.find((n) => n.key === 'udi');
  assert.equal(group?.module, 'udi.compliance');
  assert.ok(group?.children?.every((c) => c.module === 'udi.compliance'));
});

test('权限点决定叶子：有 templates 模块但没有 template:write 时设计器被过滤', () => {
  const tree = buildMenus(['print', 'templates'], ['template:read']);
  assert.deepEqual(childKeys(tree, 'template-center'), ['templates']);
});

test('模块门决定叶子：有 template:read 权限但未订阅 templates 模块时，模板中心整组消失', () => {
  const tree = buildMenus(['print'], ['print:job:read', 'template:read']);
  assert.deepEqual(keys(tree), ['print', 'subscription']);
  assert.equal(tree.find((n) => n.key === 'template-center'), undefined);
});

test('通配权限 print:* 放行该模块下的读入口', () => {
  const tree = buildMenus(['print'], ['print:*']);
  assert.deepEqual(keys(tree), ['dashboard', 'print', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs', 'printers', 'print']);
});

test('* 全局通配：权限维度假设成立，但模块门仍然限制未订阅的模块', () => {
  const tree = buildMenus(['print'], ['*']);
  assert.deepEqual(keys(tree), ['dashboard', 'print', 'subscription']);
  assert.deepEqual(childKeys(tree, 'print'), ['print-jobs', 'printers', 'print']);
});

test('叶子节点不带 children 字段，分组节点保留 children', () => {
  const tree = buildMenus(['print', 'templates'], ['print:*', 'template:*']);
  const leaf = tree.find((n) => n.key === 'print');
  assert.ok(leaf.children && leaf.children.length > 0);
  for (const c of leaf.children!) assert.equal('children' in c, false);
});

test('呆滞预警入口：订阅 alert 且有 alert:event:read 才出现在库存分组，路径 /alerts', () => {
  const withAlert = buildMenus(['inventory', 'alert'], ['inventory:stock:read', 'alert:event:read']);
  const inv = withAlert.find((n) => n.key === 'inventory');
  assert.ok(inv?.children?.some((c) => c.key === 'alerts' && c.path === '/alerts' && c.module === 'alert'));

  // 只订 inventory、没有 alert 模块：即便有权限点也不出现（模块是门）
  const noModule = buildMenus(['inventory'], ['inventory:stock:read', 'alert:event:read']);
  const inv2 = noModule.find((n) => n.key === 'inventory');
  assert.ok(!inv2?.children?.some((c) => c.key === 'alerts'));
});

test('BOM 齐套率入口：订阅 bom 且有 bom:kit:read 才出现在库存分组，路径 /bom', () => {
  const withBom = buildMenus(['inventory', 'bom'], ['inventory:stock:read', 'bom:kit:read']);
  const inv = withBom.find((n) => n.key === 'inventory');
  assert.ok(inv?.children?.some((c) => c.key === 'bom' && c.path === '/bom' && c.module === 'bom'));

  // 只订 inventory、没有 bom 模块：即便有权限点也不出现（加购模块是门）
  const noModule = buildMenus(['inventory'], ['inventory:stock:read', 'bom:kit:read']);
  const inv2 = noModule.find((n) => n.key === 'inventory');
  assert.ok(!inv2?.children?.some((c) => c.key === 'bom'));
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
