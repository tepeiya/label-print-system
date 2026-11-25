import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';

/**
 * PDA H5 API 封装 —— 与 console 对齐：
 * - baseURL /api/v1，Vite 代理到后端
 * - Bearer token + x-tenant-code 请求头
 * - 拆 { code, message, data } 信封，非 0 抛 ApiError
 * - 401 单飞刷新令牌后重放一次
 */
const http = axios.create({
  baseURL: '/api/v1',
  timeout: 30_000,
});

export class ApiError extends Error {
  bizCode?: number;
  httpStatus?: number;
  modules?: string[];
  permissions?: string[];
  action?: string;

  constructor(
    message: string,
    bizCode?: number,
    httpStatus?: number,
    modules?: string[],
    permissions?: string[],
    action?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.bizCode = bizCode;
    this.httpStatus = httpStatus;
    this.modules = modules;
    this.permissions = permissions;
    this.action = action;
  }
}

let refreshing: Promise<boolean> | null = null;

function describeError(e: ApiError): string {
  if (e.bizCode === 4031) return '模块未订阅：请联系管理员开通 WMS 收货上架模块';
  if (e.bizCode === 4032) return '权限不足：请联系管理员分配 WMS 权限';
  if (e.bizCode === 401) return '登录已失效，请重新登录';
  return e.message || '操作失败';
}

export interface ApiEnvelope<T = any> {
  code: number;
  message: string;
  data: T;
  [k: string]: any;
}

function isEnvelope(body: any): body is ApiEnvelope {
  return body && typeof body === 'object' && 'code' in body && 'message' in body;
}

http.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('labelflow_access');
  const tenant = localStorage.getItem('labelflow_tenant');
  if (token) cfg.headers.set('Authorization', `Bearer ${token}`);
  if (tenant) cfg.headers.set('x-tenant-code', tenant);
  return cfg;
});

async function doRefresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem('labelflow_refresh');
  if (!refreshToken) return false;
  try {
    // 裸 axios：避免递归走拦截器
    const res = await axios.post<ApiEnvelope>(
      '/api/v1/auth/refresh',
      { refreshToken },
      { baseURL: '', timeout: 15_000 },
    );
    const body = res.data;
    if (isEnvelope(body) && body.code === 0 && body.data?.accessToken) {
      localStorage.setItem('labelflow_access', body.data.accessToken);
      if (body.data.refreshToken) localStorage.setItem('labelflow_refresh', body.data.refreshToken);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

http.interceptors.response.use(
  (res) => {
    const body = res.data;
    if (!isEnvelope(body)) return body as any;
    if (body.code === 0) return body.data as any;
    throw new ApiError(body.message || '操作失败', body.code, res.status, body.modules, body.permissions, body.action);
  },
  async (err: AxiosError) => {
    const cfg = err.config as (InternalAxiosRequestConfig & { __retried?: boolean }) | undefined;
    const status = err.response?.status;
    const body = err.response?.data as ApiEnvelope | undefined;

    // 401：尝试刷新令牌并重放一次
    if (status === 401 && cfg && !cfg.__retried) {
      refreshing = refreshing || doRefresh();
      const ok = await refreshing;
      refreshing = null;
      if (ok) {
        cfg.__retried = true;
        return http(cfg);
      }
      localStorage.removeItem('labelflow_access');
      localStorage.removeItem('labelflow_refresh');
      localStorage.removeItem('labelflow_tenant');
      if (location.pathname !== '/login') location.replace('/login');
      throw new ApiError('登录已失效，请重新登录', 401, 401);
    }

    const apiErr = new ApiError(
      body?.message || (status === 403 ? '无权限访问' : status === 404 ? '资源不存在' : err.message || '网络异常'),
      body?.code ?? status,
      status,
      body?.modules,
      body?.permissions,
      body?.action,
    );
    throw apiErr;
  },
);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return describeError(err);
  if (err instanceof Error) return err.message;
  return '操作失败';
}

export function get<T = any>(url: string, params?: any, config?: AxiosRequestConfig): Promise<T> {
  return http.get(url, { params, ...config }) as Promise<T>;
}

export function post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
  return http.post(url, data, config) as Promise<T>;
}

// ---------- 认证 ----------
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tenantCode: string;
}

export const apiLogin = (username: string, password: string, tenantCode?: string) =>
  post<LoginResult>('/auth/login', { username, password, tenantCode });

export const apiMe = () => get('/auth/me');

// ---------- WMS 阶段一：收货上架 ----------
export type ReceiptStatus = 'CREATED' | 'RECEIVING' | 'RECEIVED' | 'PUTAWAY_DONE' | 'CANCELLED';
export type LineStatus = 'PENDING' | 'RECEIVED' | 'PUTAWAY_DONE';
export type DiffType = 'OVER' | 'SHORT' | 'WRONG_SKU' | null;
export type TaskStatus = 'CREATED' | 'ASSIGNED' | 'DONE' | 'CANCELLED';

export interface ReceiptLine {
  id: number;
  lineNo: number;
  skuId: string | number;
  sku?: string;
  batchNo: string | null;
  qtyExpected: number;
  qtyReceived: number;
  diffType: DiffType;
  diffQty: number;
  status: LineStatus;
}

export interface PutawayTask {
  id: number;
  receiptLineId: number;
  suggestedLocationId: number | null;
  actualLocationId: number | null;
  qty: number;
  status: TaskStatus;
  recommendReason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Receipt {
  id: number;
  receiptNo: string;
  sourceType: 'MANUAL' | 'EXCEL_IMPORT';
  sourceNo: string | null;
  supplierId: number | null;
  warehouseId: number;
  status: ReceiptStatus;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: ReceiptLine[];
  putawayTasks?: PutawayTask[];
}

export interface ReceiveScanResult {
  ok: boolean;
  warning?: string;
  line: ReceiptLine;
  /** 箱码折算结果（扫中包/托盘码时） */
  pack?: { packCount: number; packQty: number; packLevel: string; units: number };
  /** UDI 建档结果（扫 UDI 码时） */
  udi?: Record<string, any>;
  udiWarning?: string;
  /** 只扫 UDI 码时，GTIN 反查出的 SKU 与命中方式 */
  udiResolved?: { gtin: string; materialCode: string; matchedBy: string };
}

export interface RecommendResult {
  taskId: number;
  locationId: number | null;
  locationCode: string | null;
  reason: string | null;
  ruleId?: number;
  currentSuggestedLocationId: number | null;
  storedReason: string | null;
}

export const apiReceiptList = (params: { status?: string; page?: number; pageSize?: number }) =>
  get<{ items: Receipt[]; total: number; page: number }>('/wms/receipts', params);

export const apiReceiptDetail = (id: number) => get<Receipt>(`/wms/receipts/${id}`);

export const apiReceiveScan = (id: number, body: {
  sku?: string; batchNo?: string; qty: number; lineId?: number; lineNo?: number; remark?: string;
  /** UDI 码（HRI 或元素串）：只给码不给 SKU 时，服务端按码内 GTIN 反查物料与收货行 */
  udiCode?: string; strictUdi?: boolean; forceUdi?: boolean;
}) =>
  post<ReceiveScanResult>(`/wms/receipts/${id}/receive-scan`, body);

export const apiPostReceipt = (id: number) => post(`/wms/receipts/${id}/post`);

export const apiTaskList = (params: { status?: string; page?: number; pageSize?: number }) =>
  get<{ items: PutawayTask[]; total: number }>('/wms/putaway-tasks', params);

export const apiTaskRecommend = (id: number) => get<RecommendResult>(`/wms/putaway-tasks/${id}/recommend`);

export const apiTaskConfirm = (id: number, body: { actualLocationId?: number; remark?: string }) =>
  post(`/wms/putaway-tasks/${id}/confirm`, body);

export const apiReprintLabel = (lineId: number) => post(`/wms/receipts/lines/${lineId}/reprint-label`);

export const apiCreateReceipt = (body: {
  receiptNo: string;
  sourceType: 'MANUAL' | 'EXCEL_IMPORT';
  sourceNo?: string;
  supplierId?: number;
  warehouseId: number;
  remark?: string;
  lines: { sku: string; batchNo?: string; qtyExpected: number; remark?: string }[];
}) => post<Receipt>('/wms/receipts', body);

// ---------- UDI 医疗合规：扫码复核 ----------
export interface UdiUdiFields {
  gtin: string | null;
  expiry: string | null;
  production: string | null;
  lot: string | null;
  serial: string | null;
}
export interface UdiParsed {
  ok: boolean;
  errors: string[];
  warnings: string[];
  hri: string;
  udi: UdiUdiFields;
  di: string;
  pi: string;
  fields: Array<{ ai: string; title: string; value: string; group: string }>;
}
export interface UdiScanVerdict {
  ok: boolean;
  codeOk: boolean;
  match: boolean;
  message: string;
  mismatches: Array<{ field: string; expected: string; actual: string | null }>;
  parsed: UdiParsed;
}

export const apiUdiScanVerify = (body: {
  code: string;
  expect: { gtin?: string; expiry?: string; lot?: string; serial?: string };
  strict?: boolean;
}) => post<UdiScanVerdict>('/udi/scan-verify', body);

export const apiUdiParse = (code: string) => post<UdiParsed>('/udi/parse', { code });

// ---------- WMS 阶段二：工单发料（D4） ----------
export type WoStatus = 'CREATED' | 'RELEASED' | 'ISSUING' | 'ISSUED' | 'CLOSED' | 'CANCELLED';
export type WoLineStatus = 'PENDING' | 'PARTIAL' | 'DONE' | 'SHORT';

export interface WorkOrderItem {
  id: number;
  woNo: string;
  productMaterialId: number;
  warehouseId: number;
  demandQty: number;
  status: WoStatus;
  shortageFlag: boolean;
  priority?: number;
  sourceType?: string;
  sourceNo?: string | null;
  createdAt?: string;
}

export interface WoLine {
  id: number;
  lineNo: number;
  materialId: number;
  materialCode?: string;
  materialName?: string;
  unit?: string;
  batchNo?: string | null;
  qtyRequired: number;
  qtyIssued: number;
  qtyShortage: number;
  status: WoLineStatus;
  shortageReason?: string | null;
}

export interface WorkOrderDetail extends WorkOrderItem {
  lines: WoLine[];
  kitSummary?: { overallKitRate?: number; shortageLines?: any[]; overallMaxSets?: number } | null;
  issueRecords?: any[];
  returns?: any[];
  [k: string]: any;
}

export interface IssueScanVerdict {
  ok: boolean;
  mismatches?: Array<{ field: string; expected: string; actual: string | null }>;
  message?: string;
  [k: string]: any;
}

export const apiWoList = (params: { status?: string; keyword?: string; page?: number; pageSize?: number }) =>
  get<{ items: WorkOrderItem[]; total: number; page: number }>('/wms/issuing/work-orders', params);

export const apiWoDetail = (id: number) => get<WorkOrderDetail>(`/wms/issuing/work-orders/${id}`);

export const apiWoKitCheck = (id: number) => post(`/wms/issuing/work-orders/${id}/kit-check`);

export const apiWoRelease = (id: number) => post(`/wms/issuing/work-orders/${id}/release`);

export const apiWoIssueStart = (id: number) => post(`/wms/issuing/work-orders/${id}/issue-start`);

/** 扫码比对（不回写库存）：扫到码后先看是否与应收批次/物料一致 */
export const apiWoIssueScan = (id: number, body: {
  lineId?: number; lineNo?: number; materialCode?: string; batchNo?: string;
  udiCode?: string; strictUdi?: boolean;
}) => post<IssueScanVerdict>(`/wms/issuing/work-orders/${id}/issue-scan`, body);

/** 发料过账：packs 传扫到的箱码（服务端按 pack_qty 折算件数，与收货口径一致） */
export const apiWoIssuePost = (id: number, body: {
  lineIds?: number[]; force?: boolean;
  packs?: Array<{ lineId?: number; lineNo?: number; udiCode: string; packCount?: number }>;
  udiCodes?: Array<{ code: string; lineNo?: number; lineId?: number }>;
}) => post<any>(`/wms/issuing/work-orders/${id}/issue-post`, body);

export const apiWoIssueDone = (id: number) => post<any>(`/wms/issuing/work-orders/${id}/issue-done`);

export const apiWoShortages = (id: number) => get<any>(`/wms/issuing/work-orders/${id}/shortages`);

export const apiWoReturn = (id: number, body: {
  lineId: number; qty: number; batchNo?: string; reason: string; idemKey?: string;
}) => post<any>(`/wms/issuing/work-orders/${id}/returns`, body);

export const woStatusLabel = (s?: string) => ({
  CREATED: '待齐套', RELEASED: '已放行', ISSUING: '发料中', ISSUED: '已发完', CLOSED: '已关单', CANCELLED: '已取消',
} as Record<string, string>)[String(s)] || String(s ?? '—');

// ---------------------------------------------------------------------------
// 成品发运（wms.outbound）：PDA 拣货 + 出库 + 签收
// ---------------------------------------------------------------------------
export interface ShipmentListItem {
  id: number;
  shipmentNo: string;
  shipType: string;
  shipTypeText: string;
  warehouse: string;
  customerName: string | null;
  carrier: string | null;
  trackingNo: string | null;
  expectedDate: string | null;
  status: string;
  statusText: string;
  lineCount: number;
  pickedLines: number;
  shippedLines: number;
  qtyPlan: number;
  createdAt: string;
}

export interface ShipmentLineItem {
  id: number; lineNo: number; skuCode: string; materialName: string; unit: string;
  batchNo: string | null; locationText: string | null; packSscc: string | null; udiCodes: string[];
  qtyPlan: number; qtyPicked: number; qtyShipped: number;
  qtyBefore: number | null; qtyAfter: number | null;
  status: string; statusText: string; error: string | null;
  udiResult: Record<string, any> | null;
}

export interface ShipmentDetail {
  id: number; shipmentNo: string; shipType: string; shipTypeText: string;
  status: string; statusText: string; warehouse: { id: number; code: string; name: string } | null;
  customerName: string | null; shipTo: string | null; carrier: string | null; trackingNo: string | null;
  expectedDate: string | null; remark: string | null;
  shippedAt: string | null; signedReceiver: string | null; signedAt: string | null;
  lines: ShipmentLineItem[];
}

export const apiShipmentList = (params: { status?: string; keyword?: string; page?: number; pageSize?: number }) =>
  get<{ items: ShipmentListItem[]; total: number }>('/wms/shipments', params);

export const apiShipmentDetail = (id: number) => get<ShipmentDetail>(`/wms/shipments/${id}`);

export const apiShipmentPick = (id: number, lineId: number, body: { qty: number; batchNo?: string }) =>
  post<ShipmentDetail>(`/wms/shipments/${id}/lines/${lineId}/pick`, body);

export const apiShipmentPost = (id: number) => post<any>(`/wms/shipments/${id}/post`);

export const apiShipmentSign = (id: number, receiver?: string) =>
  post<ShipmentDetail>(`/wms/shipments/${id}/sign`, { receiver });

export const shipStatusLabel = (s?: string) => ({
  CREATED: '待拣货', PICKING: '拣货中', PICKED: '已拣完', SHIPPED: '已出库', SIGNED: '已签收', CANCELLED: '已作废',
} as Record<string, string>)[String(s)] || String(s ?? '—');
