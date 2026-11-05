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
  @Column({ name: 'depends_on', type: 'text', array: true, default: () => '{}' }) dependsOn: string[];
  @Column({ name: 'trial_days', default: 14 }) trialDays: number;
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
  // P3 计费：月费（分）。0 = 免费/未定价（saas_p3_billing.sql）
  @Column({ name: 'price_cents', type: 'bigint', default: 0 }) priceCents: number;
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
  source: 'plan' | 'purchase' | 'addon' | 'trial' | 'gift' | 'manual';
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
  @Column({ length: 80, default: '' }) name: string;
  @Column({ name: 'is_high_risk', default: false }) isHighRisk: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 角色 → 权限（4 个固定角色：admin/operator/sql/viewer）
// 兼容期仍以 role 字符串为主键，role_id 为 §11.12.2 预留列
// ============================================================
@Entity('role_permissions')
export class RolePermission {
  @PrimaryColumn({ length: 30 }) role: string;
  @PrimaryColumn({ name: 'permission_code', length: 60 }) permissionCode: string;
  @Column({ name: 'role_id', type: 'bigint', nullable: true }) roleId: number | null;
}

// ============================================================
// 角色（tenant_id IS NULL = 系统内置模板角色，§11.12.2 第 1 步）
// 唯一性由 DDL 保证：UNIQUE (tenant_id, code) + partial index uq_role_system_code
// ============================================================
@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint', nullable: true }) tenantId: number | null;
  @Column({ length: 40 }) code: string;
  @Column({ length: 60 }) name: string;
  @Column({ name: 'is_system', default: false }) isSystem: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

// ============================================================
// 数据范围（L3，§11.4.5）
// ============================================================
@Entity('data_scopes')
export class DataScopeRecord {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  // 联合字面量类型同样反射不出列类型，必须显式写 type
  @Column({ name: 'subject_type', type: 'varchar', length: 10 }) subjectType: 'user' | 'role' | 'agent';
  @Column({ name: 'subject_id', type: 'bigint' }) subjectId: number;
  @Column({ name: 'scope_type', type: 'varchar', length: 20 }) scopeType: 'all' | 'dept' | 'warehouse' | 'self';
  @Column({ name: 'scope_value', type: 'varchar', length: 60, nullable: true }) scopeValue: string | null;
}

// ============================================================
// 功能开关（D7：agent.print.submit 默认关闭，灰度用）
// ============================================================
@Entity('feature_flags')
export class FeatureFlag {
  @PrimaryColumn({ name: 'tenant_id' }) tenantId: number;
  @PrimaryColumn({ length: 60 }) key: string;
  @Column({ default: false }) enabled: boolean;
  @Column({ type: 'jsonb', default: () => '{}' }) rollout: Record<string, any>;
}
