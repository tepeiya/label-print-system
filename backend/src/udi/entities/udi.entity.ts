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
  /** 装箱来源：RECEIPT | WORK_ORDER；NULL = 自由装箱 */
  @Column({ name: 'source_type', type: 'varchar', length: 16, nullable: true }) sourceType: string | null;
  /** 来源单号：收货单号 / 工单号 */
  @Column({ name: 'source_no', type: 'varchar', length: 64, nullable: true }) sourceNo: string | null;
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

/** DI 主数据台账（DDL: scripts/udi_p3_compliance.sql）——一物一 DI，含包装层级与上下级关系 */
@Entity('udi_di_master')
@Unique('uq_udi_di_master', ['tenantId', 'di'])
@Index('ix_udi_di_master_level', ['tenantId', 'packageLevel', 'status'])
export class UdiDiMaster {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** GTIN-14（含校验位） */
  @Column({ type: 'varchar', length: 14 }) di: string;
  @Column({ type: 'varchar', length: 128 }) name: string;
  @Column({ type: 'varchar', length: 128, nullable: true }) spec: string | null;
  @Column({ type: 'varchar', length: 128, nullable: true }) model: string | null;
  @Column({ name: 'registration_no', type: 'varchar', length: 64, nullable: true }) registrationNo: string | null;
  /** 分类目录编码，形如 02-04-01 */
  @Column({ name: 'catalog_code', type: 'varchar', length: 32, nullable: true }) catalogCode: string | null;
  @Column({ type: 'varchar', length: 32, nullable: true }) gmdn: string | null;
  @Column({ type: 'varchar', length: 32, nullable: true }) emdn: string | null;
  @Column({ name: 'issuing_agency', type: 'varchar', length: 16, default: 'GS1' }) issuingAgency: string;
  @Column({ name: 'is_sterile', type: 'boolean', default: false }) isSterile: boolean;
  @Column({ name: 'is_single_use', type: 'boolean', default: false }) isSingleUse: boolean;
  /** UNIT(最小销售单元) / CARTON(中包装) / PALLET(托盘) */
  @Column({ name: 'package_level', type: 'varchar', length: 16, default: 'UNIT' }) packageLevel: string;
  @Column({ name: 'qty_in_package', type: 'numeric', precision: 14, scale: 3, nullable: true }) qtyInPackage: string | null;
  @Column({ name: 'parent_di', type: 'varchar', length: 14, nullable: true }) parentDi: string | null;
  @Column({ type: 'varchar', length: 16, default: 'active' }) status: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) remark: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** 申报提交记录——校验/生成文件/接口提交共用一条账 */
@Entity('udi_submissions')
@Index('ix_udi_submissions_tenant', ['tenantId', 'createdAt'])
export class UdiSubmission {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** NMPA / EUDAMED / GUDID / FILE */
  @Column({ type: 'varchar', length: 16 }) channel: string;
  /** validate 只校验 / file 生成文件 / api 接口直传 */
  @Column({ type: 'varchar', length: 16, default: 'validate' }) mode: string;
  @Column({ type: 'jsonb', default: () => "'[]'" }) dis: string[];
  @Column({ type: 'jsonb', nullable: true }) payload: Record<string, any> | null;
  @Column({ type: 'jsonb', nullable: true }) issues: any[] | null;
  @Column({ type: 'varchar', length: 16, default: 'draft' }) status: string;
  @Column({ name: 'remote_code', type: 'varchar', length: 64, nullable: true }) remoteCode: string | null;
  @Column({ name: 'remote_msg', type: 'text', nullable: true }) remoteMsg: string | null;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
