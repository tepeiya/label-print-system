// =============================================================================
// AgentRateService —— Agent 维度限流（docs/11 §11.7.7 护栏 5：60 次/分）
// Redis 固定窗口 INCR；阈值走 feature_flags['agent.rate_limit'].rollout.rpm（运营即时可调）。
//
// 降级策略：Redis 不可用时退回**进程内**固定窗口（单实例仍有效，多实例各算各的），
// 宁可松一点也不让限流组件本身成为故障点——与 P3 配额「宁可漏检不漏服务」同一取向，
// 但这里保留计数（只是精度降级），因为写工具没有保护会直接产生成本。
// =============================================================================
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { redisConnection } from '../common/config';
import { TenantConfigService } from '../saas/tenant-config.service';
import { RateLimitedException } from '../common/business.errors';
import {
  isLimited, rateLimitKey, rateLimitTtlMs, remaining, resolveRpm, WINDOW_MS,
} from './rate.calc';

/** 阈值开关键名（rollout={"rpm":N}；无行=默认 60/分） */
export const RATE_LIMIT_FLAG = 'agent.rate_limit';

export interface RateOutcome {
  rpm: number;
  count: number;
  remaining: number;
}

interface LocalWindow { count: number; resetAt: number }

@Injectable()
export class AgentRateService implements OnModuleDestroy {
  private logger = new Logger('AgentRateService');
  private redis: Redis | null = null;
  private redisBroken = false;
  private local = new Map<string, LocalWindow>();

  constructor(private cfg: TenantConfigService) {}

  private client(): Redis {
    if (!this.redis) {
      const c = redisConnection();
      this.redis = new Redis({
        host: c.host, port: c.port, password: c.password, db: c.db ?? 0,
        // 首条命令允许排队等连接建立（否则进程刚起来时 INCR 必然失败、静默退回进程内窗口）；
        // 但一旦连不上就快速失败，绝不让限流把请求拖住。
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: false,
        retryStrategy: (times: number) => Math.min(times * 200, 5000),
      });
      this.redis.on('error', (e: Error) => {
        this.redisBroken = true;
        this.logger.warn(`限流 Redis 异常，退回进程内窗口: ${e.message}`);
      });
      this.redis.on('ready', () => { this.redisBroken = false; });
    }
    return this.redis;
  }

  /** 本窗口剩余秒数（429 的 Retry-After 口径） */
  private retryAfterSec(now: Date): number {
    return Math.max(1, Math.ceil((WINDOW_MS - (now.getTime() % WINDOW_MS)) / 1000));
  }

  /**
   * 打一次计数；超限直接抛 429 + code 4037。
   * ⚠️ 放在 dispatch 的「执行前」，被拒的调用不计量（与 denied_scope/denied_module 一致）。
   */
  async hit(tenantId: number, clientId: number): Promise<RateOutcome> {
    const now = new Date();
    const rollout = await this.cfg.rolloutFor(tenantId, RATE_LIMIT_FLAG).catch((e: Error) => {
      this.logger.warn(`agent.rate_limit 读取失败 tenant=${tenantId}: ${e.message}`);
      return null;
    });
    const rpm = resolveRpm(rollout);
    const key = rateLimitKey(tenantId, clientId, now);

    let count: number;
    try {
      if (this.redisBroken) throw new Error('redis 未就绪');
      const r = this.client();
      count = await r.incr(key);
      if (count === 1) await r.pexpire(key, rateLimitTtlMs(now));
    } catch (e) {
      const w = this.local.get(key);
      if (!w || w.resetAt <= now.getTime()) {
        const next = { count: 1, resetAt: now.getTime() + WINDOW_MS };
        this.local.set(key, next);
        count = next.count;
      } else {
        w.count += 1;
        count = w.count;
      }
      if (this.local.size > 5000) this.local.clear();   // 防止窗口 map 无界增长
      this.logger.debug(`限流降级计数 key=${key}: ${(e as Error).message}`);
    }

    if (isLimited(count, rpm)) {
      throw new RateLimitedException(rpm, this.retryAfterSec(now));
    }
    return { rpm, count, remaining: remaining(count, rpm) };
  }

  /** 当前窗口已用量（Redis 优先，降级时读进程内窗口）；异常一律当 0 处理，不阻断展示 */
  private async currentCount(tenantId: number, clientId: number, now: Date): Promise<number> {
    const key = rateLimitKey(tenantId, clientId, now);
    if (this.redisBroken) return this.local.get(key)?.count ?? 0;
    try {
      return Number(await this.client().get(key) ?? 0);
    } catch (e) {
      this.redisBroken = true;
      this.logger.warn(`限流计数读取失败，退回进程内窗口: ${(e as Error).message}`);
      return this.local.get(key)?.count ?? 0;
    }
  }

  /** 当前阈值与已用量（GET /agent/v1/whoami 的 rate_limit 字段用，不计数） */
  async peek(tenantId: number, clientId: number): Promise<RateOutcome> {
    const now = new Date();
    const rpm = resolveRpm(await this.cfg.rolloutFor(tenantId, RATE_LIMIT_FLAG).catch(() => null));
    const count = await this.currentCount(tenantId, clientId, now);
    return { rpm, count, remaining: Math.max(0, rpm - count) };
  }

  async onModuleDestroy() {
    if (this.redis) {
      try { await this.redis.quit(); } catch { /* 关闭失败不影响退出 */ }
      this.redis = null;
    }
  }
}
