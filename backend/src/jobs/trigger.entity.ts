// P8.1 触发器实体。两张表都带 tenant_id，DDL 见 scripts/saas_p8_triggers.sql
// （含 RLS 兜底：新表不补策略就是隔离缺口，参考 saas_p7_notifications.sql）。
import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('print_triggers')
@Index(['tenantId', 'source', 'enabled'])
export class PrintTrigger {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 80 }) name: string;
  @Column({ length: 40 }) source: string;
  /** 公式引擎语法，变量用 {{name}} 占位；NULL = 恒真 */
  @Column({ name: 'condition_expr', type: 'text', nullable: true }) conditionExpr: string | null;
  @Column({ length: 20 }) action: string;
  /** webhook secret 以 secretEnc 密文保存（复用 datasource/sql-crypto），不落明文 */
  @Column('jsonb', { default: {} }) config: Record<string, any>;
  @Column({ default: true }) enabled: boolean;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity('trigger_deliveries')
@Index(['tenantId', 'createdAt'])
export class TriggerDelivery {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'trigger_id', type: 'bigint' }) triggerId: number;
  @Column({ name: 'event_source', length: 40 }) eventSource: string;
  /** 唯一索引 (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL 兜并发 */
  @Column({ name: 'dedupe_key', length: 160, nullable: true }) dedupeKey: string | null;
  @Column({ length: 20, default: 'pending' }) status: 'pending' | 'success' | 'failed' | 'skipped';
  @Column({ name: 'http_status', type: 'int', nullable: true }) httpStatus: number | null;
  @Column({ name: 'error_msg', type: 'text', nullable: true }) errorMsg: string | null;
  @Column({ name: 'duration_ms', type: 'int', default: 0 }) durationMs: number;
  @Column('jsonb', { default: {} }) metadata: Record<string, any>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
