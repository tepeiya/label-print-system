// =============================================================================
// api.js —— 后端 API 客户端（统一响应体 { code, message, data }）
//   Access Token 15 分钟过期：请求遇到 401 自动用 refreshToken 换新，
//   刷新失败则自动重新登录（开发态默认账号），避免模板库显示「Token 失效」。
// =============================================================================

const BASE = (() => {
  // 支持通过 query 覆盖：?api=http://host:3200/api/v1
  const q = new URLSearchParams(location.search).get('api');
  return q || 'http://localhost:3200/api/v1';
})();

const TOKEN_KEY = 'labelflow.token';
const REFRESH_KEY = 'labelflow.refresh';

/** 当前后端地址（用于错误提示，如「确认后端已启动」） */
export function apiBase() {
  return BASE;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY) || '';
}
export function setTokens(accessToken, refreshToken) {
  setToken(accessToken || '');
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

/** 底层请求：返回 { status, json }，不抛异常（网络错误除外） */
async function raw(method, path, body, { auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

let refreshing = null;

/** 用 refreshToken 续期；失败则清空本地凭证 */
async function refreshAccessToken() {
  const rt = getRefreshToken();
  if (!rt) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { status, json } = await raw('POST', '/auth/refresh', { refreshToken: rt }, { auth: false });
      if (status < 400 && json?.code === 0 && json.data?.accessToken) {
        setTokens(json.data.accessToken, json.data.refreshToken || rt);
        return true;
      }
    } catch {
      /* 网络异常按刷新失败处理 */
    }
    setTokens('', '');
    return false;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

/** 开发态默认账号登录，失败返回 false */
export async function doLogin(username = 'admin', password = 'admin123') {
  try {
    const { status, json } = await raw('POST', '/auth/login', { username, password }, { auth: false });
    if (status < 400 && json?.code === 0 && json.data?.accessToken) {
      setTokens(json.data.accessToken, json.data.refreshToken);
      return true;
    }
  } catch (e) {
    console.warn('[auth] 登录失败：', e.message);
  }
  return false;
}

async function req(method, path, body, retried = false) {
  const { status, json } = await raw(method, path, body);

  // Access Token 过期：先刷新，刷新失败再自动重登，然后重试一次原请求
  if (status === 401 && !retried && path !== '/auth/login' && path !== '/auth/refresh') {
    const refreshed = await refreshAccessToken();
    if (refreshed) return req(method, path, body, true);
    if (await doLogin()) return req(method, path, body, true);
  }

  if (json && json.code !== 0) throw new Error(json.message || `请求失败 (${status})`);
  if (!json) throw new Error(`HTTP ${status}`);
  return json.data;
}

export const api = {
  base: BASE,
  login: async (username, password) => {
    const r = await req('POST', '/auth/login', { username, password });
    if (r?.accessToken) setTokens(r.accessToken, r.refreshToken);
    return r;
  },
  /** 当前登录用户详情（含角色） */
  me: () => req('GET', '/auth/me'),

  // ----------------------------- 模板 -----------------------------
  listTemplates: (q = {}) => req('GET', '/templates?' + new URLSearchParams(q)),
  getTemplate: (id) => req('GET', `/templates/${id}`),
  createTemplate: (body) => req('POST', '/templates', body),
  updateTemplate: (id, body) => req('PUT', `/templates/${id}`, body),
  deleteTemplate: (id) => req('DELETE', `/templates/${id}`),
  copyTemplate: (id, name) => req('POST', `/templates/${id}/copy`, { name }),
  favoriteTemplate: (id, value = true) => req('POST', `/templates/${id}/favorite`, { value }),
  templateVersions: (id) => req('GET', `/templates/${id}/versions`),
  templateVersion: (id, v) => req('GET', `/templates/${id}/versions/${v}`),
  rollbackTemplate: (id, v) => req('POST', `/templates/${id}/versions/${v}/rollback`),
  importTemplate: (body) => req('POST', '/templates/import', body),
  exportTemplate: (id) => req('GET', `/templates/${id}/export`),

  // ----------------------------- 公式 / 条码 -----------------------------
  evalFormula: (expr, vars) => req('POST', '/formula/eval', { expr, vars }),
  validateBarcode: (sym, content) => req('POST', '/barcode/validate', { sym, content }),
  barcodeSvg: (body) => req('POST', '/barcode/svg', body),
  barcodeTypes: () => req('GET', '/barcode/types'),

  // ----------------------------- 打印机 -----------------------------
  listPrinters: () => req('GET', '/printers'),
  getPrinter: (id) => req('GET', `/printers/${id}`),
  createPrinter: (body) => req('POST', '/printers', body),
  updatePrinter: (id, body) => req('PUT', `/printers/${id}`, body),
  deletePrinter: (id) => req('DELETE', `/printers/${id}`),
  calibratePrinter: (id, body) => req('POST', `/printers/${id}/calibrate`, body),
  testPrinter: (id) => req('POST', `/printers/${id}/test`, {}),
  testPrintPrinter: (id) => req('POST', `/printers/${id}/test-print`, {}),
  printerCommands: (id, protocol) => req('POST', `/printers/${id}/test-commands`, { protocol }),

  // ----------------------------- 打印 -----------------------------
  createPrintJob: (body) => req('POST', '/print/jobs', body),
  listPrintJobs: (q = {}) => req('GET', '/print/jobs?' + new URLSearchParams(q)),
  getPrintJob: (id) => req('GET', `/print/jobs/${id}`),
  printJobLogs: (id, q = {}) => req('GET', `/print/jobs/${id}/logs?` + new URLSearchParams(q)),
  printLogs: (q = {}) => req('GET', '/print/jobs/logs?' + new URLSearchParams(q)),
  cancelPrintJob: (id) => req('POST', `/print/jobs/${id}/cancel`, {}),
  retryPrintJob: (id, seqNos) => req('POST', `/print/jobs/${id}/retry`, { seqNos }),
  reprintPrintJob: (id, seqNos) => req('POST', `/print/jobs/${id}/reprint`, { seqNos }),
  previewPrint: (body) => req('POST', '/print/preview', body),
  printCommands: (body) => req('POST', '/print/commands', body),

  // ----------------------------- 数据源 -----------------------------
  listDataSources: () => req('GET', '/data-sources'),
  dataSourceRows: (id, q = {}) => req('GET', `/data-sources/${id}/rows?` + new URLSearchParams(q)),
  saveDataSourceRows: (body) => req('POST', '/data-sources/rows', body),
  uploadDataSource: (body) => req('POST', '/data-sources/upload', body),
  /** 后端 Excel 上传（multipart/form-data） */
  uploadExcelDataSource: async (file, opts = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.name) fd.append('name', opts.name);
    if (opts.fieldMap) fd.append('fieldMap', JSON.stringify(opts.fieldMap));
    const res = await fetch(BASE + '/data-sources/upload-excel', {
      method: 'POST',
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      body: fd,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { await doLogin(); return api.uploadExcelDataSource(file, opts); }
    if (json?.code !== 0) throw new Error(json.message || `HTTP ${res.status}`);
    return json.data;
  },
  previewDataSource: (body) => req('POST', '/data-sources/preview', body),
  deleteDataSource: (id) => req('DELETE', `/data-sources/${id}`),

  // ----------------------------- SQL 数据源 -----------------------------
  saveSqlDataSource: (body) => req('POST', '/data-sources/save-sql', body),
  testSqlDataSource: (id) => req('POST', `/data-sources/${id}/sql-test`, {}),
  previewSqlDataSource: (id, params = [], limit = 200) => req('POST', `/data-sources/${id}/sql-preview`, { params, limit }),
  execSqlDataSource: (id, params = [], limit = 1000) => req('POST', `/data-sources/${id}/sql-exec`, { params, limit }),

  // ----------------------------- 用户管理（admin） -----------------------------
  listUsers: () => req('GET', '/users'),
  createUser: (body) => req('POST', '/users', body),
  updateUser: (id, body) => req('PATCH', `/users/${id}`, body),
  deleteUser: (id) => req('DELETE', `/users/${id}`),
  resetUserPassword: (id, newPassword) => req('POST', `/users/${id}/reset-password`, { newPassword }),
  grantRole: (id, role) => req('POST', `/users/${id}/roles`, { role }),
  revokeRole: (id, role) => req('DELETE', `/users/${id}/roles/${role}`),

  // ----------------------------- AI 模板生成 -----------------------------
  saveAiTemplate: (body) => req('POST', '/ai-template/save', body),
  aiTemplateJobs: (limit = 20) => req('GET', `/ai-template/jobs?limit=${limit}`),
  listAiModels: () => req('GET', '/ai-template/models'),
  createAiModel: (body) => req('POST', '/ai-template/models', body),
  testAiModel: (id) => req('POST', `/ai-template/models/${id}/test`, {}),
  deleteAiModel: (id) => req('DELETE', `/ai-template/models/${id}`),

  // ----------------------------- 审计 / 流水号 -----------------------------
  auditLogs: (q = {}) => req('GET', '/audit/logs?' + new URLSearchParams(q)),
  /** 审计导出：返回 URL 浏览器直接打开下载 */
  auditExportUrl: (format = 'csv', q = {}) =>
    `${BASE}/audit/logs/export?format=${format}&${new URLSearchParams(q).toString()}&token=${getToken()}`,
  serialPreview: (id, n = 50) => req('GET', `/serial-sequences/${id}/segment-preview?n=${n}`),
};

/** 判断 Access Token 是否仍然可用（提前 60 秒续期） */
function isAccessTokenFresh(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp ? payload.exp * 1000 - Date.now() > 60_000 : true;
  } catch {
    return false;
  }
}

/** 自动登录 / 恢复会话（失败不抛异常） */
export async function ensureLogin() {
  const token = getToken();
  if (token && getRefreshToken() && isAccessTokenFresh(token)) return true;
  if (await refreshAccessToken()) return true;
  return doLogin();
}
