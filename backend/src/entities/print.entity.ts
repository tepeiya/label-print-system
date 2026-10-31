// 打印机 / 打印任务 / 打印日志 / 数据源 / 审计 实体
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('printers')
@Index('ix_printers_tenant', ['tenantId'])
export class Printer {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ length: 120 }) name: string;
  @Column({ length: 20 }) type: string;
  @Column('jsonb', { default: {} }) connection: Record<string, any>;
  @Column({ default: 203 }) dpi: number;
  @Column({ name: 'label_width_mm', type: 'numeric', precision: 8, scale: 2, default: 40 }) labelWidthMm: number;
  @Column({ name: 'label_height_mm', type: 'numeric', precision: 8, scale: 2, default: 30 }) labelHeightMm: number;
  @Column({ default: 0 }) orientation: number;
  @Column({ name: 'offset_x_mm', type: 'numeric', precision: 7, scale: 2, default: 0 }) offsetXMm: number;
  @Column({ name: 'offset_y_mm', type: 'numeric', precision: 7, scale: 2, default: 0 }) offsetYMm: number;
  @Column({ nullable: true }) density: number;
  @Column({ nullable: true }) speed: number;
  @Column({ name: 'default_template_id', nullable: true }) defaultTemplateId: number;
  @Column({ name: 'is_default', default: false }) isDefault: boolean;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('print_jobs')
@Index('ix_printjobs_tenant_status', ['tenantId', 'status'])
export class PrintJob {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column('uuid', { nullable: true }) uuid: string;
  @Column({ name: 'template_id' }) templateId: number;
  @Column({ name: 'printer_id', nullable: true }) printerId: number;
  @Column({ default: 1 }) total: number;
  @Column({ default: 0 }) done: number;
  @Column({ default: 0 }) failed: number;
  @Column({ default: 'queued' }) status: string;
  @Column('jsonb', { default: {} }) params: Record<string, any>;
  @Column('jsonb', { nullable: true }) dataRef: Record<string, any>;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
  @Column({ name: 'finished_at', nullable: true }) finishedAt: Date;
}

@Entity('print_logs')
@Index('ix_printlogs_tenant_job', ['tenantId', 'jobId'])
export class PrintLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'job_id' }) jobId: number;
  @Column({ name: 'template_id' }) templateId: number;
  @Column({ name: 'printer_id', nullable: true }) printerId: number;
  @Column() seqNo: number;
  @Column('jsonb', { nullable: true }) serialValues: Record<string, any>;
  @Column('jsonb', { nullable: true }) dataSnapshot: Record<string, any>;
  @Column() status: string;
  @Column({ name: 'error_msg', length: 500, nullable: true }) errorMsg: string;
  @Column({ name: 'reprint_of', nullable: true }) reprintOf: number;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
}

@Entity('data_sources')
@Index('ix_datasources_tenant', ['tenantId'])
export class DataSource {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ length: 120 }) name: string;
  @Column({ length: 20 }) type: string;
  @Column('jsonb', { default: {} }) config: Record<string, any>;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('data_rows')
@Index('ix_datarows_tenant_source', ['tenantId', 'sourceId'])
export class DataRow {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'source_id', nullable: true }) sourceId: number;
  @Column({ name: 'template_id', nullable: true }) templateId: number;
  @Column('jsonb') payload: Record<string, any>;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
}

@Entity('audit_logs')
@Index('ix_audit_tenant_created', ['tenantId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'actor_id', nullable: true }) actorId: number;
  @Column({ length: 40 }) action: string;
  @Column({ name: 'target_type', length: 30, nullable: true }) targetType: string;
  @Column({ name: 'target_id', nullable: true }) targetId: number;
  @Column('jsonb', { nullable: true }) detail: Record<string, any>;
  @Column({ length: 45, nullable: true }) ip: string;
  @CreateDateColumn() createdAt: Date;
}

@Entity('tenant_backups')
@Index('ix_backups_tenant', ['tenantId', 'createdAt'])
export class TenantBackup {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ length: 160 }) name: string;
  @Column({ name: 'storage_key', length: 300 }) storageKey: string;
  @Column({ name: 'size_bytes', nullable: true }) sizeBytes: number;
  @Column({ default: 'manual' }) kind: string;
  @Column({ name: 'created_by', nullable: true }) createdBy: number;
  @CreateDateColumn() createdAt: Date;
}
