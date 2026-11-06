// =============================================================================
// 模板接口（backend/src/template/template.controller.ts 的前端镜像）
//   路径与 web/js/api.js 一一对应，只是换成 Console 的 axios 信封拆包实例。
//   list 后端返回 [rows, total] 元组（TypeORM findAndCount），这里保持原样不加工。
// =============================================================================
import http from './index';
import type { TemplateData, TemplateRecord, TemplateVersion } from '@/views/designer/types';

export interface TemplateListQuery {
  category?: string;
  keyword?: string;
  favorite?: boolean;
  page?: number;
  pageSize?: number;
}

export type TemplateListResult = [TemplateRecord[], number];

export interface CreateTemplateBody {
  name: string;
  content: TemplateData;
  category?: string;
  tags?: string[];
  acl?: Record<string, unknown>;
  createdBy?: number;
}

export interface UpdateTemplateBody {
  name?: string;
  content?: TemplateData;
  updatedBy?: number;
}

/** 导入包：exportOne 返回 { template, schemaVersion }，导入只需 name/category/tags/content */
export interface ImportTemplateBody {
  name: string;
  content: TemplateData;
  schemaVersion?: number;
  category?: string;
  tags?: string[];
}

export interface ExportedTemplate {
  template: TemplateRecord;
  schemaVersion: number;
}

export const apiListTemplates = (q: TemplateListQuery = {}): Promise<TemplateListResult> =>
  http.get('/templates', { params: q });

export const apiGetTemplate = (id: number): Promise<TemplateRecord> =>
  http.get(`/templates/${id}`);

export const apiCreateTemplate = (body: CreateTemplateBody): Promise<TemplateRecord> =>
  http.post('/templates', body);

export const apiUpdateTemplate = (id: number, body: UpdateTemplateBody): Promise<TemplateRecord> =>
  http.put(`/templates/${id}`, body);

export const apiDeleteTemplate = (id: number) =>
  http.delete(`/templates/${id}`);

export const apiCopyTemplate = (id: number, name?: string): Promise<TemplateRecord> =>
  http.post(`/templates/${id}/copy`, { name });

export const apiFavoriteTemplate = (id: number, value = true): Promise<TemplateRecord> =>
  http.post(`/templates/${id}/favorite`, { value });

export const apiTemplateVersions = (id: number): Promise<TemplateVersion[]> =>
  http.get(`/templates/${id}/versions`);

export const apiTemplateVersion = (id: number, v: number): Promise<TemplateVersion> =>
  http.get(`/templates/${id}/versions/${v}`);

export const apiRollbackTemplate = (id: number, v: number): Promise<TemplateRecord> =>
  http.post(`/templates/${id}/versions/${v}/rollback`);

export const apiImportTemplate = (body: ImportTemplateBody): Promise<TemplateRecord> =>
  http.post('/templates/import', body);

export const apiExportTemplate = (id: number): Promise<ExportedTemplate> =>
  http.get(`/templates/${id}/export`);
