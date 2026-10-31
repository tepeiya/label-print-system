// 流水号 实体（并发安全核心）
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('serial_sequences')
@Index('ix_serial_tenant', ['tenantId'])
export class SerialSequence {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;          // 租户隔离字段
  @Column({ length: 80 }) name: string;
  @Column({ default: 'template' }) scope: string;
  @Column({ name: 'group_key', length: 60, nullable: true }) groupKey: string;
  @Column({ name: 'start_value', default: 1 }) startValue: number;
  @Column({ default: 1 }) step: number;
  @Column({ name: 'current_value', default: 1 }) currentValue: number;  // 游标
  @Column({ default: 0 }) digits: number;
  @Column({ default: '' }) prefix: string;
  @Column({ default: '' }) suffix: string;
  @Column({ default: 10 }) radix: number;
  @Column({ name: 'reset_cycle', default: 'never' }) resetCycle: string;
  @Column({ name: 'reset_at', nullable: true }) resetAt: Date;
  @Column({ name: 'custom_cycle_days', nullable: true }) customCycleDays: number;
  @Column({ name: 'allow_manual_reset', default: true }) allowManualReset: boolean;
  @Column({ name: 'consume_mode', default: 'per_copy' }) consumeMode: string;
  @Column({ name: 'rollback_policy', default: 'consume' }) rollbackPolicy: string;
  @Column({ default: 0 }) version: number;                 // 乐观锁
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('serial_usage_log')
@Index('ix_serialusage_tenant_seq', ['tenantId', 'sequenceId'])
@Index('ix_serialusage_tenant_job', ['tenantId', 'jobId'])
export class SerialUsageLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'sequence_id' }) sequenceId: number;
  @Column({ name: 'job_id', nullable: true }) jobId: number;
  @Column() value: number;
  @Column({ length: 120, nullable: true }) formatted: string;
  @Column({ default: 'issued' }) status: string;
  @CreateDateColumn() createdAt: Date;
}
