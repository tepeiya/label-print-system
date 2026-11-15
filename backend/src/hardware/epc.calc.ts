// =============================================================================
// epc.calc.ts —— P8.5 RFID / EPC 数据层「判定层单一真源」
//
// 【范围界定（重要）】RFID 完整链路 = 标签数据编码（EPC TDS）+ 空中接口（Gen2）
// + 读写器协议（LLRP / 厂商 SDK）+ 写后读回校验。本文件只做**可纯函数验证的两头**：
//   1. EPC 数据编码/解码（SGTIN-96，GS1 EPC Tag Data Standard 1.x）；
//   2. 写操作作业信封 + 写后读回判定（防错写 / 防重 / 防漏写）。
// 中间的「真发指令给读写器」必须由本地代理 + 真机完成，见 docs/10 §10.30。
// 沙盒无读写器，绝不假装已经写过 EPC。
//
// 【SGTIN-96 位布局（共 96 bit / 24 hex）】
//   Header 8 (0x30) | Filter 3 | Partition 3 | CompanyPrefix 40~20 |
//   ItemReference 4~24 | Serial 38
//   Partition 决定 Company/Item 的位数切分，两者位数之和恒为 44，
//   Company 数字位数 + Item 数字位数恒为 13（GTIN-14 去掉校验位）。
// =============================================================================
import { gtinCheckDigit } from '../../core/checksum';
import { fingerprint } from '../jobs/trigger.calc';

export const SGTIN96_HEADER = 0x30;
export const EPC_HEX_LEN = 24;
export const EPC_BANK = '01';           // EPC memory bank（Gen2 四 bank 之一）
export const RFID_WRITE_TIMEOUT_MS = 3000;
export const RFID_MAX_RETRIES = 2;

/** GS1 EPC TDS SGTIN-96 分区表 */
export const SGTIN_PARTITIONS = [
  { p: 0, companyBits: 40, companyDigits: 12, itemBits: 4, itemDigits: 1 },
  { p: 1, companyBits: 37, companyDigits: 11, itemBits: 7, itemDigits: 2 },
  { p: 2, companyBits: 34, companyDigits: 10, itemBits: 10, itemDigits: 3 },
  { p: 3, companyBits: 30, companyDigits: 9, itemBits: 14, itemDigits: 4 },
  { p: 4, companyBits: 27, companyDigits: 8, itemBits: 17, itemDigits: 5 },
  { p: 5, companyBits: 24, companyDigits: 7, itemBits: 20, itemDigits: 6 },
  { p: 6, companyBits: 20, companyDigits: 6, itemBits: 24, itemDigits: 7 },
] as const;

export interface Sgtin96Input {
  /** GTIN-14（13 位数据 + 1 位校验位） */
  gtin: string;
  /** 公司前缀数字位数 6~12（决定分区） */
  companyPrefixLen: number;
  /** 序列号，0 ~ 2^38-1 */
  serial: number | string;
  /** 过滤值 0~7（物流/零售/…） */
  filter?: number;
}

export interface Sgtin96Decoded {
  header: number; filter: number; partition: number;
  companyPrefix: string; itemReference: string; serial: string;
  gtin: string;
}

export interface EncodeVerdict {
  ok: boolean;
  errors: string[];
  epcHex: string | null;
  tagUri: string | null;
}

const MAX_SERIAL = 2n ** 38n - 1n;

/** 归一化 hex：去空格/前缀/统一大写；非法返回 null */
export function normalizeEpcHex(v: any): string | null {
  const s = String(v ?? '').trim().replace(/^0x/i, '').replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(s)) return null;
  return s;
}

/** GTIN 模 10 校验（复用 core/checksum 真源，不重复实现权重算法） */
export function validGtin14(gtin: string): boolean {
  const s = String(gtin ?? '').replace(/\D/g, '');
  if (s.length !== 14) return false;
  try { return gtinCheckDigit(s.slice(0, 13)) === s[13]; } catch { return false; }
}

/**
 * SGTIN-96 编码。
 * 原理：按分区表把 13 位 GTIN 数据切成「公司前缀」与「指示符+项目参考」两段，
 * 分别按各自位宽写进 96 bit 整数，最后低 38 bit 放序列号。
 * 所有数值范围都显式校验，超界绝不静默截断（截断会写出一张错误 EPC 标签）。
 */
export function encodeSgtin96(input: Sgtin96Input): EncodeVerdict {
  const errors: string[] = [];
  const gtin = String(input?.gtin ?? '').replace(/\D/g, '');
  if (!validGtin14(gtin)) errors.push('GTIN 必须是 14 位数字且校验位正确');
  const len = Number(input?.companyPrefixLen);
  const part = SGTIN_PARTITIONS.find((x) => x.companyDigits === len);
  if (!part) errors.push('companyPrefixLen 必须是 6~12 的整数且对应有效分区');
  let serial: bigint;
  try { serial = BigInt(String(input?.serial ?? '')); }
  catch { errors.push('serial 必须是整数'); return { ok: false, errors, epcHex: null, tagUri: null }; }
  if (serial < 0n || serial > MAX_SERIAL) errors.push(`serial 超界（0 ~ ${MAX_SERIAL}）`);
  const filter = Number(input?.filter ?? 0);
  if (!Number.isInteger(filter) || filter < 0 || filter > 7) errors.push('filter 必须是 0~7');
  if (errors.length || !part) return { ok: false, errors, epcHex: null, tagUri: null };

  // GTIN-14 = 指示符(1) + 公司前缀(len) + 项目参考(12-len) + 校验位(1)
  const body = gtin.slice(0, 13);
  const companyPrefix = body.slice(1, 1 + len);
  const itemReference = body[0] + body.slice(1 + len);   // 长度 = 13 - len = part.itemDigits
  if (itemReference.length !== part.itemDigits) {
    return { ok: false, errors: ['GTIN 切分与分区表不一致'], epcHex: null, tagUri: null };
  }
  if (BigInt(companyPrefix) >= (1n << BigInt(part.companyBits)) ||
      BigInt(itemReference) >= (1n << BigInt(part.itemBits))) {
    return { ok: false, errors: ['公司前缀/项目参考超出该分区位宽'], epcHex: null, tagUri: null };
  }

  let bits = 0n;
  bits = (bits << 8n) | BigInt(SGTIN96_HEADER);
  bits = (bits << 3n) | BigInt(filter);
  bits = (bits << 3n) | BigInt(part.p);
  bits = (bits << BigInt(part.companyBits)) | BigInt(companyPrefix);
  bits = (bits << BigInt(part.itemBits)) | BigInt(itemReference);
  bits = (bits << 38n) | serial;
  const epcHex = bits.toString(16).toUpperCase().padStart(EPC_HEX_LEN, '0');
  return {
    ok: true, errors: [], epcHex,
    tagUri: `urn:epc:tag:sgtin-96:${filter}.${companyPrefix}.${itemReference}.${serial.toString()}`,
  };
}

/** SGTIN-96 解码：反向按位读取，并用模 10 重建 GTIN-14 校验位 */
export function decodeSgtin96(hex: string): Sgtin96Decoded | null {
  const s = normalizeEpcHex(hex);
  if (!s) return null;
  let bits = BigInt(`0x${s}`);
  const serial = (bits & ((1n << 38n) - 1n)).toString(); bits >>= 38n;
  const part = SGTIN_PARTITIONS.find((x) => x.p === Number((bits >> 44n) & 0b111n));
  if (!part) return null;
  const itemReference = (bits & ((1n << BigInt(part.itemBits)) - 1n)).toString().padStart(part.itemDigits, '0');
  bits >>= BigInt(part.itemBits);
  const companyPrefix = (bits & ((1n << BigInt(part.companyBits)) - 1n)).toString().padStart(part.companyDigits, '0');
  bits >>= BigInt(part.companyBits);
  const pAndFilter = bits;              // 14 bit = header(8) + filter(3) + partition(3)
  const partitionValue = Number(pAndFilter & 0b111n);          // 最低 3 bit 是分区
  const filter = Number((pAndFilter >> 3n) & 0b111n);          // 中间 3 bit 是过滤值
  const header = Number(pAndFilter >> 6n);
  if (header !== SGTIN96_HEADER || partitionValue !== part.p) return null;
  const body = itemReference[0] + companyPrefix + itemReference.slice(1);
  let checkDigit: string;
  try { checkDigit = gtinCheckDigit(body); } catch { return null; }
  const gtin = body + checkDigit;
  return { header, filter, partition: part.p, companyPrefix, itemReference, serial, gtin };
}

// ---------------------------------------------------------------- 写操作与读回校验

export interface RfidWriteJob {
  jobKey: string;
  epcHex: string;
  bank: string;
  timeoutMs: number;
  retries: number;
  verifyReadBack: boolean;
  /** 期望写后读回值（与 epcHex 相同，显式列出便于代理侧比对） */
  expectedReadBack: string;
}

/** 生成 RFID 写操作信封（供本地代理消费；不在这里发任何设备指令） */
export function rfidWriteJob(tenantId: number, jobId: number, epcHex: string): RfidWriteJob | null {
  const s = normalizeEpcHex(epcHex);
  if (!s) return null;
  return {
    jobKey: fingerprint({ t: tenantId, j: jobId, epc: s }),
    epcHex: s, bank: EPC_BANK,
    timeoutMs: RFID_WRITE_TIMEOUT_MS, retries: RFID_MAX_RETRIES,
    verifyReadBack: true, expectedReadBack: s,
  };
}

export interface WriteVerdict {
  ok: boolean;
  verified: boolean;
  reason: string;
  normalizedReadBack: string | null;
}

/**
 * 写后读回判定（P8.5 的重点：写成功 ≠ 写对）。
 * 归一化后逐 hex 比较；空读回、长度不符、脏字符一律判失败，绝不按「宽松通过」。
 * 只有读回值完全一致才算 verified，否则代理必须重试或标记失败并留痕。
 */
export function verifyEpcWrite(expectedEpc: string, readBack: any): WriteVerdict {
  const expected = normalizeEpcHex(expectedEpc);
  const actual = normalizeEpcHex(readBack);
  if (!expected) return { ok: false, verified: false, reason: '期望 EPC 不是合法 96-bit hex', normalizedReadBack: actual };
  if (!actual) return { ok: false, verified: false, reason: '读回值为空或格式非法', normalizedReadBack: null };
  if (actual !== expected) {
    return { ok: false, verified: false, reason: `读回不一致（期望 ${expected}，实读 ${actual}）`, normalizedReadBack: actual };
  }
  return { ok: true, verified: true, reason: '写后读回一致', normalizedReadBack: actual };
}

/** 防重：同一 EPC 是否已在本批次写过（避免一模板多数据时重复写同一张标签） */
export function epcDedupeVerdict(epcHex: string, seen: string[] | Set<string>): { duplicate: boolean; key: string } {
  const key = normalizeEpcHex(epcHex) ?? String(epcHex ?? '').toUpperCase();
  // seen 里的历史值也必须归一化，否则大小写不同就能绕过防重（真实缺陷，别只归一化当前值）
  const raw = seen instanceof Set ? [...seen] : (seen ?? []);
  const set = new Set(raw.map((v) => normalizeEpcHex(v) ?? String(v ?? '').toUpperCase()));
  return { duplicate: set.has(key), key };
}
