import { defineStore } from 'pinia';
import { apiLogin, apiMe } from '@/api';

export interface UserInfo {
  id: number;
  username: string;
  displayName?: string;
  email?: string;
  roles: string[];
  tenantId: number;
  tenantCode: string;
  // SaaS P0 新增：后端 /auth/me 直接返回
  modules: string[];
  permissions: string[];
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    accessToken: localStorage.getItem('labelflow_access') || '',
    refreshToken: localStorage.getItem('labelflow_refresh') || '',
    tenantCode: localStorage.getItem('labelflow_tenant') || '',
    user: null as UserInfo | null,
  }),
  getters: {
    isLoggedIn: (s) => !!s.accessToken,
    displayName: (s) => s.user?.displayName || s.user?.username || '',
    isAdmin: (s) => s.user?.roles?.includes('admin') || false,
    modules: (s): string[] => s.user?.modules || [],
    permissions: (s): string[] => s.user?.permissions || [],
  },
  actions: {
    async login(username: string, password: string, tenantCode?: string) {
      const res: any = await apiLogin({ username, password, tenantCode });
      this.accessToken = res.accessToken;
      this.refreshToken = res.refreshToken;
      this.tenantCode = res.tenantCode || tenantCode || 'default';
      localStorage.setItem('labelflow_access', res.accessToken);
      localStorage.setItem('labelflow_refresh', res.refreshToken);
      localStorage.setItem('labelflow_tenant', this.tenantCode);
      await this.fetchMe();
    },
    async fetchMe() {
      try {
        // ResponseInterceptor 统一返回 { code, message, data }
        const res: any = await apiMe();
        const me = res?.data ?? res;   // 兼容两种情况
        this.user = {
          id: me.id,
          username: me.username,
          displayName: me.displayName,
          email: me.email,
          roles: me.roles || [],
          tenantId: me.tenantId,
          tenantCode: me.tenantCode || this.tenantCode,
          modules: me.modules || [],
          permissions: me.permissions || [],
        };
      } catch {
        this.logout();
      }
    },
    logout() {
      this.accessToken = '';
      this.refreshToken = '';
      this.user = null;
      localStorage.removeItem('labelflow_access');
      localStorage.removeItem('labelflow_refresh');
      localStorage.removeItem('labelflow_tenant');
    },

    // ========== SaaS P0 权限检查 ==========

    /** 检查是否有指定权限（支持通配：template:* 匹配 template:read；* 全通） */
    hasPermission(perm: string): boolean {
      const perms = this.permissions;
      if (!perm) return true;
      if (!perms.length) return false;
      if (perms.includes('*')) return true;
      if (perms.includes(perm)) return true;
      // 通配：从右往左把每一段换成 * 试
      const parts = perm.split(':');
      while (parts.length > 0) {
        parts[parts.length - 1] = '*';
        const pattern = parts.join(':');
        if (perms.includes(pattern)) return true;
        parts.pop();
      }
      return false;
    },

    /** 检查租户是否开通了指定模块 */
    hasModule(code: string): boolean {
      if (!code) return true;
      return this.modules.includes(code);
    },

    /** 综合检查：路由 meta 中可能同时有 permission 和 module */
    canAccess(meta: { permission?: string; module?: string }): boolean {
      if (meta.module && !this.hasModule(meta.module)) return false;
      if (meta.permission && !this.hasPermission(meta.permission)) return false;
      return true;
    },
  },
});
