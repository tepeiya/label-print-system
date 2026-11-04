// 动态菜单目录（docs/11 §11.4.6 / P0 验收项「/auth/me 返回 menus」）——纯函数
// 菜单可见性 = 模块已订阅（L2）&& 有入口权限点（L1）；父级只要有一个可见子项就保留。
// 这里的 path 与 apps/console/src/router/index.ts 的路由一一对应，前端不再硬编码菜单。
import { matchPermission } from '../common/permission-match';

export interface MenuNode {
  key: string;
  name: string;
  icon?: string;
  path?: string;
  module?: string;
  permission?: string;
  children?: MenuNode[];
}

export const MENU_CATALOG: MenuNode[] = [
  { key: 'dashboard', name: '仪表盘', icon: 'DataBoard', path: '/dashboard', module: 'print', permission: 'print:stats:read' },
  {
    key: 'print',
    name: '打印',
    icon: 'Printer',
    module: 'print',
    children: [
      { key: 'print-jobs', name: '打印任务', icon: 'List', path: '/print-jobs', module: 'print', permission: 'print:job:read' },
      { key: 'designer', name: '标签设计器', icon: 'Edit', path: '/designer', module: 'templates', permission: 'template:write' },
      { key: 'templates', name: '模板库', icon: 'Document', path: '/templates', module: 'templates', permission: 'template:read' },
    ],
  },
  {
    key: 'data',
    name: '数据源',
    icon: 'Coin',
    module: 'datasource',
    children: [
      { key: 'datasource', name: '数据源管理', icon: 'Coin', path: '/datasource', module: 'datasource', permission: 'datasource:read' },
    ],
  },
  {
    key: 'system',
    name: '系统管理',
    icon: 'Setting',
    children: [
      { key: 'users', name: '用户管理', icon: 'User', path: '/users', module: 'users', permission: 'sys:user:read' },
      { key: 'audit', name: '审计日志', icon: 'Document', path: '/audit', module: 'audit', permission: 'audit:read' },
      { key: 'backups', name: '备份中心', icon: 'Folder', path: '/backups', module: 'backup', permission: 'backup:read' },
    ],
  },
  // 订阅页永远可见：租户被降级/停用时要能看到自己买了什么、怎么续费
  { key: 'subscription', name: '我的订阅', icon: 'Tickets', path: '/subscription' },
];

function nodeVisible(node: MenuNode, modules: string[], permissions: string[]): boolean {
  if (node.module && !modules.includes(node.module)) return false;
  if (node.permission && !matchPermission(permissions, node.permission)) return false;
  return true;
}

/** 按模块订阅 + 权限点裁剪菜单树；父节点全空则一并剔除 */
export function buildMenus(modules: string[], permissions: string[], catalog: MenuNode[] = MENU_CATALOG): MenuNode[] {
  const mods = modules ?? [];
  const perms = permissions ?? [];
  const out: MenuNode[] = [];

  for (const node of catalog) {
    const children = node.children?.length ? buildMenus(mods, perms, node.children) : [];
    if (node.children?.length) {
      if (children.length) out.push({ ...node, children });
      continue;                       // 纯分组节点：自身不参与可见性判断
    }
    if (nodeVisible(node, mods, perms)) {
      const { children: _drop, ...rest } = node;
      out.push(rest);
    }
  }
  return out;
}
