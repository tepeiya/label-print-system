// =============================================================================
// UsageService —— P3 用量采集与配额（docs/11 §11.7）
// 设计：先写 usage_meters 原始记录（对账依据），同事务外即时 upsert usage_daily
// （配额检查读日聚合表，避免每次扫原始表）；每日定时用原始表重算日聚合兜底幂等。
// =============================================================================
import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsageMeter, UsageDaily, Quota } from './billing.entity';
import { QuotaExceededException } from '../common/business.errors';
import { checkQuota, dayKey, windowStart, QuotaDecision } from './billing.calc';

export interface RecordOpts {
  moduleCode?: string | null;
  userId?: number | null;
  meta?: Record<string, any>;
  occurredAt?: Date;
}

@Injectable()
export class UsageService implements OnModuleInit {
  private logger = new Logger('UsageService');

  constructor(
    @InjectRepository(UsageMeter) private meters: Repository<UsageMeter>,
    @InjectRepository(UsageDaily) private daily: Repository<UsageDaily>,
    @InjectRepository(Quota) private quotas: Repository<Quota>,
  ) {}

  // -------------------------------------------------------------- 采集

  /** 写一条原始用量 + 即时累加日聚合。计费链路里调用它失败不应阻断业务，调用方自行 catch */
  async record(tenantId: number, meter: string, quantity: number, opts: RecordOpts = {}) {
    const occurredAt = opts.occurredAt ?? new Date();
    await this.meters.insert({
      tenantId, meter,
      moduleCode: opts.moduleCode ?? null,
      quantity: String(quantity),
      userId: opts.userId ?? null,
      meta: opts.meta ?? {},
      occurredAt,
    });
    await this.daily.query(
      `INSERT INTO usage_daily (tenant_id, meter, day, quantity, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, meter, day)
       DO UPDATE SET quantity = usage_daily.quantity + EXCLUDED.quantity, updated_at = now()`,
      [tenantId, meter, dayKey(occurredAt), String(quantity)],
    );
  }

  /** 定时重算某天聚合（幂等覆盖）：数据修复 / 补录场景用 */
  async reconcileDay(day: string) {
    await this.daily.query(
      `INSERT INTO usage_daily (tenant_id, meter, day, quantity, updated_at)
       SELECT tenant_id, meter, $1::date, SUM(quantity), now()
       FROM usage_meters WHERE occurred_at::date = $1::date
       GROUP BY tenant_id, meter
       ON CONFLICT (tenant_id, meter, day)
       DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [day],
    );
  }

  /**
   * 无 @nestjs/schedule 依赖（与 P2 到期任务同一模式）：每小时重算「今天+昨天」聚合。
   * 写路径已即时累加，这里只是防漏账的兜底，成本是一条聚合 SQL。
   */
  onModuleInit() {
    const run = () => {
      const now = new Date();
      const today = dayKey(now);
      const yesterday = dayKey(new Date(now.getTime() - 24 * 3600 * 1000));
      this.reconcileDay(today).catch((e) => this.logger.warn(`聚合重算失败(${today}): ${e?.message}`));
      this.reconcileDay(yesterday).catch((e) => this.logger.warn(`聚合重算失败(${yesterday}): ${e?.message}`));
    };
    const t = setTimeout(run, 30 * 1000);
    t.unref?.();
    const i = setInterval(run, 60 * 60 * 1000);
    i.unref?.();
  }

  // -------------------------------------------------------------- 查询

  /** 窗口用量（配额检查 / 账单行都读日聚合表） */
  async windowUsed(tenantId: number, meter: string, period: 'month' | 'day', now: Date = new Date()): Promise<number> {
    const rows: Array<{ used: string }> = await this.daily.query(
      `SELECT COALESCE(SUM(quantity), 0) AS used FROM usage_daily
       WHERE tenant_id = $1 AND meter = $2 AND day >= $3`,
      [tenantId, meter, windowStart(period, now)],
    );
    return Number(rows[0]?.used ?? 0);
  }

  /** 某租户本月各 meter 用量 + 配额状态（租户账单页 / 运营用量抽屉共用） */
  async monthSummary(tenantId: number) {
    const rows: Array<{ meter: string; used: string }> = await this.daily.query(
      `SELECT meter, COALESCE(SUM(quantity), 0) AS used FROM usage_daily
       WHERE tenant_id = $1 AND day >= $2 GROUP BY meter`,
      [tenantId, windowStart('month')],
    );
    const quotas = await this.quotas.find({ where: { tenantId } });
    return rows.map((r) => {
      const q = quotas.find((x) => x.meter === r.meter) ?? null;
      return {
        meter: r.meter,
        used: Number(r.used),
        softLimit: q?.softLimit === null || q?.softLimit === undefined ? null : Number(q.softLimit),
        hardLimit: q?.hardLimit === null || q?.hardLimit === undefined ? null : Number(q.hardLimit),
        period: q?.period ?? 'month',
      };
    });
  }

  /** 近 N 天序列（图表用；无记录的日期不补零，前端按需处理） */
  async daySeries(tenantId: number, meter: string, days = 30) {
    const d = Math.max(1, Math.min(180, days));
    const rows: Array<{ day: string; quantity: string }> = await this.daily.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, quantity FROM usage_daily
       WHERE tenant_id = $1 AND meter = $2 AND day >= current_date - ($3::int - 1)::int
       ORDER BY day ASC`,
      [tenantId, meter, d],
    );
    return rows.map((r) => ({ day: r.day, quantity: Number(r.quantity) }));
  }

  /** 原始计量明细（对账用，运营端） */
  async listMeters(q: { tenantId?: number; meter?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, q.page ?? 1);
    const size = Math.min(200, q.pageSize ?? 50);
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (q.tenantId) { params.push(q.tenantId); where.push(`tenant_id = $${params.length}`); }
    if (q.meter) { params.push(q.meter); where.push(`meter = $${params.length}`); }
    if (q.from) { params.push(q.from); where.push(`occurred_at >= $${params.length}::timestamptz`); }
    if (q.to) { params.push(q.to); where.push(`occurred_at <= ($${params.length}::date + 1)::timestamptz`); }
    params.push(size); const lim = `$${params.length}`;
    params.push((page - 1) * size); const off = `$${params.length}`;
    const rows: Array<Record<string, any>> = await this.meters.query(
      `SELECT id, tenant_id AS "tenantId", meter, module_code AS "moduleCode", quantity,
              user_id AS "userId", meta, occurred_at AS "occurredAt"
       FROM usage_meters WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    return rows.map((r) => ({
      ...r,
      id: Number(r.id),
      tenantId: Number(r.tenantId),
      userId: r.userId === null || r.userId === undefined ? null : Number(r.userId),
      quantity: Number(r.quantity),
    }));
  }

  // -------------------------------------------------------------- 配额

  async getQuota(tenantId: number, meter: string): Promise<Quota | null> {
    return this.quotas.findOne({ where: { tenantId, meter } });
  }

  async listQuotas(tenantId: number) {
    const rows = await this.quotas.find({ where: { tenantId }, order: { meter: 'ASC' } });
    return rows.map((r) => ({
      meter: r.meter,
      softLimit: r.softLimit === null ? null : Number(r.softLimit),
      hardLimit: r.hardLimit === null ? null : Number(r.hardLimit),
      period: r.period,
    }));
  }

  /** 运营设配额：数值传 null 表示取消该侧限制；两边都 null 等价删除 */
  async setQuota(tenantId: number, meter: string, input: { softLimit?: number | null; hardLimit?: number | null; period?: 'month' | 'day' }) {
    const period = input.period ?? 'month';
    const existing = await this.getQuota(tenantId, meter);
    const soft = input.softLimit === undefined ? (existing?.softLimit ?? null) : (input.softLimit === null ? null : String(input.softLimit));
    const hard = input.hardLimit === undefined ? (existing?.hardLimit ?? null) : (input.hardLimit === null ? null : String(input.hardLimit));
    if (soft !== null && hard !== null && Number(soft) > Number(hard)) {
      throw new BadRequestException('soft_limit 不能大于 hard_limit');
    }
    await this.quotas.save({
      tenantId, meter,
      softLimit: soft, hardLimit: hard,
      period,
      updatedAt: new Date(),
    } as Quota);
    return { tenantId, meter, softLimit: soft === null ? null : Number(soft), hardLimit: hard === null ? null : Number(hard), period };
  }

  async removeQuota(tenantId: number, meter: string) {
    await this.quotas.delete({ tenantId, meter });
    return { tenantId, meter, removed: true };
  }

  /**
   * 业务动作前置检查（打印提交 / AI 生成调用）。
   * hard 超限抛 4033；soft 只回告警信息，不拦。无配额记录直接通过。
   */
  async assertQuota(tenantId: number, meter: string, quantity: number): Promise<{ warn: boolean; decision?: QuotaDecision }> {
    const q = await this.getQuota(tenantId, meter);
    if (!q) return { warn: false };
    const used = await this.windowUsed(tenantId, meter, q.period);
    const decision = checkQuota(used, quantity, {
      softLimit: q.softLimit, hardLimit: q.hardLimit, period: q.period,
    });
    if (decision.kind === 'exceeded') {
      throw new QuotaExceededException(meter, decision.used, decision.hardLimit, q.period);
    }
    return { warn: decision.kind === 'warn', decision };
  }
}
