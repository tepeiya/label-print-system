// =============================================================================
// gs1.ts —— GS1 应用标识符（AI）解析与 bwip `^FNC1` 文本转写（Console 预览侧副本）
//
// 【与 backend/core/gs1.ts 的 bwip 通道语义等价】
// apps/console 与 backend 是两个独立 TS 工程（console 的 tsconfig 只覆盖 src/，
// 前端产物也不该打进服务端代码），所以这里不 import 后端，只维护一份内容等价副本，
// 约定同 ./barcode-caps.ts：AI 定长表、分隔符规则、报错口径任何一项改动都必须两边同步。
//
// 为什么预览侧也必须转写（P7.4/P7.5 的前端一致性收尾）：
//   bwip-js 的 datamatrix / qrcode / microqrcode / datamatrixrectangular / azteccode
//   对括号 AI 文本**不做任何 GS1 处理**。实测判据（zxing-cpp 读 bwip-js 4.11.4 出图，scale=4）：
//     · `(01)04251234567890(10)AB789` + parsefnc → 普通符号，bytes 里带字面括号
//       ⇒ 扫描器解出一整串带括号的文本，AI 结构完全丢失（错码，不是降级）。
//     · `^FNC1` 链 + parsefnc → `]d2`（GS1 DataMatrix）/ `]Q3`（GS1 QR），
//       bytes = `b'0104251234567890\x1d10AB789'`，与后端打印结果一致。
//   后端 core/gs1.ts + core/barcode-renderer.ts 已按此实现；预览若仍喂括号文本，
//   就是「设计器看到的是 A、标签打出来是 B」——本仓库最反对的那类问题。
//
// 规则（GS1 General Specifications 5.4.6 / ISO/IEC 15418）：
//   · 符号起始必须是 FNC1（否则不构成 GS1 系统）
//   · 定长 AI 之后**不**加 FNC1
//   · 变长 AI 之后如果还有下一个 AI，必须加 FNC1 作为分隔（bwip 编成 GS 0x1D）
//   · 末尾的 FNC1 无意义，不应输出
//   · 数据里的字面 `^` 必须写成 `^^`，否则 bwip 报 bwipp.truncatedFNC（实测）
// 未知 AI 一律按变长处理（保守：宁可多一个分隔符，也不能让扫描器串字段）。
//
// 与后端的唯一差异：本文件只服务「括号形式 + 二维 bwip」这一条通道，
// 后端 parseGs1 的裸串分支（②）在这里不可达——gs1BwipText 的括号守卫两边同一口径，
// 没有括号的内容后端也保持原文本，预览同样保持原文本，不做任何猜测式转写。
// parseGs1 的括号分支与后端逐字相同（含 3 处 \u001d 正则），只在正则行加了
// no-control-regex 的行内放行——console 的 eslint 基线开着这条规则，后端 core/ 不在其 lint 范围内。
// =============================================================================

export interface Gs1Component {
  ai: string;
  data: string;
  fixed: boolean;
  /** 定长 AI 的期望数据长度；变长为 null */
  length: number | null;
}

/**
 * 定长 AI 表：ai → 数据长度（与 backend/core/gs1.ts#FIXED_AI 逐字一致）。
 * 计量类 AI（31nn–36nn）由 measureAiLen 前缀展开；4 位定长 AI 故意不进表（见后端注释 §10.27.3）。
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

/** 计量类 AI（31xx–36xx）为「前缀 + 6 位数字」定长；4xxx 一律不套（42xx 是变长地址族） */
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
 * 解析括号形式的 GS1 内容 → 组件序列（`(01)12345678901231(21)ABC`）。
 * 括号里已存在的 GS（\u001d）分隔符忽略，由本模块按定长表重新判定。
 * 结构不完整（有散字符 / 解析不到 AI）一律抛出，由调用侧走占位兜底——
 * 按「宁可不出图，不出错图」，绝不静默退回字面括号。
 */
export function parseGs1(content: string): Gs1Component[] {
  const raw = String(content ?? '');
  if (!raw.trim()) throw new Error('GS1 内容为空');
  const out: Gs1Component[] = [];
  // eslint-disable-next-line no-control-regex -- 与 backend/core/gs1.ts 逐字一致：数据段要同时排除 GS 和下一个 '('
  const re = /\((\d{2,4})\)([^\u001d(]*)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(raw))) {
    consumed += m[0].length;
    const ai = m[1];
    // eslint-disable-next-line no-control-regex -- 同上：剥掉括号里已有的 GS 分隔符
    const data = m[2].replace(/\u001d/g, '');
    const { fixed, length } = aiLength(ai);
    out.push({ ai, data, fixed, length });
  }
  // eslint-disable-next-line no-control-regex -- 同上：长度核对按剥掉 GS 后的原文
  if (consumed !== raw.replace(/\u001d/g, '').length) {
    throw new Error(`GS1 内容格式不完整或存在多余字符：${raw.slice(consumed, consumed + 24)}`);
  }
  if (!out.length) throw new Error('GS1 内容未解析到任何 AI');
  return out;
}

/**
 * bwip 的 GS1 文本：`^FNC1` + 去括号 AI 链，变长 AI 之后再用 `^FNC1` 作分隔符。
 * 一维 `gs1-128` 不用本函数：它自己解析括号 AI（实测 `]C1`，bytes 无括号），
 * 给它裸串反而报 bwipp.GS1aiMissingOpenParen。
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
 * 需要转写的二维 bcid 名单（与后端同一张表）。
 * PDF417 不在内 —— GS1 AI 在 PDF417 里走 Composite 链接语义，
 * 与这里的「起始 FNC1 + GS 分隔」不是一回事，混用会打出结构不对的符号。
 */
export const BWIP_GS1_2D_BCIDS = ['datamatrix', 'datamatrixrectangular', 'qrcode', 'microqrcode', 'azteccode'];

/**
 * 命中名单且内容含括号 AI 时返回转写后的 `^FNC1` 文本；
 * 返回 undefined 表示不适用（不在名单、或内容没有括号 AI），调用方保持原文本。
 * AI 结构解析失败会抛出：与后端 gs1BwipText 同一口径，宁可不出图也不出错图。
 *
 * microqrcode 是名单里唯一「语义上该支持、本实现做不出来」的一档，这里不等出图失败再兜底，
 * 而是显式抛出可读原因（抛不抛、抛出什么值必须与后端一致，文案可以短）：
 * 否则同一个模板在不同 dpi / 元素顺序下会得到不同的报错文案，用户看不出「是码制选错了」。
 */
export function gs1BwipText(bcid: string, content: string): string | undefined {
  if (!BWIP_GS1_2D_BCIDS.includes(bcid)) return undefined;
  if (!/\(\d{2,4}\)/.test(content)) return undefined;
  // 实测：bwip-js 4.11.4 对 microqrcode 的**任何** ^FNC1 文本都报 bwipp.qrcodeNoValidSymbol
  // （连 (13)260101 也一样），GS1 Micro QR 在本实现里出不了图。
  // 保持它在名单里（防止哪天被顺手删掉后退回「带括号的普通 Micro QR」那种错码），但必须显式拒绝。
  if (bcid === 'microqrcode') {
    throw new Error('GS1 Micro QR 暂不支持：bwip-js 无法为 Micro QR 编出 GS1 符号。请改用 DataMatrix 或 QR 码制');
  }
  return gs1ToBwipFnc1(parseGs1(content));
}
