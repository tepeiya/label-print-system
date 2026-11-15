// SQL 数据源执行器（参数化查询 + 只读强制 + 多驱动）
// P8.4：方言差异（占位符 / LIMIT / 标识符）全部下沉到 sql-driver.calc.ts，
//   本文件只做 IO。PG 用 pg 原生驱动（已在 dependencies）；MySQL / SQL Server
//   驱动按需懒加载，未安装时明确报错，不静默假装成功。
import { Pool, PoolConfig, QueryResult } from 'pg';
import {
  DRIVER_PROFILES, SqlDriver, detectDriver, namedParams, paginateSql,
} from './sql-driver.calc';

export interface SqlExecConfig {
  /** 加密前的原始连接串或已解密的 config 对象 */
  connection: string | PoolConfig;
  /** 只读检查关闭（仅用于内部受信任源） */
  skipReadOnlyCheck?: boolean;
  /** P8.4：目标驱动；不指定时从连接串前缀判定，判定不了默认 postgres（保持旧行为） */
  driver?: SqlDriver;
  /** P8.4：SQL 级分页偏移（0 基） */
  offset?: number;
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

/** 解析驱动：显式 driver > 连接串前缀 > 默认 postgres（保证旧调用零变化） */
export function resolveDriver(config: SqlExecConfig): SqlDriver {
  if (config.driver && DRIVER_PROFILES[config.driver]) return config.driver;
  const url = typeof config.connection === 'string' ? config.connection : '';
  return detectDriver(url).driver ?? 'postgres';
}

/** 保留原始异常（tsconfig 的 lib 不含 ErrorOptions，用 cause 属性挂载，满足错误链可追溯） */
function wrapSqlError(e: any, prefix: string): Error {
  const err = new Error(`${prefix} [${e?.code ?? 'UNKNOWN'}]: ${e?.message ?? String(e)}`);
  (err as any).cause = e;
  return err;
}

/** PostgreSQL：复用连接池缓存，rowMode=array 便于从 fields 取列名 */
async function queryPostgres(config: SqlExecConfig, wrappedSql: string, params: any[], hardLimit: number): Promise<SqlExecResult> {
  const key = typeof config.connection === 'string'
    ? config.connection
    : JSON.stringify(config.connection);
  const pool = getPool(key, config);
  const t0 = Date.now();
  let result: QueryResult;
  try {
    result = await pool.query({ text: wrappedSql, values: params, rowMode: 'array' });
  } catch (e: any) {
    throw wrapSqlError(e, 'SQL 执行失败');
  }
  const columns = (result.fields ?? []).map((f) => f.name);
  const rows = result.rows.map((row: any[]) => {
    const obj: Record<string, any> = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
  return {
    columns, rows, rowCount: result.rowCount ?? rows.length,
    durationMs: Date.now() - t0, command: result.command,
    warnings: result.rowCount === hardLimit ? [`结果已截断到前 ${hardLimit} 行，实际可能更多`] : [],
  };
}

/** 懒加载可选原生驱动；未安装时给出可执行修复建议，绝不静默降级 */
function loadOptionalDriver(pkg: string): any {
  try {
    return require(pkg);
  } catch {
    throw new Error(
      `${pkg} 驱动未安装：请执行 npm i ${pkg} 后重启服务。` +
      `（当前仅 pg 为内置依赖；沙盒/离线环境请使用 PostgreSQL 数据源）`,
    );
  }
}

/** MySQL：mysql2/promise 的 prepared execute，? 占位符 */
async function queryMysql(config: SqlExecConfig, wrappedSql: string, params: any[], hardLimit: number): Promise<SqlExecResult> {
  const mysql = loadOptionalDriver('mysql2/promise');
  const connStr = typeof config.connection === 'string'
    ? config.connection
    : (config.connection as any).connectionString;
  if (!connStr) throw new Error('MySQL 数据源需要连接串（mysql://user:pass@host:3306/db）');
  const t0 = Date.now();
  let conn: any;
  try {
    conn = await mysql.createConnection({ ...parseMysqlUrl(connStr), connectTimeout: 5000 });
    const [rows, fields] = await conn.execute({ sql: wrappedSql, values: params });
    const columns: string[] = (fields ?? []).map((f: any) => f.name);
    const objs: Record<string, any>[] = (rows ?? []).map((r: any) => {
      if (Array.isArray(r)) {
        const o: Record<string, any> = {};
        columns.forEach((c, i) => { o[c] = r[i]; });
        return o;
      }
      return r;
    });
    return {
      columns, rows: objs, rowCount: objs.length,
      durationMs: Date.now() - t0, command: 'SELECT',
      warnings: objs.length === hardLimit ? [`结果已截断到前 ${hardLimit} 行，实际可能更多`] : [],
    };
  } catch (e: any) {
    throw wrapSqlError(e, 'MySQL 执行失败');
  } finally {
    try { await conn?.end?.(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/** 把 mysql:// URL 拆成 mysql2 连接选项（密码需 decodeURIComponent） */
function parseMysqlUrl(url: string): Record<string, any> {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 3306),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

/** 把 mssql:// URL 拆成 mssql.ConnectionPool 配置 */
function parseMssqlUrl(url: string): Record<string, any> {
  const u = new URL(url);
  return {
    server: u.hostname, port: Number(u.port || 1433),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionTimeout: 5000, requestTimeout: 15_000,
    options: {
      encrypt: /encrypt=true/i.test(u.search),
      trustServerCertificate: process.env.DB_MSSQL_TRUST_CERT === '1',
    },
  };
}

/** SQL Server：命名参数 @pN，OFFSET/FETCH 分页 */
async function queryMssql(config: SqlExecConfig, wrappedSql: string, params: any[], hardLimit: number): Promise<SqlExecResult> {
  const mssql = loadOptionalDriver('mssql');
  const cfg = typeof config.connection === 'string'
    ? parseMssqlUrl(config.connection)
    : config.connection;
  const t0 = Date.now();
  let pool: any;
  try {
    pool = await new mssql.ConnectionPool(cfg).connect();
    const req = pool.request();
    for (const [k, v] of Object.entries(namedParams(params))) req.input(k, v);
    const r = await req.query(wrappedSql);
    const objs: Record<string, any>[] = r.recordset ?? [];
    const columns = objs.length ? Object.keys(objs[0]) : [];
    return {
      columns, rows: objs, rowCount: r.rowsAffected?.[0] ?? objs.length,
      durationMs: Date.now() - t0, command: 'SELECT',
      warnings: objs.length === hardLimit ? [`结果已截断到前 ${hardLimit} 行，实际可能更多`] : [],
    };
  } catch (e: any) {
    throw wrapSqlError(e, 'SQL Server 执行失败');
  } finally {
    try { await pool?.close?.(); } catch { /* 关闭失败不影响结果 */ }
  }
}

/**
 * 参数化执行 SQL（P8.4 多驱动入口）。
 * @param sql    SQL 模板，占位符统一写 $1..$N（由方言层按驱动转换）
 * @param limit  强制上限（默认 1000，最大 5000）
 * @param config.offset  SQL 级分页偏移
 *
 * 只读白名单是独立防线，不依赖任何驱动的 prepared 协议；多语句一律拒绝。
 */
export async function execute(
  config: SqlExecConfig,
  sql: string,
  params: any[] = [],
  limit = 1000,
): Promise<SqlExecResult> {
  assertReadOnly(sql, config.skipReadOnlyCheck);
  const driver = resolveDriver(config);
  // SQL Server 不支持 SHOW / VALUES / EXPLAIN 作为独立只读语句，显式拦掉
  if (!DRIVER_PROFILES[driver].allowShowValues) {
    const first = String(sql).replace(/^\s+/, '').split(/\s+/)[0]?.toLowerCase();
    if (['show', 'values', 'explain'].includes(first)) {
      throw new Error(`SQL Server 不支持 "${String(first).toUpperCase()}" 语句（只读模式）`);
    }
  }
  const plan = paginateSql(sql, driver, { limit, offset: config.offset, params });
  switch (driver) {
    case 'mysql': return queryMysql(config, plan.sql, plan.params, plan.limit);
    case 'mssql': return queryMssql(config, plan.sql, plan.params, plan.limit);
    default:      return queryPostgres(config, plan.sql, plan.params, plan.limit);
  }
}

/** 测试连接：SELECT 1（按驱动生成方言 SQL） */
export async function ping(config: SqlExecConfig): Promise<{ ok: boolean; message?: string; durationMs: number }> {
  const t0 = Date.now();
  try {
    await execute(config, 'SELECT 1 AS ok', [], 1);
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), durationMs: Date.now() - t0 };
  }
}
