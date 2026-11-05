import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/store/auth';

/** 左侧固定菜单项（页面只有 6 个，静态声明即可；平台身份不做模块裁剪菜单） */
export interface PlatformMenuItem {
  path: string;
  title: string;
  icon: string;
}

export const PLATFORM_MENUS: PlatformMenuItem[] = [
  { path: '/tenants', title: '租户管理', icon: 'OfficeBuilding' },
  { path: '/plans', title: '套餐配置', icon: 'Tickets' },
  { path: '/billing', title: '账单中心', icon: 'Money' },
  { path: '/usage', title: '用量看板', icon: 'DataBoard' },
  { path: '/tenant-data', title: '数据保留与导出', icon: 'Files' },
  { path: '/audit', title: '平台审计', icon: 'Document' },
];

/**
 * 路由表（P2 平台运营后台 + P3 计费运营 UI + P6.3 数据保留/导出硬删）。
 * 菜单标题的唯一来源是上面的 PLATFORM_MENUS，这里只声明 path → 组件的映射。
 */
const routes: RouteRecordRaw[] = [
  { path: '/login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('@/layouts/PlatformLayout.vue'),
    redirect: '/tenants',
    children: [
      { path: 'tenants', component: () => import('@/views/Tenants.vue') },
      { path: 'plans', component: () => import('@/views/Plans.vue') },
      { path: 'billing', component: () => import('@/views/Billing.vue') },
      { path: 'usage', component: () => import('@/views/Usage.vue') },
      { path: 'tenant-data', component: () => import('@/views/TenantData.vue') },
      { path: 'audit', component: () => import('@/views/Audit.vue') },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/tenants' },
];

const router = createRouter({ history: createWebHistory(), routes });

// 守卫：无 token 一律去 /login 并带上 redirect；已登录再进 /login 直接回首页
router.beforeEach((to, _from, next) => {
  const auth = useAuthStore();
  if (to.meta.public) {
    if (to.path === '/login' && auth.isLoggedIn) return next({ path: '/' });
    return next();
  }
  if (!auth.isLoggedIn) {
    return next({ path: '/login', query: { redirect: to.fullPath } });
  }
  next();
});

export default router;
