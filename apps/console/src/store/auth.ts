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
    permissions: (s) => {
      // 简化：按角色推导权限点（后续 SaaS 化时从后端 /auth/me 返回）
      const perms: string[] = [];
      const roles = s.user?.roles || [];
      if (roles.includes('admin')) {
        perms.push('*:*');
      } else {
        if (roles.includes('operator')) {
          perms.push('template:read', 'template:write', 'print:*', 'ai:*');
        }
        if (roles.includes('sql')) {
          perms.push('template:*', 'sql:*', 'print:*');
        }
        perms.push('print:read', 'template:read');
      }
      return perms;
    },
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
        const me: any = await apiMe();
        this.user = me;
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
    hasPermission(perm: string) {
      const perms = this.permissions;
      return perms.includes('*:*') || perms.includes(perm) || perms.some((p) => {
        // 'template:*' 匹配 'template:read'
        if (p.endsWith(':*')) {
          const prefix = p.slice(0, -1); // 'template:'
          return perm.startsWith(prefix);
        }
        return false;
      });
    },
  },
});
