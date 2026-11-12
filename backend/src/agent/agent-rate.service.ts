// =============================================================================
// AgentRateService —— Agent 限流（docs/11 §11.7.7 护栏 5 + docs/10 §10.20 B3）
// Redis 固定窗口 INCR；阈值走 feature_flags['agent.rate_limit'].rollout（运营即时可调）。
//
// B3：从单一 agent 维度扩到三维
//   agent（tenant+client）、tool（tenant+client+tool）、token（tenant+token），
//   后两维默认关闭，只有 rollout 显式配了 tool_rpm / token_rpm / per_tool 才生效。
//   响应头 X-RateLimit-* 由 rate.calc 纯函数生成，成功响应经 rate.context（ALS）下发，
//   429 由异常自带 headers 经 AllExceptionsFilter 下发。
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
  makeOutcome, rateHeaders, resetSecOf, resolveRatePlan, retryAfterHeaders,
  tightestOutcome, tokenRateLimitKey, toolRateLimitKey, toolRpmFor,
  type RateDimension, type RateOutcome,
} from './rate.calc';
import { publishRateOutcome } from './rate.context';

/** 兼容历史 import 路径（原 RateOutcome 定义在本文件，现已下沉到纯函数模块） */
export type { RateOutcome } from './rate.calc';

/** 阈值开关键名（rollout={"rpm":N}；无行=默认 60/分） */
export const RATE_LIMIT_FLAG = 'agent.rate_limit';

/** hit() 的细分上下文；两个字段都可选，缺省时行为与 P5 完全一致 */
export interface RateHitOptions {
  toolName?: string;
  tokenId?: number;
}

interface LocalWindow { count: number; resetAt: number }
interface DimensionCheck { dim: RateDimension; key: string; rpm: number }

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

  /** 单个维度的一次 INCR（Redis 优先，失败自动退回进程内窗口） */
  private async incr(key: string, now: Date): Promise<number> {
    try {
      if (this.redisBroken) throw new Error('redis 未就绪');
      const r = this.client();
      const count = await r.incr(key);
      if (count === 1) await r.pexpire(key, rateLimitTtlMs(now));
      return count;
    } catch (e) {
      const w = this.local.get(key);
      let count: number;
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
      return count;
    }
  }

  /**
   * 打一次计数（三维）；任一维度超限直接抛 429 + code 4037，异常自带 X-RateLimit-* 头。
   * ⚠️ 放在 dispatch 的「执行前」，被拒的调用不计量（与 denied_scope/denied_module 一致）。
   * 返回的是**最紧维度**的 outcome，供成功响应下发响应头（见 rate.context）。
   */
  async hit(tenantId: number, clientId: number, opts: RateHitOptions = {}): Promise<RateOutcome> {
    const now = new Date();
    const rollout = await this.cfg.rolloutFor(tenantId, RATE_LIMIT_FLAG).catch((e: Error) => {
      this.logger.warn(`agent.rate_limit 读取失败 tenant=${tenantId}: ${e.message}`);
      return null;
    });
    const plan = resolveRatePlan(rollout);

    const checks: DimensionCheck[] = [
      // agent 维度 key 保持 P5 原样（验收 M 段直接查这个 Redis key）
      { dim: 'agent', key: rateLimitKey(tenantId, clientId, now), rpm: plan.agent },
    ];
    const toolRpm = opts.toolName ? toolRpmFor(plan, opts.toolName) : 0;
    if (opts.toolName && toolRpm > 0) {
      checks.push({
        dim: 'tool', key: toolRateLimitKey(tenantId, clientId, opts.toolName, now), rpm: toolRpm,
      });
    }
    if (opts.tokenId && plan.token > 0) {
      checks.push({
        dim: 'token', key: tokenRateLimitKey(tenantId, opts.tokenId, now), rpm: plan.token,
      });
    }

    const outcomes: RateOutcome[] = [];
    for (const c of checks) {
      const count = await this.incr(c.key, now);
      const outcome = makeOutcome(c.dim, c.rpm, count, now);
      outcomes.push(outcome);
      if (isLimited(count, c.rpm)) {
        // 命中哪个维度就报哪个：客户端能据 X-RateLimit-Scope 判断该换工具、换 token 还是整体退避
        throw new RateLimitedException(c.rpm, this.retryAfterSec(now), {
          scope: c.dim,
          headers: { ...rateHeaders(outcome), ...retryAfterHeaders(outcome, now) },
        });
      }
    }

    const tight = tightestOutcome(outcomes);
    publishRateOutcome(tight);   // Controller 在返回前读取并 setHeader
    return tight;
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
    return {
      rpm, count, remaining: remaining(count, rpm),
      scope: 'agent', resetSec: resetSecOf(now),
    };
  }

  async onModuleDestroy() {
    if (this.redis) {
      try { await this.redis.quit(); } catch { /* 关闭失败不影响退出 */ }
      this.redis = null;
    }
  }
}
