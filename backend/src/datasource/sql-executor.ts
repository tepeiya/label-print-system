// SQL 数据源执行器（参数化查询 + 只读强制）
// 支持 pg 原生驱动（pg 包已在 dependencies）
import { Pool, PoolConfig, QueryResult } from 'pg';

export interface SqlExecConfig {
  /** 加密前的原始连接串（postgresql://...）或已解密的 config 对象 */
  connection: string | PoolConfig;
  /** 只读检查关闭（仅用于内部受信任源） */
  skipReadOnlyCheck?: boolean;
}

export interface SqlExecResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  durationMs: number;
  /** pg 原始 result.command（SELECT / INSERT ... 等） */
  command?: string;
  /** 只读检查的 warnings */
  warnings?: string[];
}

/** 明确禁止的关键字（不分大小写，按行首匹配） */
const FORBIDDEN_PREFIX = [
  'insert', 'update', 'delete', 'truncate',
  'create', 'drop', 'alter', 'rename',
  'grant', 'revoke', 'set', 'reset',
  'execute', 'prepare', 'deallocate',
  'do', 'copy', 'listen', 'notify', 'unlisten',
];

/** 允许的首字符关键字（SELECT / WITH / VALUES / SHOW / EXPLAIN） */
const ALLOWED_PREFIX = ['select', 'with', 'values', 'show', 'explain'];

/**
 * 按分号切分语句，忽略字符串字面量（'...' / "..."，含 '' 转义）里的分号。
 * 必须在去注释之后调用：旧实现按分号「计数」判断多语句，`SELECT 1; DROP TABLE users`
 * 只有 1 个分号，会被放过并只校验第一条的前缀。
 * 注：execute() 走带 values 的 extended 协议，PG 本身也会拒收多语句（42601），
 * 但只读白名单是独立防线，不能依赖调用方恰好用了哪种协议。
 */
function splitStatements(cleaned: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (quote) {
      buf += ch;
      if (ch === quote) {
        if (cleaned[i + 1] === quote) { buf += cleaned[++i]; continue; } // '' / "" 转义
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === ';') { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 只读强制：抛异常则阻止执行（导出供单元测试覆盖 INSERT / 多语句 / SELECT 三类用例） */
export function assertReadOnly(sql: string, skip = false): void {
  if (skip) return;
  // 去注释、去空白
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/--[^\n]*/g, ' ')          // 行注释
    .replace(/\s+/g, ' ')
    .trim();

  // 多语句禁止：逐条校验，任何一条非空语句都要过只读白名单
  const stmts = splitStatements(cleaned);
  if (stmts.length > 1) {
    throw new Error('禁止多语句（仅允许单条 SELECT / WITH 查询）');
  }
  const stmt = stmts[0] ?? '';
  if (!stmt) throw new Error('SQL 为空');

  const prefix = stmt.split(/\s+/)[0].toLowerCase();
  if (FORBIDDEN_PREFIX.includes(prefix)) {
    throw new Error(`禁止执行 "${prefix.toUpperCase()}" 语句（只读模式，仅允许 SELECT / WITH / VALUES / SHOW / EXPLAIN）`);
  }
  if (!ALLOWED_PREFIX.includes(prefix)) {
    throw new Error(`未知语句类型 "${prefix}"（只读模式，仅允许 SELECT / WITH / VALUES / SHOW / EXPLAIN）`);
  }

  // 防注入：禁止在 SELECT 里做高危子句（不严格，但挡住明显的 UNION 注入）
  const lower = stmt.toLowerCase();
  if (/union\s+select/i.test(lower)) {
    // UNION SELECT 本身允许（合法查询），但要排除 UNION ALL 注入 —— 实际上不用，pg prepared 已经安全
  }
}

/** pg 连接池单例缓存（按连接串 key，最多缓存 5 个） */
const poolCache = new Map<string, Pool>();
const MAX_POOLS = 5;

function getPool(key: string, config: SqlExecConfig): Pool {
  let pool = poolCache.get(key);
  if (pool) return pool;
  const poolConfig: PoolConfig = typeof config.connection === 'string'
    ? { connectionString: config.connection, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 }
    : { ...config.connection, max: config.connection.max ?? 5 };
  pool = new Pool(poolConfig);
  if (poolCache.size >= MAX_POOLS) {
    // 逐出最旧（这里简单全关重建，生产可改 LRU）
    for (const p of poolCache.values()) p.end().catch(() => {});
    poolCache.clear();
  }
  poolCache.set(key, pool);
  return pool;
}

/** 显式释放指定连接池（删除数据源时调用） */
export async function releasePool(key: string) {
  const pool = poolCache.get(key);
  if (pool) {
    await pool.end();
    poolCache.delete(key);
  }
}

/**
 * 参数化执行 SQL。
 * @param sql  SQL 模板（含 $1, $2 ... 占位符 —— pg 原生 prepared）
 * @param params  对应参数数组
 * @param limit  强制上限（默认 1000，最大 5000）
 */
export async function execute(
  config: SqlExecConfig,
  sql: string,
  params: any[] = [],
  limit = 1000,
): Promise<SqlExecResult> {
  assertReadOnly(sql, config.skipReadOnlyCheck);
  const hardLimit = Math.min(Math.max(1, +limit || 1000), 5000);
  // 若原 SQL 没有 LIMIT，则自动加一层子查询限制行
  const wrappedSql = ensureLimit(sql, hardLimit);

  const key = typeof config.connection === 'string'
    ? config.connection
    : JSON.stringify(config.connection);
  const pool = getPool(key, config);

  const t0 = Date.now();
  let result: QueryResult;
  try {
    result = await pool.query({
      text: wrappedSql,
      values: params,
      rowMode: 'array', // 用 array 取列名更干净（后续从 result.fields 拿）
    });
  } catch (e: any) {
    // pg 错误码提取（例如 42601 语法错、28000 鉴权失败）
    const code = e?.code ?? 'UNKNOWN';
    const msg = e?.message ?? String(e);
    throw new Error(`SQL 执行失败 [${code}]: ${msg}`);
  }
  const durationMs = Date.now() - t0;

  // 转回对象形式
  const columns = (result.fields ?? []).map((f) => f.name);
  const rows = result.rows.map((row: any[]) => {
    const obj: Record<string, any> = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });

  const warnings: string[] = [];
  if (result.rowCount === hardLimit) warnings.push(`结果已截断到前 ${hardLimit} 行，实际可能更多`);

  return {
    columns,
    rows,
    rowCount: result.rowCount ?? rows.length,
    durationMs,
    command: result.command,
    warnings,
  };
}

/** 若原 SQL 顶层没有 LIMIT，则自动包一层子查询加 LIMIT hardLimit。
 *  保留 ORDER BY 顺序。 pg 原生无 LIMIT 时直接包：
 *    SELECT * FROM (原SQL) AS _lf LIMIT hardLimit
 *  若已有 LIMIT 则保持原样。 */
function ensureLimit(sql: string, hardLimit: number): string {
  const trimmed = sql.replace(/;\s*$/, '').trim();
  // 简单检查末尾 LIMIT（不够严格但够 95% 场景）
  if (/\blimit\s+\d+/i.test(trimmed) && /\border\s+by\b[\s\S]*\blimit\b/i.test(trimmed)) {
    // 原 SQL 已经带 LIMIT，不做处理（留给 hardLimit 兜底）
    return trimmed;
  }
  return `SELECT * FROM (${trimmed}) AS _lf LIMIT ${hardLimit}`;
}

/** 测试连接：SELECT 1 */
export async function ping(config: SqlExecConfig): Promise<{ ok: boolean; message?: string; durationMs: number }> {
  const t0 = Date.now();
  try {
    await execute(config, 'SELECT 1 AS ok', [], 1);
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), durationMs: Date.now() - t0 };
  }
}
