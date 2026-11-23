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
    // silentError：调用方自己兜底的「增强信息」类请求（如设计器取 /print/commands 的
    // warnings）失败时不弹全局 toast，否则每次生成预览都会闪一条与主流程无关的报错。
    if (status !== 401 && !config?.silentError) ElMessage.error(describeError(apiErr));   // 401 上面已经提示过了
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

// ========== Print Commands（指令导出，设计器打印预览取 warnings 用）==========
// 契约见 backend/src/print/print.controller.ts 的 PrintCommandsController +
// docs/05-api.md：warnings 里是码制降级、几何量化、静区放大、TSPL 中文字库等提示。
// 字节口径：TSPL 的 BITMAP 数据段、EPL 的 GW 数据段是原始二进制，utf8 解码会把高位字节
// 换成 U+FFFD —— text 只在 textExact=true 时才与 bytes 逐字节等价，否则只能读不能用，
// 要落盘/下发必须取 textBase64。
export interface PrintCommandsResult {
  protocol: 'zpl' | 'tspl' | 'epl';
  text: string;
  /** 整份作业字节无损的 base64（含位图段时唯一的可信字节来源） */
  textBase64: string;
  /** text 是否字节无损（含位图段时为 false） */
  textExact: boolean;
  labelCount: number;
  bytes: number;
  dpi: number;
  warnings: string[];
}

export const apiPrintCommands = (
  data: Record<string, any>,
  config?: Record<string, any>,
): Promise<PrintCommandsResult> => http.post('/print/commands', data, config);

// ========== Inventory / 出入库 ==========
// 后端 InventoryController（backend/src/inventory/inventory.controller.ts）：
// 读：/inventory/stock · low-stock · expiring · moves · materials · warehouses
// 写：/inventory/inbound · outbound · transfer（dryRun=true 可预演，不改库存）
export const apiQueryStock = (params?: any) => http.get('/inventory/stock', { params });
export const apiLowStock = (keyword?: string) => http.get('/inventory/low-stock', { params: { keyword } });
export const apiExpiringStock = (params?: any) => http.get('/inventory/expiring', { params });
export const apiQueryMoves = (params?: any) => http.get('/inventory/moves', { params });
export const apiInventoryMaterials = (keyword?: string) => http.get('/inventory/materials', { params: { keyword } });
export const apiInventoryWarehouses = () => http.get('/inventory/warehouses');
export const apiStockInbound = (data: any) => http.post('/inventory/inbound', data);
export const apiStockOutbound = (data: any) => http.post('/inventory/outbound', data);
export const apiStockTransfer = (data: any) => http.post('/inventory/transfer', data);

// ========== 基础资料：产品 / 仓库 / 库位 ==========
const MD = '/inventory/masterdata';
export const apiMdMaterials = (params?: any) => http.get(`${MD}/materials`, { params });
export const apiMdCreateMaterial = (data: any) => http.post(`${MD}/materials`, data);
export const apiMdUpdateMaterial = (id: number, data: any) => http.put(`${MD}/materials/${id}`, data);
export const apiMdMaterialActive = (id: number, active: boolean) => http.post(`${MD}/materials/${id}/active`, { active });
export const apiMdPrintMaterial = (id: number, data: any) => http.post(`${MD}/materials/${id}/print`, data);
export const apiMdMaterialCategories = () => http.get(`${MD}/materials/categories`);
export const apiMdBindTemplate = (data: any) => http.post(`${MD}/materials/bind-template`, data);
// 产品自定义字段定义
export const apiMdFields = (includeInactive = false) => http.get(`${MD}/fields`, { params: { includeInactive } });
export const apiMdCreateField = (data: any) => http.post(`${MD}/fields`, data);
export const apiMdUpdateField = (id: number, data: any) => http.put(`${MD}/fields/${id}`, data);
export const apiMdFieldActive = (id: number, active: boolean) => http.post(`${MD}/fields/${id}/active`, { active });
export const apiMdGroups = (params?: any) => http.get(`${MD}/groups`, { params });
export const apiMdCreateGroup = (data: any) => http.post(`${MD}/groups`, data);
export const apiMdUpdateGroup = (id: number, data: any) => http.put(`${MD}/groups/${id}`, data);
export const apiMdGroupActive = (id: number, active: boolean) => http.post(`${MD}/groups/${id}/active`, { active });
export const apiMdSetDefaultLocation = (data: any) => http.post(`${MD}/materials/set-default-location`, data);
export const apiMdWarehouses = (includeInactive = false) => http.get(`${MD}/warehouses`, { params: { includeInactive } });
export const apiMdCreateWarehouse = (data: any) => http.post(`${MD}/warehouses`, data);
export const apiMdUpdateWarehouse = (id: number, data: any) => http.put(`${MD}/warehouses/${id}`, data);
export const apiMdWarehouseActive = (id: number, active: boolean) => http.post(`${MD}/warehouses/${id}/active`, { active });
export const apiMdLocations = (params?: any) => http.get(`${MD}/locations`, { params });
export const apiMdCreateLocation = (data: any) => http.post(`${MD}/locations`, data);
export const apiMdUpdateLocation = (id: number, data: any) => http.put(`${MD}/locations/${id}`, data);
export const apiMdLocationActive = (id: number, active: boolean) => http.post(`${MD}/locations/${id}/active`, { active });

// ========== BOM 齐套率（bom 模块）==========
// 后端 BomController（backend/src/inventory/bom.controller.ts）：
// 齐套：GET /inventory/bom/check-kit · GET /inventory/bom/shortages
// 维护：GET /inventory/bom/list · GET /:id · POST · PUT /:id · POST /:id/status · DELETE /:id
const BOM = '/inventory/bom';
export const apiBomCheckKit = (params: { product: string; demand: number; warehouse?: string }) =>
  http.get(`${BOM}/check-kit`, { params });
export const apiBomShortages = (params: { product: string; demand: number; warehouse?: string }) =>
  http.get(`${BOM}/shortages`, { params });
export const apiBomList = (product?: string) => http.get(`${BOM}/list`, { params: { product } });
export const apiBomGet = (id: number) => http.get(`${BOM}/${id}`);
export const apiBomCreate = (data: any) => http.post(BOM, data);
export const apiBomUpdate = (id: number, data: any) => http.put(`${BOM}/${id}`, data);
export const apiBomStatus = (id: number, status: 'draft' | 'active' | 'inactive') =>
  http.post(`${BOM}/${id}/status`, { status });
export const apiBomDelete = (id: number) => http.delete(`${BOM}/${id}`);

// ========== 呆滞/效期预警（alert 模块）==========
// 后端 AlertController（backend/src/inventory/alert.controller.ts）：
// 规则：GET/POST /inventory/alerts/rules · PUT /rules/:id · POST /rules/:id/active · DELETE /rules/:id
// 扫描/事件：POST /inventory/alerts/scan · GET /events · GET /summary · POST /events/:id/ack
const AL = '/inventory/alerts';
export const apiAlertRules = (includeInactive = false) => http.get(`${AL}/rules`, { params: { includeInactive } });
export const apiAlertCreateRule = (data: any) => http.post(`${AL}/rules`, data);
export const apiAlertUpdateRule = (id: number, data: any) => http.put(`${AL}/rules/${id}`, data);
export const apiAlertRuleActive = (id: number, active: boolean) => http.post(`${AL}/rules/${id}/active`, { active });
export const apiAlertDeleteRule = (id: number) => http.delete(`${AL}/rules/${id}`);
export const apiAlertScan = (ruleId?: number) => http.post(`${AL}/scan`, ruleId ? { ruleId } : {});
export const apiAlertEvents = (params?: any) => http.get(`${AL}/events`, { params });
export const apiAlertSummary = () => http.get(`${AL}/summary`);
export const apiAlertAck = (id: number, data: { status: 'ack' | 'ignored'; note?: string }) =>
  http.post(`${AL}/events/${id}/ack`, data);

// ========== Printers ==========
// 后端 PrinterController（backend/src/printer/printer.module.ts）：
// GET /printers · POST /printers · GET /printers/:id · PUT /printers/:id ·
// DELETE /printers/:id · POST /printers/:id/calibrate · /test · /test-print · /test-commands
export const apiListPrinters = () => http.get('/printers');
export const apiGetPrinter = (id: number) => http.get(`/printers/${id}`);
export const apiCreatePrinter = (data: any) => http.post('/printers', data);
export const apiUpdatePrinter = (id: number, data: any) => http.put(`/printers/${id}`, data);
export const apiDeletePrinter = (id: number) => http.delete(`/printers/${id}`);
export const apiCalibratePrinter = (id: number, data: any) => http.post(`/printers/${id}/calibrate`, data);
export const apiTestPrinter = (id: number) => http.post(`/printers/${id}/test`);
export const apiTestPrintPrinter = (id: number) => http.post(`/printers/${id}/test-print`);
export const apiTestCommandsPrinter = (id: number, protocol?: string) =>
  http.post(`/printers/${id}/test-commands`, protocol ? { protocol } : {});

// ========== Print Job 提交 ==========
// 后端 PrintController.create：{ templateId, printerId, rows, copies, params?, serialMap? }
export const apiCreatePrintJob = (data: any) => http.post('/print/jobs', data);
export const apiGetPrintJob = (id: number) => http.get(`/print/jobs/${id}`);
export const apiCancelPrintJob = (id: number) => http.post(`/print/jobs/${id}/cancel`);
export const apiRetryPrintJob = (id: number, seqNos?: number[]) =>
  http.post(`/print/jobs/${id}/retry`, seqNos ? { seqNos } : {});

// ========== Backups ==========
export const apiListBackups = () => http.get('/backups');
export const apiCreateBackup = (name?: string) => http.post('/backups', { name });
export const apiDeleteBackup = (id: number) => http.delete(`/backups/${id}`);
export const apiRestoreBackup = (id: number) => http.post(`/backups/${id}/restore`);

// ========== Data Sources（数据源统一入口）==========
export const apiListDataSources = () => http.get('/data-sources');
export const apiSaveSqlDataSource = (data: { name: string; connectionUrl: string; queryTemplate?: string; description?: string }) =>
  http.post('/data-sources/save-sql', data);
export const apiDeleteDataSource = (id: number) => http.delete(`/data-sources/${id}`);
export const apiTestSqlDataSource = (id: number) => http.post(`/data-sources/${id}/sql-test`);
export const apiExecSqlDataSource = (id: number, data?: any) =>
  http.post(`/data-sources/${id}/sql-exec`, data ?? {});

/** Excel 上传（后端 SheetJS 解析首个工作表，10MB 限制） */
export const apiUploadExcelDataSource = (file: File, name?: string) => {
  const fd = new FormData();
  fd.append('file', file);
  if (name) fd.append('name', name);
  return http.post('/data-sources/upload-excel', fd);
};
/** CSV 文本上传（后端 parseCsv，支持 fieldMap） */
export const apiUploadCsvDataSource = (data: { name: string; csvText: string; fieldMap?: Record<string, string> }) =>
  http.post('/data-sources/upload', data);
/** 前端解析好的数据行统一入库（Excel/CSV/TSV/JSON 最终都走这里） */
export const apiSaveDataSourceRows = (data: {
  name: string; type: 'csv' | 'excel' | 'sql'; headers: string[]; rows: any[];
  fieldMap?: Record<string, string>; config?: any;
}) => http.post('/data-sources/rows', data);
/** 读取数据源的数据行（limit 上限 2000）——后端返回 DataRow 实体，此处统一展开 payload 为真实行 */
export const apiDataSourceRows = async (id: number, limit = 500, offset = 0): Promise<Record<string, any>[]> => {
  const res: any = await http.get(`/data-sources/${id}/rows`, { params: { limit, offset } });
  const list = Array.isArray(res) ? res : (res?.rows ?? res?.items ?? []);
  return list.map((r: any) => (r && typeof r === 'object' && r.payload && typeof r.payload === 'object' ? r.payload : r));
};
export const apiPreviewDataSource = (data: { sourceId: number; templateId?: number; limit?: number }) =>
  http.post('/data-sources/preview', data);
export const apiSqlPreview = (id: number, data?: any) => http.post(`/data-sources/${id}/sql-preview`, data ?? {});

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
export interface AiModelInput {
  name: string;
  modelId: string;
  apiEndpoint: string;
  provider?: string;
  apiKey?: string;
  settings?: Record<string, any>;
  isDefault?: boolean;
}
export const apiCreateAiModel = (data: AiModelInput) => http.post('/ai-template/models', data);
export const apiTestAiModel = (id: number) => http.post(`/ai-template/models/${id}/test`);
export const apiDeleteAiModel = (id: number) => http.delete(`/ai-template/models/${id}`);
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
  /** 当前版本号 */
  version: number;
  /** 按角色分发：空=全员 */
  roles: string[];
  /** 渲染/调用次数 */
  usageCount: number;
}

export interface PromptVersion {
  id: number;
  version: number;
  action: string;
  summary: string;
  title: string;
  content: string;
  arguments: PromptArgument[];
  enabled: boolean;
  actorId: number | null;
  createdAt: string;
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
  data: { title: string; description?: string; content: string; arguments?: PromptArgument[]; enabled?: boolean; sortOrder?: number; roles?: string[] },
): Promise<AgentPrompt> => http.put(`/agent-prompts/${encodeURIComponent(name)}`, data);
export const apiDeletePrompt = (name: string): Promise<{ name: string; removed: boolean; revertedToSystem: boolean }> =>
  http.delete(`/agent-prompts/${encodeURIComponent(name)}`);
export const apiPreviewPrompt = (name: string, args: Record<string, string>): Promise<PromptPreview> =>
  http.post(`/agent-prompts/${encodeURIComponent(name)}/preview`, { arguments: args });
export const apiPromptVersions = (name: string): Promise<PromptVersion[]> =>
  http.get(`/agent-prompts/${encodeURIComponent(name)}/versions`);
export const apiPromptRollback = (name: string, version: number): Promise<AgentPrompt> =>
  http.post(`/agent-prompts/${encodeURIComponent(name)}/rollback`, { version });

export default http;

// ========== 医疗 UDI：追溯 / 留痕报表（U2/U4）==========
export interface UdiUnitRow {
  id: number; udiKey: string; gtin: string; lot: string | null; serial: string | null;
  expiry: string | null; production: string | null; status: string;
  packageSscc: string | null; workOrderNo: string | null; templateCode: string | null;
  printedAt: string | null; createdAt: string;
}
export interface UdiTraceEvent {
  id: number; eventType: string; statusBefore: string | null; statusAfter: string | null;
  refType: string | null; refNo: string | null; occurredAt: string; detail?: any;
}
export interface UdiTraceResult {
  found: 'unit' | 'package';
  unit: UdiUnitRow | null;
  package: any;
  timeline: UdiTraceEvent[];
  hierarchy: any;
  reverse: { issuedCount: number; shippedCount: number; refs: Array<any> } | null;
}
export interface UdiPrintAudit {
  since: string | null; until: string | null; totalEvents: number;
  totals: { printed: number; failed: number; units: number };
  byDay: Array<{ day: string; printed: number; failed: number; units: number }>;
  byTemplate: Array<{ templateCode: string; printed: number; failed: number }>;
}

export const apiUdiTrace = (code: string): Promise<UdiTraceResult> =>
  http.get(`/udi/trace/${encodeURIComponent(code)}`);
export const apiUdiUnits = (params?: any): Promise<{ total: number; items: UdiUnitRow[] }> =>
  http.get('/udi/units', { params });
export const apiUdiPrintAudit = (params?: any): Promise<UdiPrintAudit> =>
  http.get('/udi/report/print-audit', { params });
export const apiUdiPrinterProfiles = (): Promise<any> => http.get('/udi/printer-profiles');

/** CSV 下载走浏览器（拦截器会把文件流当 JSON 拆坏），token 拼进 URL（JwtAuthGuard 支持 query.token） */
export const udiExportUrl = (path: string, params: Record<string, any> = {}) => {
  const qs = new URLSearchParams({
    ...params,
    token: localStorage.getItem('labelflow_access') || '',
  }).toString();
  return `/api/v1${path}?${qs}`;
};
