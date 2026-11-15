// =============================================================================
// checksum.ts —— 条码校验位算法（设计态预览用）
//   与 backend/core/checksum.ts 保持一致。公式 CHECKSUM 函数依赖本文件，
//   任何算法改动必须同步后端，并以 formula-parity 测试验证两端输出一致。
// =============================================================================

/** GTIN / EAN / UPC / ITF-14 系列模 10 校验位（权重 1,3 交替，从右向左）。 */
export function gtinCheckDigit(data: string): string {
  const digits = data.replace(/\D/g, '');
  if (digits.length === 0) throw new Error('GTIN 校验需要数字内容');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = +digits[digits.length - 1 - i];
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

const CODE39_MAP: Record<string, number> = (() => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*';
  const m: Record<string, number> = {};
  [...chars].forEach((c, i) => (m[c] = i));
  return m;
})();

/** Code 39 模 43 校验字符。 */
export function code39CheckChar(data: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  let sum = 0;
  for (const ch of data.toUpperCase()) {
    const v = CODE39_MAP[ch];
    if (v === undefined) throw new Error(`Code39 不支持字符: ${ch}`);
    sum += v;
  }
  return chars[sum % 43];
}

const CODE128B_VALUE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let c = 32; c <= 127; c++) m[String.fromCharCode(c)] = c - 32;
  return m;
})();

/** Code 128 校验值（Code Set B，模 103）。 */
export function code128CheckValue(data: string): number {
  let sum = 104;
  for (let i = 0; i < data.length; i++) {
    const v = CODE128B_VALUE[data[i]];
    if (v === undefined) throw new Error(`Code128-B 不支持字符: ${data[i]}`);
    sum += v * (i + 1);
  }
  return sum % 103;
}

/** 通用 CHECKSUM 分发（供公式引擎调用）。 */
export function checksum(scheme: string, data: string): string {
  switch (scheme.toUpperCase()) {
    case 'MOD10':
    case 'EAN13':
    case 'EAN8':
    case 'UPCA':
    case 'UPCE':
    case 'ITF14':
    case 'GTIN':
      return gtinCheckDigit(data);
    case 'CODE39':
    case 'MOD43':
      return code39CheckChar(data);
    case 'CODE128':
    case 'MOD103':
      return String(code128CheckValue(data));
    default:
      throw new Error(`未知校验方案: ${scheme}`);
  }
}
