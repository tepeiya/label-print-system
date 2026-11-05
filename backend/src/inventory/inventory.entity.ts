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
  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 }) qty: string;
  @Column({ name: 'unit_cost_cents', type: 'bigint', nullable: true }) unitCostCents: string | null;
  @Column({ name: 'produced_at', type: 'date', nullable: true }) producedAt: string | null;
  @Column({ name: 'expires_at', type: 'date', nullable: true }) expiresAt: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
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
