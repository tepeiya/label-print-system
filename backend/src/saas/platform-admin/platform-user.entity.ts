import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * 平台运营账号（P2，docs/11 §11.4 L0 / §11.6.2）。
 * 与租户的 users 表完全隔离：platform_users 只能登录 /platform/auth/login，
 * 拿到 scope='platform' 的 JWT；租户侧 JWT 进不了运营接口，反之亦然。
 */
@Entity('platform_users')
export class PlatformUser {
  @PrimaryGeneratedColumn() id: number;
  @Column({ length: 60, unique: true }) username: string;
  @Column({ name: 'password_hash', length: 100 }) passwordHash: string;
  @Column({ name: 'display_name', length: 60, default: '' }) displayName: string;
  /** super / operator（L0） */
  @Column({ length: 20, default: 'operator' }) role: string;
  @Column({ default: 1 }) status: number;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
}
