import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import { ElMessage } from 'element-plus';

const http: any = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
});

// ---------------------------------------------------------------------------
// 统一约定
// 后端 ResponseInterceptor 把所有成功响应包成 { code: 0, message: 'ok', data }，
// AllExceptionsFilter 把失败响应包成 { code: <业务码或 HTTP 状态>, message, data: null, ...detail }。
// 这里在 axios 层一次性拆包：调用方拿到的就是 data 本体（各 view 一直是这么假设的）。
// ---------------------------------------------------------------------------

http.interceptors.request.use((config: any) => {
  const token = localStorage.getItem('labelflow_access');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const tenantCode = localStorage.getItem('labelflow_tenant');
  if (tenantCode) config.headers['x-tenant-code'] = tenantCode;
  return config;
});

/** 业务码（docs/11 §11.11.1）：4031 模块未订阅 / 4032 权限不足 */
export const BIZ_MODULE_NOT_SUBSCRIBED = 4031;
export const BIZ_PERMISSION_DENIED = 4032;

/** 给调用方用的错误对象：带 bizCode / 缺失的 modules / permissions，便于跳「未订阅」页 */
export interface ApiError extends Error {
  bizCode?: number;
  httpStatus?: number;
  modules?: string[];
  permissions?: string[];
  action?: 'upgrade' | 'contact_admin' | string;
}

function toApiError(body: any, status: number, fallbackMsg: string): ApiError {
  const err: ApiError = new Error(body?.message || fallbackMsg);
  err.httpStatus = status;
  // 业务码优先：403 时 body.code 是 4031/4032，而不是 403
  const biz = typeof body?.code === 'number' ? body.code : undefined;
  err.bizCode = biz;
  err.modules = body?.modules;
  err.permissions = body?.permissions;
  err.action = body?.action;
  return err;
}

function describeError(err: ApiError): string {
  if (err.bizCode === BIZ_MODULE_NOT_SUBSCRIBED) {
    const m = err.modules?.join('、') || '该模块';
    return `模块未订阅：${m}，需要升级套餐`;
  }
  if (err.bizCode === BIZ_PERMISSION_DENIED) {
    const p = err.permissions?.join('、') || '所需权限';
    return `缺少权限：${p}，请联系管理员`;
  }
  return err.message || '请求失败';
}

// ---------------------------------------------------------------------------
// 401 自动续期：单飞（并发只发一次 refresh），其余请求排队等结果后重试
// ---------------------------------------------------------------------------
let refreshing: Promise<string> | null = null;

async function doRefresh(): Promise<string> {
  const auth = useAuthStore();
  const rt = localStorage.getItem('labelflow_refresh');
  if (!rt) throw new Error('no refresh token');
  // 用裸 axios，避免走本拦截器造成递归
  const res = await axios.post('/api/v1/auth/refresh', { refreshToken: rt });
  const payload = res?.data?.data ?? res?.data ?? {};
  if (!payload.accessToken) throw new Error('refresh 返回异常');
  localStorage.setItem('labelflow_access', payload.accessToken);
  if (payload.refreshToken) localStorage.setItem('labelflow_refresh', payload.refreshToken);
  // 权限/订阅可能已变（升降级、加购），顺手刷新一次 /auth/me
  await auth.fetchMe();
  return payload.accessToken;
}

http.interceptors.response.use(
  (res: any) => {
    const body = res?.data;
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      return body.code === 0 ? body.data : Promise.reject(toApiError(body, res.status, '请求失败'));
    }
    return body;          // 非信封（例如导出接口直接返回文件流）
  },
  async (err: any) => {
    const status = err?.response?.status;
    const body = err?.response?.data;
    const config = err?.config;

    if (status === 401 && config && !config.__retried) {
      try {
        refreshing = refreshing ?? doRefresh();
        const token = await refreshing;
        refreshing = null;
        config.__retried = true;
        config.headers = config.headers ?? {};
        config.headers.Authorization = `Bearer ${token}`;
        return http.request(config);
      } catch {
        refreshing = null;
        const auth = useAuthStore();
        auth.logout();
        ElMessage.error('登录已过期，请重新登录');
        if (location.pathname !== '/login') window.location.href = '/login';
        return Promise.reject(toApiError(body, status, '登录已过期'));
      }
    }

    const apiErr = toApiError(body, status ?? 0, err?.message ?? '请求失败');
    if (status !== 401) ElMessage.error(describeError(apiErr));   // 401 上面已经提示过了
    return Promise.reject(apiErr);
  },
);

// ========== Auth ==========
export const apiLogin = (data: { username: string; password: string; tenantCode?: string }) =>
  http.post('/auth/login', data);

export const apiMe = () => http.get('/auth/me');

export const apiLogout = (refreshToken: string) => http.post('/auth/logout', { refreshToken });

// ========== Users ==========
export const apiListUsers = (params?: any) => http.get('/users', { params });
export const apiCreateUser = (data: any) => http.post('/users', data);
export const apiUpdateUser = (id: number, data: any) => http.patch(`/users/${id}`, data);
export const apiDeleteUser = (id: number) => http.delete(`/users/${id}`);
// 后端收的是 newPassword（web/js/api.js 同款字段名）；曾错发 { password } 导致 console 重置密码必失败
export const apiResetUserPassword = (id: number, newPassword: string) =>
  http.post(`/users/${id}/reset-password`, { newPassword });
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

// ========== Data Sources（P1 新增页面）==========
export const apiListDataSources = () => http.get('/data-sources');
export const apiSaveSqlDataSource = (data: { name: string; connectionUrl: string; queryTemplate?: string; description?: string }) =>
  http.post('/data-sources/save-sql', data);
export const apiDeleteDataSource = (id: number) => http.delete(`/data-sources/${id}`);
export const apiTestSqlDataSource = (id: number) => http.post(`/data-sources/${id}/sql-test`);
export const apiExecSqlDataSource = (id: number, data?: any) =>
  http.post(`/data-sources/${id}/sql-exec`, data ?? {});

// ========== Audit（P1 新增页面）==========
export const apiListAuditLogs = (params?: any) => http.get('/audit/logs', { params });
/**
 * 导出用浏览器直接下载，不走 axios（拦截器会把文件流当 JSON 拆坏）。
 * JwtAuthGuard 支持 query.token（为 SSE / 下载这类没法带 header 的场景留的），
 * 所以这里把 access token 拼进 URL。
 */
export const auditExportUrl = (params: Record<string, any>) => {
  const qs = new URLSearchParams({
    ...params,
    token: localStorage.getItem('labelflow_access') || '',
  }).toString();
  return `/api/v1/audit/logs/export?${qs}`;
};

// ========== AI（P1 新增页面）==========
// 注：后端没有 /ai-template/quota 接口（配额在服务侧直接扣），所以这里不提供 apiAiQuota。
export const apiAiJobs = (limit = 20) => http.get('/ai-template/jobs', { params: { limit } });
export const apiAiModels = () => http.get('/ai-template/models');
export const apiAiGenerate = (form: FormData) =>
  http.post('/ai-template/generate', form, { headers: { 'Content-Type': 'multipart/form-data' } });
export const apiAiTextToTemplate = (data: { description: string; widthMm?: number; heightMm?: number }) =>
  http.post('/ai-template/text-to-template', data);
export const apiAiSaveTemplate = (data: { template: any; name?: string; category?: string }) =>
  http.post('/ai-template/save', data);

// ========== SaaS: Subscription (租户视角) ==========
export const apiSubscription = () => http.get('/subscription');
export const apiSubscriptionUsage = () => http.get('/subscription/usage');

// ========== SaaS P3: Billing（账单与用量，租户侧只读，权限点 sys:billing:read）==========
// 契约见 docs/11 §11.7 / backend/src/billing/billing.controller.ts。
// 金额一律「分」（BIGINT），前端展示统一 /100 保留两位。

/** 计量项用量（softLimit/hardLimit 为 null 表示该侧未设限） */
export interface BillingUsageItem {
  meter: string;
  used: number;
  softLimit: number | null;
  hardLimit: number | null;
  period: string;
}

export interface BillingUsageSummary {
  tenantId: number;
  period: string;
  items: BillingUsageItem[];
}

/** 日序列点位：稀疏，没记录的日期后端不补零 */
export interface BillingSeriesPoint {
  day: string;
  quantity: number;
}

export interface BillingQuota {
  meter: string;
  softLimit: number | null;
  hardLimit: number | null;
  period: string;
}

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'void';

/** 账单行：plan 出账时带 qty/unitPriceCents，手工行可能只有 title + amountCents */
export interface InvoiceLineItem {
  code?: string;
  title: string;
  qty?: number;
  unitPriceCents?: number;
  amountCents?: number;
}

/** 出账快照（invoices.detail），运营改价不影响已出账单 */
export interface InvoiceDetail {
  source?: 'plan' | 'manual' | string;
  plan?: { id?: number; code?: string; name?: string; priceCents?: number };
  items?: InvoiceLineItem[];
  note?: string;
}

export interface Invoice {
  id: number;
  tenantId: number;
  number: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  periodStart: string | null;
  periodEnd: string | null;
  dueAt: string | null;
  paidAt: string | null;
  detail: InvoiceDetail;
  createdBy?: number | null;
  createdAt?: string;
  paidCents: number;
  balanceCents: number;
}

export interface InvoicePayment {
  id: number;
  invoiceId?: number;
  tenantId?: number;
  provider: string;
  providerRef: string | null;
  amountCents: number;
  note: string | null;
  paidBy?: number | null;
  paidAt: string;
}

/** GET /billing/invoices/:id —— 账单 + 收款记录 */
export interface InvoiceFull extends Invoice {
  payments: InvoicePayment[];
}

export const apiBillingUsage = () => http.get('/billing/usage');
export const apiBillingSeries = (meter: string, days = 30) =>
  http.get('/billing/usage/series', { params: { meter, days } });
export const apiBillingInvoices = () => http.get('/billing/invoices');
export const apiBillingInvoice = (id: number) => http.get(`/billing/invoices/${id}`);
export const apiBillingQuotas = () => http.get('/billing/quotas');

// ========== SaaS: Platform (admin only，用于订阅页做套餐对比) ==========
export const apiPlatformModules = () => http.get('/platform/modules');
export const apiPlatformPlans = () => http.get('/platform/plans');
export const apiPlatformPermissions = () => http.get('/platform/permissions');

// ========== SaaS P5: Agent 接入 + 高危操作待确认 ==========
// 契约见 backend/src/agent/agents.controller.ts + approval.service.ts。
// 注意几处与「直觉」不同的地方（都已对着跑着的后端实测确认）：
//   - GET /agents 只回 { items, total }，没有 page/pageSize；
//   - GET /agents/:id/tokens 直接回数组，不是 { items }；
//   - POST /agents/:id/tokens 的明文 token 只在这一次响应里（服务端只存 sha256），
//     且不返回 token id，要展示列表必须重新拉一次；
//   - 审批单 DTO 没有 onBehalfOf，租户列表里 agentClientName 恒为 null
//     （listForTenant 调 toDto 时没传 clientName）→ 名称只能前端按 agentClientId 自己补。

export type AgentClientKind = 'mcp_stdio' | 'mcp_http' | 'internal';
export type AgentClientStatus = 'active' | 'disabled';

export interface AgentClient {
  id: number;
  name: string;
  description: string | null;
  kind: AgentClientKind;
  status: AgentClientStatus;
  createdAt: string;
  tokenCount: number;
  lastUsedAt: string | null;
}

export interface AgentToken {
  id: number;
  /** sha256 指纹尾 8 位，反推不了 token */
  hashTail: string;
  scopes: string[];
  revoked: boolean;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** 一次性明文：关掉就没有第二次 */
export interface AgentTokenIssued {
  token: string;
  tokenMasked: string;
  scopes: string[];
  expiresAt: string;
  clientId: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export interface AgentApproval {
  id: number;
  tool: string;
  status: string;
  agentClientId: number;
  agentClientName: string | null;
  argsPreview: Record<string, any>;
  argsHash: string;
  createdAt: string;
  expiresAt: string;
  approvedBy: number | null;
  approvedAt: string | null;
  consumedAt: string | null;
  message?: string;
}

export const apiListAgents = (params?: any) => http.get('/agents', { params });
export const apiCreateAgent = (data: { name: string; description?: string; kind?: AgentClientKind }) =>
  http.post('/agents', data);
export const apiSetAgentStatus = (id: number, status: AgentClientStatus) =>
  http.post(`/agents/${id}/status`, { status });
export const apiListAgentTokens = (id: number): Promise<AgentToken[]> => http.get(`/agents/${id}/tokens`);
export const apiCreateAgentToken = (id: number, data: { scopes?: string[]; expiresInDays?: number }) =>
  http.post(`/agents/${id}/tokens`, data);
export const apiRevokeAgentToken = (id: number, tokenId: number) =>
  http.post(`/agents/${id}/tokens/${tokenId}/revoke`);

export const apiListApprovals = (params?: any) => http.get('/agents/approvals', { params });
export const apiApproveApproval = (id: number) => http.post(`/agents/approvals/${id}/approve`);
export const apiRejectApproval = (id: number, reason?: string) =>
  http.post(`/agents/approvals/${id}/reject`, reason ? { reason } : {});

// ========== SaaS P6.5: Prompt 库 ==========
// 契约见 backend/src/agent/prompts.controller.ts。
// 列表是「系统默认 + 租户覆盖」的合并视图：source=system 表示还吃代码里的默认文案，
// source=custom 表示该租户有自己的一行（overridden=true 表示覆盖了同名系统提示词）。
// 删除租户行 = 回落系统默认（系统行本身没有删除接口）。

export interface PromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
  /** 服务端渲染时补的默认值 */
  default?: string;
}

export interface AgentPrompt {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  content: string;
  enabled: boolean;
  sortOrder: number;
  source: 'system' | 'custom';
  overridden: boolean;
  updatedAt: string | null;
}

export interface PromptPreview {
  name: string;
  title: string;
  source: 'system' | 'custom';
  text: string;
  length: number;
}

export const apiListPrompts = (): Promise<AgentPrompt[]> => http.get('/agent-prompts');
export const apiGetPrompt = (name: string): Promise<AgentPrompt> =>
  http.get(`/agent-prompts/${encodeURIComponent(name)}`);
export const apiSavePrompt = (
  name: string,
  data: { title: string; description?: string; content: string; arguments?: PromptArgument[]; enabled?: boolean; sortOrder?: number },
): Promise<AgentPrompt> => http.put(`/agent-prompts/${encodeURIComponent(name)}`, data);
export const apiDeletePrompt = (name: string): Promise<{ name: string; removed: boolean; revertedToSystem: boolean }> =>
  http.delete(`/agent-prompts/${encodeURIComponent(name)}`);
export const apiPreviewPrompt = (name: string, args: Record<string, string>): Promise<PromptPreview> =>
  http.post(`/agent-prompts/${encodeURIComponent(name)}/preview`, { arguments: args });

export default http;
