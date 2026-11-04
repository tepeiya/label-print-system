import { defineStore } from 'pinia';
import { apiLogin, apiMe } from '@/api';

export interface MenuNode {
  key: string;
  name: string;
  icon?: string;
  path?: string;
  module?: string;
  permission?: string;
  children?: MenuNode[];
}

export interface TenantInfo {
  id: number;
  name?: string;
  code?: string;
  type?: string;
  plan?: string;
  planName?: string;
  seatLimit?: number;
  status?: number | string;
  trialEndsAt?: string | null;
}

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
  // SaaS P1：后端算好的菜单树 + 灰度开关 + L3 数据范围
  menus: MenuNode[];
  features: Record<string, boolean>;
  dataScopes: any | null;
  tenant: TenantInfo | null;
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
    isAdmin: (s) => s.user?.roles?.includes('admin') || s.user?.roles?.includes('tenant_admin') || false,
    modules: (s): string[] => s.user?.modules || [],
    permissions: (s): string[] => s.user?.permissions || [],
    menus: (s): MenuNode[] => s.user?.menus || [],
    features: (s): Record<string, boolean> => s.user?.features || {},
    tenant: (s): TenantInfo | null => s.user?.tenant ?? null,
    /** 扁平化的可见路由 path（菜单树的叶子），供路由守卫判定「有没有这个入口」 */
    menuPaths: (s): Set<string> => {
      const out = new Set<string>();
      const walk = (nodes: MenuNode[]) => {
        for (const n of nodes) {
          if (n.path) out.add(n.path.startsWith('/') ? n.path : `/${n.path}`);
          if (n.children?.length) walk(n.children);
        }
      };
      walk(s.user?.menus || []);
      return out;
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
        // api/index.ts 已经在 axios 层拆过 { code, message, data } 信封，这里直接拿 payload
        const me: any = await apiMe();
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
          menus: me.menus || [],
          features: me.features || {},
          dataScopes: me.dataScopes ?? null,
          tenant: me.tenant ?? null,
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

    // ========== SaaS P0/P1 权限检查 ==========

    /** 检查是否有指定权限（支持通配：template:* 匹配 template:read；* 全通） */
    hasPermission(perm: string): boolean {
      if (!perm) return true;
      // 与后端 PermissionGuard 对齐：超管无条件放行（后端也是这么放的，
      // 否则前端会把 admin 的入口藏掉，出现「后端能调、前端看不到」的错觉）
      if (this.isAdmin) return true;
      const perms = this.permissions;
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

    /** D7 灰度开关：只有明确 true 才算开启（缺省按关闭处理） */
    hasFeature(key: string): boolean {
      return this.features[key] === true;
    },

    /** 综合检查：路由 meta 中可能同时有 permission 和 module */
    canAccess(meta: { permission?: string; module?: string }): boolean {
      if (meta.module && !this.hasModule(meta.module)) return false;
      if (meta.permission && !this.hasPermission(meta.permission)) return false;
      return true;
    },
  },
});
