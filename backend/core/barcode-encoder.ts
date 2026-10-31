// =============================================================================
// barcode-encoder.ts —— 自包含一维条码编码器（无第三方依赖，可单测/服务端出图）
// 实现：Code 128（Code Set B）+ EAN-13。输出为「模块序列」：
//   每个元素 {width: number(模块数), black: boolean}
// 模块宽度 = 最窄条的宽度；渲染时 modulePx = width * 单模块像素。
// 校验位取自 checksum.ts（Code128 模103 / EAN 模10）。
// =============================================================================

import { code128CheckValue, gtinCheckDigit } from './checksum';

/** Code 128 Code Set B 字符→值（ASCII 32..127 → 0..95） */
const C128B: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let c = 32; c <= 127; c++) m[String.fromCharCode(c)] = c - 32;
  return m;
})();

// Code 128 各值(0..106)对应的条形：每项为 [条,空,条,空,条,空] 模块宽（黑起交替）。
// 顺序对应值 0..106。来源为 Code 128 规范（Start B=104, Stop=106）。
const CODE128_PATTERN: number[][] = [
  [2,1,1,2,2,2],[2,2,2,1,1,2],[2,1,1,2,1,3],[2,1,3,2,1,2],[2,3,1,2,1,2],
  [1,2,1,2,3,2],[1,2,3,2,1,2],[1,3,1,1,2,2],[1,1,2,2,1,3],[1,1,3,2,2,1],
  [1,3,2,1,2,1],[1,2,1,3,2,1],[1,3,1,2,1,2],[1,1,2,1,3,2],[1,2,1,1,2,3],
  [1,1,2,3,1,2],[1,1,3,1,2,2],[2,3,1,1,2,1],[2,1,3,1,2,1],[2,1,1,3,2,1],
  [2,1,1,1,2,3],[2,1,1,3,1,2],[2,3,1,1,1,2],[1,2,2,1,1,3],[1,1,2,2,3,1],
  [1,3,2,1,1,1],[1,2,1,2,1,3],[1,2,1,1,3,1],[1,1,3,1,2,1],[3,1,1,1,2,1],
  [3,1,1,3,1,1],[3,3,1,1,1,1],[1,1,2,2,1,1],[1,1,1,2,2,1],[3,1,2,1,1,1],
  [2,1,1,2,1,1],[2,1,1,1,1,3],[2,3,1,3,1,1],[3,1,1,1,3,1],[1,3,1,1,2,1],
  [1,1,3,1,2,1],[1,3,1,3,1,1],[1,1,1,3,1,3],[1,3,1,1,3,1],[3,1,1,1,1,1],
  [2,1,2,1,1,1],[1,1,1,1,2,2],[2,1,1,1,2,2],[1,1,2,1,1,2],[3,3,1,3,1,3],
  [3,3,3,1,1,1],[3,1,3,1,3,1],[3,1,1,3,1,3],[3,1,1,1,3,3],[3,1,3,1,1,3],
  [3,1,3,3,1,1],[3,3,1,1,3,1],[3,3,1,3,3,1],[1,1,1,3,1,1],[1,1,3,1,1,1],
  [3,1,1,1,1,3],[1,1,1,3,3,3],[1,3,1,3,1,3],[1,1,3,1,3,1],[1,1,3,3,1,1],
  [1,3,3,1,1,1],[1,3,1,1,1,3],[1,1,1,1,3,3],[1,1,1,3,1,3],[3,1,3,1,1,1],
  [3,1,1,1,3,1],[1,3,3,3,1,1],[3,3,3,1,1,3],[3,1,1,3,3,1],[3,3,1,3,1,1],
  [3,1,3,1,3,1],[3,3,1,1,1,3],[3,1,1,1,3,3],[1,3,1,3,3,1],[3,3,3,1,3,1],
  [1,1,3,1,1,3],[1,3,3,1,1,3],[3,3,1,1,3,3],[1,3,1,1,3,3],[1,1,3,3,3,1],
  [3,1,1,3,3,3],[1,3,3,1,3,1],[3,3,3,3,1,1],[3,1,3,3,1,3],[3,3,1,3,3,1],
  [1,1,3,3,1,3],[1,3,1,3,3,3],[3,3,3,1,1,1],[3,1,1,1,3,1],[3,1,3,1,1,3],
  [3,3,1,1,1,1],[3,1,1,3,1,1],[3,3,1,3,1,3],[3,1,3,1,3,3],[3,1,1,3,3,3],
  [3,1,3,3,3,1],[1,3,3,3,3,1],[1,1,3,3,3,3],[1,3,3,1,3,3],[3,3,3,3,3,1],
  [1,1,1,1,1,1],[2,2,2,2,2,2], // 106 = 停止符（即值106）
];

/**
 * 编码 Code128（自动使用 Code Set B）。返回模块序列。
 * 结构：起始符(104) + 数据(各字符值,权重从1) + 校验(模103) + 停止符(106) + 终止条(2)
 */
export function encodeCode128(data: string): { width: number; black: boolean }[] {
  const values: number[] = [104]; // 起始符 B
  for (const ch of data) {
    const v = C128B[ch];
    if (v === undefined) throw new Error(`Code128-B 不支持字符: ${ch}`);
    values.push(v);
  }
  const check = code128CheckValue(data); // 模103
  values.push(check);
  values.push(106); // 停止符

  const seq: { width: number; black: boolean }[] = [];
  let black = true;
  for (const val of values) {
    const pat = CODE128_PATTERN[val];
    for (const w of pat) { seq.push({ width: w, black }); black = !black; }
  }
  seq.push({ width: 2, black: true }); // 终止条（额外 2 模块宽的条）
  return seq;
}

// EAN-13 各数字(0..9)的 L/G/R 编码（7 位条空模式，1=黑）
// 左(奇)L、左(偶)G、右(偶)R；首位由前置码决定奇偶组合。
const EAN_L: string[] = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G: string[] = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R: string[] = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const EAN_FIRST: string[] = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGGGL'];

/** 编码 EAN-13。data 应为 12 或 13 位数字（13 位时末位作校验校验）。返回模块序列。 */
export function encodeEAN13(data: string): { width: number; black: boolean }[] {
  const digits = data.replace(/\D/g, '');
  if (digits.length !== 12 && digits.length !== 13) throw new Error('EAN-13 需 12 或 13 位数字');
  const body = digits.slice(0, 12);
  const cd = gtinCheckDigit(body);
  if (digits.length === 13 && digits[12] !== cd) throw new Error('EAN-13 校验位不正确');
  const full = body + cd;
  const first = +full[0];
  const parity = EAN_FIRST[first];

  const seq: { width: number; black: boolean }[] = [];
  const push = (bits: string) => { for (const b of bits) seq.push({ width: 1, black: b === '1' }); };
  // 起始警戒 101
  push('101');
  // 左 6 位（按奇偶组合用 L/G）
  for (let i = 1; i <= 6; i++) {
    const d = +full[i];
    push(parity[i - 1] === 'L' ? EAN_L[d] : EAN_G[d]);
  }
  // 中间 01010
  push('01010');
  // 右 6 位（R）
  for (let i = 7; i <= 12; i++) push(EAN_R[+full[i]]);
  // 结束警戒 101
  push('101');
  return seq;
}

/** 把模块序列渲染为 1bit 行（每模块 1 像素宽，高度为 quiet+bar），返回像素行数组 */
export function patternToBits(seq: { width: number; black: boolean }[]): { row: number[]; width: number } {
  const row: number[] = [];
  for (const m of seq) for (let i = 0; i < m.width; i++) row.push(m.black ? 1 : 0);
  return { row, width: row.length };
}
