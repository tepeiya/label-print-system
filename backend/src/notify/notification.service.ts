// =============================================================================
// NotificationService —— 发布 / 查询 / 已读（B2.5 站内信通道）
//
// 红线：所有查询与更新**显式带 tenant_id**，绝不从前端参数决定数据范围。
// 发布失败不抛给业务主流程（通知是旁路能力），但会记日志，便于运维发现通道故障。
// =============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './notification.entity';
import {
  ChannelDelivery, ChannelRegistry, InAppChannel, NotificationMessage,
} from './notification.channel';

export interface PublishResult {
  created: boolean;
  duplicate: boolean;
  id: number | null;
  deliveries: ChannelDelivery[];
}

export interface ListOptions {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class NotificationService {
  private logger = new Logger('NotificationService');

  constructor(
    @InjectRepository(Notification) private repo: Repository<Notification>,
    private inApp: InAppChannel,
    private channels: ChannelRegistry,
  ) {}

  /**
   * 发布一条通知。站内信必须先落库成功；外部通道（邮件/飞书/…）是 best-effort，
   * 任一失败只记日志，不影响已落库的站内信，也不抛给调用方（定时任务不该被邮件拖垮）。
   */
  async publish(msg: NotificationMessage): Promise<PublishResult> {
    if (!Number.isFinite(Number(msg.tenantId)) || Number(msg.tenantId) <= 0) {
      throw new Error('publish(): tenantId 必填且必须为正数（多租户红线）');
    }
    const saved = await this.inApp.save(msg);
    if (saved.duplicate) return { created: false, duplicate: true, id: saved.row.id, deliveries: [] };

    const deliveries = await Promise.all(this.channels.all().map(async (c) => {
      try {
        return await c.send(msg, saved.row.id);
      } catch (e) {
        this.logger.warn(`外部通道 ${c.kind} 投递失败（站内信已保存）: ${(e as Error).message}`);
        return { channel: c.kind, ok: false, detail: (e as Error).message } as ChannelDelivery;
      }
    }));
    return { created: true, duplicate: false, id: saved.row.id, deliveries };
  }

  /** 租户内可见：定向给自己的 + 全租户广播；显式 tenant_id 过滤 */
  async list(tenantId: number, userId: number, opts: ListOptions = {}) {
    const page = Math.max(1, Math.floor(Number(opts.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(opts.pageSize) || 20)));
    const qb = this.repo.createQueryBuilder('n')
      .where('n.tenant_id = :tenantId', { tenantId })
      .andWhere('(n.user_id = :userId OR n.user_id IS NULL)', { userId });
    if (opts.unreadOnly) qb.andWhere('n.read_at IS NULL');
    const [items, total] = await qb
      .orderBy('n.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { items, total, page, pageSize };
  }

  /** 未读数（角标用）；异常不影响页面渲染，由调用方兜底 */
  async unreadCount(tenantId: number, userId: number): Promise<number> {
    return this.repo.createQueryBuilder('n')
      .where('n.tenant_id = :tenantId', { tenantId })
      .andWhere('(n.user_id = :userId OR n.user_id IS NULL)', { userId })
      .andWhere('n.read_at IS NULL')
      .getCount();
  }

  /** 标已读：带 tenant_id + 归属条件，杜绝跨租户/跨用户越权改写 */
  async markRead(tenantId: number, userId: number, id: number): Promise<boolean> {
    const r = await this.repo.createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('id = :id', { id })
      .andWhere('tenant_id = :tenantId', { tenantId })
      .andWhere('(user_id = :userId OR user_id IS NULL)', { userId })
      .andWhere('read_at IS NULL')
      .execute();
    return (r.affected ?? 0) > 0;
  }

  /** 全部标已读 */
  async markAllRead(tenantId: number, userId: number): Promise<number> {
    const r = await this.repo.createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('tenant_id = :tenantId', { tenantId })
      .andWhere('(user_id = :userId OR user_id IS NULL)', { userId })
      .andWhere('read_at IS NULL')
      .execute();
    return r.affected ?? 0;
  }
}
