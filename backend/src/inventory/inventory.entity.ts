// 库存最小读模型实体（P4，docs/11 §11.7 只读工具数据面）
// ⚠️ 命名沿用全局 SnakeNamingStrategy；numeric 列 TypeORM 反射为 string（pg 返回字符串），
//    服务层出参前用 Number() 转换——与 P3 billing 实体同一约定。
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('warehouses')
@Index('ix_warehouses_tenant', ['tenantId'])
export class Warehouse {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 40 }) code: string;
  @Column({ length: 80 }) name: string;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** 仓库库位（DDL: scripts/inventory_masterdata.sql） */
@Entity('warehouse_locations')
@Index('ix_wlocations_warehouse', ['tenantId', 'warehouseId'])
export class WarehouseLocation {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ length: 40 }) code: string;
  @Column({ length: 80 }) name: string;
  @Column({ length: 40, type: 'varchar', nullable: true }) zone: string | null;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** 产品分组（品牌 / 供应商 / 自定义，DDL: scripts/inventory_product_groups.sql） */
@Entity('product_groups')
@Index('ix_product_groups_tenant', ['tenantId', 'type'])
export class ProductGroup {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 40 }) code: string;
  @Column({ length: 120 }) name: string;
  // 显式 type：字面量联合反射成 Object 会让 TypeORM 启动失败
  @Column({ type: 'varchar', length: 20, default: 'custom' }) type: 'brand' | 'supplier' | 'custom';
  @Column({ name: 'default_warehouse_id', type: 'bigint', nullable: true }) defaultWarehouseId: number | null;
  @Column({ name: 'default_location_id', type: 'bigint', nullable: true }) defaultLocationId: number | null;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('materials')
@Index('ix_materials_tenant', ['tenantId'])
export class Material {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 40 }) code: string;
  @Column({ length: 120 }) name: string;
  // 显式 type：TS 联合类型（string | null）反射成 Object，TypeORM 启动会报 DataTypeNotSupportedError
  @Column({ length: 120, type: 'varchar', nullable: true }) spec: string | null;
  @Column({ length: 20, default: '件' }) unit: string;
  @Column({ length: 60, type: 'varchar', nullable: true }) category: string | null;
  @Column({ name: 'safety_stock', type: 'numeric', precision: 14, scale: 3, default: 0 }) safetyStock: string;
  @Column({ name: 'template_id', type: 'bigint', nullable: true }) templateId: number | null;
  @Column({ name: 'group_id', type: 'bigint', nullable: true }) groupId: number | null;
  @Column({ name: 'auto_print', default: false }) autoPrint: boolean;
  @Column({ name: 'printer_id', type: 'bigint', nullable: true }) printerId: number | null;
  @Column({ name: 'default_warehouse_id', type: 'bigint', nullable: true }) defaultWarehouseId: number | null;
  @Column({ name: 'default_location_id', type: 'bigint', nullable: true }) defaultLocationId: number | null;
  // U5.1：GS1 GTIN14（UDI 联动比对用）；udi_required=true 时收货/发料必须扫 UDI 码
  @Column({ length: 14, type: 'varchar', nullable: true }) gtin: string | null;
  @Column({ name: 'udi_required', default: false }) udiRequired: boolean;
  // 自定义字段值（fieldKey -> value），字段定义在 material_field_definitions
  @Column('jsonb', { name: 'custom_fields', default: {} }) customFields: Record<string, any>;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/** 物料多 GTIN（单品/中包/托盘）。DDL: scripts/wms_u5_material_gtins.sql */
@Entity('material_gtins')
@Index('ix_material_gtins_material', ['tenantId', 'materialId'])
export class MaterialGtin {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ length: 14, type: 'varchar' }) gtin: string;
  @Column({ name: 'pack_level', type: 'varchar', length: 8, default: 'UNIT' }) packLevel: 'UNIT' | 'CARTON' | 'PALLET';
  @Column({ name: 'is_primary', default: false }) isPrimary: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

/**
 * 产品自定义字段定义（租户级）。DDL: scripts/inventory_material_custom_fields.sql
 * type 必须显式声明，避免字面量联合反射成 Object 让 TypeORM 启动失败（同 ProductGroup.type）。
 */
@Entity('material_field_definitions')
@Index('ix_mfielddefs_tenant', ['tenantId', 'sortOrder'])
export class MaterialFieldDefinition {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'field_key', length: 40 }) fieldKey: string;
  @Column({ length: 60 }) label: string;
  @Column({ type: 'varchar', length: 16, default: 'text' }) type: 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'boolean';
  @Column({ default: false }) required: boolean;
  @Column('jsonb', { default: [] }) options: string[];
  @Column({ name: 'sort_order', type: 'int', default: 0 }) sortOrder: number;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('stock_batches')
@Index('ix_stock_batches_tenant', ['tenantId'])
export class StockBatch {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'batch_no', length: 60 }) batchNo: string;
  @Column({ name: 'location_id', type: 'bigint', nullable: true }) locationId: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 }) qty: string;
  @Column({ name: 'unit_cost_cents', type: 'bigint', nullable: true }) unitCostCents: string | null;
  @Column({ name: 'produced_at', type: 'date', nullable: true }) producedAt: string | null;
  @Column({ name: 'expires_at', type: 'date', nullable: true }) expiresAt: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

/** 出入库台账：每次库存变动按批次落一行（DDL: scripts/inventory_stock_moves.sql） */
@Entity('stock_moves')
@Index('ix_stock_moves_tenant_time', ['tenantId', 'createdAt'])
export class StockMove {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'move_no', length: 40 }) moveNo: string;
  // 显式 type：字面量联合反射成 Object 会让 TypeORM 启动失败（同 Bom.status）
  @Column({ type: 'varchar', length: 10 }) kind: 'in' | 'out' | 'transfer';
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ name: 'to_warehouse_id', type: 'bigint', nullable: true }) toWarehouseId: number | null;
  @Column({ name: 'batch_no', length: 60 }) batchNo: string;
  @Column({ name: 'location_id', type: 'bigint', nullable: true }) locationId: number | null;
  @Column({ type: 'numeric', precision: 14, scale: 3 }) qty: string;
  @Column({ name: 'before_qty', type: 'numeric', precision: 14, scale: 3 }) beforeQty: string;
  @Column({ name: 'after_qty', type: 'numeric', precision: 14, scale: 3 }) afterQty: string;
  @Column({ length: 200 }) reason: string;
  @Column({ length: 80 }) operator: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('boms')
@Index('ix_boms_tenant', ['tenantId'])
export class Bom {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'product_material_id', type: 'bigint' }) productMaterialId: number;
  @Column({ name: 'version', length: 20, default: 'v1' }) version: string;
  // 联合字面量类型同样反射成 Object，必须显式 type（见文件头注释）
  @Column({ type: 'varchar', length: 20, default: 'active' }) status: 'draft' | 'active' | 'inactive';
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Entity('bom_items')
@Index('ix_bom_items_bom', ['bomId'])
export class BomItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'bom_id', type: 'bigint' }) bomId: number;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ name: 'qty_per', type: 'numeric', precision: 14, scale: 6 }) qtyPer: string;
  @Column({ name: 'loss_rate', type: 'numeric', precision: 6, scale: 4, default: 0 }) lossRate: string;
}
