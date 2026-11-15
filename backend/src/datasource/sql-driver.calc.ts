// =============================================================================
// sql-driver.calc.ts —— P8.4 多 SQL 驱动「方言层」单一真源（纯函数、零 DB 依赖）
//
// 【为什么要抽这一层】P0 的 sql-executor 只认 postgresql://，占位符 $1、LIMIT 包装、
//   只读白名单全写死。要支持 MySQL / SQL Server，最容易犯的错是在 Service 里散落
//   `if (mysql) ... else if (mssql) ...`，三处各写一份 soon 漂移成「分页在 MySQL 生效、
//   在 SQL Server 报错」。这里把方言差异收敛成纯函数，执行器只做 IO。
//
// 【方言差异（写清原理）】
//   - 占位符：PG 用 $1（位置参数，extended 协议）；MySQL 用 ?（prepared）；
//     SQL Server 用 @p1（命名参数，mssql 库 request.input('p1', v)）。
//   - 分页：PG/MySQL 用 LIMIT n OFFSET m；SQL Server 2012+ 用
//     OFFSET m ROWS FETCH NEXT n ROWS ONLY，且语法上要求 ORDER BY —— 包一层子查询时
//     用 ORDER BY (SELECT NULL) 满足语法而不改变内层顺序。
//   - 标识符引用：PG "x"、MySQL `x`、SQL Server [x]。字段查找拼列名必须引用，
//     否则保留字（order/select）会直接语法错。
//
// 【诚实边界】本层只做 SQL 文本与参数生成，不连库；mysql2 / mssql 由执行器懒加载，
//   未安装时明确报错（不静默假装成功）。真连库回归需第二套数据库实例，沙盒无法验收。
// =============================================================================

export type SqlDriver = 'postgres' | 'mysql' | 'mssql';

export interface DriverProfile {
  driver: SqlDriver;
  placeholderStyle: 'dollar' | 'question' | 'named';
  identifierQuote: [string, string];
  limitStyle: 'limit-offset' | 'offset-fetch';
  /** MySQL/PG 支持 SHOW/VALUES，SQL Server 不适用 */
  allowShowValues: boolean;
}

export const DRIVER_PROFILES: Record<SqlDriver, DriverProfile> = {
  postgres: { driver: 'postgres', placeholderStyle: 'dollar', identifierQuote: ['"', '"'], limitStyle: 'limit-offset', allowShowValues: true },
  mysql:    { driver: 'mysql',    placeholderStyle: 'question', identifierQuote: ['`', '`'], limitStyle: 'limit-offset', allowShowValues: true },
  mssql:    { driver: 'mssql',    placeholderStyle: 'named',    identifierQuote: ['[', ']'], limitStyle: 'offset-fetch', allowShowValues: false },
};

/** 连接串前缀 → 驱动（显式 driver 优先，避免「URL 写了 sqlserver:// 但配置说 mysql」的歧义） */
export function detectDriver(urlOrDriver: string, explicit?: string): { driver: SqlDriver | null; ok: boolean; reason: string } {
  const p = String(explicit ?? '').trim().toLowerCase();
  if (p) {
    if (['postgres', 'postgresql', 'pg'].includes(p)) return { driver: 'postgres', ok: true, reason: '显式指定 postgres' };
    if (['mysql', 'mysql2', 'mariadb'].includes(p)) return { driver: 'mysql', ok: true, reason: '显式指定 mysql' };
    if (['mssql', 'sqlserver', 'sql_server'].includes(p)) return { driver: 'mssql', ok: true, reason: '显式指定 mssql' };
    return { driver: null, ok: false, reason: `未知的 driver "${explicit}"，仅支持 postgres / mysql / mssql` };
  }
  const u = String(urlOrDriver ?? '').trim().toLowerCase();
  if (u.startsWith('postgresql://') || u.startsWith('postgres://')) return { driver: 'postgres', ok: true, reason: '连接串前缀 postgresql://' };
  if (u.startsWith('mysql://') || u.startsWith('mysql2://') || u.startsWith('mariadb://')) return { driver: 'mysql', ok: true, reason: '连接串前缀 mysql://' };
  if (u.startsWith('mssql://') || u.startsWith('sqlserver://') || u.startsWith('jdbc:sqlserver://')) return { driver: 'mssql', ok: true, reason: '连接串前缀 mssql:// / sqlserver://' };
  return {
    driver: null, ok: false,
    reason: '无法从连接串判定驱动：请使用 postgresql:// / mysql:// / mssql:// 前缀，或在 driver 字段显式指定',
  };
}

/** 安全标识符：只接受字母/下划线开头的简单列名，杜绝注入 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdentifier(name: string, driver: SqlDriver): string {
  if (!SAFE_IDENT.test(String(name ?? ''))) throw new Error(`非法字段名 "${name}"（仅允许字母/数字/下划线）`);
  const [l, r] = DRIVER_PROFILES[driver].identifierQuote;
  return `${l}${name}${r}`;
}

/**
 * 占位符转换：把 PG 风格 $1..$N 转成目标驱动风格。
 * 用引号状态机跳过字符串字面量，避免把 `'价格 $1'` 里的 $1 也替换掉。
 * 已是 ? 风格时（历史模板）原样返回，不重复转换。
 */
export function convertPlaceholders(sql: string, driver: SqlDriver): string {
  const style = DRIVER_PROFILES[driver].placeholderStyle;
  if (style === 'dollar') return sql;
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += sql[++i]; continue; }  // '' / "" 转义
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql[j])) j++;
      const n = sql.slice(i + 1, j);
      out += style === 'question' ? '?' : `@p${n}`;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 占位符按目标驱动生成（供字段查找等「从零拼 SQL」的场景） */
export function placeholder(index: number, driver: SqlDriver): string {
  const style = DRIVER_PROFILES[driver].placeholderStyle;
  return style === 'dollar' ? `$${index}` : style === 'question' ? '?' : `@p${index}`;
}

/**
 * 分页包装：把任意只读查询包成带硬上限的语句。
 * limit/offset 都是「夹取后的整数」直接内联，不作为参数 —— 因为 MySQL prepared
 * 对 LIMIT ? 支持不一致，而内联数字由调用方夹过界，不存在注入面。
 * 注意：包一层子查询会丢掉内层 ORDER BY 的「保证顺序」语义（PG 旧实现同样如此），
 * 需要稳定顺序时请在原 SQL 里写 ORDER BY 并在外层再加一层，见文档 §10.29。
 */
export function wrapLimit(sql: string, driver: SqlDriver, limit: number, offset = 0): string {
  const n = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 1000)));
  const m = Math.max(0, Math.min(10_000_000, Math.floor(Number(offset) || 0)));
  const trimmed = sql.replace(/;\s*$/, '').trim();
  if (DRIVER_PROFILES[driver].limitStyle === 'offset-fetch') {
    // SQL Server：OFFSET/FETCH 语法要求 ORDER BY；用常量排序满足语法而不改变内层顺序
    return `SELECT * FROM (${trimmed}) AS _lf ORDER BY (SELECT NULL) OFFSET ${m} ROWS FETCH NEXT ${n} ROWS ONLY`;
  }
  return `SELECT * FROM (${trimmed}) AS _lf LIMIT ${n}${m > 0 ? ` OFFSET ${m}` : ''}`;
}

/** 分页计划：把用户入参夹到合法域，返回可直接执行的 SQL 与参数口径 */
export function paginateSql(
  sql: string, driver: SqlDriver,
  opts: { limit?: number; offset?: number; params?: any[] } = {},
): { sql: string; params: any[]; limit: number; offset: number; driver: SqlDriver } {
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(opts.limit) || 1000)));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const converted = convertPlaceholders(sql, driver);
  return {
    sql: wrapLimit(converted, driver, limit, offset),
    params: Array.isArray(opts.params) ? opts.params : [],
    limit, offset, driver,
  };
}

/** 把 PG 参数数组转成 mssql 命名参数对象 { p1: v1, p2: v2 } */
export function namedParams(params: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  (params ?? []).forEach((v, i) => { out[`p${i + 1}`] = v; });
  return out;
}

// -----------------------------------------------------------------------------
// 字段查找（清单项「按字段查找」）：生成参数化 WHERE，并对行做内存匹配
// -----------------------------------------------------------------------------

export interface LookupFilters { [field: string]: string | number | boolean | null }

/** 生成参数化 WHERE 子句（列名经 quoteIdentifier 校验 + 引用，值全部走占位符） */
export function buildLookupWhere(
  filters: LookupFilters, driver: SqlDriver, startIndex = 1,
): { clause: string; params: any[]; invalid: string[] } {
  const invalid: string[] = [];
  const parts: string[] = [];
  const params: any[] = [];
  let i = startIndex;
  for (const [field, value] of Object.entries(filters ?? {})) {
    if (!SAFE_IDENT.test(field)) { invalid.push(`非法字段名 "${field}"`); continue; }
    if (value === null || value === undefined) { invalid.push(`字段 "${field}" 的查找值为空`); continue; }
    if (Array.isArray(value) || typeof value === 'object') { invalid.push(`字段 "${field}" 的查找值不支持对象/数组`); continue; }
    parts.push(`${quoteIdentifier(field, driver)} = ${placeholder(i++, driver)}`);
    params.push(value);
  }
  return { clause: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params, invalid };
}

/** 对已取回的数据行做内存查找（CSV/Excel 数据源没有 SQL 层时用），纯函数 */
export function matchLookup(row: Record<string, any>, filters: LookupFilters): boolean {
  return Object.entries(filters ?? {}).every(([k, v]) => {
    if (v === null || v === undefined || v === '') return true;   // 空条件忽略
    const cell = row?.[k];
    return String(cell ?? '').toLowerCase() === String(v).toLowerCase();
  });
}

// -----------------------------------------------------------------------------
// 自动刷新计划（清单项「数据库自动刷新」）：纯函数，调度器只消费结果
// -----------------------------------------------------------------------------
export const MIN_REFRESH_SEC = 60;
export const MAX_REFRESH_SEC = 7 * 24 * 3600;

export interface RefreshConfig {
  enabled?: boolean;
  intervalSec?: number;
  cron?: string;
  /** 刷新结果是否覆盖旧 data_rows（false = 追加） */
  replaceRows?: boolean;
}

export interface RefreshPlan {
  enabled: boolean;
  intervalSec: number;
  cron: string | null;
  replaceRows: boolean;
  /** BullMQ repeatable 的 every(ms) 或 pattern */
  repeat: { everyMs: number } | { pattern: string } | null;
  warnings: string[];
}

/** 5/6 段 cron 的宽松校验（不引 cron-parser，避免为一段判定加依赖） */
export function isCronLike(v: string): boolean {
  const parts = String(v ?? '').trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  return parts.every((p) => /^[*\d,\-/?LW#]+$/i.test(p));
}

export function refreshPlan(raw: any): RefreshPlan {
  const c = raw && typeof raw === 'object' ? raw : {};
  const warnings: string[] = [];
  const enabled = c.enabled === true;
  let intervalSec = Math.floor(Number(c.intervalSec) || 0);
  if (intervalSec > 0 && intervalSec < MIN_REFRESH_SEC) {
    warnings.push(`刷新间隔 ${intervalSec}s 低于下限 ${MIN_REFRESH_SEC}s，已夹到 ${MIN_REFRESH_SEC}s`);
    intervalSec = MIN_REFRESH_SEC;
  }
  if (intervalSec > MAX_REFRESH_SEC) {
    warnings.push(`刷新间隔超过上限 ${MAX_REFRESH_SEC}s，已夹到上限`);
    intervalSec = MAX_REFRESH_SEC;
  }
  const cronRaw = typeof c.cron === 'string' ? c.cron.trim() : '';
  let cron: string | null = null;
  if (cronRaw) {
    if (isCronLike(cronRaw)) cron = cronRaw;
    else warnings.push(`cron "${cronRaw}" 格式不合法（需 5/6 段），已忽略`);
  }
  let repeat: RefreshPlan['repeat'] = null;
  if (enabled) {
    if (cron) repeat = { pattern: cron };
    else if (intervalSec > 0) repeat = { everyMs: intervalSec * 1000 };
    else { repeat = { everyMs: 3600 * 1000 }; warnings.push('未配置 intervalSec/cron，默认每小时刷新一次'); }
  }
  return { enabled, intervalSec, cron, replaceRows: c.replaceRows !== false, repeat, warnings };
}
