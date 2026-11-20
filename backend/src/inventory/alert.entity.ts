// 呆滞 / 效期预警实体（alert 模块，docs/11 §11.16）
// ⚠️ 与 inventory.entity.ts 同约定：全局 SnakeNamingStrategy；numeric/bigint 列反射为 string，
//    服务层出参前 Number()。DDL: scripts/inventory_alert.sql。
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/** 预警规则（租户级）：库龄/效期阈值 + 严重级别阈值 + 最低数量过滤 */
@Entity('alert_rules')
@Index('ix_alert_rules_tenant', ['tenantId', 'active'])
export class AlertRule {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ length: 80 }) name: string;
  // 显式 type：字面量联合反射成 Object 会让 TypeORM 启动失败（同 ProductGroup.type）
  @Column({ type: 'varchar', length: 20, default: 'dead_stock' }) type: 'dead_stock' | 'expiring';
  @Column({ name: 'idle_days', type: 'int', default: 90 }) idleDays: number;
  @Column({ name: 'critical_days', type: 'int', default: 180 }) criticalDays: number;
  @Column({ name: 'expiry_days', type: 'int', default: 30 }) expiryDays: number;
  @Column({ name: 'min_qty', type: 'numeric', precision: 14, scale: 3, default: 0 }) minQty: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) category: string | null;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}

/** 预警事件：扫描落库，fingerprint 幂等去重；状态机 open -> ack / ignored */
@Entity('alert_events')
@Index('ix_alert_events_tenant', ['tenantId', 'status', 'createdAt'])
@Index('ix_alert_events_rule', ['tenantId', 'ruleId'])
export class AlertEvent {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  @Column({ name: 'rule_id', type: 'bigint' }) ruleId: number;
  @Column({ type: 'varchar', length: 20, default: 'dead_stock' }) type: 'dead_stock' | 'expiring';
  @Column({ length: 240 }) fingerprint: string;
  @Column({ name: 'material_id', type: 'bigint' }) materialId: number;
  @Column({ length: 40 }) code: string;
  @Column({ length: 120 }) name: string;
  @Column({ length: 120, type: 'varchar', nullable: true }) spec: string | null;
  @Column({ length: 20, default: '件' }) unit: string;
  @Column({ name: 'warehouse_id', type: 'bigint' }) warehouseId: number;
  @Column({ length: 80, type: 'varchar', nullable: true }) warehouse: string | null;
  @Column({ name: 'batch_no', length: 60, default: '' }) batchNo: string;
  @Column({ type: 'numeric', precision: 14, scale: 3, default: 0 }) qty: string;
  @Column({ name: 'age_days', type: 'int', default: 0 }) ageDays: number;
  @Column({ name: 'last_out_days', type: 'int', default: 0 }) lastOutDays: number;
  @Column({ name: 'days_to_expire', type: 'int', nullable: true }) daysToExpire: number | null;
  @Column({ type: 'varchar', length: 16, default: 'warning' }) severity: 'warning' | 'critical';
  @Column({ type: 'varchar', length: 16, default: 'open' }) status: 'open' | 'ack' | 'ignored';
  @Column({ name: 'ack_by', length: 80, type: 'varchar', nullable: true }) ackBy: string | null;
  @Column({ name: 'ack_note', length: 300, type: 'varchar', nullable: true }) ackNote: string | null;
  @Column({ name: 'ack_at', type: 'timestamp', nullable: true }) ackAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
