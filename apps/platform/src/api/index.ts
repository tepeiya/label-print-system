import axios, { type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';
import type {
  AddModuleResult,
  CancelTenantResult,
  DisableModuleResult,
  ModuleCatalogItem,
  ModuleSource,
  PlanInfo,
  PlanUpdatePayload,
  PlanUpdateResult,
  PlatformAuditLog,
  PlatformLoginResult,
  PlatformTenant,
  ProvisionTenantPayload,
  ProvisionTenantResult,
  SetEnabledResult,
  TenantModuleRow,
  TenantSubscriptionDetail,
  UsageOverview,
} from './types';

// ---------------------------------------------------------------------------
// 统一约定（同 apps/console/src/api/index.ts）
// 后端 ResponseInterceptor 把成功响应包成 { code: 0, message: 'ok', data }，
// AllExceptionsFilter 把失败响应包成 { code: <业务码或 HTTP 状态>, message, data: null }。
// 这里在 axios 层一次性拆包：调用方拿到的就是 data 本体，失败一律 reject ApiError。
//
// 与 console 的差异：平台身份（scope='platform'）只有 2h 的 access token，后端没做
// refresh（platform-admin.service.ts#login 不落 refresh 表），所以 401 不重试续期，
// 直接清 token 回登录页。
// ---------------------------------------------------------------------------

export const TOKEN_KEY = 'labelflow_platform_token';
export const USER_KEY = 'labelflow_platform_user';

/** 带 silent 的请求配置：silent=true 时失败不自动弹 toast（给「后端可能还没上」的探测接口用） */
export interface RequestOptions extends AxiosRequestConfig {
  silent?: boolean;
}

/** 给调用方用的错误对象：保留 HTTP 状态与业务码，便于区分 401（回登录页）/ 404（接口未就绪） */
export interface ApiError extends Error {
  bizCode?: number;
  httpStatus?: number;
}

function toApiError(body: any, status: number, fallbackMsg: string): ApiError {
  const err: ApiError = new Error(
    typeof body?.message === 'string' ? body.message : fallbackMsg,
  );
  err.name = 'ApiError';
  err.httpStatus = status;
  err.bizCode = typeof body?.code === 'number' ? body.code : status;
  return err;
}

// 声明成 Promise<T> 而不是 axios 的 Promise<AxiosResponse<T>>：拆包发生在拦截器里，
// 类型只在这一层收口，view 里就不必再 `as any`。
interface PlatformHttp {
  get<T>(url: string, config?: RequestOptions): Promise<T>;
  post<T>(url: string, data?: unknown, config?: RequestOptions): Promise<T>;
  put<T>(url: string, data?: unknown, config?: RequestOptions): Promise<T>;
  delete<T>(url: string, config?: RequestOptions): Promise<T>;
}

const instance = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
});

instance.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** 401 时清登录态并回登录页；登录接口自己返回 401 只弹文案，不做跳转（免得刷掉表单） */
function forceRelogin(msg: string) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  ElMessage.error(msg);
  if (!location.pathname.startsWith('/login')) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?redirect=${redirect}`;
  }
}

instance.interceptors.response.use(
  (res) => {
    const body = res?.data;
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      return body.code === 0 ? body.data : Promise.reject(toApiError(body, res.status, '请求失败'));
    }
    return body;
  },
  (err: any) => {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const silent: boolean = err?.config?.silent === true;
    const apiErr = toApiError(body, status ?? 0, err?.message ?? '请求失败');

    if (status === 401) {
      forceRelogin(apiErr.message || '登录已过期，请重新登录');
      return Promise.reject(apiErr);
    }
    if (!silent) ElMessage.error(apiErr.message || '请求失败');
    return Promise.reject(apiErr);
  },
);

const http = instance as unknown as PlatformHttp;

// ========== 平台身份 ==========
export const apiPlatformLogin = (data: { username: string; password: string }) =>
  http.post<PlatformLoginResult>('/platform/auth/login', data);

// ========== 租户运营 ==========
export const apiListTenants = () => http.get<PlatformTenant[]>('/platform/tenants');
export const apiProvisionTenant = (data: ProvisionTenantPayload) =>
  http.post<ProvisionTenantResult>('/platform/tenants', data);
export const apiSuspendTenant = (id: number) =>
  http.post<SetEnabledResult>(`/platform/tenants/${id}/suspend`);
export const apiResumeTenant = (id: number) =>
  http.post<SetEnabledResult>(`/platform/tenants/${id}/resume`);
export const apiCancelTenant = (id: number) =>
  http.post<CancelTenantResult>(`/platform/tenants/${id}/cancel`);

/** 加购单模块（D1：后端会自动补齐前置模块，返回体里的 added 是实际新增的 code） */
export const apiAddTenantModule = (id: number, moduleCode: string, source: ModuleSource) =>
  http.post<AddModuleResult>(`/platform/tenants/${id}/modules`, { moduleCode, source });
export const apiDisableTenantModule = (id: number, code: string) =>
  http.delete<DisableModuleResult>(`/platform/tenants/${id}/modules/${code}`);

/** 订阅详情 / 已开模块详情：后端 P2 尚未上线这两个 GET，调用侧按 404 降级处理 */
export const apiTenantSubscription = (id: number) =>
  http.get<TenantSubscriptionDetail>(`/platform/tenants/${id}/subscription`, { silent: true });
export const apiTenantModules = (id: number) =>
  http.get<TenantModuleRow[]>(`/platform/tenants/${id}/modules`, { silent: true });

// ========== 模块目录 / 套餐 ==========
export const apiListModules = () => http.get<ModuleCatalogItem[]>('/platform/modules');
export const apiListPlans = () => http.get<PlanInfo[]>('/platform/plans');
// PUT /platform/plans/:code 没有对应的 GET（platform-admin 只暴露列表 + 更新）
export const apiUpdatePlan = (code: string, data: PlanUpdatePayload) =>
  http.put<PlanUpdateResult>(`/platform/plans/${code}`, data);

// ========== 用量看板 / 平台审计 ==========
export const apiUsage = () => http.get<UsageOverview>('/platform/usage');
export const apiPlatformAudit = () => http.get<PlatformAuditLog[]>('/platform/audit');

export default http;
