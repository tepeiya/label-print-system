import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * 平台侧审计（P2）。与租户 audit_logs 分开：audit_logs.tenant_id 有 FK，
 * 平台动作（登录/开通/停用/改套餐）没有租户上下文，写 0 会撞 FK。
 */
@Entity('platform_audit_logs')
@Index('ix_plataudit_time', ['createdAt'])
export class PlatformAuditLog {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'actor_id' }) actorId: number;
  @Column({ name: 'actor_name', length: 60, default: '' }) actorName: string;
  @Column({ length: 60 }) action: string;
  @Column('jsonb', { default: {} }) detail: Record<string, any>;
  @Column({ name: 'target_type', length: 40, nullable: true }) targetType?: string;
  @Column({ name: 'target_id', nullable: true }) targetId?: number;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}

@Injectable()
export class PlatformAuditService {
  constructor(@InjectRepository(PlatformAuditLog) private repo: Repository<PlatformAuditLog>) {}

  write(actor: { id: number; username?: string }, action: string, detail: Record<string, any> = {}, targetType?: string, targetId?: number) {
    return this.repo.save({
      actorId: actor.id, actorName: actor.username ?? '', action, detail, targetType, targetId,
    }).catch((e) => { console.warn('[platform-audit] 写入失败（不阻断主链路）', e.message); });
  }

  /** 最近审计（运营后台「平台审计」页；P3 再加分页/过滤） */
  list(limit = 200) {
    return this.repo.find({ order: { createdAt: 'DESC' }, take: Math.min(1000, limit) });
  }
}
