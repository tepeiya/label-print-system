// =============================================================================
// P6.2 独立库租户（D2）可测逻辑：dataSourceKey 校验 + DSN 解析/脱敏
//
// 纯函数，不 import TypeORM（单测跑 node --test + tsx，见 docs/10 §10.15.6 的 ⚠️）。
//
// 这里只做「能不能用」的判定，不做连接：连库/探活/建池在 TenantDataSourceManager。
// 安全口径：DSN 只在进程内存里活着（env 或平台接口传入），**永不落库**——
// `tenants` 表只存 data_source_key 这种不含凭据的标识。
// =============================================================================

/** key 会成为环境变量名与日志字段：小写字母开头，a-z0-9-，2~64 字符 */
export const KEY_RE = /^[a-z][a-z0-9-]{1,63}$/;
/** 独立库至少要有的表（docs/03 + saas_* 跑完后必然存在）；缺表说明这个库还没初始化 */
export const REQUIRED_TABLES = ['tenants', 'users', 'templates', 'tenant_backups', 'tenant_modules', 'audit_logs'];

export function validateKey(key: string): { ok: boolean; reason?: string } {
  const k = String(key ?? '').trim();
  if (!k) return { ok: false, reason: 'dataSourceKey 不能为空' };
  if (k === 'default') return { ok: false, reason: "dataSourceKey 不能是 'default'（那是共享库）" };
  if (!KEY_RE.test(k)) return { ok: false, reason: 'dataSourceKey 需为小写字母开头的 a-z0-9-，长度 2–64' };
  return { ok: true };
}

/** 只接受 postgres:// / postgresql://；其它协议（mysql、file、socket 简写）一律拒，避免猜来猜去 */
export function isPostgresUrl(url: string): boolean {
  const u = String(url ?? '').trim();
  return /^postgres(ql)?:\/\/[^\s]+$/i.test(u);
}

/**
 * 从 DSN 里读目标信息（用于诊断面板与日志），读不出就返回 null。
 * ⚠️ 不要用 URL 解析后拼回字符串做连接：密码里的 @ / : 会被转义错。
 */
export function dsnTarget(url: string): { host: string; port: number; database: string; user: string } | null {
  const u = String(url ?? '').trim();
  if (!isPostgresUrl(u)) return null;
  try {
    const parsed = new URL(u);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    if (!database) return null;
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? Number(parsed.port) : 5432,
      database,
      user: decodeURIComponent(parsed.username || ''),
    };
  } catch {
    return null;
  }
}

/** 日志/审计里用的脱敏形式：`postgres://user:***@host:port/db` */
export function maskDsn(url: string): string {
  const t = dsnTarget(url);
  if (!t) return '(invalid-dsn)';
  return `postgres://${t.user || 'user'}:***@${t.host}:${t.port}/${t.database}`;
}

/**
 * 解析 env `DB_DEDICATED_DSNS`：JSON 对象 `{ "acme": "postgres://..." }`。
 * 坏条目单独报错（errors），不影响其它 key 注册 —— 一个租户配错不该让全进程起不来。
 */
export function parseDedicatedDsns(raw: string | undefined | null): { map: Record<string, string>; errors: string[] } {
  const out: Record<string, string> = {};
  const errors: string[] = [];
  if (!raw || !String(raw).trim()) return { map: out, errors };
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e: any) {
    return { map: out, errors: [`DB_DEDICATED_DSNS 不是合法 JSON：${e?.message ?? e}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: out, errors: ['DB_DEDICATED_DSNS 必须是对象：{"key": "postgres://..."}'] };
  }
  for (const [k, v] of Object.entries(parsed)) {
    const chk = validateKey(k);
    if (!chk.ok) { errors.push(`${k}: ${chk.reason}`); continue; }
    if (typeof v !== 'string' || !isPostgresUrl(v)) { errors.push(`${k}: DSN 必须是 postgres:// 连接串`); continue; }
    out[k] = v;
  }
  return { map: out, errors };
}

/** 库结构自检结果 → 一句话（平台接口/日志共用，别各写各的） */
export function schemaVerdict(missing: string[], tableCount: number): { ok: boolean; message: string } {
  if (missing.length) {
    return {
      ok: false,
      message: `目标库缺表 ${missing.join('、')}，请先在该库执行 docs/03-database.sql 与 backend/scripts/saas_*.sql`,
    };
  }
  if (tableCount < REQUIRED_TABLES.length) {
    return { ok: false, message: `目标库 public 下只有 ${tableCount} 张表，不像初始化过的库` };
  }
  return { ok: true, message: `目标库就绪（${tableCount} 张表）` };
}
