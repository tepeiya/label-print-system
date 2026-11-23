/**
 * D2 全局限流（docs/24 §D2「限流」）
 *
 * 分档（都可用环境变量调，改阈值不用重启以外的代码改动）：
 *   RATE_LIMIT_PER_MIN        全局每 IP 每分钟（默认 300）
 *   RATE_LIMIT_LOGIN_PER_MIN  登录/注册类接口每 IP 每分钟（默认 20，防撞库）
 *   RATE_LIMIT_TRUST_PROXY    是否信任 X-Forwarded-For（默认 1；前面有 nginx 时必须开）
 *
 * 实现：Redis 固定窗口 INCR + EXPIRE（多实例共享计数，单机也走同一条路，避免两套逻辑）。
 * Redis 挂掉时 **fail-open**（放行 + 一次性 warn）：可用性优先，限流是防滥用的软闸，
 * 不能因为它挂了把整个业务打停。真正要硬挡的撞库在登录接口自身的失败计数里。
 *
 * 返回头：X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset（秒级 UTC epoch），
 * 超限 429 + Retry-After，响应体沿用统一异常格式（AllExceptionsFilter）。
 */
import Redis from 'ioredis';
import type { NextFunction, Request, Response } from 'express';
import { redisConnection } from './config';
import { log } from './trace.middleware';

const WINDOW_MS = 60_000;

const LIMIT_GLOBAL = +(process.env.RATE_LIMIT_PER_MIN || 300);
const LIMIT_LOGIN = +(process.env.RATE_LIMIT_LOGIN_PER_MIN || 20);

/** 登录/注册/刷新令牌类接口：按更严的一档限 */
const STRICT_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/forgot',
  '/api/v1/auth/reset-password',
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
];

/** 不限流的路径：健康探针（监控高频轮询，不该被限流打断，否则 LB 会误判下线） */
const SKIP_PATHS = ['/health', '/api/v1/health'];

let redis: Redis | null = null;
let redisDead = false;
let warnedOnce = false;

export function rateLimitRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      ...redisConnection(),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,        // Redis 不可用时立刻失败 → fail-open，不排队积压
      lazyConnect: true,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
    });
    redis.on('error', () => { redisDead = true; });
    redis.on('ready', () => { redisDead = false; });
  }
  return redis;
}

/** 纯函数：该路径属于哪一档（'skip' 不限流 / 'login' 严档 / 'global' 通用），单测直接打这个 */
export function rateScopeFor(path: string): 'skip' | 'login' | 'global' {
  if (SKIP_PATHS.some((p) => path === p || path.startsWith(p + '/'))) return 'skip';
  if (STRICT_PATHS.some((p) => path === p || path.startsWith(p))) return 'login';
  return 'global';
}

/** 纯函数：档位 → 每分钟上限 */
export function rateLimitFor(scope: 'login' | 'global'): number {
  return scope === 'login' ? LIMIT_LOGIN : LIMIT_GLOBAL;
}

/** 纯函数：分桶 key（同 IP 同分钟内同 key），便于单测与运维排查 */
export function rateKey(scope: 'global' | 'login', ident: string, now = Date.now()): string {
  const bucket = Math.floor(now / WINDOW_MS);
  return `lf:rl:${scope}:${ident}:${bucket}`;
}

function clientIp(req: Request): string {
  const trust = process.env.RATE_LIMIT_TRUST_PROXY !== '0';
  const xff = trust ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return xff || req.ip || 'unknown';
}

export function rateLimitMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const decided = rateScopeFor(req.path);
    if (decided === 'skip') return next();
    const scope: 'login' | 'global' = decided;
    const limit = rateLimitFor(scope);
    const ident = clientIp(req);
    const key = rateKey(scope, ident);

    try {
      const c = rateLimitRedis();
      if (c.status !== 'ready') await c.connect();
      const n = await c.incr(key);
      if (n === 1) await c.pexpire(key, WINDOW_MS);
      const ttl = await c.pttl(key);
      const remaining = Math.max(0, limit - n);
      const resetSec = Math.ceil((Date.now() + Math.max(ttl, 0)) / 1000);

      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(resetSec));
      res.setHeader('X-RateLimit-Scope', scope);

      if (n > limit) {
        const retryAfter = Math.max(1, Math.ceil(Math.max(ttl, 0) / 1000));
        log.warn('rate_limited', { scope, ident, limit, hits: n, path: req.path });
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          code: 429,
          message: `请求过于频繁（${scope === 'login' ? '登录类' : '通用'}限流 ${limit} 次/分钟），请 ${retryAfter} 秒后重试`,
          data: null,
          limit, scope, retry_after: retryAfter, action: 'retry_later',
        });
        return;
      }
    } catch (e: any) {
      // fail-open：Redis 不可用不能拖垮业务
      if (!warnedOnce) {
        warnedOnce = true;
        log.warn('rate_limit_unavailable_fail_open', { error: e?.message?.slice(0, 120) });
      }
    }
    next();
  };
}

/** 供 /health 或运维脚本查限流 Redis 是否在独立连接上活着 */
export function rateLimitRedisStatus(): string {
  return redis?.status ?? 'not-initialized';
}
