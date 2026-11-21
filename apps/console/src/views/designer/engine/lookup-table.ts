// =============================================================================
// lookup-table.ts —— 公式查表函数族单一真源（第五层 · 数据绑定/工具）
//
// 用途：变价表（SKU→价格）、物料映射（SKU→物料/仓位）等高频场景，
//   在白名单公式里用 LOOKUP / VLOOKUP 直接从"表字符串"查值，无需新增数据源或 DB。
//
// 数据契约（表 = 字符串，前后端同口径，保证 parity）：
//   ① JSON 对象：'{"A100":12.5,"B200":9.9}'        → key→单列值
//   ② JSON 行数组：'[["A100","MAT1","E"],["B200","MAT2","W"]]'  → 首列为 key，其余为多列
//   ③ 紧凑 KV 文本：'A100=12.5;B200=9.9'（分号/换行分隔行，=或:分隔键值）
//
// 纯函数、零依赖。后端 core/lookup-table.ts 是本文件的 parity 副本，由 lookup-table.parity.test.ts 锁定。
// 诚实边界：表数据经 {{var}} 注入时是字符串；后端 tokenize 不支持字符串内转义，
//   故内联 JSON（含双引号）不可用，请用 KV 文本内联或 {{var}} 注入 JSON。
// =============================================================================

/** 解析后的表：key（trim 后字符串）→ 该行的列值数组（索引 0 为 key 对应的首列） */
export type ParsedTable = Map<string, any[]>;

/** 值归一化：纯数字串→number、true/false→boolean，其余 trim 后原样返回 */
function coerce(raw: unknown): any {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (s === '') return '';
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  return s;
}

function rowFromValue(v: unknown): any[] {
  return Array.isArray(v) ? v.map(coerce) : [coerce(v)];
}

/**
 * 把任意输入解析为查找表。
 * - Array：每项 [key, ...cols] 或标量（标量自身既作 key 又作值）
 * - Object：每个字段 key→值
 * - String：先试 JSON.parse（对象/数组递归），失败则按 KV 文本解析
 * - 其他：空表
 */
export function parseTable(input: unknown): ParsedTable {
  const map: ParsedTable = new Map();
  const put = (key: unknown, cols: any[]) => {
    const k = String(key ?? '').trim();
    if (!k) return;
    map.set(k, cols);
  };

  if (Array.isArray(input)) {
    for (const item of input) {
      if (Array.isArray(item) && item.length) {
        // 行数组 [key, ...cols]：首列为查找键，其余为数据列
        put(item[0], item.slice(1).map(coerce));
      } else {
        // 标量项：自身既作键也作唯一数据列
        put(item, [coerce(item)]);
      }
    }
    return map;
  }
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) put(k, rowFromValue(v));
    return map;
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return map;
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return parseTable(parsed);
    } catch {
      // 非 JSON → 按 KV 文本解析（下方）
    }
    // 紧凑 KV 文本：行分隔 ; 或换行；键分隔 = 或 :（取第一个匹配的分隔符）
    for (const line of s.split(/[;\n]/)) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      const colon = t.indexOf(':');
      let sep = -1;
      if (eq >= 0 && colon >= 0) sep = Math.min(eq, colon);
      else if (eq >= 0) sep = eq;
      else if (colon >= 0) sep = colon;
      if (sep <= 0) continue; // 无合法分隔符的行忽略
      const key = t.slice(0, sep).trim();
      const rest = t.slice(sep + 1).trim();
      // 值内可用 , 或 | 表示多列（VLOOKUP 取列用）
      put(key, rest.split(/[,|]/).map(coerce));
    }
    return map;
  }
  return map;
}

/** LOOKUP：按 key 取首列值；未找到/空一律返回 fallback（缺省 ''） */
export function lookup(table: ParsedTable, key: unknown, fallback?: unknown): any {
  const row = table.get(String(key ?? '').trim());
  const v = row?.[0];
  return v === undefined || v === '' ? (fallback ?? '') : v;
}

/** VLOOKUP：按 key 取第 col 个数据列（1-based，默认 1 = 首列，同 LOOKUP）；未找到/空返回 fallback */
export function vlookup(table: ParsedTable, key: unknown, col?: unknown, fallback?: unknown): any {
  const row = table.get(String(key ?? '').trim());
  if (!row) return fallback ?? '';
  let idx: number;
  if (col === undefined || col === null || col === '') idx = 0; // 默认首数据列
  else {
    const n = Number(col);
    idx = Number.isFinite(n) ? Math.max(0, Math.floor(n) - 1) : 0;
  }
  const v = row[idx];
  return v === undefined || v === '' ? (fallback ?? '') : v;
}
