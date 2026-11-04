// =============================================================================
// ai-quota.service.ts —— AI 每日调用配额检查与扣减
//
// 规则：
//   1. 每天自然日（UTC YYYY-MM-DD）重置计数
//   2. limitTotal 硬上限（租户全局每天所有 kind 合计）
//   3. limitPerKind 软上限（每 kind 独立限）
//   4. 默认值从 env 读 AI_DAILY_QUOTA_TOTAL（默认 1000）、AI_DAILY_QUOTA_PER_KIND（默认 500）
//   5. 可以在 ai_quotas 表里单独设某租户的 limit（覆盖默认）
// =============================================================================

import { Injectable, ForbiddenException, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { AiQuota } from '../entities/ai-quota.entity';

const DEFAULT_TOTAL = +(process.env.AI_DAILY_QUOTA_TOTAL || '1000');
const DEFAULT_PER_KIND = +(process.env.AI_DAILY_QUOTA_PER_KIND || '500');

export type AiKind = 'vision' | 'text' | 'image';

export interface QuotaCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  remaining: number;
  kind: string;
  limitType: 'total' | 'perKind';
}

@Injectable()
export class AiQuotaService {
  private readonly logger = new Logger('AiQuota');

  constructor(
    @InjectRepository(AiQuota) private repo: Repository<AiQuota>,
    private ds: DataSource,
  ) {}

  /** 检查并扣减 1 次调用。超过硬限抛 ForbiddenException */
  async checkAndConsume(tenantId: number, kind: AiKind): Promise<QuotaCheckResult> {
    const date = new Date().toISOString().slice(0, 10); // UTC

    // 在一个 queryRunner 里做 upsert + 检查 + increment（原子性）
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const rows = await qr.manager.query(
        `SELECT * FROM ai_quotas WHERE tenant_id = $1 AND date = $2 AND kind = $3 FOR UPDATE`,
        [tenantId, date, kind],
      );
      let row: any = rows[0];
      if (!row) {
        const inserted = await qr.manager.query(
          `INSERT INTO ai_quotas (tenant_id, date, kind, count, limit_total, limit_per_kind)
           VALUES ($1, $2, $3, 0, $4, $5) RETURNING *`,
          [tenantId, date, kind, 0, DEFAULT_TOTAL, DEFAULT_PER_KIND],
        );
        row = inserted[0];
      }

      const totalRows = await qr.manager.query(
        `SELECT COALESCE(SUM(count), 0) as total FROM ai_quotas WHERE tenant_id = $1 AND date = $2`,
        [tenantId, date],
      );
      const currentTotal = +(totalRows[0]?.total ?? 0);

      const hardTotal = row.limit_total > 0 ? row.limit_total : DEFAULT_TOTAL;
      const softPerKind = row.limit_per_kind > 0 ? row.limit_per_kind : DEFAULT_PER_KIND;

      // 硬限检查
      if (currentTotal >= hardTotal) {
        await qr.rollbackTransaction();
        throw new ForbiddenException(
          `AI 调用已达每日上限（${hardTotal} 次/天），明天再来或联系管理员扩容`,
        );
      }

      // 扣减
      await qr.manager.query(
        `UPDATE ai_quotas SET count = count + 1, updated_at = now() WHERE id = $1`,
        [row.id],
      );
      await qr.commitTransaction();

      const updated = { ...row, count: row.count + 1 };
      this.logger.debug(`[quota] tenant=${tenantId} ${kind} count=${updated.count} total=${currentTotal + 1}/${hardTotal}`);

      const remaining = Math.min(hardTotal - (currentTotal + 1), softPerKind - updated.count);
      return {
        allowed: true,
        current: updated.count,
        limit: hardTotal,
        remaining: Math.max(0, remaining),
        kind,
        limitType: currentTotal + 1 >= hardTotal ? 'total' : 'perKind',
      };
    } catch (e) {
      await qr.rollbackTransaction().catch(() => {});
      throw e;
    } finally {
      await qr.release();
    }
  }

  /** 查询当前租户今日配额概况 */
  async stats(tenantId: number) {
    const date = new Date().toISOString().slice(0, 10);
    const rows = await this.repo.find({ where: { tenantId, date } });
    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      date,
      limits: { total: DEFAULT_TOTAL, perKind: DEFAULT_PER_KIND },
      total,
      remaining: Math.max(0, DEFAULT_TOTAL - total),
      byKind: Object.fromEntries(rows.map((r) => [r.kind, r.count])),
    };
  }
}
