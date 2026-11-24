// =============================================================================
// 库存调整单纯函数层（不 import 任何 TypeORM 实体，可直接被 node:test 加载）
// 口径规则集中在这里：类型-方向一致性、单号生成、状态收敛。
// =============================================================================
import { BadRequestException } from '@nestjs/common';

export type AdjustType = 'GAIN' | 'LOSS' | 'DAMAGE' | 'RETURN' | 'OTHER';

export const ADJUST_TYPE_TEXT: Record<AdjustType, string> = {
  GAIN: '盘盈', LOSS: '盘亏', DAMAGE: '报废', RETURN: '退货入库', OTHER: '其他调整',
};

/** 类型与方向的硬约束：拿「盘亏」当借口加库存是最常见的口径事故 */
export const TYPE_SIGN: Record<AdjustType, 'up' | 'down' | 'any'> = {
  GAIN: 'up', RETURN: 'up', LOSS: 'down', DAMAGE: 'down', OTHER: 'any',
};

/** 类型-方向一致性校验：up=只能增加、down=只能减少、any=不限 */
export function assertDirection(type: AdjustType, delta: number, lineNo: number): void {
  const sign = TYPE_SIGN[type];
  if (sign === 'up' && delta < 0) throw new BadRequestException(`第 ${lineNo} 行：「${ADJUST_TYPE_TEXT[type]}」只能增加库存，请检查方向`);
  if (sign === 'down' && delta > 0) throw new BadRequestException(`第 ${lineNo} 行：「${ADJUST_TYPE_TEXT[type]}」只能减少库存，请检查方向`);
}

/** 调整单号：SA-YYYYMMDD-NNNN（序号补 4 位，日期取本地时区） */
export function formatAdjustNo(d: Date, seq: number): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `SA-${ymd}-${String(seq).padStart(4, '0')}`;
}

/** 单据状态收敛：全部行 DONE → POSTED，否则 PARTIAL */
export function nextDocStatus(lineStatuses: string[]): 'POSTED' | 'PARTIAL' {
  if (!lineStatuses.length) return 'PARTIAL';
  return lineStatuses.every((s) => s === 'DONE') ? 'POSTED' : 'PARTIAL';
}
