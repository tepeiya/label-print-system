// 站内信实体（B2.5）。DDL: backend/scripts/saas_p7_notifications.sql
// ⚠️ 所有读写必须显式带 tenant_id（docs/11 §11.14 多租户红线）。
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from 'typeorm';

@Entity('notifications')
@Index('ix_notif_tenant_user_read', ['tenantId', 'userId', 'readAt'])
export class Notification {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** NULL = 全租户广播；非 NULL = 定向到某个用户 */
  @Column({ name: 'user_id', type: 'bigint', nullable: true }) userId: number | null;
  @Column({ length: 40 }) category: string;
  @Column({ length: 200 }) title: string;
  @Column({ type: 'text', default: '' }) body: string;
  @Column({ name: 'dedupe_key', length: 160, nullable: true }) dedupeKey: string | null;
  @Column({ length: 20, default: 'in_app' }) channel: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) metadata: Record<string, any>;
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true }) readAt: Date | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
