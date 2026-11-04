import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/store/auth';

const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', component: () => import('@/views/Dashboard.vue'),
        meta: { title: '仪表盘', icon: 'DataBoard', module: 'print' } },
      { path: 'designer', component: () => import('@/views/Designer.vue'),
        meta: { title: '标签设计器', icon: 'Edit', module: 'print', permission: 'template:write' } },
      { path: 'templates', component: () => import('@/views/Templates.vue'),
        meta: { title: '模板库', icon: 'Document', module: 'templates', permission: 'template:read' } },
      { path: 'print-jobs', component: () => import('@/views/PrintJobs.vue'),
        meta: { title: '打印任务', icon: 'Printer', module: 'print', permission: 'print:job:read' } },
      {
        path: 'users',
        component: () => import('@/views/UserManagement.vue'),
        meta: { title: '用户管理', icon: 'User', module: 'users', permission: 'sys:user:manage' },
      },
      {
        path: 'backups',
        component: () => import('@/views/Backups.vue'),
        meta: { title: '备份中心', icon: 'Folder', module: 'backup', permission: 'backup:read' },
      },
      {
        path: 'subscription',
        component: () => import('@/views/SubscriptionInfo.vue'),
        meta: { title: '我的订阅', icon: 'Tickets' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({ history: createWebHistory(), routes });

// SaaS P0 综合守卫：登录 → 模块 → 权限
router.beforeEach((to, _from, next) => {
  const auth = useAuthStore();

  if (to.meta.public) return next();
  if (!auth.isLoggedIn) return next({ path: '/login', query: { redirect: to.fullPath } });

  // SaaS P0：先检查模块订阅，再检查细粒度权限
  if (to.meta.module && !auth.hasModule(to.meta.module as string)) {
    // 模块未开通 → 跳订阅页
    return next('/subscription');
  }
  if (to.meta.permission && !auth.hasPermission(to.meta.permission as string)) {
    // 模块已开但无具体权限 → 说明是角色限制，跳 dashboard
    return next('/dashboard');
  }
  next();
});

export default router;
