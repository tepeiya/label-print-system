/**
 * D2 请求上下文 + 结构化日志（docs/24 §D2「traceId / 结构化日志」）
 *
 * 设计取舍：
 *  - traceId 用 AsyncLocalStorage 传递，不挂 req 对象到处传参；logger 自动带上。
 *  - 客户端/网关传了 x-request-id 就复用（跨服务串联），否则生成 16 位 hex；响应头回写，
 *    前端报问题时把 requestId 贴给运维就能 grep 到整条链路。
 *  - 日志是「单行 JSON」而不是多行文本：容器日志按行采集，多行会被拆散拼不回去。
 *    LOG_FORMAT=pretty 时退化成人类可读（本地开发用）。
 *  - 敏感字段永不落日志：authorization / cookie / password / token 只在字段名层面脱敏。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const traceStorage = new AsyncLocalStorage<{ traceId: string }>();

export function currentTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

/** 命中任一子串即脱敏（按子串而不是精确名，防漏：client_secret / x-api-token / oldPassword 都能挡住） */
const SECRET_PATTERNS = ['authorization', 'cookie', 'pass', 'token', 'secret', 'credential', 'apikey', 'api_key'];

/** 导出给单测：敏感字段脱敏（authorization/cookie/password/token/secret 一律打 ***） */
export function maskFields(obj: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!obj) return obj;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    out[k] = SECRET_PATTERNS.some((p) => key.includes(p)) ? '***' : v;
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) || (process.env.NODE_ENV === 'production' ? 'info' : 'info');
const PRETTY = process.env.LOG_FORMAT === 'pretty';

function emit(level: Level, msg: string, fields?: Record<string, any>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const payload: Record<string, any> = {
    ts: new Date().toISOString(),
    level,
    msg,
    traceId: currentTraceId(),
    ...(fields ? maskFields(fields) : {}),
  };
  const line = PRETTY
    ? `[${payload.ts}] ${level.toUpperCase()} ${payload.traceId ?? '-'} ${msg} ${fields ? JSON.stringify(maskFields(fields)) : ''}`
    : JSON.stringify(payload);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, any>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, any>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, any>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, any>) => emit('error', msg, fields),
};

/** 纯函数：生成/复用 traceId（16 位 hex 或复用上游 X-Request-Id） */
export function resolveTraceId(incoming?: unknown): string {
  const v = String(incoming ?? '').trim();
  return v && v.length <= 64 ? v : randomBytes(8).toString('hex');
}

/** traceId 中间件：必须在限流/访问日志之前挂 */
export function traceMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const traceId = resolveTraceId(req.headers['x-request-id']);
    res.setHeader('x-request-id', traceId);
    traceStorage.run({ traceId }, () => next());
  };
}

/**
 * 访问日志：只在请求结束打一行（含状态码、耗时、路由模板）。
 * 探针路径（/health）默认不打，避免监控每 2s 刷一条噪音；`LOG_HEALTH=1` 可开。
 */
export function accessLogMiddleware() {
  const logHealth = process.env.LOG_HEALTH === '1';
  return (req: Request, res: Response, next: NextFunction) => {
    if (!logHealth && req.path.startsWith('/health')) return next();
    if (!logHealth && req.path.startsWith('/api/v1/health')) return next();
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const level: Level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      emit(level, 'http', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: req.ip,
        ua: String(req.headers['user-agent'] || '').slice(0, 80),
      });
    });
    next();
  };
}
