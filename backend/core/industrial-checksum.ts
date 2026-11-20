// =============================================================================
// industrial-checksum.ts —— 医药/工业码制专用校验位（第三层 · 码制专业性）
//
// 覆盖：
//   - HIBC LIC Modulo 43 校验字符（ANS/HIBC 2.6，Code39/Code128 载体通用）
//   - PZN（德国药品中央编号）Modulo 11 校验位（IFA 规范，PZN7/PZN8）
// 算法均已对照官方规范核实，纯函数无副作用。来源见 docs/10 §10.32。
// =============================================================================

// ------------------------------ HIBC Modulo 43 ------------------------------
// 值表：0-9→0-9，A-Z→10-35，-→36，.→37，空格→38，$→39，/→40，+→41，%→42
const HIBC_VALUE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i <= 9; i++) m[String(i)] = i;
  for (let i = 0; i < 26; i++) m[String.fromCharCode(65 + i)] = 10 + i;
  m['-'] = 36; m['.'] = 37; m[' '] = 38; m['$'] = 39; m['/'] = 40; m['+'] = 41; m['%'] = 42;
  return m;
})();
const VALUE_CHAR = Object.fromEntries(Object.entries(HIBC_VALUE).map(([c, v]) => [v, c]));

export interface HibcCheckResult {
  /** 完整数据（含前导 + 与末尾校验字符），可直接送 bwip hibccode128/hibccode39 */
  data: string;
  /** 校验字符 */
  checkChar: string;
  /** 参与求和的字符值总和（便于排查/教学） */
  sum: number;
  ok: boolean;
  error?: string;
}

/**
 * 计算 HIBC LIC 校验字符。
 * @param payload 主数据（可含或不含前导 '+'；如 '+A123BJC5D6E71' 或 'A123BJC5D6E71'）
 *   官方规范：校验 = 消息中（含前导 +，不含 * 与校验位本身）所有字符值之和 mod 43。
 *   官方样例 '+A123BJC5D6E71' 求和 145 → 145 % 43 = 16 → 'G'。
 */
export function hibcCheck(payload: string): HibcCheckResult {
  let data = String(payload ?? '').trim();
  // HIBC 主数据必须以 + 开头（LIC flag）；允许调用方省略，自动补
  if (!data.startsWith('+')) data = '+' + data;
  // 去掉可能已有的校验位场景由调用方保证只传主数据；这里只按传入串求和
  let sum = 0;
  for (const ch of data) {
    const v = HIBC_VALUE[ch];
    if (v === undefined) {
      return { data, checkChar: '', sum, ok: false, error: `HIBC 不支持字符: ${ch}` };
    }
    sum += v;
  }
  const checkChar = VALUE_CHAR[sum % 43];
  return { data: data + checkChar, checkChar, sum, ok: true };
}

/** 校验一个已带校验字符的 HIBC 串是否合法（末位重算比对） */
export function verifyHibc(full: string): boolean {
  let s = String(full ?? '').trim();
  if (s.length < 2) return false;
  const body = s.slice(0, -1);
  const given = s.slice(-1);
  const r = hibcCheck(body);
  return r.ok && r.checkChar === given;
}

// ------------------------------ PZN Modulo 11 ------------------------------
/**
 * PZN 校验位（IFA 规范）：取 7 位基础数字，从左到右乘权重 1..7，求和 mod 11。
 * - 余数 0..9 即校验位；余数 10 的号段 IFA 不发放（本函数返回 ok:false）。
 * - PZN7（历史，6 位基础 + 校验）等价于前面补 0 后按 7 位算（0×1=0 不改变求和）。
 * - 前导 0 是 PZN 的组成部分，绝不 trim。
 */
export function pznCheckDigit(base7: string): { checkDigit: string; ok: boolean; error?: string } {
  const s = String(base7 ?? '');
  if (!/^\d{6,7}$/.test(s)) {
    return { checkDigit: '', ok: false, error: 'PZN 基础数字需为 6–7 位（PZN7 六位 / PZN8 七位）' };
  }
  // 6 位（PZN7）前面补 0 → 7 位，0×1 不影响结果
  const seven = s.length === 6 ? '0' + s : s;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (+seven[i]) * (i + 1);
  const rem = sum % 11;
  if (rem === 10) {
    return { checkDigit: '', ok: false, error: '校验位为 10：该数字序列 IFA 不作为 PZN 发放' };
  }
  return { checkDigit: String(rem), ok: true };
}

/** 由基础数字生成完整 PZN8（7 位基础 + 校验位，共 8 位） */
export function buildPzn(base: string): { pzn: string; ok: boolean; error?: string } {
  const r = pznCheckDigit(base);
  if (!r.ok) return { pzn: '', ok: false, error: r.error };
  const seven = base.length === 6 ? '0' + base : base;
  return { pzn: seven + r.checkDigit, ok: true };
}

/** 校验完整 PZN（8 位，末位为校验位） */
export function verifyPzn(full: string): boolean {
  const s = String(full ?? '').trim();
  if (!/^\d{8}$/.test(s)) return false;
  const r = pznCheckDigit(s.slice(0, 7));
  return r.ok && r.checkDigit === s.slice(-1);
}
