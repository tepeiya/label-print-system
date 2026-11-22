// WMS 阶段一实体（收货与上架）
// DDL: backend/scripts/wms_p1_inbound.sql
// 约定：全部含 tenantId；数量 NUMERIC(14,3) 反射为 string，出参前 Number()（对齐 inventory 模块）。
// 所有列显式声明 type，避免 tsx（esbuild 不 emit design:type metadata）下单测 import 实体报错。
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('wms_receipts')
@Index('idx_wms_receipts_status', ['tenantId', 'status'])
export class WmsReceipt {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'receipt_no', type: 'varchar', length: 64 }) receiptNo: string;
  @Column({ name: 'source_type', type: 'varchar', length: 32 }) sourceType: string;   // MANUAL | EXCEL_IMPORT
  @Column({ name: 'source_no', type: 'varchar', length: 64, nullable: true }) sourceNo: string | null;
  @Column({ name: 'supplier_id', type: 'bigint', nullable: true }) supplierId: number | null;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ type: 'varchar', length: 32, default: 'CREATED' }) status: string;
  @Column({ type: 'text', nullable: true }) remark: string | null;
  @Column({ name: 'created_by', type: 'bigint' }) createdBy: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wms_receipt_lines')
@Index('idx_wms_lines_receipt', ['tenantId', 'receiptId'])
export class WmsReceiptLine {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'receipt_id', type: 'bigint' }) receiptId: number;
  @Column({ type: 'int' }) lineNo: number;
  @Column({ name: 'sku_id', type: 'bigint' }) skuId: number;
  @Column({ name: 'batch_no', type: 'varchar', length: 64, nullable: true }) batchNo: string | null;
  @Column({ name: 'qty_expected', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyExpected: string;
  @Column({ name: 'qty_received', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyReceived: string;
  @Column({ name: 'diff_type', type: 'varchar', length: 32, nullable: true }) diffType: string | null;
  @Column({ name: 'diff_qty', type: 'numeric', precision: 14, scale: 3, nullable: true, default: 0 }) diffQty: string | null;
  @Column({ type: 'varchar', length: 32, default: 'PENDING' }) status: string;
}

@Entity('wms_putaway_tasks')
@Index('idx_wms_putaway_status', ['tenantId', 'status'])
@Index('idx_wms_putaway_line', ['tenantId', 'receiptLineId'])
export class WmsPutawayTask {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'receipt_line_id', type: 'bigint' }) receiptLineId: number;
  @Column({ name: 'suggested_location_id', type: 'bigint', nullable: true }) suggestedLocationId: number | null;
  @Column({ name: 'actual_location_id', type: 'bigint', nullable: true }) actualLocationId: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 3 }) qty: string;
  @Column({ type: 'varchar', length: 32, default: 'CREATED' }) status: string;
  @Column({ name: 'operator_id', type: 'bigint', nullable: true }) operatorId: number | null;
  @Column({ name: 'recommend_reason', type: 'varchar', length: 300, nullable: true }) recommendReason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt: Date | null;
}

@Entity('wms_putaway_rules')
@Index('idx_wms_putaway_rules', ['tenantId', 'warehouseId', 'priority'])
export class WmsPutawayRule {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ type: 'int' }) priority: number;
  @Column({ name: 'condition_json', type: 'jsonb' }) conditionJson: Record<string, any>;
  @Column({ name: 'action_json', type: 'jsonb' }) actionJson: Record<string, any>;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
}
