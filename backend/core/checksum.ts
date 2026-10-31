// =============================================================================
// checksum.ts —— 条码校验位算法
// 这些算法同时被【公式引擎 CHECKSUM 函数】与【条码渲染/校验】复用。
// 所有函数纯函数、无副作用，便于单测。
// =============================================================================

/**
 * GTIN / EAN / UPC / ITF-14 系列模 10 校验位（权重 1,3 交替，从右向左）。
 * 原理：
 *   1) 取除校验位外的数字串，从右往左第 1 位权重 3、第 2 位权重 1、第 3 位 3……
 *   2) 加权求和 S
 *   3) 校验位 = (10 - (S mod 10)) mod 10
 * 适用：EAN-8/13、UPC-A/E、ITF-14、GS1 包装指示符场景。
 */
export function gtinCheckDigit(data: string): string {
  // 仅保留数字
  const digits = data.replace(/\D/g, '');
  if (digits.length === 0) throw new Error('GTIN 校验需要数字内容');
  let sum = 0;
  // 从右往左，最右（将被校验位取代的位置）权重 3
  for (let i = 0; i < digits.length; i++) {
    const d = +digits[digits.length - 1 - i];
    // i=0 是最右位 → 权重 3；i=1 → 权重 1；交替
    const weight = i % 2 === 0 ? 3 : 1;
    sum += d * weight;
  }
  const cd = (10 - (sum % 10)) % 10;
  return String(cd);
}

/**
 * Code 39 模 43 校验字符。
 * 原理：每个字符映射到 0-42 的值，求和后 mod 43，再映射回字符。
 */
const CODE39_MAP: Record<string, number> = (() => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*';
  const m: Record<string, number> = {};
  [...chars].forEach((c, i) => (m[c] = i));
  return m;
})();

export function code39CheckChar(data: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  let sum = 0;
  for (const ch of data.toUpperCase()) {
    const v = CODE39_MAP[ch];
    if (v === undefined) throw new Error(`Code39 不支持字符: ${ch}`);
    sum += v;
  }
  const idx = sum % 43;
  return chars[idx];
}

/**
 * Code 128 校验值（模 103）。
 * 这里以【Code Set B】为例（覆盖 ASCII 32-127，满足绝大多数业务）。
 * 原理：
 *   1) 起始符 B 值 = 104
 *   2) 每个数据字符按 Code B 取值（ASCII-32），第 i 个字符权重 = i（从 1 开始）
 *   3) check = (104 + Σ value_i * i) mod 103
 */
const CODE128B_VALUE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let c = 32; c <= 127; c++) m[String.fromCharCode(c)] = c - 32;
  return m;
})();

export function code128CheckValue(data: string): number {
  let sum = 104; // 起始符 Code B
  for (let i = 0; i < data.length; i++) {
    const v = CODE128B_VALUE[data[i]];
    if (v === undefined) throw new Error(`Code128-B 不支持字符: ${data[i]}`);
    sum += v * (i + 1); // 第 1 个字符权重 1
  }
  return sum % 103;
}

/**
 * 通用 CHECKSUM 分发（供公式引擎调用）。
 * 用法：CHECKSUM('EAN13', '690123') → '0'；CHECKSUM('CODE39','ABC') → 'X'
 */
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
