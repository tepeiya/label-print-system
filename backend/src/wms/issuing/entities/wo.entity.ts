// =============================================================================
// WMS 阶段二实体（wms.issuing 工单发料）
// DDL: backend/scripts/wms_p2_issuing.sql
// 约定沿用阶段一：全表含 tenant_id；数量 NUMERIC(14,3) 反射为 string，出参前 Number()。
// 所有列显式声明 type（esbuild 无 design:type 元数据）。
// =============================================================================
import {
  Entity, PrimaryGeneratedColumn, Column, Index, Unique, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('wms_work_orders')
@Unique('uq_wms_wo_no', ['tenantId', 'woNo'])
@Index('idx_wms_wo_status', ['tenantId', 'status'])
export class WmsWorkOrder {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'wo_no', type: 'varchar', length: 64 }) woNo: string;
  @Column({ name: 'product_material_id', type: 'bigint' }) productMaterialId: number;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'demand_qty', type: 'numeric', precision: 14, scale: 3 }) demandQty: string;
  @Column({ name: 'source_type', type: 'varchar', length: 32, default: 'MANUAL' }) sourceType: string;
  @Column({ name: 'source_no', type: 'varchar', length: 64, nullable: true }) sourceNo: string | null;
  @Column({ type: 'int', default: 100 }) priority: number;
  @Column({ name: 'planned_start_at', type: 'timestamptz', nullable: true }) plannedStartAt: Date | null;
  @Column({ name: 'planned_end_at', type: 'timestamptz', nullable: true }) plannedEndAt: Date | null;
  @Column({ type: 'varchar', length: 32, default: 'CREATED' }) status: string;
  @Column({ name: 'shortage_flag', type: 'boolean', default: false }) shortageFlag: boolean;
  @Column({ type: 'text', nullable: true }) remark: string | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wms_wo_lines')
@Unique('uq_wms_wo_line_no', ['tenantId', 'woId', 'lineNo'])
@Index('idx_wms_wo_lines_wo', ['tenantId', 'woId'])
export class WmsWoLine {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'wo_id', type: 'bigint' }) woId: number;
  @Column({ name: 'line_no', type: 'int' }) lineNo: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'qty_required', type: 'numeric', precision: 14, scale: 3 }) qtyRequired: string;
  @Column({ name: 'qty_issued', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyIssued: string;
  @Column({ name: 'qty_shortage', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyShortage: string;
  @Column({ name: 'batch_no', type: 'varchar', length: 60, nullable: true }) batchNo: string | null;
  @Column({ type: 'varchar', length: 32, default: 'PENDING' }) status: string;
  @Column({ name: 'shortage_reason', type: 'varchar', length: 300, nullable: true }) shortageReason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('wms_issue_records')
@Unique('uq_wms_issue_idem', ['tenantId', 'idemKey'])
@Index('idx_wms_issue_wo', ['tenantId', 'woId'])
export class WmsIssueRecord {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'wo_id', type: 'bigint' }) woId: number;
  @Column({ name: 'line_id', type: 'bigint' }) lineId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'batch_no', type: 'varchar', length: 60, nullable: true }) batchNo: string | null;
  @Column({ name: 'location_id', type: 'bigint', nullable: true }) locationId: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 3 }) qty: string;
  @Column({ name: 'idem_key', type: 'varchar', length: 128 }) idemKey: string;
  @Column({ name: 'ref_type', type: 'varchar', length: 32, default: 'WMS_ISSUE' }) refType: string;
  @Column({ name: 'operator_id', type: 'bigint', nullable: true }) operatorId: number | null;
  @Column({ name: 'print_job_id', type: 'varchar', length: 64, nullable: true }) printJobId: string | null;
  @Column({ name: 'print_status', type: 'varchar', length: 32, nullable: true }) printStatus: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity('wms_wo_returns')
@Unique('uq_wms_return_idem', ['tenantId', 'idemKey'])
@Index('idx_wms_return_wo', ['tenantId', 'woId'])
export class WmsWoReturn {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'wo_id', type: 'bigint' }) woId: number;
  @Column({ name: 'line_id', type: 'bigint' }) lineId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'batch_no', type: 'varchar', length: 60, nullable: true }) batchNo: string | null;
  @Column({ name: 'location_id', type: 'bigint', nullable: true }) locationId: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 3 }) qty: string;
  @Column({ name: 'idem_key', type: 'varchar', length: 128 }) idemKey: string;
  @Column({ name: 'approved_by', type: 'bigint', nullable: true }) approvedBy: number | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt: Date | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) reason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
