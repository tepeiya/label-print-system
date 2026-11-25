// =============================================================================
// udi.sscc.calc.ts —— SSCC-18 生成与装箱计划（纯函数，无副作用，便于单测）
//
// SSCC-18 结构：扩展位(1) + GS1 公司前缀(7) + 序列号(9) + 校验位(1)
//   例：0 6901234 000000001 5
// 校验位与 GTIN 同源（mod 10，权重 3/1 从右向左），复用 core/checksum 的 gtinCheckDigit。
//
// 装箱计划：总件数 + 每箱件数 → 满箱数 / 尾箱件数 / 每箱实际件数。
//   尾箱（不足一箱）默认也出一箱一码，数量记真实件数（不是 packQty）。
// =============================================================================

import { gtinCheckDigit } from '../../core/checksum';

/** 演示用 GS1 公司前缀；生产用环境变量 GS1_COMPANY_PREFIX 覆盖（必须是 7 位数字） */
export const DEFAULT_GS1_PREFIX = '6901234';

export class SsccFormatError extends Error {}

/** 校验 SSCC 公司前缀 */
export function normalizePrefix(prefix?: string | null): string {
  const p = String(prefix ?? DEFAULT_GS1_PREFIX).replace(/\D/g, '');
  if (p.length !== 7) throw new SsccFormatError(`GS1 公司前缀必须是 7 位数字，当前为「${prefix ?? DEFAULT_GS1_PREFIX}」`);
  return p;
}

/**
 * 用序列号构造 SSCC-18。
 * @param prefix   7 位公司前缀
 * @param serial   序列号（1 ~ 999999999，超过 9 位会被拒，不做静默截断）
 * @param extensionDigit 扩展位（0~9，默认 0，用于区分"同一前缀下的不同码源"）
 */
export function buildSscc(prefix: string, serial: number, extensionDigit = 0): string {
  const p = normalizePrefix(prefix);
  const ext = Number(extensionDigit);
  if (!Number.isInteger(ext) || ext < 0 || ext > 9) throw new SsccFormatError(`SSCC 扩展位必须是 0~9，当前为「${extensionDigit}」`);
  if (!Number.isInteger(serial) || serial < 1 || serial > 999_999_999) {
    throw new SsccFormatError(`SSCC 序列号必须是 1~999999999 的整数，当前为「${serial}」`);
  }
  const body = `${ext}${p}${String(serial).padStart(9, '0')}`;
  return body + gtinCheckDigit(body);
}

/** 校验 SSCC-18（18 位数字 + 校验位） */
export function isValidSscc(sscc: string): boolean {
  const s = String(sscc ?? '').replace(/[\s-]/g, '');
  if (!/^\d{18}$/.test(s)) return false;
  return gtinCheckDigit(s.slice(0, 17)) === s[17];
}

export interface BoxPlan {
  /** 每箱标准件数 */
  packQty: number;
  /** 总件数 */
  totalQty: number;
  /** 满箱数量 */
  fullBoxes: number;
  /** 尾箱件数（0 表示正好装满，无尾箱） */
  tailQty: number;
  /** 每个箱子实际件数，含尾箱 */
  boxes: number[];
}

/**
 * 计算装箱计划。
 * @param allowTail 尾箱是否允许单独出一箱（false 时出现尾箱直接抛错，交给调用方转 400）
 */
export function planBoxes(totalQty: number, packQty: number, allowTail = true, maxBoxes = 1000): BoxPlan & { hasTail: boolean } {
  const total = Number(totalQty);
  const pack = Number(packQty);
  if (!(total > 0)) throw new SsccFormatError('装箱总件数必须为正数');
  if (!(pack > 0)) throw new SsccFormatError('每箱件数必须为正数');

  const fullBoxes = Math.floor((total + 1e-9) / pack);
  const tailRaw = Number((total - fullBoxes * pack).toFixed(3));
  const tailQty = tailRaw > 1e-6 ? tailRaw : 0;
  if (tailQty > 0 && !allowTail) {
    throw new SsccFormatError(`总件数 ${total} 不是每箱 ${pack} 的整数倍，尾箱 ${tailQty} 件需单独处理（allowTail=false）`);
  }
  const boxes: number[] = [
    ...Array.from({ length: fullBoxes }, () => pack),
    ...(tailQty > 0 ? [tailQty] : []),
  ];
  if (boxes.length > maxBoxes) throw new SsccFormatError(`箱数 ${boxes.length} 超过单次上限 ${maxBoxes}，请分批装箱`);
  return { packQty: pack, totalQty: total, fullBoxes, tailQty, boxes, hasTail: tailQty > 0 };
}
