// =============================================================================
// UDI 追溯实体（UDI 里程碑 U2）
// DDL: backend/scripts/udi_p1_trace.sql
// 约定：全表含 tenant_id；udi 单元以 udi_key 做租户内唯一键（GTIN|批号|序列号）。
// 所有列显式声明 type（tsx/esbuild 无 design:type 元数据）。
// =============================================================================
import {
  Entity, PrimaryGeneratedColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('udi_units')
@Unique('uq_udi_units_key', ['tenantId', 'udiKey'])
@Index('idx_udi_units_lookup', ['tenantId', 'gtin', 'lot', 'serial'])
@Index('idx_udi_units_status', ['tenantId', 'status'])
export class UdiUnit {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** 单品唯一键：GTIN14|批号|序列号（由 udiUnitKey 生成，最长 200） */
  @Column({ name: 'udi_key', type: 'varchar', length: 200 }) udiKey: string;
  @Column({ type: 'varchar', length: 14 }) gtin: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) lot: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) serial: string | null;
  @Column({ name: 'expiry_date', type: 'date', nullable: true }) expiryDate: string | null;
  @Column({ name: 'production_date', type: 'date', nullable: true }) productionDate: string | null;
  @Column({ type: 'varchar', length: 32, default: 'REGISTERED' }) status: string;
  @Column({ name: 'package_id', type: 'bigint', nullable: true }) packageId: number | null;
  @Column({ name: 'package_sscc', type: 'varchar', length: 18, nullable: true }) packageSscc: string | null;
  @Column({ name: 'work_order_no', type: 'varchar', length: 64, nullable: true }) workOrderNo: string | null;
  @Column({ name: 'template_code', type: 'varchar', length: 64, nullable: true }) templateCode: string | null;
  @Column({ name: 'printed_at', type: 'timestamptz', nullable: true }) printedAt: Date | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity('udi_packages')
@Unique('uq_udi_packages_sscc', ['tenantId', 'sscc'])
@Index('idx_udi_packages_parent', ['tenantId', 'parentSscc'])
export class UdiPackage {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ type: 'varchar', length: 18 }) sscc: string;
  /** UNIT | CARTON | PALLET */
  @Column({ type: 'varchar', length: 16, default: 'CARTON' }) level: string;
  @Column({ type: 'varchar', length: 14, nullable: true }) gtin: string | null;
  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 }) qty: string;
  @Column({ name: 'parent_sscc', type: 'varchar', length: 18, nullable: true }) parentSscc: string | null;
  @Column({ name: 'work_order_no', type: 'varchar', length: 64, nullable: true }) workOrderNo: string | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('udi_events')
@Index('idx_udi_events_unit', ['tenantId', 'unitId', 'occurredAt'])
@Index('idx_udi_events_type', ['tenantId', 'eventType', 'occurredAt'])
@Unique('uq_udi_events_idem', ['tenantId', 'idemKey'])
export class UdiEvent {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'unit_id', type: 'bigint', nullable: true }) unitId: number | null;
  @Column({ name: 'udi_key', type: 'varchar', length: 200, nullable: true }) udiKey: string | null;
  @Column({ name: 'package_sscc', type: 'varchar', length: 18, nullable: true }) packageSscc: string | null;
  @Column({ name: 'event_type', type: 'varchar', length: 24 }) eventType: string;
  @Column({ name: 'status_before', type: 'varchar', length: 32, nullable: true }) statusBefore: string | null;
  @Column({ name: 'status_after', type: 'varchar', length: 32, nullable: true }) statusAfter: string | null;
  /** 关联单据类型：RECEIPT | ISSUE | SHIPMENT | PRINT_JOB | MANUAL */
  @Column({ name: 'ref_type', type: 'varchar', length: 32, nullable: true }) refType: string | null;
  @Column({ name: 'ref_no', type: 'varchar', length: 64, nullable: true }) refNo: string | null;
  @Column({ name: 'idem_key', type: 'varchar', length: 120, nullable: true }) idemKey: string | null;
  @Column({ type: 'jsonb', nullable: true }) detail: Record<string, any> | null;
  @Column({ name: 'actor_id', type: 'bigint', nullable: true }) actorId: number | null;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
