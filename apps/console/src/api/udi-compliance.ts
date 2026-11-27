// UDI 合规申报（DI 台账 / 校验 / 召回 / 申报）—— 与 api/index.ts 同风格（http 是 any，不泛型）
import http, { udiExportUrl } from './index';

export interface UdiDiRow {
  id: number;
  di: string;
  name: string;
  spec: string | null;
  model: string | null;
  registrationNo: string | null;
  catalogCode: string | null;
  gmdn: string | null;
  emdn: string | null;
  issuingAgency: string;
  isSterile: boolean;
  isSingleUse: boolean;
  packageLevel: string;
  qtyInPackage: string | number | null;
  parentDi: string | null;
  status: string;
  remark: string | null;
}

export interface UdiValidationIssue {
  di: string;
  field: string;
  message: string;
  level: 'error' | 'warn';
}

export interface UdiSubmissionRow {
  id: number;
  channel: string;
  mode: string;
  dis: string[];
  status: string;
  remoteCode: string | null;
  remoteMsg: string | null;
  issues: UdiValidationIssue[] | null;
  attempts: number;
  submittedAt: string | null;
  createdAt: string;
}

export const apiUdiDiList = (params?: any): Promise<{ total: number; items: UdiDiRow[] }> =>
  http.get('/udi/di', { params, silent: true });

export const apiUdiDiSave = (rows: Partial<UdiDiRow>[]) =>
  http.post('/udi/di', { rows });

export const apiUdiDiRemove = (di: string) => http.delete(`/udi/di/${encodeURIComponent(di)}`);

export const apiUdiDiTree = (): Promise<{ total: number; tree: any[] }> =>
  http.get('/udi/di-tree', { silent: true });

export const apiUdiValidate = (dis?: string[]): Promise<{ ok: boolean; checked: number; issues: UdiValidationIssue[] }> =>
  http.post('/udi/validate', { dis: dis ?? [] });

export const apiUdiRecall = (params: any): Promise<any> =>
  http.get('/udi/recall', { params, silent: true });

export const apiUdiSubmit = (body: { channel: string; mode: string; dis?: string[] }): Promise<UdiSubmissionRow> =>
  http.post('/udi/submissions', body);

export const apiUdiSubmissions = (params?: any): Promise<{ total: number; items: UdiSubmissionRow[] }> =>
  http.get('/udi/submissions', { params, silent: true });

export const apiUdiNmpaProbe = (): Promise<{ ok: boolean; code: string; message: string; baseUrl: string; configured: boolean }> =>
  http.get('/udi/nmpa/probe', { silent: true });

/** 召回清单 CSV 直下（带 token，window.open 用） */
export const udiRecallUrl = (params: any) => udiExportUrl('/udi/recall/export', params);

/** UDI 内置模板包清单（含页面尺寸与变量名） */
export interface UdiTemplateBrief {
  code: string; name: string; scenario: string;
  page: { widthMm: number; heightMm: number; dpi?: number };
  variables: string[];
}
export const apiUdiTemplates = (): Promise<{ items: UdiTemplateBrief[]; notice: string }> =>
  http.get('/udi/templates');

/** 取模板包完整 JSON（可直接喂给 POST /templates/import） */
export const apiUdiTemplatePayload = (code: string): Promise<{
  code: string; name: string; scenario: string; template: any;
}> => http.get(`/udi/templates/${encodeURIComponent(code)}`);
