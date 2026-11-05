// 白标（D6）实体：tenant_domains 表（P0 预留，补列见 scripts/saas_p6_branding.sql）
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('tenant_domains')
@Index('ix_tenant_domains_tid', ['tenantId'])
export class TenantDomain {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'bigint' }) tenantId: number;
  /** 规范化后的小写域名（不含端口、不含尾部点） */
  @Column({ length: 200, unique: true }) domain: string;
  /** 只有 true 才参与 Host → 租户解析；抢注防护全押在这一个字段上 */
  @Column({ default: false }) verified: boolean;
  /** 登记时生成，客户把它写进 TXT 记录后才算证明域名归他 */
  @Column({ name: 'verify_token', type: 'varchar', length: 64, nullable: true }) verifyToken: string | null;
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true }) verifiedAt: Date | null;
  /** 多域名时优先展示哪个（只影响展示口径，不影响解析） */
  @Column({ name: 'is_primary', default: false }) isPrimary: boolean;
  @Column({ name: 'created_by', type: 'bigint', nullable: true }) createdBy: number | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
