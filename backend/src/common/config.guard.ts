// =============================================================================
// config.guard.ts —— 启动期配置强校验（B2.2 弱口令/密钥，fail-fast）
//
// 【为什么】config.ts 里 JWT_SECRET / SQL_SECRET_KEY 都有内置 dev 默认值，
// DB 口令在沙盒里是 labelflow/labelflow 这类弱值。开发态没问题，但如果带着
// 这套默认值上了生产，等于把签名密钥和加密密钥公开。靠"上线前记得改"不可靠，
// 必须由进程自己在启动时拒绝启动（fail-closed，与 RLS 同一取向）。
//
// 【设计】
//   1. 纯函数校验（不 import Nest），可单测；由 main.ts bootstrap 调用。
//   2. 只在 NODE_ENV=production（或 LABELFLOW_STRICT_CONFIG=1）时**拒绝启动**；
//      dev/test 只 warn，不打断本地开发与单测。
//   3. 判定项分级：BLOCK（拒绝启动）/ WARN（提示但不拦）。
//   4. 绝不把密钥明文写进错误或日志，只报「哪项有问题」。
//   5. strict 可由调用方显式注入（单测用它验证生产行为，不必篡改全局 process.env）。
// =============================================================================

import { JWT_SECRET, SQL_SECRET_KEY } from './config';

/** 内置的 dev 默认密钥（与 config.ts 保持一致，用于识别"没配"） */
export const DEV_DEFAULTS = {
  jwt: 'dev-secret',
  sqlKeyPrefix: 'dev-sql-secret-key',
};

/** 生产环境不允许出现的弱口令（沙盒 dev 值） */
const WEAK_DB_PASSWORDS = new Set(['labelflow', 'postgres', 'password', '123456', 'admin', '']);

export interface ConfigIssue {
  key: string;
  level: 'block' | 'warn';
  /** 不含任何明文密钥的安全描述 */
  message: string;
}

export interface ConfigSnapshot {
  nodeEnv: string;
  jwtSecret: string;
  sqlSecretKey: string;
  dbUser?: string;
  dbPassword?: string;
  dbRlsUser?: string;
  dbRlsPassword?: string;
  brandingDevVerify?: string;
}

/** 从 process.env 抓一份快照（单测可传入构造的快照，不污染全局） */
export function readConfigSnapshot(env: NodeJS.ProcessEnv = process.env): ConfigSnapshot {
  return {
    nodeEnv: String(env.NODE_ENV ?? 'development'),
    jwtSecret: String(env.JWT_SECRET ?? JWT_SECRET),
    sqlSecretKey: String(env.SQL_SECRET_KEY ?? SQL_SECRET_KEY),
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASS ?? env.DB_PASSWORD,
    dbRlsUser: env.DB_RLS_USER,
    dbRlsPassword: env.DB_RLS_PASSWORD,
    brandingDevVerify: env.BRANDING_DEV_VERIFY,
  };
}

/** 是否处于"严格模式"：生产 或 显式开启 */
export function isStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.NODE_ENV ?? '').toLowerCase() === 'production'
    || String(env.LABELFLOW_STRICT_CONFIG ?? '') === '1';
}

/** 从快照推导严格模式；override 优先（单测用） */
function strictOf(s: ConfigSnapshot, override?: boolean): boolean {
  if (override !== undefined) return override;
  return isStrict({
    NODE_ENV: s.nodeEnv,
    LABELFLOW_STRICT_CONFIG: process.env.LABELFLOW_STRICT_CONFIG,
  } as NodeJS.ProcessEnv);
}

/** JWT_SECRET：长度 ≥ 32 且不是 dev 默认值 */
function checkJwt(s: ConfigSnapshot): ConfigIssue | null {
  const v = s.jwtSecret ?? '';
  if (!v || v === DEV_DEFAULTS.jwt) {
    return { key: 'JWT_SECRET', level: 'block', message: 'JWT_SECRET 仍为内置 dev 值或未配置（签名密钥公开，任意人可伪造 Token）' };
  }
  if (v.length < 32) {
    return { key: 'JWT_SECRET', level: 'warn', message: 'JWT_SECRET 长度不足 32，建议用 64 位随机串' };
  }
  return null;
}

/** SQL_SECRET_KEY：AES-256-GCM 需 32 字节；不能是 dev 前缀 */
function checkSqlKey(s: ConfigSnapshot): ConfigIssue | null {
  const v = s.sqlSecretKey ?? '';
  if (!v || v.startsWith(DEV_DEFAULTS.sqlKeyPrefix)) {
    return { key: 'SQL_SECRET_KEY', level: 'block', message: 'SQL_SECRET_KEY 仍为内置 dev 值（数据源 DSN / AI Key 的加密形同明文）' };
  }
  if (v.length < 32) {
    return { key: 'SQL_SECRET_KEY', level: 'warn', message: 'SQL_SECRET_KEY 建议为 64 位 hex（32 字节）' };
  }
  return null;
}

/** DB 口令：生产不得用弱值；RLS 角色口令独立判定 */
function checkDbPassword(s: ConfigSnapshot): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  if (WEAK_DB_PASSWORDS.has(String(s.dbPassword ?? '').toLowerCase())) {
    out.push({ key: 'DB_PASS', level: 'block', message: 'DB_PASS 为沙盒弱口令或未配置' });
  }
  if (s.dbRlsUser && String(s.dbRlsPassword ?? '').toLowerCase() === s.dbRlsUser.toLowerCase()) {
    // 现有代码里有 "password = DB_RLS_PASSWORD || DB_RLS_USER" 的回退，等于用户名即口令
    out.push({ key: 'DB_RLS_PASSWORD', level: 'block', message: 'RLS 角色口令回退成用户名（等价于无口令），必须显式配置' });
  }
  return out;
}

/** BRANDING_DEV_VERIFY=1 是白标 TXT 校验的 dev 逃生口，仅生产必须关闭 */
function checkBranding(s: ConfigSnapshot, strict: boolean): ConfigIssue | null {
  const on = ['1', 'true', 'yes'].includes(String(s.brandingDevVerify ?? '').toLowerCase());
  if (on && strict) {
    return { key: 'BRANDING_DEV_VERIFY', level: 'block', message: '白标域名校验 dev 逃生口在生产开启（任意域名可冒充已验证）' };
  }
  return null;
}

/** 汇总所有问题（纯函数，单测直接断言）；strict 可注入以便脱离全局 env 测试 */
export function auditConfig(s: ConfigSnapshot, strict: boolean = strictOf(s)): ConfigIssue[] {
  return [checkJwt(s), checkSqlKey(s), ...checkDbPassword(s), checkBranding(s, strict)]
    .filter(Boolean) as ConfigIssue[];
}

/**
 * 启动守卫：严格模式下有任一 block 级问题就抛错（进程拒绝启动）。
 * dev 模式只记录 warn，不抛。返回问题清单便于 main.ts 打日志。
 */
export function assertProductionConfig(
  s: ConfigSnapshot,
  opts: { strict?: boolean } = {},
): ConfigIssue[] {
  const strict = strictOf(s, opts.strict);
  const issues = auditConfig(s, strict);
  const blocks = issues.filter((i) => i.level === 'block');
  if (strict && blocks.length) {
    throw new Error(
      `[CONFIG FAIL-FAST] 生产配置不合规，拒绝启动：\n` +
      blocks.map((b) => `  - ${b.key}: ${b.message}`).join('\n') +
      `\n请通过密钥管理注入环境变量后重启（勿把密钥写进代码/仓库）。`,
    );
  }
  return issues;
}
