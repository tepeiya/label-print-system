// =============================================================================
// agent.calc —— Agent Token / 参数指纹纯函数（无 Nest / TypeORM 依赖，tsx 单测可用）
// 设计（docs/11 §11.5.3 / §11.7.7）：
//   - token 形态 lfagent_ + 40 hex（20 字节随机），库里只存 sha256 hex，明文仅签发时返回一次；
//   - argsHash 用「键排序后的稳定 JSON」，P5 审批流按它绑定参数（§11.7.6）。
// =============================================================================
import { createHash, randomBytes } from 'crypto';
import { matchPermission } from '../common/permission-match';

export const AGENT_TOKEN_PREFIX = 'lfagent_';

/** scope 必须是权限点形态：module:resource:action（允许两段式，如 template:read） */
const SCOPE_RE = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)*$/;

export function isValidScope(s: unknown): s is string {
  return typeof s === 'string' && SCOPE_RE.test(s) && s.length <= 60;
}

export function hashAgentToken(plain: string): string {
  return createHash('sha256').update(String(plain)).digest('hex');
}

export function newAgentToken(): { plain: string; hash: string } {
  const plain = AGENT_TOKEN_PREFIX + randomBytes(20).toString('hex');
  return { plain, hash: hashAgentToken(plain) };
}

/** 粗校验形态（先挡掉租户 JWT 打到 /agent/v1 的情况，省一次 DB 查询） */
export function looksLikeAgentToken(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(`^${AGENT_TOKEN_PREFIX}[0-9a-f]{40}$`).test(v);
}

/** 列表/审计里展示的脱敏串 */
export function maskToken(plain: string): string {
  const s = String(plain ?? '');
  if (s.length <= 16) return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

/** 递归按键名排序，得到稳定序列化结果（undefined 与函数被 JSON.stringify 丢弃是预期行为） */
export function normalizeArgs(v: unknown): string {
  const sort = (x: any): any => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(x).sort()) out[k] = sort(x[k]);
      return out;
    }
    return x;
  };
  try {
    return JSON.stringify(sort(v ?? {}));
  } catch {
    return String(v);
  }
}

export function argsHash(args: unknown): string {
  return createHash('sha256').update(normalizeArgs(args)).digest('hex');
}

export function isExpired(expiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;      // 空 = 不过期
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/** scope 判定：token 的 scopes 覆盖某权限点（通配语义复用 matchPermission） */
export function scopeCovers(scopes: string[] | null | undefined, permission: string): boolean {
  return matchPermission(scopes ?? [], permission);
}

/**
 * §11.7.7 护栏 2「新建 Agent 默认只读」：
 * 不显式传 scopes 时，签发 P4 全部只读工具所需的权限点集合。
 */
export function defaultReadScopes(): string[] {
  return [
    'template:read',
    'inventory:stock:read',
    'inventory:batch:read',
    'bom:kit:read',
    'bom:shortage:read',
  ];
}
