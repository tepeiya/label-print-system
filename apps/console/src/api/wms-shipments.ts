// 成品发运（wms.outbound）：发货单建档 / 拣货 / 出库过账 / 签收 / 作废
// 模块门：wms.outbound（后端 Controller 已挂 @RequireModule）
import http from './index';

export type ShipType = 'SALES' | 'TRANSFER' | 'SAMPLE' | 'OTHER';

export interface ShipmentLine {
  id: number;
  lineNo: number;
  materialId: number;
  skuCode: string;
  materialName: string;
  unit: string;
  batchNo: string | null;
  locationId: number | null;
  locationText: string | null;
  packSscc: string | null;
  udiCodes: string[];
  qtyPlan: number;
  qtyPicked: number;
  qtyShipped: number;
  qtyBefore: number | null;
  qtyAfter: number | null;
  status: string;
  statusText: string;
  udiResult: Record<string, any> | null;
  error: string | null;
  pickedAt: string | null;
  shippedAt: string | null;
}

export interface ShipmentDoc {
  id: number;
  shipmentNo: string;
  shipType: ShipType;
  shipTypeText: string;
  status: string;
  statusText: string;
  warehouseId: number;
  warehouse: { id: number; code: string; name: string } | null;
  customerCode: string | null;
  customerName: string | null;
  shipTo: string | null;
  carrier: string | null;
  trackingNo: string | null;
  expectedDate: string | null;
  remark: string | null;
  createdBy: number | null;
  pickedAt: string | null;
  shippedBy: number | null;
  shippedAt: string | null;
  signedReceiver: string | null;
  signedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  lines: ShipmentLine[];
}

export interface ShipmentListRow {
  id: number;
  shipmentNo: string;
  shipType: ShipType;
  shipTypeText: string;
  warehouseId: number;
  warehouse: string;
  customerName: string | null;
  customerCode: string | null;
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
  shippedAt: string | null;
  signedAt: string | null;
}

export interface RecommendLine {
  lineId: number;
  lineNo: number;
  skuCode: string;
  qtyPlan: number;
  allocations: Array<{ batchNo: string; qty: number; locationId?: number | null; expiresAt?: string | null }>;
  allocated: number;
  shortage: number;
  expiredPicked?: string[];
  reason?: string | null;
  note?: string;
}

export const apiListShipments = (q: Record<string, any>) => http.get('/wms/shipments', { params: q });
export const apiGetShipment = (id: number) => http.get(`/wms/shipments/${id}`);
export const apiCreateShipment = (data: any) => http.post('/wms/shipments', data);
export const apiRecommendShipment = (id: number) => http.get(`/wms/shipments/${id}/recommend`);
export const apiPickShipmentLine = (id: number, lineId: number, data: any) =>
  http.post(`/wms/shipments/${id}/lines/${lineId}/pick`, data);
export const apiPostShipment = (id: number) => http.post(`/wms/shipments/${id}/post`);
export const apiSignShipment = (id: number, receiver?: string) => http.post(`/wms/shipments/${id}/sign`, { receiver });
export const apiCancelShipment = (id: number, reason?: string) => http.post(`/wms/shipments/${id}/cancel`, { reason });
