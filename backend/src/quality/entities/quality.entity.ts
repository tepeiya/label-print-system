// =============================================================================
// 质量闸门实体（DDL: scripts/quality_p1_gates.sql）
//   · QcInspection / QcInspectionItem —— 来料·过程·成品检验单
//   · QaRelease                      —— 成品放行单（QA 签批）
//   · BatchRecord / BatchRecordStep   —— 批记录（工单工序 + 参数 + 结果）
//   · QcStatusLog                     —— 批次质量状态变更留痕
// ⚠️ 字面量联合类型必须显式 type，否则反射成 Object 会让 TypeORM 启动失败（同 inventory 实体约定）
// =============================================================================
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export type QualityStatus = 'PENDING' | 'RELEASED' | 'REJECTED' | 'FROZEN';

@Entity('qc_inspections')
@Index('ix_qc_insp_batch', ['tenantId', 'materialId', 'batchNo'])
export class QcInspection {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'inspection_no', length: 40 }) inspectionNo: string;
  @Column({ name: 'insp_type', type: 'varchar', length: 8, default: 'IQC' }) inspType: 'IQC' | 'IPQC' | 'FQC' | 'OQC';
  @Column({ type: 'varchar', length: 12, default: 'MANUAL' }) source: 'RECEIPT' | 'MANUAL' | 'WORKORDER';
  @Column({ name: 'receipt_id', type: 'bigint', nullable: true }) receiptId: number | null;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'sku_code', length: 40 }) skuCode: string;
  @Column({ name: 'batch_no', length: 60 }) batchNo: string;
  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 }) qty: string;
  @Column({ name: 'sample_qty', type: 'numeric', precision: 14, scale: 3, default: 0 }) sampleQty: string;
  @Column({ type: 'varchar', length: 12, default: 'DRAFT' }) status: 'DRAFT' | 'PASS' | 'FAIL' | 'CANCELLED';
  @Column({ type: 'varchar', length: 80, nullable: true }) inspector: string | null;
  @Column({ name: 'inspected_by', type: 'bigint', nullable: true }) inspectedBy: number | null;
  @Column({ name: 'inspected_at', type: 'timestamptz', nullable: true }) inspectedAt: Date | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) reviewer: string | null;
  @Column({ name: 'reviewed_by', type: 'bigint', nullable: true }) reviewedBy: number | null;
  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) opinion: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) remark: string | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

@Entity('qc_inspection_items')
@Index('ix_qc_item_doc', ['tenantId', 'inspectionId'])
export class QcInspectionItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'inspection_id', type: 'bigint' }) inspectionId: number;
  @Column({ type: 'int', default: 1 }) seq: number;
  @Column({ name: 'item_name', length: 80 }) itemName: string;
  @Column({ type: 'varchar', length: 160, nullable: true }) standard: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) measured: string | null;
  @Column({ type: 'varchar', length: 8, default: 'NA' }) verdict: 'PASS' | 'FAIL' | 'NA';
  @Column({ type: 'varchar', length: 200, nullable: true }) remark: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('qa_releases')
@Index('ix_qa_rel_batch', ['tenantId', 'materialId', 'batchNo'])
export class QaRelease {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'release_no', length: 40 }) releaseNo: string;
  @Column({ type: 'varchar', length: 12, default: 'PRODUCTION' }) source: 'PRODUCTION' | 'MANUAL';
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'sku_code', length: 40 }) skuCode: string;
  @Column({ name: 'batch_no', length: 60 }) batchNo: string;
  @Column({ name: 'work_order_id', type: 'bigint', nullable: true }) workOrderId: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 }) qty: string;
  @Column({ name: 'inspection_id', type: 'bigint', nullable: true }) inspectionId: number | null;
  @Column({ type: 'varchar', length: 12, default: 'PENDING' }) status: 'PENDING' | 'RELEASED' | 'REJECTED' | 'CANCELLED';
  @Column({ type: 'varchar', length: 80, nullable: true }) submitter: string | null;
  @Column({ name: 'submitted_by', type: 'bigint', nullable: true }) submittedBy: number | null;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) reviewer: string | null;
  @Column({ name: 'reviewed_by', type: 'bigint', nullable: true }) reviewedBy: number | null;
  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true }) reviewedAt: Date | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) opinion: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) remark: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

@Entity('batch_records')
@Index('ix_br_wo', ['tenantId', 'workOrderId'])
export class BatchRecord {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'record_no', length: 40 }) recordNo: string;
  @Column({ name: 'work_order_id', type: 'bigint', nullable: true }) workOrderId: number | null;
  @Column({ name: 'wo_no', type: 'varchar', length: 40, nullable: true }) woNo: string | null;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'sku_code', length: 40 }) skuCode: string;
  @Column({ name: 'product_name', type: 'varchar', length: 120, nullable: true }) productName: string | null;
  @Column({ name: 'batch_no', length: 60 }) batchNo: string;
  @Column({ name: 'qty_planned', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyPlanned: string;
  @Column({ name: 'qty_actual', type: 'numeric', precision: 14, scale: 3, nullable: true }) qtyActual: string | null;
  @Column({ type: 'varchar', length: 12, default: 'OPEN' }) status: 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  @Column({ name: 'opened_by', type: 'bigint', nullable: true }) openedBy: number | null;
  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true }) openedAt: Date | null;
  @Column({ name: 'submitted_by', type: 'bigint', nullable: true }) submittedBy: number | null;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date | null;
  @Column({ name: 'approved_by', type: 'bigint', nullable: true }) approvedBy: number | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt: Date | null;
  @Column({ name: 'approval_opinion', type: 'varchar', length: 300, nullable: true }) approvalOpinion: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) remark: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

@Entity('batch_record_steps')
@Index('ix_br_step_doc', ['tenantId', 'recordId'])
export class BatchRecordStep {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'record_id', type: 'bigint' }) recordId: number;
  @Column({ type: 'int' }) seq: number;
  @Column({ name: 'step_name', length: 80 }) stepName: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) equipment: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) operator: string | null;
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true }) endedAt: Date | null;
  @Column('jsonb', { default: {} }) params: Record<string, any>;
  @Column({ type: 'varchar', length: 8, default: 'PASS' }) result: 'PASS' | 'FAIL' | 'NA';
  @Column({ type: 'varchar', length: 200, nullable: true }) remark: string | null;
  @Column({ name: 'attachment_url', type: 'varchar', length: 300, nullable: true }) attachmentUrl: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('qc_status_log')
@Index('ix_qc_log_batch', ['tenantId', 'materialId', 'batchNo'])
export class QcStatusLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'sku_code', length: 40 }) skuCode: string;
  @Column({ name: 'batch_no', length: 60 }) batchNo: string;
  @Column({ name: 'from_status', type: 'varchar', length: 12, nullable: true }) fromStatus: string | null;
  @Column({ name: 'to_status', type: 'varchar', length: 12 }) toStatus: string;
  @Column({ length: 200 }) reason: string;
  @Column({ name: 'ref_type', type: 'varchar', length: 20, nullable: true }) refType: string | null;
  @Column({ name: 'ref_no', type: 'varchar', length: 40, nullable: true }) refNo: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) operator: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
