import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/store/auth';

const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', component: () => import('@/views/Dashboard.vue'), meta: { title: '仪表盘', icon: 'DataBoard' } },
      { path: 'designer', component: () => import('@/views/Designer.vue'), meta: { title: '标签设计器', icon: 'Edit' } },
      { path: 'templates', component: () => import('@/views/Templates.vue'), meta: { title: '模板库', icon: 'Document' } },
      { path: 'print-jobs', component: () => import('@/views/PrintJobs.vue'), meta: { title: '打印任务', icon: 'Printer' } },
      {
        path: 'users',
        component: () => import('@/views/UserManagement.vue'),
        meta: { title: '用户管理', icon: 'User', permission: 'user:manage' },
      },
      {
        path: 'backups',
        component: () => import('@/views/Backups.vue'),
        meta: { title: '备份中心', icon: 'Folder', permission: 'backup:manage' },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({ history: createWebHistory(), routes });

// 权限守卫
router.beforeEach((to, _from, next) => {
  const auth = useAuthStore();

  if (to.meta.public) return next();
  if (!auth.isLoggedIn) return next({ path: '/login', query: { redirect: to.fullPath } });

  if (to.meta.permission && !auth.hasPermission(to.meta.permission as string)) {
    // 无权限跳 dashboard
    return next('/dashboard');
  }
  next();
});

export default router;
