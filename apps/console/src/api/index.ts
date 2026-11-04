import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import { ElMessage } from 'element-plus';

const http: any = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
});

// 请求拦截：加 JWT
http.interceptors.request.use((config: any) => {
  const token = localStorage.getItem('labelflow_access');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const tenantCode = localStorage.getItem('labelflow_tenant');
  if (tenantCode) config.headers['x-tenant-code'] = tenantCode;
  return config;
});

// 响应拦截：401 自动跳登录
http.interceptors.response.use(
  (res: any) => res.data,
  (err: any) => {
    const status = err?.response?.status;
    const msg = err?.response?.data?.message ?? err.message;
    if (status === 401) {
      const auth = useAuthStore();
      auth.logout();
      window.location.href = '/login';
      ElMessage.error('登录已过期，请重新登录');
    } else if (status === 403) {
      ElMessage.error(msg || '权限不足');
    } else {
      ElMessage.error(msg || '请求失败');
    }
    return Promise.reject(err);
  },
);

// ========== Auth ==========
export const apiLogin = (data: { username: string; password: string; tenantCode?: string }) =>
  http.post('/auth/login', data);

export const apiMe = () => http.get('/auth/me');

// ========== Users ==========
export const apiListUsers = (params?: any) => http.get('/users', { params });
export const apiCreateUser = (data: any) => http.post('/users', data);
export const apiUpdateUser = (id: number, data: any) => http.patch(`/users/${id}`, data);
export const apiDeleteUser = (id: number) => http.delete(`/users/${id}`);
export const apiResetUserPassword = (id: number, password: string) =>
  http.post(`/users/${id}/reset-password`, { password });
export const apiGrantRole = (id: number, role: string) =>
  http.post(`/users/${id}/roles`, { role });
export const apiRevokeRole = (id: number, role: string) =>
  http.delete(`/users/${id}/roles/${role}`);

// ========== Print Jobs ==========
export const apiListPrintJobs = (params?: any) => http.get('/print/jobs', { params });
export const apiPrintStats = (days = 7) => http.get('/print/jobs/stats', { params: { days } });

// ========== Backups ==========
export const apiListBackups = () => http.get('/backups');
export const apiCreateBackup = (name?: string) => http.post('/backups', { name });
export const apiDeleteBackup = (id: number) => http.delete(`/backups/${id}`);
export const apiRestoreBackup = (id: number) => http.post(`/backups/${id}/restore`);

// ========== AI Quota ==========
export const apiAiQuota = () => http.get('/ai-template/quota');

// ========== SaaS P0: Subscription (租户视角) ==========
export const apiSubscription = () => http.get('/subscription');
export const apiSubscriptionUsage = () => http.get('/subscription/usage');

// ========== SaaS P0: Platform (平台视角，admin only) ==========
export const apiPlatformModules = () => http.get('/platform/modules');
export const apiPlatformPlans = () => http.get('/platform/plans');
export const apiPlatformPermissions = () => http.get('/platform/permissions');

export default http;
