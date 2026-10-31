// 租户 / 用户 / 角色 实体（tenant_id 强制行级隔离）
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn() id: number;
  @Column({ length: 120 }) name: string;
  @Column({ length: 60, unique: true }) code: string;
  @Column({ default: 1 }) status: number;
  @Column('jsonb', { default: {} }) settings: Record<string, any>;
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
