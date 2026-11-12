// =============================================================================
// redaction.calc.ts —— Agent 工具返回字段脱敏（docs/11 §11.7.7 护栏 7，B2.6）
//
// 【问题】P5 之前，print / inventory / templates 等工具的返回值把业务字段
// （客户名、地址、手机号、邮箱、单价、成本、连接串…）原样下发给 LLM。
// Agent 是可被 prompt injection 影响的通道，业务敏感数据不应无差别出域。
//
// 【策略】字段级脱敏：
//   1. 按 key 名（大小写/下划线不敏感）匹配敏感模式，值替换为掩码；
//   2. 深度遍历（对象/数组），保留结构与非敏感字段（模型仍能据结构推理）；
//   3. 掩码保留"有值/类型/少量前后缀"信息，不泄露原文：
//      字符串 → 首 1 字符 + *** + 长度提示；数字 → 保留数量级不完全精确。
//   4. 明确标注 redacted 字段清单，写进 warnings 让调用方知道数据被裁剪过。
//   5. 纯函数，不 import Nest，单测可跑。
//
// 【不变式】
//   - 输入永不被修改（返回新对象）；
//   - 不递归过深（MAX_DEPTH 防循环/超大对象），超界用占位替换；
//   - 白名单字段（如 id/status/code）不脱敏，保证 Agent 能继续编排。
// =============================================================================

/** 敏感字段名模式（key 归一化后匹配：去下划线、小写） */
const SENSITIVE_PATTERNS: RegExp[] = [
  /pass(word)?|secret|token|apikey|api_key|privatekey|credential/i,     // 凭据
  /phone|mobile|tel|fax/i,                                                // 电话
  /email|mail/i,                                                          // 邮箱
  /address|addr|street|zipcode|postcode/i,                                // 地址
  /idcard|idno|ssn|passport|license/i,                                    // 证件
  /customername|contact|recipient|consignee|buyer|supplier/i,            // 人名/主体
  /cost|price|amount|salary|balance|revenue|discount/i,                   // 金额（成本/单价）
  /dsn|conn(ection)?string|jdbc|dburl/i,                                  // 连接串
];

/** 归一化 key：去下划线/连字符、小写，便于统一匹配（如 customer_name / CustomerName） */
function normKey(k: string): string {
  return String(k).replace(/[_-]/g, '').toLowerCase();
}

/** 明确不脱敏的白名单（结构字段 / 状态码 / 计数 / 布尔标记） */
const SAFE_KEYS = new Set([
  'id', 'tenantid', 'status', 'code', 'type', 'kind', 'count', 'total', 'page',
  'pagesize', 'enabled', 'ok', 'createdat', 'updatedat', 'groupby', 'field',
  'modulecode', 'toolname', 'action', 'warnings', 'nextactions', 'summary',
  'redacted', 'redactedfields', 'idempotencykey', 'approvalid',
]);

export const MAX_DEPTH = 12;

export interface RedactionResult {
  data: any;
  /** 被脱敏的字段路径（去重、最多 50 条），用于 warnings 与审计 */
  redactedFields: string[];
  /** 是否发生过脱敏 */
  redacted: boolean;
}

/** 单值掩码：保留"有值 + 类型 + 长度量级"，不泄露原文 */
export function maskValue(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (v.length === 0) return '';
    // 首字符 + 星号 + 长度提示；短串全掩码
    const head = v.length <= 2 ? '' : v[0];
    return `${head}***(${v.length})`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '***';
    // 保留数量级与符号，不保留精确值
    const mag = v === 0 ? 0 : Math.pow(10, Math.floor(Math.log10(Math.abs(v))));
    return `~${Math.sign(v) * mag}(number)`;
  }
  if (typeof v === 'boolean') return v;   // 布尔无敏感信息，保留
  return '***';
}

function isSensitive(key: string): boolean {
  const n = normKey(key);
  if (SAFE_KEYS.has(n)) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(n));
}

/** 深度脱敏主函数（纯函数，不改输入） */
export function redact(input: any, opts: { maxDepth?: number } = {}): RedactionResult {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const fields: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (v: any, path: string, depth: number): any => {
    if (v === null || v === undefined) return v;
    if (typeof v !== 'object') return v;
    if (depth > maxDepth) return '[depth-limit]';
    if (seen.has(v)) return '[circular]';       // 防循环引用
    seen.add(v);
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));

    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (isSensitive(k)) {
        out[k] = maskValue(val);
        if (fields.length < 50 && !fields.includes(p)) fields.push(p);
      } else {
        out[k] = walk(val, p, depth + 1);
      }
    }
    return out;
  };

  const data = walk(input, '', 0);
  return { data, redactedFields: fields, redacted: fields.length > 0 };
}

/** 按工具名决定脱敏强度：只读元数据工具可放宽，业务数据工具必须脱敏 */
export function shouldRedact(toolName: string): boolean {
  // 元数据类工具（目录/权限/帮助）不含业务数据，跳过脱敏以免干扰摘要
  const metaOnly = /^(help|whoami|list_tools|list_modules|explain|catalog)/i;
  return !metaOnly.test(String(toolName ?? ''));
}

/** 生成脱敏 warning（写进 ToolResult.warnings，让模型/审计知道数据被裁剪） */
export function redactionWarning(r: RedactionResult): string | null {
  if (!r.redacted) return null;
  return `护栏7：已脱敏 ${r.redactedFields.length} 个字段（${r.redactedFields.slice(0, 6).join('、')}${r.redactedFields.length > 6 ? '…' : ''}），敏感原值未下发`;
}
