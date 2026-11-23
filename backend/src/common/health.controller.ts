/**
 * D2 健康探针（docs/24 §D2）
 *
 * 三个口径分开，别混用：
 *   /health/live   —— 进程活着（不做任何外部依赖检查），供 k8s liveness / compose healthcheck 用。
 *                     依赖挂了不该重启进程，所以这里绝不能查库（否则 DB 抖动 → 全线重启风暴）。
 *   /health/ready  —— 能对外服务（DB 可查 + Redis 可 ping），供 k8s readiness / 负载均衡摘流用。
 *   /health        —— 两者合并的简报，给人看；也带版本、启动时间、运行时长。
 *
 * 另外提供 /api/v1/health（走全局前缀），裸 /health 在 main.ts 里额外注册（nginx/compose 探针习惯）。
 *
 * 三个探针都不写库、不打日志噪音（只在失败时 warn 一行），可 1s 一次高频调用。
 */
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from './public.decorator';
import { redisConnection, PORT } from './config';
import Redis from 'ioredis';

const STARTED_AT = Date.now();
const PROBE_TIMEOUT_MS = +(process.env.HEALTH_PROBE_TIMEOUT_MS || 2000);

type Probe = { ok: boolean; ms: number; detail?: string };

async function withTimeout<T>(fn: () => Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`探针超时 ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 单例 Redis 探针连接（懒建；连不上明确报 false，不影响业务连接池） */
let probeRedis: Redis | null = null;

async function pingRedis(): Promise<Probe> {
  const t0 = Date.now();
  try {
    if (!probeRedis) {
      const c = new Redis({
        ...redisConnection(),
        connectTimeout: PROBE_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,        // 探针不重连，失败即报 not-ready
        lazyConnect: true,
      });
      c.on('error', () => { /* 结果由 ping 体现，避免重复刷日志 */ });
      await c.connect();
      probeRedis = c;
    }
    const pong = await withTimeout(() => probeRedis!.ping());
    return { ok: pong === 'PONG', ms: Date.now() - t0, detail: pong };
  } catch (e: any) {
    try { probeRedis?.disconnect(); } catch { /* ignore */ }
    probeRedis = null;
    return { ok: false, ms: Date.now() - t0, detail: e?.message?.slice(0, 120) };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly ds: DataSource) {}

  /** 存活：只要进程能回包就算活 */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000) };
  }

  /** 就绪：DB + Redis 都通才算 ready；任一不通返回 503，让 LB 摘流而不是重启 */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, redis] = await Promise.all([this.probeDb(), pingRedis()]);
    const ok = db.ok && redis.ok;
    // 503 让 LB/readiness 探针摘流；本体仍走统一响应包装
    res.status(ok ? 200 : 503);
    return {
      status: ok ? 'ready' : 'not-ready',
      checks: { db, redis },
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    };
  }

  /** 简报：给人/监控面板看 */
  @Public()
  @Get()
  async summary() {
    const [db, redis] = await Promise.all([this.probeDb(), pingRedis()]);
    return {
      status: db.ok && redis.ok ? 'ok' : 'degraded',
      version: process.env.APP_VERSION || 'dev',
      port: PORT,
      node: process.version,
      startedAt: new Date(STARTED_AT).toISOString(),
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      checks: { db, redis },
    };
  }

  private async probeDb(): Promise<Probe> {
    const t0 = Date.now();
    try {
      await withTimeout(() => this.ds.query('select 1'));
      return { ok: true, ms: Date.now() - t0 };
    } catch (e: any) {
      return { ok: false, ms: Date.now() - t0, detail: e?.message?.slice(0, 120) };
    }
  }
}
