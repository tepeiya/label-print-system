// 库存调整单（① 手工出入库单据化）：建单 / 过账 / 作废 / 查询
import http from './index';

export type AdjustType = 'GAIN' | 'LOSS' | 'DAMAGE' | 'RETURN' | 'OTHER';

export interface AdjustLineRow {
  id: number;
  lineNo: number;
  materialId: number;
  skuCode: string;
  materialName: string;
  unit: string;
  batchNo: string | null;
  locationId: number | null;
  locationText: string | null;
  qtyDelta: number;
  status: 'PENDING' | 'DONE' | 'FAILED';
  qtyBefore: number | null;
  qtyAfter: number | null;
  error: string | null;
  postedAt: string | null;
}

export interface AdjustDoc {
  id: number;
  adjustNo: string;
  adjustType: AdjustType;
  adjustTypeText: string;
  warehouseId: number;
  warehouse: { id: number; code: string; name: string } | null;
  status: 'DRAFT' | 'PARTIAL' | 'POSTED' | 'CANCELLED';
  reason: string;
  remark: string | null;
  createdBy: number | null;
  postedBy: number | null;
  postedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  netDelta: number;
  lines: AdjustLineRow[];
}

export const apiListAdjustments = (params?: any): Promise<{ items: any[]; total: number; page: number; pageSize: number }> =>
  http.get('/inventory/adjustments', { params });

export const apiGetAdjustment = (id: number): Promise<AdjustDoc> =>
  http.get(`/inventory/adjustments/${id}`);

export const apiCreateAdjustment = (payload: any): Promise<AdjustDoc> =>
  http.post('/inventory/adjustments', payload);

export const apiPostAdjustment = (id: number): Promise<{ adjustment: AdjustDoc; results: any[]; allDone: boolean }> =>
  http.post(`/inventory/adjustments/${id}/post`);

export const apiCancelAdjustment = (id: number, reason?: string): Promise<{ adjustment: AdjustDoc; note: string }> =>
  http.post(`/inventory/adjustments/${id}/cancel`, { reason });
