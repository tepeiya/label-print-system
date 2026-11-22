import { defineStore } from 'pinia';
import { apiLogin } from '@/api';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    accessToken: localStorage.getItem('labelflow_access') || '',
    refreshToken: localStorage.getItem('labelflow_refresh') || '',
    tenantCode: localStorage.getItem('labelflow_tenant') || '',
    displayName: localStorage.getItem('pda_display_name') || '',
  }),
  getters: {
    isLoggedIn: (s) => !!s.accessToken,
  },
  actions: {
    async login(username: string, password: string, tenantCode?: string) {
      const res = await apiLogin(username, password, tenantCode);
      this.accessToken = res.accessToken;
      this.refreshToken = res.refreshToken;
      this.tenantCode = res.tenantCode || tenantCode || 'default';
      this.displayName = username;
      localStorage.setItem('labelflow_access', res.accessToken);
      localStorage.setItem('labelflow_refresh', res.refreshToken);
      localStorage.setItem('labelflow_tenant', this.tenantCode);
      localStorage.setItem('pda_display_name', username);
    },
    logout() {
      this.accessToken = '';
      this.refreshToken = '';
      this.displayName = '';
      localStorage.removeItem('labelflow_access');
      localStorage.removeItem('labelflow_refresh');
      localStorage.removeItem('pda_display_name');
    },
  },
});
