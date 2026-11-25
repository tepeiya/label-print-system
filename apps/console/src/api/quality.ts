// 质量闸门（quality.qms）：检验单 / 成品放行 / 批记录
// 模块门 quality.qms（后端 Controller 已挂 @RequireModule）
import http from './index';

export interface QcSummary {
  inspections: { waiting: number; decidedToday: number; failed: number; pendingBatches: number };
  releases: { pending: number; released: number; rejected: number; stalePending: number };
  records: { open: number; submitted: number; approved: number };
}

export interface PendingBatch {
  materialId: number;
  skuCode: string;
  materialName: string;
  unit: string;
  warehouseId: number;
  warehouse: string;
  batchNo: string;
  qty: number;
  expiresAt: string | null;
  hasDraft: boolean;
  createdAt: string;
}

export const apiQualitySummary = () => http.get('/quality/summary');
export const apiPendingBatches = () => http.get('/quality/pending-batches');

// ---- 检验单 ----
export const apiListInspections = (q: Record<string, any>) => http.get('/quality/inspections', { params: q });
export const apiGetInspection = (id: number) => http.get(`/quality/inspections/${id}`);
export const apiCreateInspection = (data: any) => http.post('/quality/inspections', data);
export const apiAutoOpen = () => http.post('/quality/inspections/auto-open');
export const apiSaveItems = (id: number, items: any[]) => http.put(`/quality/inspections/${id}/items`, { items });
export const apiJudge = (id: number, data: any) => http.post(`/quality/inspections/${id}/judge`, data);
export const apiCancelInspection = (id: number, reason: string) =>
  http.post(`/quality/inspections/${id}/cancel`, { reason });

// ---- 成品放行 ----
export const apiListReleases = (q: Record<string, any>) => http.get('/quality/releases', { params: q });
export const apiGetRelease = (id: number) => http.get(`/quality/releases/${id}`);
export const apiSubmitRelease = (data: any) => http.post('/quality/releases', data);
export const apiSignRelease = (id: number, data: any) => http.post(`/quality/releases/${id}/sign`, data);
export const apiCancelRelease = (id: number, reason: string) => http.post(`/quality/releases/${id}/cancel`, { reason });

// ---- 批记录 ----
export const apiListRecords = (q: Record<string, any>) => http.get('/quality/batch-records', { params: q });
export const apiGetRecord = (id: number) => http.get(`/quality/batch-records/${id}`);
export const apiCreateRecord = (data: any) => http.post('/quality/batch-records', data);
export const apiAddStep = (id: number, data: any) => http.post(`/quality/batch-records/${id}/steps`, data);
export const apiUpdateStep = (id: number, stepId: number, data: any) =>
  http.put(`/quality/batch-records/${id}/steps/${stepId}`, data);
export const apiDeleteStep = (id: number, stepId: number) =>
  http.delete(`/quality/batch-records/${id}/steps/${stepId}`);
export const apiSubmitRecord = (id: number) => http.post(`/quality/batch-records/${id}/submit`);
export const apiApproveRecord = (id: number, data: any) => http.post(`/quality/batch-records/${id}/approve`, data);
