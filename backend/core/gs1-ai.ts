// =============================================================================
// gs1-ai.ts —— GS1 应用标识符（AI）字典与合规校验（P8.4）
//
// 【为什么要有这个文件】P7 的 encodeGs1 里只有一张 20 来项的 FIXED_LEN_AI 简表，
//   只能回答「哪个 AI 是定长」，无法回答「这个 AI 合不合法、值该多长、字符集对不对、
//   校验位对不对、日期格式对不对」。专业版 GS1 向导要的正是后面这些。
//   本文件把这些规则集中成单一真源：encodeGs1 / 校验端点 / 前端向导全部派生自此。
//
// 【范围声明（诚实）】下表覆盖 GS1 General Specifications 中**零售 / 医药 / 物流常用的
//   约 60 个精确 AI + 5 类模式族），不是全量字典（全量 500+ 条且随版本更新）。
//   未登记的 AI 走「宽松处理 + warning 提示核对手册」，不冒充已校验，也不静默拒绝。
//   各 AI 的长度按 GS1 General Specifications 常用值填写，行业专用码请以最新官方手册复核。
//
// 【单一真源】symbology.capabilities.ts 的 encodeGs1 委托本文件，不再自己维护定长表。
// =============================================================================

import { gtinCheckDigit } from './checksum';
import { GS1_AI_FULL } from './gs1-ai.full';

export type AiValueKind = 'numeric' | 'alphanumeric' | 'date' | 'gtin' | 'sscc' | 'gln' | 'amount' | 'percent';

export interface Gs1Ai {
  ai: string;
  title: string;
  /** 前端向导分组 */
  group: '标识' | '日期' | '数量金额' | '物流' | '追溯' | '内部';
  /** 定长 AI 的精确长度 */
  fixedLen?: number;
  /** 变长 AI 的最大长度 */
  maxLen?: number;
  minLen?: number;
  kind: AiValueKind;
  /** 需要模 10 校验位（GTIN / SSCC / GLN 家族） */
  checkDigit?: boolean;
  note?: string;
  example?: string;
}

// -----------------------------------------------------------------------------
// 1. 常用 AI 字典
// -----------------------------------------------------------------------------
const AI_LIST: Gs1Ai[] = [
  { ai: '00', title: 'SSCC 系列货运包装箱代码', group: '物流', fixedLen: 18, kind: 'sscc', checkDigit: true, example: '123456789012345675' },
  { ai: '01', title: 'GTIN 全球贸易项目代码', group: '标识', fixedLen: 14, kind: 'gtin', checkDigit: true, example: '12345678901231' },
  { ai: '02', title: '内含商品 GTIN', group: '标识', fixedLen: 14, kind: 'gtin', checkDigit: true },
  { ai: '03', title: 'GTIN（保留）', group: '标识', fixedLen: 14, kind: 'gtin', checkDigit: true },
  { ai: '04', title: 'GTIN（16 位，保留）', group: '标识', fixedLen: 16, kind: 'numeric' },

  { ai: '11', title: '生产日期 YYMMDD', group: '日期', fixedLen: 6, kind: 'date', example: '251231' },
  { ai: '12', title: '应付款日期 YYMMDD', group: '日期', fixedLen: 6, kind: 'date' },
  { ai: '13', title: '包装日期 YYMMDD', group: '日期', fixedLen: 6, kind: 'date' },
  { ai: '15', title: '最佳食用期 YYMMDD', group: '日期', fixedLen: 6, kind: 'date' },
  { ai: '16', title: '销售截止日 YYMMDD', group: '日期', fixedLen: 6, kind: 'date' },
  { ai: '17', title: '有效期 YYMMDD', group: '日期', fixedLen: 6, kind: 'date', example: '251231' },
  { ai: '20', title: '商品变体', group: '标识', fixedLen: 2, kind: 'numeric' },

  { ai: '10', title: '批号 / 批次', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric', example: 'AB12' },
  { ai: '21', title: '序列号', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '22', title: '消费者产品变体', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '240', title: '附加产品标识', group: '标识', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '241', title: '客户零件号', group: '标识', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '242', title: '定制款号', group: '标识', maxLen: 6, minLen: 1, kind: 'numeric' },
  { ai: '243', title: '包装组件编号', group: '标识', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '250', title: '二级序列号', group: '追溯', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '251', title: '源实体参考', group: '追溯', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '253', title: '全球文件类型标识', group: '追溯', maxLen: 30, minLen: 1, kind: 'numeric' },
  { ai: '254', title: 'GLN 扩展组件', group: '追溯', maxLen: 20, minLen: 1, kind: 'numeric' },
  { ai: '255', title: '全球优惠券代码', group: '追溯', maxLen: 25, minLen: 1, kind: 'numeric' },

  { ai: '30', title: '数量（可变计量）', group: '数量金额', maxLen: 8, minLen: 1, kind: 'numeric' },
  { ai: '37', title: '物流单元内商品数量', group: '数量金额', maxLen: 8, minLen: 1, kind: 'numeric' },

  { ai: '400', title: '客户采购订单号', group: '物流', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '401', title: '托运单号', group: '物流', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '402', title: '物流单元代码（SSCC 引用）', group: '物流', fixedLen: 17, kind: 'numeric' },
  { ai: '403', title: '路由代码', group: '物流', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '420', title: '同一邮编内交货地 GLN', group: '物流', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '421', title: '带国家码的交货地邮编', group: '物流', maxLen: 20, minLen: 4, kind: 'alphanumeric' },
  { ai: '422', title: '原产国 ISO 3166', group: '物流', fixedLen: 3, kind: 'numeric' },
  { ai: '423', title: '加工国 ISO 3166 列表', group: '物流', maxLen: 15, minLen: 1, kind: 'numeric' },
  { ai: '41', title: '交货地 GLN（旧 2 位 AI）', group: '物流', fixedLen: 13, kind: 'gln', checkDigit: true },

  { ai: '7001', title: 'NATO 库存号', group: '标识', fixedLen: 13, kind: 'numeric' },
  { ai: '7003', title: '到期日期时间 YYMMDDHHMM', group: '日期', fixedLen: 10, kind: 'numeric' },
  { ai: '8001', title: ' Roll 产品（卷装）标识', group: '标识', fixedLen: 14, kind: 'numeric' },
  { ai: '8005', title: '单价', group: '数量金额', fixedLen: 6, kind: 'numeric' },
  { ai: '8006', title: '贸易项目组件标识', group: '标识', fixedLen: 18, kind: 'gtin', checkDigit: true },
  { ai: '8008', title: '生产日期时间 YYYYMMDDHHMMSS', group: '日期', fixedLen: 14, kind: 'numeric' },
  { ai: '8017', title: '服务提供方 GSRN', group: '物流', fixedLen: 18, kind: 'sscc', checkDigit: true },
  { ai: '8018', title: '服务接受方 GSRN', group: '物流', fixedLen: 18, kind: 'sscc', checkDigit: true },
  { ai: '8020', title: '付款单参考号', group: '内部', maxLen: 25, minLen: 1, kind: 'alphanumeric' },
  { ai: '8200', title: '包装 URL', group: '内部', maxLen: 70, minLen: 1, kind: 'alphanumeric' },
  { ai: '90', title: '贸易伙伴内部信息', group: '内部', maxLen: 30, minLen: 1, kind: 'alphanumeric' },

  // 肉类加工 / 资产 / 内部应用常用 AI
  { ai: '235', title: '第三方控制序列号', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '7002', title: 'UN/ECE 胴体分类', group: '标识', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '7020', title: '屠宰场批准号', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '7021', title: '屠宰批次 / 动物群', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '7022', title: '动物标识', group: '追溯', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '7023', title: '屠宰批次 / 生产日期', group: '追溯', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '8003', title: 'GRAI 全球可退回资产标识', group: '标识', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '8004', title: 'GIAI 全球单个资产标识', group: '标识', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '8007', title: '国际银行账号 IBAN', group: '内部', maxLen: 34, minLen: 1, kind: 'alphanumeric' },
  { ai: '8009', title: '光学可读传感器指标', group: '内部', maxLen: 50, minLen: 1, kind: 'alphanumeric' },
  { ai: '8010', title: 'CPID 组件/部件标识', group: '标识', maxLen: 30, minLen: 1, kind: 'alphanumeric' },
  { ai: '8011', title: 'CPID 序列号', group: '标识', maxLen: 12, minLen: 1, kind: 'numeric' },
  { ai: '8012', title: '软件版本', group: '标识', maxLen: 20, minLen: 1, kind: 'alphanumeric' },
  { ai: '8110', title: '优惠券代码标识', group: '内部', maxLen: 70, minLen: 1, kind: 'alphanumeric' },
];

/**
 * 模式化 4 位 / 3 位 AI：GS1 规范里 310x~369x（净重/尺寸）、390x~393x（金额）、
 * 410~417（GLN）、703s（加工批次）、91~99（内部）都是「AI 本身带小数位/序号」的族，
 * 逐条枚举会漏且易错，用模式生成并保留族名。
 */
const AI_PATTERNS: Array<{ re: RegExp; make: (ai: string) => Gs1Ai }> = [
  { re: /^3[1-6][0-5]\d$/, make: (ai) => ({ ai, title: `贸易项目度量（${ai.slice(0, 2)} 族，小数位 ${ai.slice(3)}）`, group: '数量金额', fixedLen: 6, kind: 'numeric', note: 'GS1 度量 AI 为 4 位，值为 6 位数字' }) },
  { re: /^39[0-3]\d$/, make: (ai) => ({ ai, title: `应付金额 / 单价（${ai.slice(0, 3)} 族，小数位 ${ai.slice(3)}）`, group: '数量金额', maxLen: ai.startsWith('391') || ai.startsWith('393') ? 18 : 15, minLen: 1, kind: 'amount', note: '391x/393x 值末尾含 3 位 ISO 4217 货币码' }) },
  { re: /^41[0-7]$/, make: (ai) => ({ ai, title: '交货地 / 发票方 GLN', group: '物流', fixedLen: 13, kind: 'gln', checkDigit: true }) },
  { re: /^70[3-9]\d$/, make: (ai) => ({ ai, title: '加工 / 屠宰批次信息', group: '追溯', maxLen: 30, minLen: 1, kind: 'alphanumeric' }) },
  { re: /^9[1-9]$/, make: (ai) => ({ ai, title: '公司内部信息', group: '内部', maxLen: 90, minLen: 1, kind: 'alphanumeric' }) },
];

export const GS1_AI: Record<string, Gs1Ai> = Object.fromEntries(AI_LIST.map((a) => [a.ai, a]));

/**
 * 查 AI（第三层扩全量）：命中优先级 = 中文精调层 → 模式族 → GS1 官方全量层 → null。
 * - 精调层（AI_LIST）覆盖常用 65 项，带中文标题/行业分组/示例，行为与 P8.4 完全一致；
 * - 模式族（31xx–36xx/39xx/41x/703x/9x）给出比官方英文更贴切的中文语义与正确定长，
 *   故优先于全量层命中，避免 3902 等被英文标题覆盖丢失"金额"语义；
 * - 全量层（gs1-ai.full.ts）来自 GS1 官方 JSON-LD 541 项，补齐长尾（医药/物流/度量），
 *   长度/字符集由 formatString 派生，标题为官方英文 description；
 * - 重叠时以精调层/模式族为准，故老单测（中文标题/示例/校验位）不受影响。
 */
export function lookupAi(ai: string): Gs1Ai | null {
  const key = String(ai ?? '').trim();
  if (GS1_AI[key]) return GS1_AI[key];
  for (const p of AI_PATTERNS) if (p.re.test(key)) return p.make(key);
  if (GS1_AI_FULL[key]) return GS1_AI_FULL[key];
  return null;
}

/** 全量字典项数（精调 + 官方全量去重后的实际可查 AI 总数），供目录/文档展示 */
export function gs1TotalKnown(): number {
  return Object.keys({ ...GS1_AI_FULL, ...GS1_AI }).length;
}

/** 前端向导目录（含精确 AI 与模式族样例） */
export interface CatalogGroup { group: string; items: Array<{ ai: string; title: string; fixedLen?: number; maxLen?: number; kind: AiValueKind; example?: string }> }
export function gs1Catalog(): { groups: CatalogGroup[]; totalExact: number; totalFull: number; patterns: string[]; disclaimer: string } {
  const byGroup = new Map<string, CatalogGroup>();
  for (const a of AI_LIST) {
    const g = byGroup.get(a.group) ?? { group: a.group, items: [] };
    g.items.push({ ai: a.ai, title: a.title, fixedLen: a.fixedLen, maxLen: a.maxLen, kind: a.kind, example: a.example });
    byGroup.set(a.group, g);
  }
  return {
    groups: [...byGroup.values()],
    totalExact: AI_LIST.length,
    totalFull: gs1TotalKnown(),
    patterns: ['31xx–36xx 度量（6 位值）', '390x–393x 金额（含 3 位货币码）', '410–417 GLN（13 位）', '703x–709x 加工批次', '91–99 内部信息'],
    disclaimer: '精调目录覆盖常用 AI，非 GS1 General Specifications 全量中文译本；全量索引取自 GS1 官方 Application Identifiers 数据集（541 项）。中文精调字段优先，长尾 AI 以官方英文标题 + formatString 派生长度为准；复合格式取首段，行业专用码请核对 GS1 General Specifications 官方手册。非精调字段仍按宽松处理',
  };
}

// -----------------------------------------------------------------------------
// 2. 单字段校验（字符集 / 长度 / 日期 / 校验位）
// -----------------------------------------------------------------------------
export interface AiValueVerdict {
  errors: string[];
  warnings: string[];
  checkDigitOk?: boolean;
  hint: string;
}

const ALNUM = /^[\x20-\x7E]+$/;
const DATE6 = /^\d{6}$/;

export function validateAiValue(ai: string, value: string): AiValueVerdict {
  const def = lookupAi(ai);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!def) {
    warnings.push(`AI(${ai}) 未在本产品字典登记，按变长宽松处理；请核对 GS1 General Specifications`);
    return { errors, warnings, hint: '未登记 AI：仅做基本字符检查' };
  }
  const v = String(value ?? '');
  if (!v) errors.push(`AI(${ai}) ${def.title} 的值为空`);

  // 长度
  if (def.fixedLen && v.length !== def.fixedLen) {
    errors.push(`AI(${ai}) 应为 ${def.fixedLen} 位，实际 ${v.length} 位`);
  }
  if (def.maxLen && v.length > def.maxLen) {
    errors.push(`AI(${ai}) 最长 ${def.maxLen} 位，实际 ${v.length} 位`);
  }
  if (def.minLen && v.length < def.minLen) {
    errors.push(`AI(${ai}) 至少 ${def.minLen} 位，实际 ${v.length} 位`);
  }

  // 字符集
  const numericKinds: AiValueKind[] = ['numeric', 'gtin', 'sscc', 'gln', 'amount', 'percent', 'date'];
  if (numericKinds.includes(def.kind) && v && !/^\d+$/.test(v)) {
    errors.push(`AI(${ai}) 仅允许数字（${def.title}）`);
  }
  if (def.kind === 'alphanumeric' && v && !ALNUM.test(v)) {
    errors.push(`AI(${ai}) 含不可打印字符或控制字符，不符合 GS1-128 C 字符集`);
  }
  if (v.includes('(')) {
    errors.push(`AI(${ai}) 的值含有 "("，会破坏 AI 分段解析，请改用其它字符`);
  }

  // 日期（YYMMDD：月 01–12、日 01–31；不做闰年严格校验，避免过度拒绝 2/29）
  if (def.kind === 'date' && DATE6.test(v)) {
    const mm = +v.slice(2, 4), dd = +v.slice(4, 6);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) errors.push(`AI(${ai}) 日期 ${v} 的月/日不合法（YYMMDD）`);
  }

  // 模 10 校验位（GTIN / SSCC / GLN 家族）
  let checkDigitOk: boolean | undefined;
  if (def.checkDigit && /^\d+$/.test(v) && v.length >= 8) {
    try {
      const expected = gtinCheckDigit(v.slice(0, -1));
      checkDigitOk = expected === v.slice(-1);
      if (!checkDigitOk) errors.push(`AI(${ai}) 模 10 校验位错误：应为 ${expected}，实际 ${v.slice(-1)}`);
    } catch { /* 数字已校验，理论不会抛 */ }
  }

  const hint = def.fixedLen
    ? `${def.title}：定长 ${def.fixedLen} 位${def.checkDigit ? '（含模 10 校验位）' : ''}`
    : `${def.title}：变长，最长 ${def.maxLen} 位`;
  return { errors, warnings, checkDigitOk, hint };
}

// -----------------------------------------------------------------------------
// 3. 整串 GS1 校验 + 编码
// -----------------------------------------------------------------------------
export const AI_RE = /^\((\d{2,4})\)([^\s(]*)/;
const FNC1 = '\u001D';

export interface Gs1Field extends Gs1Ai {
  value: string;
  checkDigitOk?: boolean;
}

export interface Gs1Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  fields: Gs1Field[];
  /** 编码数据流（含 FNC1 占位符 \u001D；生成器按协议转义） */
  data: string;
  fnc1Prefix: boolean;
  separators: number;
  humanReadable: string;
}

/**
 * 解析 "(01)123...(10)AB..." 人类可读串 → 结构化校验 + 编码数据流。
 * 原理与 P7 一致：定长 AI 直接接续；变长 AI 后若还有 AI 必须插 FNC1 分隔，
 * 否则译码器无法断句。区别是本函数用完整字典做长度/字符集/日期/校验位校验。
 *
 * 未带括号的串视为「已编码原始数据流」原样返回（不猜测 AI 边界）。
 */
export function validateGs1(content: string): Gs1Validation {
  const s = String(content ?? '').trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  const fields: Gs1Field[] = [];

  if (!s) {
    return { ok: false, errors: ['GS1 内容为空'], warnings, fields, data: '', fnc1Prefix: false, separators: 0, humanReadable: '' };
  }
  if (!s.includes('(')) {
    warnings.push('内容不含 (AI) 括号，按「已编码原始数据流」原样处理，未做字段级校验');
    return {
      ok: true, errors, warnings, fields,
      data: s.replace(/\s+/g, ''), fnc1Prefix: true, separators: 0,
      humanReadable: s.replace(/\s+/g, ''),
    };
  }

  let rest = s;
  let data = '';
  let separators = 0;
  let guard = 0;
  while (rest.length && guard++ < 100) {
    const m = AI_RE.exec(rest);
    if (!m) { errors.push(`无法解析的片段: "${rest}"`); break; }
    const ai = m[1];
    const value = m[2];
    const def = lookupAi(ai);
    const v = validateAiValue(ai, value);
    errors.push(...v.errors);
    warnings.push(...v.warnings.map((w) => `AI(${ai}): ${w}`));

    if (def) {
      fields.push({ ...def, value, checkDigitOk: v.checkDigitOk });
    } else {
      // 未登记 AI：构造一个最小定义，保证 fields 不丢字段，前端向导仍能看到
      fields.push({ ai, value, title: '未登记 AI', group: '内部', maxLen: 90, minLen: 1, kind: 'alphanumeric' });
    }
    data += ai + value;
    rest = rest.slice(m[0].length).replace(/^\s+/, '');

    // 变长 AI 后面还有内容 → 插 FNC1（定长 AI 直接接续）
    const isFixed = !!def?.fixedLen;
    if (rest.length && !isFixed) { data += FNC1; separators++; }
  }
  if (guard >= 100) errors.push('AI 数量超过 100 个，已截断（疑似异常内容）');

  const humanReadable = fields.map((f) => `(${f.ai})${f.value}`).join('');
  return {
    ok: errors.length === 0, errors, warnings, fields,
    data, fnc1Prefix: true, separators, humanReadable,
  };
}

/** 单 AI 输入提示（前端向导选中 AI 后显示） */
export function gs1FieldHelp(ai: string): { found: boolean; ai: string; hint: string; example?: string; group?: string } {
  const def = lookupAi(ai);
  if (!def) return { found: false, ai, hint: '未登记 AI，请核对 GS1 手册或改用已登记 AI' };
  return {
    found: true, ai, group: def.group,
    hint: def.fixedLen
      ? `${def.title}｜定长 ${def.fixedLen} 位｜${def.kind}${def.checkDigit ? '｜含模 10 校验位' : ''}`
      : `${def.title}｜变长，最长 ${def.maxLen} 位｜${def.kind}`,
    example: def.example,
  };
}

/**
 * 剔除「值为空」的 AI 段：`(21)` 这类后面没有任何值的段整段去掉。
 * 产品背景：模板里常把 `(21){{serial}}` 写死，操作员没填序列号时若原样下发，
 * bwip 抛 GS1valueTooShort 导致整单打印失败；剔除后码合法，HRI 也与码保持一致。
 * 只在 HRI 形式（含括号）下处理；已经是编码数据流的串原样返回。
 */
export function stripEmptyGs1Ais(text: string): string {
  const s = String(text ?? '');
  if (!s.includes('(')) return s;
  return s
    .replace(/\(\d{2,4}\)(?=\s*(?:\r?\n|$))/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');
}
