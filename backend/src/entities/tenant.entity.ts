// 租户 / 用户 / 角色 实体（tenant_id 强制行级隔离）
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn() id: number;
  @Column({ length: 120 }) name: string;
  @Column({ length: 60, unique: true }) code: string;
  @Column({ default: 1 }) status: number;
  @Column('jsonb', { default: {} }) settings: Record<string, any>;
  // ---- SaaS P0 扩展（docs/11 §11.5.2；DDL 见 backend/scripts/saas_p0_roles.sql）----
  // status 仍是 SMALLINT 开关（1 启用 / 0 禁用），订阅生命周期放 subscriptions.status
  @Column({ name: 'type', type: 'varchar', length: 20, default: 'shared' }) type: 'shared' | 'dedicated';
  // 显式 type 是必须的：TS 联合类型（number | null）反射出来是 Object，
  // TypeORM 猜不到列类型会在启动时报 DataTypeNotSupportedError
  @Column({ name: 'plan_id', type: 'bigint', nullable: true }) planId: number | null;
  @Column({ name: 'trial_ends_at', type: 'timestamptz', nullable: true }) trialEndsAt: Date | null;
  @Column({ name: 'seat_limit', default: 5 }) seatLimit: number;
  @Column({ type: 'jsonb', default: () => '{}' }) branding: Record<string, any>;
  /** D12：canceled 后 90 天硬删，删除任务读这个字段 */
  @Column({ name: 'canceled_at', type: 'timestamptz', nullable: true }) canceledAt: Date | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id: number;
  @Index() @Column({ name: 'tenant_id' }) tenantId: number;   // 租户隔离字段
  @Column({ length: 60 }) username: string;
  @Column({ length: 160, nullable: true }) email: string;
  @Column({ name: 'password_hash', length: 100 }) passwordHash: string;
  @Column({ length: 80, nullable: true }) displayName: string;
  @Column({ default: 1 }) status: number;
  @CreateDateColumn({ name: 'last_login_at', nullable: true }) lastLoginAt: Date;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('user_roles')
@Index('ix_user_roles_tenant_user', ['tenantId', 'userId'])
export class UserRole {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'user_id' }) userId: number;
  @Column({ length: 30 }) role: string;
  /** §11.12.2 两步迁移：新数据写 role_id，role 字符串兼容期保留一个版本 */
  @Column({ name: 'role_id', type: 'bigint', nullable: true }) roleId: number | null;
  @CreateDateColumn() createdAt: Date;
}

@Entity('refresh_tokens')
@Index('ix_refresh_tokens_tenant_user', ['tenantId', 'userId'])
export class RefreshToken {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id' }) tenantId: number;
  @Column({ name: 'user_id' }) userId: number;
  @Column({ name: 'token_hash', length: 100, unique: true }) tokenHash: string;
  @Column({ name: 'expires_at' }) expiresAt: Date;
  @Column({ default: false }) revoked: boolean;
  @CreateDateColumn() createdAt: Date;
}
