// P8.3 企业治理实体。四张表全部带 tenant_id，DDL 见 scripts/saas_p8_governance.sql
// （含 RLS 兜底：新表不补策略就是隔离缺口，与 saas_p8_triggers.sql 同口径）。
import {
  Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

/** 租户级治理策略：一行一租户，policy 存归一化后的 JSONB（缺省 = 默认全宽松） */
@Entity('governance_settings')
export class GovernanceSetting {
  @PrimaryColumn({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column('jsonb', { default: {} }) policy: Record<string, any>;
  @Column({ name: 'updated_by', type: 'bigint', nullable: true }) updatedBy: number | null;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** 模板级治理状态：与 templates 表解耦（存量模板没有记录 = 未纳管，一律放行） */
@Entity('template_governance')
@Index('uq_template_governance_tenant_template', ['tenantId', 'templateId'], { unique: true })
@Index('ix_template_governance_tenant_status', ['tenantId', 'status'])
export class TemplateGovernance {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'template_id', type: 'bigint' }) templateId: number;
  @Column({ length: 20, default: 'draft' }) status: string;
  /** 发布时锁定的模板版本号，用于追溯「线上到底在打哪一版」 */
  @Column({ name: 'published_version', type: 'int', nullable: true }) publishedVersion: number | null;
  @Column({ name: 'submitted_by', type: 'bigint', nullable: true }) submittedBy: number | null;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date | null;
  @Column({ name: 'reviewed_by', type: 'bigint', nullable: true }) reviewedBy: number | null;
  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ name: 'review_comment', type: 'text', nullable: true }) reviewComment: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** 审批留痕：每次状态迁移一行，含操作人、动作、理由、前后状态 */
@Entity('template_reviews')
@Index('ix_template_reviews_tenant_template', ['tenantId', 'templateId', 'createdAt'])
export class TemplateReview {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'template_id', type: 'bigint' }) templateId: number;
  @Column({ name: 'from_status', type: 'varchar', length: 20, nullable: true }) fromStatus: string | null;
  @Column({ name: 'to_status', length: 20 }) toStatus: string;
  @Column({ length: 30 }) action: string;
  @Column({ name: 'actor_id', type: 'bigint', nullable: true }) actorId: number | null;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

/** 防重打印登记：唯一索引 (tenant_id, dedupe_key) 是并发去重的最终防线 */
@Entity('print_dedupe')
@Index('uq_print_dedupe_tenant_key', ['tenantId', 'dedupeKey'], { unique: true })
@Index('ix_print_dedupe_tenant_template', ['tenantId', 'templateId'])
export class PrintDedupe {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'dedupe_key', length: 160 }) dedupeKey: string;
  @Column({ name: 'template_id', type: 'bigint' }) templateId: number;
  @Column({ name: 'job_id', type: 'bigint' }) jobId: number;
  @Column({ name: 'first_printed_at', type: 'timestamptz' }) firstPrintedAt: Date;
  @Column({ name: 'last_printed_at', type: 'timestamptz' }) lastPrintedAt: Date;
  @Column({ name: 'print_count', type: 'int', default: 1 }) printCount: number;
}
