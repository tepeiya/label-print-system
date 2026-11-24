// =============================================================================
// 成品发运纯函数层（不 import 任何 TypeORM 实体，可直接被 node:test 加载）
// 口径规则集中在这里：单号、状态收敛、过账数量、动作许可。
// =============================================================================
import { BadRequestException } from '@nestjs/common';

export type ShipType = 'SALES' | 'TRANSFER' | 'SAMPLE' | 'OTHER';
export const SHIP_TYPE_TEXT: Record<ShipType, string> = {
  SALES: '销售出库', TRANSFER: '调拨出库', SAMPLE: '样品/试用', OTHER: '其他出库',
};

export const SHIP_STATUS_TEXT: Record<string, string> = {
  CREATED: '待拣货', PICKING: '拣货中', PICKED: '已拣完', SHIPPED: '已出库', SIGNED: '已签收', CANCELLED: '已作废',
};

export const SHIP_LINE_STATUS_TEXT: Record<string, string> = {
  PENDING: '待拣货', PICKED: '已拣货', SHIPPED: '已出库', SHORT: '缺量出库', FAILED: '过账失败',
};

/** 发货单号：SH-YYYYMMDD-NNNN（序号补 4 位，日期取本地时区） */
export function formatShipmentNo(d: Date, seq: number): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `SH-${ymd}-${String(seq).padStart(4, '0')}`;
}

/** 拣货阶段单据状态收敛：全拣完 → PICKED，有拣货 → PICKING，否则 CREATED */
export function nextPickStatus(lineStatuses: string[]): 'CREATED' | 'PICKING' | 'PICKED' {
  const picked = lineStatuses.filter((s) => s === 'PICKED' || s === 'SHIPPED').length;
  if (!picked) return 'CREATED';
  return lineStatuses.every((s) => s === 'PICKED' || s === 'SHIPPED') ? 'PICKED' : 'PICKING';
}

/** 动作许可：只有待拣/拣货中/已拣完能过账；已出库不能重复过账；已作废不能动 */
export function assertCanPost(status: string): void {
  if (status === 'SHIPPED' || status === 'SIGNED') throw new BadRequestException('该发货单已出库，不能重复过账');
  if (status === 'CANCELLED') throw new BadRequestException('该发货单已作废，不能过账');
}

/** 作废许可：库存一旦动过就不许作废（真实世界已发货，只能走退货入库） */
export function assertCanCancel(status: string): void {
  if (status === 'CANCELLED') throw new BadRequestException('该发货单已作废');
  if (status === 'SHIPPED' || status === 'SIGNED') {
    throw new BadRequestException('已出库的发货单不能作废（库存已变动，客户退回请走退货入库）');
  }
  if (status === 'PICKED' || status === 'PICKING') {
    // 允许作废，但调用方须知道已拣的货要回库位（本项目未做移库，拣货不动物理库存，因此安全）
  }
}

/** 签收许可：只有已出库的单能签收 */
export function assertCanSign(status: string): void {
  if (status !== 'SHIPPED') throw new BadRequestException('只有已出库的发货单能签收');
}

/** 拣货量校验：必须 > 0 且不超过计划量 */
export function assertPickQty(qty: number, qtyPlan: number, lineNo: number): void {
  if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException(`第 ${lineNo} 行：拣货数量必须为正数`);
  if (qty > qtyPlan + 1e-9) throw new BadRequestException(`第 ${lineNo} 行：拣货数量 ${qty} 超过计划量 ${qtyPlan}`);
}

/**
 * 过账数量口径：
 *   · 拣过货的行按实拣量出库（差额记 SHORT，不假装发齐）；
 *   · 没拣货的行按计划量直接出库（PDA 现场常见「扫一箱就走」，两步合一）。
 */
export function resolveShipQty(line: { qtyPlan: number; qtyPicked: number; status: string }): { qty: number; short: number } {
  const qtyPlan = Number(line.qtyPlan);
  const picked = Number(line.qtyPicked);
  const pickedAny = line.status === 'PICKED' || picked > 0;
  const qty = pickedAny ? picked : qtyPlan;
  const short = pickedAny ? Math.max(0, round3(qtyPlan - picked)) : 0;
  return { qty: round3(qty), short };
}

function round3(v: number): number {
  return Math.round((Number(v) + Number.EPSILON) * 1000) / 1000;
}
