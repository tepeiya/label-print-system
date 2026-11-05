import { defineStore } from 'pinia';
import { apiPlatformLogin, TOKEN_KEY, USER_KEY } from '@/api';
import type { PlatformUser } from '@/api/types';

/**
 * 平台运营登录态（P2）。
 * 与租户 console 的 auth store 完全独立：token 键名不同（labelflow_platform_token），
 * 里面没有 modules / permissions / menus —— 平台身份不做模块裁剪，能看的就是全平台。
 * 后端不签 refresh token（expiresIn 2h），过期就靠 401 拦截器回登录页。
 */
function readUser(): PlatformUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PlatformUser;
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    accessToken: localStorage.getItem(TOKEN_KEY) || '',
    user: readUser(),
  }),
  getters: {
    isLoggedIn: (s) => !!s.accessToken,
    displayName: (s) => s.user?.displayName || s.user?.username || '平台运营',
  },
  actions: {
    async login(username: string, password: string) {
      const res = await apiPlatformLogin({ username, password });
      this.accessToken = res.accessToken;
      this.user = res.user;
      localStorage.setItem(TOKEN_KEY, res.accessToken);
      // 只存展示用的身份摘要（没有 /platform/auth/me，刷新页面后靠它回填顶栏）
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    },
    logout() {
      this.accessToken = '';
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
  },
});
