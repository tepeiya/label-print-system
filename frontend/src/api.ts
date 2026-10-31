// 前端 API 客户端（统一响应体 { code, message, data }）
const BASE = '/api/v1';

async function req<T>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.message || '请求失败');
  return json.data as T;
}

export const api = {
  login: (username: string, password: string) => req('POST', '/auth/login', { username, password }),
  listTemplates: (q = {}) => req('GET', '/templates?' + new URLSearchParams(q)),
  saveTemplate: (t: any) => req('POST', '/templates', t),
  updateTemplate: (id: number, t: any) => req('PUT', `/templates/${id}`, t),
  previewBarcode: (spec: any) => fetch(BASE + '/barcode/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  }).then((r) => r.blob()),
  createPrintJob: (job: any) => req('POST', '/print/jobs', job),
  evalFormula: (expr: string, vars: any) => req('POST', '/formula/eval', { expr, vars }),
};
