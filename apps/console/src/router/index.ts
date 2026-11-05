import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/store/auth';

/**
 * 路由表（P1）
 * 路由本身仍是静态声明的（Vue Router 需要组件映射），但**能不能进、菜单怎么排**
 * 由后端 /auth/me 的 menus / modules / permissions 决定，前端不再自行维护菜单清单。
 * meta 里的 module / permission 与 backend/src/saas/menu.catalog.ts 的条目一一对应。
 */
const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', component: () => import('@/views/Dashboard.vue'),
        meta: { title: '仪表盘', icon: 'DataBoard', module: 'print', permission: 'print:stats:read' } },
      { path: 'designer', component: () => import('@/views/Designer.vue'),
        meta: { title: '标签设计器', icon: 'Edit', module: 'templates', permission: 'template:write' } },
      { path: 'templates', component: () => import('@/views/Templates.vue'),
        meta: { title: '模板库', icon: 'Document', module: 'templates', permission: 'template:read' } },
      { path: 'print-jobs', component: () => import('@/views/PrintJobs.vue'),
        meta: { title: '打印任务', icon: 'Printer', module: 'print', permission: 'print:job:read' } },
      { path: 'ai', component: () => import('@/views/AiGenerate.vue'),
        meta: { title: 'AI 生成模板', icon: 'MagicStick', module: 'ai', permission: 'ai:generate' } },
      { path: 'datasource', component: () => import('@/views/DataSources.vue'),
        meta: { title: '数据源管理', icon: 'Coin', module: 'datasource', permission: 'datasource:read' } },
      {
        path: 'users',
        component: () => import('@/views/UserManagement.vue'),
        meta: { title: '用户管理', icon: 'User', module: 'users', permission: 'sys:user:read' },
      },
      {
        path: 'audit',
        component: () => import('@/views/AuditLogs.vue'),
        meta: { title: '审计日志', icon: 'Document', module: 'audit', permission: 'audit:read' },
      },
      {
        path: 'backups',
        component: () => import('@/views/Backups.vue'),
        meta: { title: '备份中心', icon: 'Folder', module: 'backup', permission: 'backup:read' },
      },
      // 白标（D6）：与 backend/src/saas/menu.catalog.ts 的 '/branding' 对齐。
      // module 用 users 而不是新模块——品牌配置存在 tenants.branding 上、域名表也是 SaaS 侧的，
      // 单开一个模块会让 BASIC 套餐的客户「有权限却没模块」，反而要点 /blocked。
      {
        path: 'branding',
        component: () => import('@/views/Branding.vue'),
        meta: { title: '品牌与域名', icon: 'Brush', module: 'users', permission: 'sys:branding:manage' },
      },
      {
        path: 'subscription',
        component: () => import('@/views/SubscriptionInfo.vue'),
        meta: { title: '我的订阅', icon: 'Tickets', always: true },
      },
      // P3 账单与用量：后端 BillingController 是 @RequireModule('users') + sys:billing:read，
      // meta 与之一致；path 必须叫 billing（backend/src/saas/menu.catalog.ts 的 '/billing' 有反向断言）。
      {
        path: 'billing',
        component: () => import('@/views/Billing.vue'),
        meta: { title: '账单与用量', icon: 'Wallet', module: 'users', permission: 'sys:billing:read' },
      },
      // P5 Agent 接入（后端 AgentsController 类上 @RequireModule('agent')，写操作 sys:agent:manage）。
      // ⚠️ backend/src/saas/menu.catalog.ts 里还没有这两条菜单，而下面的守卫要求
      // path 出现在 /auth/me.menus 里才放行 —— 后端补目录前，这两页只能靠直接敲 URL 进来，
      // 且会被守卫跳 /blocked。前端不改后端，先按现有约定把路由声明好。
      {
        path: 'agents',
        component: () => import('@/views/Agents.vue'),
        meta: { title: 'Agent 接入', icon: 'Connection', module: 'agent', permission: 'sys:agent:manage' },
      },
      // Agent 高危操作待确认。后端列表/确认/驳回是 manage OR approve，
      // 但 meta.permission 只能写一个：这里写 approve（主管/仓管的业务确认入口，
      // 见 backend/scripts/saas_p5_agent_tools.sql 的角色授权），
      // 只有 sys:agent:manage 的人会被这条 meta 挡在外面，属于单值 meta 的既有限制。
      {
        path: 'agent-approvals',
        component: () => import('@/views/AgentApprovals.vue'),
        meta: { title: 'Agent 待确认', icon: 'CircleCheck', module: 'agent', permission: 'sys:agent:approve' },
      },
      // 未订阅 / 权限不足的统一落地页（§11.10「模块未订阅」）
      {
        path: 'blocked',
        component: () => import('@/views/Blocked.vue'),
        meta: { title: '无法访问', always: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({ history: createWebHistory(), routes });

/** 跳统一拦截页：kind=module 给「升级套餐」引导，kind=permission 给「找管理员」引导 */
function toBlocked(kind: 'module' | 'permission', code: string, from: string) {
  return { path: '/blocked', query: { kind, code, from } };
}

// P1 守卫：登录 → 拉一次 /auth/me（刷新页面时 user 为空）→ 模块（L2）→ 权限点（L1）
router.beforeEach(async (to, _from, next) => {
  const auth = useAuthStore();

  if (to.meta.public) return next();
  if (!auth.isLoggedIn) return next({ path: '/login', query: { redirect: to.fullPath } });

  // 直接敲 URL / 刷新页面时 store 是空的，不先补一次就会把所有入口判成「无权限」
  if (!auth.user) {
    try { await auth.fetchMe(); } catch { /* fetchMe 内部会 logout，下面兜住 */ }
    if (!auth.isLoggedIn) return next({ path: '/login', query: { redirect: to.fullPath } });
  }

  // 订阅页与拦截页永远可达，否则「被降级后看不到自己买了什么」
  if (to.meta.always) return next();

  const meta = to.meta as { module?: string; permission?: string };

  if (meta.module && !auth.hasModule(meta.module)) {
    return next(toBlocked('module', meta.module, to.fullPath));
  }
  if (meta.permission && !auth.hasPermission(meta.permission)) {
    // 模块已开但没有权限点：角色限制，给权限码而不是模块名
    return next(toBlocked('permission', meta.permission, to.fullPath));
  }
  // 菜单里没有 = 后端认为该用户不该有这个入口（例如被裁剪掉的分组）
  if (auth.menus.length && !auth.menuPaths.has(to.path)) {
    return next(toBlocked('permission', meta.permission ?? meta.module ?? to.path, to.fullPath));
  }
  next();
});

export default router;
