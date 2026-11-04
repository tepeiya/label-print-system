// SaaS P0 实体：模块目录 / 套餐 / 套餐-模块 / 订阅 / 租户模块 / 权限字典 / 角色权限
// 全部放在 public schema（docs/11-saas-and-agent-architecture.md DDL 已手动执行）
import { Entity, PrimaryColumn, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';

// ============================================================
// 模块目录（全局共享，单例表）
// 类名用 ModuleRecord 避免和 NestJS @Module 装饰器命名冲突
// ============================================================
@Entity('modules')
export class ModuleRecord {
  @PrimaryColumn({ length: 40 }) code: string;
  @Column({ length: 80 }) name: string;
  @Column({ length: 300, nullable: true }) description: string;
  @Column({ length: 40, nullable: true }) icon: string;
  @Column({ name: 'sort_order', default: 0 }) sortOrder: number;
  @Column({ name: 'is_core', default: false }) isCore: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 套餐（BASIC / PRO / ENTERPRISE）
// ============================================================
@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn() id: number;
  @Column({ length: 40, unique: true }) code: string;
  @Column({ length: 80 }) name: string;
  @Column({ length: 500, nullable: true }) description: string;
  @Column({ name: 'sort_order', default: 0 }) sortOrder: number;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 套餐 → 模块 关联
// ============================================================
@Entity('plan_modules')
@Index('ix_pm_plan_module', ['planId', 'moduleCode'], { unique: true })
export class PlanModule {
  @PrimaryColumn({ name: 'plan_id' }) planId: number;
  @PrimaryColumn({ name: 'module_code', length: 40 }) moduleCode: string;
  @ManyToOne(() => Plan, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'plan_id' }) plan: Plan;
}

// ============================================================
// 订阅（每个租户当前激活的套餐）
// ============================================================
@Entity('subscriptions')
@Index('ix_sub_tenant_status', ['tenantId', 'status'])
export class Subscription {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'plan_id' }) planId: number;
  @Column({
    type: 'varchar',
    length: 20,
    default: 'active',
  })
  status: 'trial' | 'active' | 'canceled' | 'expired';
  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'NOW()' }) startedAt: Date;
  @Column({ name: 'ends_at', type: 'timestamptz', nullable: true }) endsAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 租户实际开通的模块（从订阅展开）
// ============================================================
@Entity('tenant_modules')
@Index('ix_tmod_tenant_status', ['tenantId', 'status'])
export class TenantModule {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'module_code', length: 40 }) moduleCode: string;
  @Column({
    type: 'varchar',
    length: 20,
    default: 'active',
  })
  status: 'trial' | 'active' | 'expired' | 'disabled';
  @Column({
    type: 'varchar',
    length: 20,
    default: 'plan',
  })
  source: 'plan' | 'purchase' | 'trial' | 'gift' | 'manual';
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 权限字典（形如 print:job:read）
// ============================================================
@Entity('permissions')
export class Permission {
  @PrimaryColumn({ length: 60 }) code: string;
  @Column({ name: 'module_code', length: 40 }) moduleCode: string;
  @Column({ length: 40 }) resource: string;
  @Column({ length: 20 }) action: string;
  @Column({ length: 200, nullable: true }) description: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 角色 → 权限（4 个固定角色：admin/operator/sql/viewer）
// ============================================================
@Entity('role_permissions')
export class RolePermission {
  @PrimaryColumn({ length: 30 }) role: string;
  @PrimaryColumn({ name: 'permission_code', length: 60 }) permissionCode: string;
}
