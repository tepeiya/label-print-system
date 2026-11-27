// =============================================================================
// 成品入库实体（wms.fg）—— 2026-11-27
// DDL: backend/scripts/wms_p4_fg_receipt.sql
//
// 这张单子补的是链条上原本空着的一环：
//   工单完工（无 MES 时在 PDA 报工）→ 成品入库单 → 过账增加成品库存 → 上架 → 放行 → 可发运
// 在此之前成品库存只能靠手工 /inventory/inbound 建账，工单产出无处登记。
// 约定：全部含 tenantId；数量 NUMERIC(14,3) 反射为 string，出参前 Number()。
// =============================================================================
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('wms_fg_receipts')
@Index('idx_wms_fg_tenant_status', ['tenantId', 'status'])
export class WmsFgReceipt {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'fg_no', type: 'varchar', length: 40 }) fgNo: string;
  /** WORK_ORDER：由工单完工报工生成；MANUAL：无工单的零星入库（须填原因） */
  @Column({ name: 'source_type', type: 'varchar', length: 16, default: 'WORK_ORDER' }) sourceType: string;
  @Column({ name: 'wo_no', type: 'varchar', length: 40, nullable: true }) woNo: string | null;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ type: 'varchar', length: 12, default: 'CREATED' }) status: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) remark: string | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @Column({ name: 'posted_by', type: 'bigint', nullable: true }) postedBy: number | null;
  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true }) postedAt: Date | null;
  @Column({ name: 'cancelled_by', type: 'bigint', nullable: true }) cancelledBy: number | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true }) cancelledAt: Date | null;
  @Column({ name: 'cancel_reason', type: 'varchar', length: 200, nullable: true }) cancelReason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wms_fg_receipt_lines')
@Index('idx_wms_fg_line_doc', ['tenantId', 'fgId'])
export class WmsFgReceiptLine {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'fg_id', type: 'bigint' }) fgId: number;
  @Column({ name: 'line_no', type: 'int' }) lineNo: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  /** 成品生产批号（与标签 / UDI-PI 的批号一致） */
  @Column({ name: 'batch_no', type: 'varchar', length: 60, nullable: true }) batchNo: string | null;
  @Column({ type: 'numeric', precision: 14, scale: 3 }) qty: string;
  @Column({ name: 'expiry_date', type: 'date', nullable: true }) expiryDate: string | null;
  @Column({ name: 'location_id', type: 'bigint', nullable: true }) locationId: number | null;
  /** PENDING / POSTED / FAILED —— 行级，过账逐行落结果 */
  @Column({ type: 'varchar', length: 12, default: 'PENDING' }) status: string;
  /** 建批次时的质量初始状态：物料 qc_required 时 PENDING，否则 RELEASED */
  @Column({ name: 'qc_status', type: 'varchar', length: 12, nullable: true }) qcStatus: string | null;
  @Column({ name: 'qty_after', type: 'numeric', precision: 14, scale: 3, nullable: true }) qtyAfter: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) error: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}
