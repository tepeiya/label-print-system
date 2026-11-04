// =============================================================================
// ai-quota.entity.ts —— AI 每日调用配额
// =============================================================================

import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/** 每日 AI 调用计数（每租户 × 每自然日 × 每 kind 一行） */
@Entity('ai_quotas')
@Index('ix_quota_tenant_date_kind', ['tenantId', 'date', 'kind'], { unique: true })
export class AiQuota {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  /** ISO 日期 YYYY-MM-DD（UTC） */
  @Column({ length: 10 }) date: string;
  /** vision | text | image */
  @Column({ length: 20 }) kind: string;
  @Column({ default: 0 }) count: number;
  @Column({ name: 'limit_total', default: 0 }) limitTotal: number;
  @Column({ name: 'limit_per_kind', default: 0 }) limitPerKind: number;
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()', onUpdate: 'now()' }) updatedAt: Date;
}
