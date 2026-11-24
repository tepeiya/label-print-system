// WMS 单据查询（只读）：收货单 / 上架任务 / 工单发料
// 模块门：receipts & putaway 属 wms.inbound；work-orders 属 wms.issuing。
import http from './index';

export interface WmsReceiptRow {
  id: number;
  receiptNo: string;
  sourceType: string;
  sourceNo: string | null;
  supplierId: number | null;
  warehouseId: number;
  status: string;
  remark: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface WmsPutawayTaskRow {
  id: number;
  receiptLineId: number;
  suggestedLocationId: number | null;
  actualLocationId: number | null;
  qty: number;
  status: string;
  recommendReason: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface WmsWorkOrderRow {
  id: number;
  woNo: string;
  productMaterialId: number;
  warehouseId: number;
  demandQty: number;
  status: string;
  shortageFlag: boolean;
  priority: number | null;
  sourceType: string | null;
  sourceNo: string | null;
  createdAt: string;
}

export const apiWmsReceipts = (params?: any): Promise<{ items: WmsReceiptRow[]; total: number; page: number }> =>
  http.get('/wms/receipts', { params, silent: true });

export const apiWmsReceiptDetail = (id: number): Promise<any> =>
  http.get(`/wms/receipts/${id}`, { silent: true });

export const apiWmsPutawayTasks = (params?: any): Promise<{ items: WmsPutawayTaskRow[]; total: number }> =>
  http.get('/wms/putaway-tasks', { params, silent: true });

export const apiWmsWorkOrders = (params?: any): Promise<{ items: WmsWorkOrderRow[]; total: number; page: number; pageSize: number }> =>
  http.get('/wms/work-orders', { params, silent: true });

export const apiWmsWorkOrderDetail = (id: number): Promise<any> =>
  http.get(`/wms/work-orders/${id}`, { silent: true });
