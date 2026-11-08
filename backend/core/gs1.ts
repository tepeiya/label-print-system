// =============================================================================
// gs1.ts —— GS1 应用标识符（AI）解析与 FNC1 语义落地（P7.4）
//
// 背景：GS1-128 / GS1 DataMatrix / GS1 QR 与"普通 Code128 装了数字"的差别只有一个：
//   符号起始的 FNC1 + 变长 AI 之后的 FNC1（GS 分隔）。缺了它，扫描器按普通 Code128
//   解出一整串字符，而不是结构化的 AI 字段——数据错但肉眼看不出来，是最危险的那类 bug。
//
// 规则（GS1 General Specifications 5.4.6 / ISO/IEC 15418）：
//   · 符号起始必须是 FNC1（否则不构成 GS1 系统）
//   · 定长 AI 之后**不**加 FNC1
//   · 变长 AI 之后如果还有下一个 AI，必须加 FNC1 作为分隔
//   · 末尾的 FNC1 无意义，不应输出
//
// 未知 AI 一律按变长处理（保守：宁可多一个分隔符，也不能让扫描器串字段）。
// =============================================================================

import { gtinCheckDigit } from './checksum';

export interface Gs1Component {
  ai: string;
  data: string;
  fixed: boolean;
  /** 定长 AI 的期望数据长度；变长为 null */
  length: number | null;
}

/**
 * 定长 AI 表：ai → 数据长度。
 * 计量类 AI（31nn–36nn）用 measureAiLen 前缀展开，不逐条写进表。
 * 注意本表**故意不收 4 位定长 AI**（4100–4109 GLN 地址 = 定长 13 等）：
 * 出处不在本仓库可核验的规范文本里，猜错方向的代价不对称，详见 §10.27.3。
 */
const FIXED_AI: Record<string, number> = {
  '00': 18, // SSCC
  '01': 14, // GTIN
  '02': 14, // 内装物 GTIN
  '11': 6,  // 生产日期
  '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, // 各类日期
  '410': 13, '411': 13, '412': 13, '413': 13, '414': 13, '415': 13,
  '7001': 13, '7002': 3, '7006': 4, '7007': 4, '7021': 3,
  '8006': 18, '8010': 8, '8011': 6, '8012': 12, '8013': 8, '8016': 12, '8017': 12, '8018': 18, '8019': 10,
  '8026': 13, '8031': 8, '8035': 4, '8037': 4, '8042': 2, '8043': 4, '8044': 4, '8046': 18, '8052': 14,
  '8053': 14, '8057': 14, '8059': 14, '8061': 6, '8074': 10, '8102': 4, '8103': 6, '8107': 2,
  '8110': 13, '8112': 4, '8113': 3,
};

/**
 * 计量类 AI（31xx–36xx，如 3103 = 净重 kg / 2 位小数）统一是「前缀 + 6 位数字」定长。
 *
 * 4xxx 段不套这个规律：41xx 是地址（GLN，定长 13）、42xx–46xx 是 Ship To 地址族
 * （**变长**字母数字），两者都不是 6 位。早先这里写的是
 * `/^[34][1-6]\d{2}$/ && !startsWith('41')`，等于把 42xx–46xx 判成定长 6
 * ——「该插分隔符却没插」正是会让扫描器串字段的那个方向，P7.8 复核时收窄为 31xx–36xx。
 * 4 位定长 AI（4100–4109）因此也走变长：后果只是多插一个分隔符（保守方向，字段仍能分开）。
 */
function measureAiLen(ai: string): number | null {
  if (/^3[1-6]\d{2}$/.test(ai)) return 6;
  return null;
}

/** 该 AI 是否定长；定长时返回长度 */
export function aiLength(ai: string): { fixed: boolean; length: number | null } {
  const m = measureAiLen(ai);
  if (m !== null) return { fixed: true, length: m };
  const l = FIXED_AI[ai];
  if (l !== undefined) return { fixed: true, length: l };
  return { fixed: false, length: null };
}

/**
 * 解析 GS1 内容 → 组件序列。
 * 支持两种输入：
 *   ① 括号形式 `(01)12345678901231(21)ABC`（前端/模板推荐写法，也便于人工核对）
 *   ② 裸串 `0112345678901231 21ABC`——按定长表贪婪切分，遇到不确定的 AI 抛错让上层提示
 * 括号形式里 GS（\u001d）分隔符若已存在则忽略，由本模块重新判定。
 */
export function parseGs1(content: string): Gs1Component[] {
  const raw = String(content ?? '');
  if (!raw.trim()) throw new Error('GS1 内容为空');

  // ① 括号形式
  if (/\(\d{2,4}\)/.test(raw)) {
    const out: Gs1Component[] = [];
    const re = /\((\d{2,4})\)([^\u001d(]*)/g;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(raw))) {
      consumed += m[0].length;
      const ai = m[1];
      const data = m[2].replace(/\u001d/g, '');
      const { fixed, length } = aiLength(ai);
      out.push({ ai, data, fixed, length });
    }
    if (consumed !== raw.replace(/\u001d/g, '').length) {
      throw new Error(`GS1 内容格式不完整或存在多余字符：${raw.slice(consumed, consumed + 24)}`);
    }
    if (!out.length) throw new Error('GS1 内容未解析到任何 AI');
    return out;
  }

  // ② 裸串：按 AI 长度（2/3/4 位）+ 定长表依次切
  const cleaned = raw.replace(/\u001d/g, '').trim();
  const out: Gs1Component[] = [];
  let i = 0;
  while (i < cleaned.length) {
    let ai = '', meta = { fixed: false, length: null as number | null };
    for (const n of [2, 3, 4]) {
      const cand = cleaned.slice(i, i + n);
      if (!/^\d+$/.test(cand)) continue;
      const m = aiLength(cand);
      if (m.fixed) { ai = cand; meta = m; break; }
      // 变长 AI：3 位表里没有就试 2 位（10/20/21/30/37 等），4 位仅接受 31xx–36xx 计量
      if (n === 2 && ['10', '20', '21', '30', '37', '22', '400', '402', '420', '421', '8020'].includes(cand)) { ai = cand; meta = m; break; }
      if (n === 3 && ['400', '402', '403', '420', '421', '422', '423', '424', '425', '8020'].includes(cand)) { ai = cand; meta = m; break; }
      if (n === 4 && /^3[1-6]\d{2}$/.test(cand)) { ai = cand; meta = m; break; }
    }
    if (!ai) throw new Error(`无法识别 GS1 应用标识符（位置 ${i}）：${cleaned.slice(i, i + 6)}`);
    i += ai.length;
    let data: string;
    if (meta.fixed && meta.length !== null) {
      data = cleaned.slice(i, i + meta.length);
      if (data.length !== meta.length) throw new Error(`AI ${ai} 数据长度不足，期望 ${meta.length} 位`);
    } else {
      // 变长：吃到下一个 AI 起点（数字且能匹配 AI 表）或结尾
      const next = /\((\d{2,4})\)|(?=(?:0[0-2]|1[0-7]|2[0-3]|3[0-7]|[4-8]\d{1,3})\d)/.exec(cleaned.slice(i + 1));
      const stop = next ? i + 1 + next.index : cleaned.length;
      data = cleaned.slice(i, Math.max(i, stop));
    }
    i += data.length;
    out.push({ ai, data, fixed: meta.fixed, length: meta.length });
  }
  return out;
}

/** 是否存在「变长 AI 后面还跟着 AI」的情况——决定要不要插 FNC1 分隔 */
export function needsSeparator(components: Gs1Component[]): boolean {
  return components.slice(0, -1).some((c) => !c.fixed);
}

/**
 * ZPL：`>;` 起始 FNC1，变长 AI 之后 `>8`（=FNC1/GS）。
 * @param escapeData 字段数据转义（ZPL 里 `>` 是 FNC 引导符，字面量必须写成 `>>`；
 *                   由调用方注入，避免本模块依赖具体协议语法）
 */
export function gs1ToZpl(components: Gs1Component[], escapeData: (s: string) => string = (x) => x): string {
  let s = '>;';
  components.forEach((c, idx) => {
    s += c.ai + escapeData(c.data);
    if (!c.fixed && idx < components.length - 1) s += '>8';
  });
  return s;
}

/** 位图通道（bwip-js）：括号形式 + parsefnc，由 bwip-js 负责 FNC1 编码 */
export function gs1ToBrackety(components: Gs1Component[]): string {
  return components.map((c) => `(${c.ai})${c.data}`).join('');
}

/**
 * 位图/预览通道（bwip-js）的 GS1 文本：`^FNC1` + 去括号 AI 链，变长 AI 之后再用
 * `^FNC1` 作为分隔符。二维符号只喂括号形式是**错码**，不是「降级」：
 *
 * 实测判据（zxing-cpp 3.x 读 bwip-js 4.x 出图，scale=4）：
 *   · `(01)04251234567890(10)AB789` + parsefnc → symbology `]d1` / `]Q1`，
 *     bytes = `b'(01)04251234567890(10)AB789'`，括号被当数据编进符号 ⇒ 扫描器按普通
 *     DataMatrix 解出一整串带括号的文本，AI 结构完全丢失。
 *   · `[01]…[10]…` + parse → `]d1`，方括号同样是字面量（datamatrix/qrcode 不认这套）。
 *   · 本函数写法 → `]d2`（GS1 DataMatrix）/ `]Q3`（GS1 QR），
 *     bytes = `b'010425123456789010AB789'`（`01` 定长 ⇒ 其后**不**插 GS，`10` 是最后一段 ⇒ 末尾也**不**插）。
 *     对照实验：在定长 `01` 之后多插一个 `^FNC1` 也能解出 `]d2`，但 bytes 会多出一个 `\x1d`
 *     —— 那是「数据里多一个不可见控制符」的不洁输出，所以本函数按 GS1 规则只在变长段后插。
 *   · 数据里的字面 `^` 必须写成 `^^`，否则 bwip 报 bwipp.truncatedFNC（实测）。
 *   · `bcid:'gs1-128'` 不用本函数：它自己解析括号 AI（实测 `]C1`，bytes 无括号），
 *     给它裸串反而报 bwipp.GS1aiMissingOpenParen。
 */
export function gs1ToBwipFnc1(components: Gs1Component[]): string {
  const esc = (s: string) => String(s).replace(/\^/g, '^^');
  let s = '^FNC1';
  components.forEach((c, idx) => {
    s += c.ai + esc(c.data);
    if (!c.fixed && idx < components.length - 1) s += '^FNC1';
  });
  return s;
}

/**
 * bwip 里「二维符号 + GS1 (AI)」必须改写文本，只开 parsefnc 是不够的（P7.4 复核）。
 * 名单按 bcid 给：PDF417 不在内 —— GS1 AI 在 PDF417 里走 Composite 链接语义，
 * 与这里的「起始 FNC1 + GS 分隔」不是一回事，混用会打出结构不对的符号。
 * 返回 undefined 表示不适用（不在名单、或内容没有括号 AI），调用方保持原文本。
 * AI 结构解析失败会抛出：按「宁可不打，不打错码」，由 raster 的 try/catch 转成
 * [位图] warning 并跳过该元素，而不是退回字面括号。
 *
 * microqrcode 是名单里唯一的「语义上该支持、本实现做不出来」的一档：这里不等出图失败再兜底，
 * 而是直接抛出可读原因 —— 否则同一个模板在 203/300dpi、在不同元素顺序下会得到不同的报错文案，
 * 用户看不出「是码制选错了」。
 */
export const BWIP_GS1_2D_BCIDS = ['datamatrix', 'datamatrixrectangular', 'qrcode', 'microqrcode', 'azteccode'];
export function gs1BwipText(bcid: string, content: string): string | undefined {
  if (!BWIP_GS1_2D_BCIDS.includes(bcid)) return undefined;
  if (!/\(\d{2,4}\)/.test(content)) return undefined;
  // 实测：bwip-js 4.11.4 对 microqrcode 的**任何** ^FNC1 文本都报 bwipp.qrcodeNoValidSymbol
  // （连 (13)260101 这种最短的定长 AI 也一样），即 GS1 Micro QR 这条符号在本实现里根本出不了图。
  // 保持它在名单里（防止哪天被顺手删掉后退回「带括号的普通 Micro QR」这种错码），但必须显式拒绝。
  if (bcid === 'microqrcode') {
    throw new Error('Micro QR 没有可实现的 GS1 变体：bwip-js 对任何 ^FNC1 文本都报 bwipp.qrcodeNoValidSymbol（实测）。'
      + '请改用 DATAMATRIX（GS1 DataMatrix，]d2）或 QRCODE（GS1 QR，]Q3）');
  }
  return gs1ToBwipFnc1(parseGs1(content));
}

/** GS1 裸数据流（部分固件的 EAN128 码型要求：起始 FNC1 + 0x1d 分隔） */
export function gs1ToRawStream(components: Gs1Component[]): string {
  let s = '';
  components.forEach((c, idx) => {
    s += c.ai + c.data;
    if (!c.fixed && idx < components.length - 1) s += '\u001d';
  });
  return s;
}

/**
 * 携带 Mod10 校验位的定长 AI —— 只列本表已经明确标注语义的三项。
 * (03)/(04)/(12)/(08) 也带数字，但它们是不是「GTIN + 校验位」结构本仓库没有可核验的出处，
 * 一律不校验：误报一条 warning 会让用户对正确的数据起疑，这是「猜错」的代价。
 */
const CHECK_DIGIT_AI: Record<string, string> = {
  '00': 'SSCC', '01': 'GTIN', '02': '内装物 GTIN',
};

/**
 * 结构性校验（不改数据，只报问题）。返回中文提示数组，空数组表示通过。
 * 目的：把「GTIN 位数不对 / 日期 AI 装了字母」这类错误在导出指令时就暴露，
 * 而不是等产线扫不出来才发现。
 * 注意：这些提示在 ZPL/TSPL 生成器里进 `[GS1]` warning 通道，**不拦打印**；
 * 校验位算错只说明数据本身可疑，是否放行由业务决定。
 */
export function validateGs1(components: Gs1Component[]): string[] {
  const errs: string[] = [];
  for (const c of components) {
    if (c.fixed && c.length !== null && c.data.length !== c.length) {
      errs.push(`AI (${c.ai}) 为定长 ${c.length} 位，实际 ${c.data.length} 位：${c.data}`);
      continue;
    }
    if (c.fixed && !/^\d+$/.test(c.data)) errs.push(`AI (${c.ai}) 只允许数字：${c.data}`);
    if (!c.fixed && c.data.length > 30) errs.push(`AI (${c.ai}) 变长数据超过 30 字符`);
    if (!c.fixed && /[\u001d]/.test(c.data)) errs.push(`AI (${c.ai}) 数据内含分隔符，需拆分`);
    const label = CHECK_DIGIT_AI[c.ai];
    if (label && /^\d+$/.test(c.data) && c.data.length > 1) {
      const expect = gtinCheckDigit(c.data.slice(0, -1));
      if (expect !== c.data.slice(-1)) {
        errs.push(`AI (${c.ai}) ${label} 校验位错误：末位应为 ${expect}，实际 ${c.data.slice(-1)}（${c.data}）`);
      }
    }
  }
  if (!components.some((c) => c.ai === '00' || c.ai === '01' || c.ai === '02')
    && components[0] && !/^(00|01|02)$/.test(components[0].ai)) {
    errs.push(`首个 AI 为 (${components[0].ai})，GS1 建议以 (00)/(01)/(02) 开头以保证识别`);
  }
  return [...new Set(errs)];
}
