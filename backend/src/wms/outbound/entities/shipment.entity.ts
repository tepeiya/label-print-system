// WMS 阶段三实体（成品发运）
// DDL: backend/scripts/wms_p3_outbound.sql
// 约定：全部含 tenantId；数量 NUMERIC(14,3) 反射为 string，出参前 Number()（对齐 inventory / inbound 模块）。
// 所有列显式声明 type，避免 tsx（esbuild 不 emit design:type metadata）下单测 import 实体报错。
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('wms_shipments')
@Index('idx_wms_ship_tenant_status', ['tenantId', 'status'])
export class WmsShipment {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'shipment_no', type: 'varchar', length: 40 }) shipmentNo: string;
  @Column({ name: 'ship_type', type: 'varchar', length: 16, default: 'SALES' }) shipType: string;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'customer_code', type: 'varchar', length: 60, nullable: true }) customerCode: string | null;
  @Column({ name: 'customer_name', type: 'varchar', length: 120, nullable: true }) customerName: string | null;
  @Column({ name: 'ship_to', type: 'varchar', length: 300, nullable: true }) shipTo: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) carrier: string | null;
  @Column({ name: 'tracking_no', type: 'varchar', length: 120, nullable: true }) trackingNo: string | null;
  @Column({ name: 'expected_date', type: 'date', nullable: true }) expectedDate: string | null;
  @Column({ type: 'varchar', length: 12, default: 'CREATED' }) status: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) remark: string | null;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @Column({ name: 'picked_at', type: 'timestamptz', nullable: true }) pickedAt: Date | null;
  @Column({ name: 'shipped_by', type: 'bigint', nullable: true }) shippedBy: number | null;
  @Column({ name: 'shipped_at', type: 'timestamptz', nullable: true }) shippedAt: Date | null;
  @Column({ name: 'signed_by', type: 'bigint', nullable: true }) signedBy: number | null;
  @Column({ name: 'signed_receiver', type: 'varchar', length: 80, nullable: true }) signedReceiver: string | null;
  @Column({ name: 'signed_at', type: 'timestamptz', nullable: true }) signedAt: Date | null;
  @Column({ name: 'cancelled_by', type: 'bigint', nullable: true }) cancelledBy: number | null;
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true }) cancelledAt: Date | null;
  @Column({ name: 'cancel_reason', type: 'varchar', length: 200, nullable: true }) cancelReason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity('wms_shipment_lines')
@Index('idx_wms_ship_line_doc', ['tenantId', 'shipmentId'])
export class WmsShipmentLine {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'shipment_id', type: 'bigint' }) shipmentId: number;
  @Column({ name: 'line_no', type: 'int' }) lineNo: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'sku_code', type: 'varchar', length: 40 }) skuCode: string;
  @Column({ name: 'batch_no', type: 'varchar', length: 60, nullable: true }) batchNo: string | null;
  @Column({ name: 'location_id', type: 'bigint', nullable: true }) locationId: number | null;
  @Column({ name: 'pack_sscc', type: 'varchar', length: 20, nullable: true }) packSscc: string | null;
  @Column({ name: 'udi_codes', type: 'jsonb', nullable: true }) udiCodes: string[] | null;
  @Column({ name: 'qty_plan', type: 'numeric', precision: 14, scale: 3 }) qtyPlan: string;
  @Column({ name: 'qty_picked', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyPicked: string;
  @Column({ name: 'qty_shipped', type: 'numeric', precision: 14, scale: 3, default: 0 }) qtyShipped: string;
  @Column({ name: 'qty_before', type: 'numeric', precision: 14, scale: 3, nullable: true }) qtyBefore: string | null;
  @Column({ name: 'qty_after', type: 'numeric', precision: 14, scale: 3, nullable: true }) qtyAfter: string | null;
  @Column({ type: 'varchar', length: 12, default: 'PENDING' }) status: string;
  @Column({ name: 'udi_result', type: 'jsonb', nullable: true }) udiResult: Record<string, any> | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) error: string | null;
  @Column({ name: 'picked_at', type: 'timestamptz', nullable: true }) pickedAt: Date | null;
  @Column({ name: 'shipped_at', type: 'timestamptz', nullable: true }) shippedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
