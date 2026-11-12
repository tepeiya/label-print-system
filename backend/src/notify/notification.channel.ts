// =============================================================================
// notification.channel.ts —— 通知通道接口与站内信实现（B2.5）
//
// 【为什么先做接口】docs/10 §10.19.5 把「邮件/飞书/短信」列为 P3/P5 的共同前置，
// 但今天只落地站内信。如果 Service 直接写死 Repository，以后每加一个通道都要改
// 发布逻辑（还容易把「站内信已写成功」和「邮件发失败」混在一次事务里）。
//
// 【分层】
//   - InAppChannel：默认通道，**必须成功**，负责落库 + dedupe_key 幂等；
//   - NotificationChannel：外部通道扩展点，失败只记日志、绝不影响站内信与业务主流程；
//   - ChannelRegistry：注册中心，加邮件只需实现接口并在 NotifyModule 里 register 一行。
// =============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './notification.entity';

export interface NotificationMessage {
  tenantId: number;
  /** NULL = 全租户广播 */
  userId?: number | null;
  category: string;
  title: string;
  body: string;
  /** 同一事件的稳定键；带它才具备幂等，重复投递只落一行 */
  dedupeKey?: string | null;
  metadata?: Record<string, any>;
}

export interface ChannelDelivery {
  channel: string;
  ok: boolean;
  detail?: string;
}

/** 外部通道扩展点（邮件 / 飞书 / 短信 / Webhook） */
export interface NotificationChannel {
  readonly kind: string;
  /** savedId 是已落库的站内信 id，外部通道可据此带跳转链接 */
  send(msg: NotificationMessage, savedId: number): Promise<ChannelDelivery>;
}

export interface SaveResult {
  row: Notification;
  /** true = 命中去重，本次未新增（不是错误） */
  duplicate: boolean;
}

/** PostgreSQL 唯一约束冲突码（uq_notif_dedupe 兜并发） */
function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && String((e as any).code ?? '') === '23505';
}

@Injectable()
export class InAppChannel {
  private logger = new Logger('InAppChannel');

  constructor(
    @InjectRepository(Notification) private repo: Repository<Notification>,
  ) {}

  /**
   * 落库（带幂等）。先查后写 + 唯一索引兜底：
   * 并发下两个进程可能同时查空，第二个 insert 会撞 23505，此时回查返回 duplicate。
   */
  async save(msg: NotificationMessage): Promise<SaveResult> {
    const dedupeKey = msg.dedupeKey ? String(msg.dedupeKey).slice(0, 160) : null;
    if (dedupeKey) {
      // 显式带 tenant_id：dedupe 键只在租户内唯一，绝不跨租户误判
      const exists = await this.repo.findOne({ where: { tenantId: msg.tenantId, dedupeKey } });
      if (exists) return { row: exists, duplicate: true };
    }
    try {
      const row = await this.repo.save(this.repo.create({
        tenantId: msg.tenantId,
        userId: msg.userId ?? null,
        category: String(msg.category ?? 'system').slice(0, 40),
        title: String(msg.title ?? '').slice(0, 200),
        body: String(msg.body ?? ''),
        dedupeKey,
        channel: 'in_app',
        metadata: msg.metadata ?? {},
        readAt: null,
      }));
      return { row, duplicate: false };
    } catch (e) {
      if (dedupeKey && isUniqueViolation(e)) {
        const row = await this.repo.findOne({ where: { tenantId: msg.tenantId, dedupeKey } });
        if (row) return { row, duplicate: true };
        this.logger.warn(`dedupe 冲突但回查未命中 tenant=${msg.tenantId} key=${dedupeKey}`);
      }
      throw e;
    }
  }
}

@Injectable()
export class ChannelRegistry {
  private channels: NotificationChannel[] = [];

  /** 扩展点：新增邮件/飞书通道时在 NotifyModule 的 onModuleInit 里 register */
  register(channel: NotificationChannel): void {
    if (this.channels.some((c) => c.kind === channel.kind)) return;
    this.channels.push(channel);
  }

  all(): NotificationChannel[] {
    return [...this.channels];
  }
}
