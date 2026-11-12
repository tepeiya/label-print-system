// =============================================================================
// MaintenanceService —— B2.4 三个定时任务的实际执行体
//
// ⚠️ 多租户红线说明（docs/11 §11.14）：业务接口一律「显式带 tenant_id 查本租户」。
// 这里是**平台级运维任务**，必须跨租户扫描候选集，属于受控例外：
//   1. 扫描结果不返回给任何终端用户，只进进程内日志与聚合计数；
//   2. 每条写回（站内信）都显式携带 tenant_id，由 NotificationService 二次校验；
//   3. 审批回写按主键批量置状态，不引入任何租户参数；幂等清理按时间，与租户无关。
//   4. 判定逻辑全部在 schedule.calc.ts 纯函数，service 只做 IO（可单测的是判定，不是 SQL）。
// =============================================================================
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from '../entities/saas.entity';
import { AgentApproval, ToolIdempotency } from '../agent/agent.entity';
import { NotificationService } from '../notify/notification.service';
import {
  APPROVAL_SWEEP_BATCH, DAY_MS, RENEWAL_REMIND_DAYS,
  expiredApprovalIds, idempotencyCutoff, renewalReminderPlan,
} from './schedule.calc';

/** 幂等清理单批上限与最大批数：避免一次 DELETE 长事务锁表 */
const CLEANUP_BATCH = 2000;
const CLEANUP_MAX_BATCHES = 20;

export interface JobReport {
  job: string;
  at: string;
  [k: string]: any;
}

@Injectable()
export class MaintenanceService {
  private logger = new Logger('MaintenanceService');

  constructor(
    @InjectRepository(Subscription) private subs: Repository<Subscription>,
    @InjectRepository(AgentApproval) private approvals: Repository<AgentApproval>,
    @InjectRepository(ToolIdempotency) private idem: Repository<ToolIdempotency>,
    private notifications: NotificationService,
  ) {}

  /** 订阅到期前 7 天：逐租户发站内信（dedupeKey 保证一天只发一次） */
  async runRenewalReminders(now: Date = new Date()): Promise<JobReport> {
    const until = new Date(now.getTime() + RENEWAL_REMIND_DAYS * DAY_MS);
    const rows = await this.subs.createQueryBuilder('s')
      .select(['s.id', 's.tenantId', 's.status', 's.endsAt'])
      .where('s.status IN (:...statuses)', { statuses: ['active', 'trial'] })
      .andWhere('s.ends_at IS NOT NULL')
      .andWhere('s.ends_at >= :now', { now })
      .andWhere('s.ends_at <= :until', { until })
      .getMany();
    const plan = renewalReminderPlan(
      rows.map((r) => ({ tenantId: Number(r.tenantId), status: r.status, endsAt: r.endsAt })), now,
    );
    let sent = 0;
    let deduped = 0;
    for (const p of plan) {
      const r = await this.notifications.publish({
        tenantId: p.tenantId,           // 显式租户，绝不由任务批量上下文隐式推断
        category: p.category,
        title: p.title,
        body: p.body,
        dedupeKey: p.dedupeKey,
        metadata: p.metadata,
      });
      if (r.created) sent += 1; else deduped += 1;
    }
    const report = {
      job: 'subscription.renewal_reminder', at: now.toISOString(),
      scanned: rows.length, candidates: plan.length, sent, deduped,
    };
    this.logger.log(`续费提醒: ${JSON.stringify(report)}`);
    return report;
  }

  /** 审批过期批量回写：把读时判定（approval.calc.isStale）同步到库里，列表状态才一致 */
  async runApprovalSweep(now: Date = new Date()): Promise<JobReport> {
    const rows = await this.approvals.createQueryBuilder('a')
      .select(['a.id', 'a.status', 'a.expiresAt'])
      .where('a.status IN (:...statuses)', { statuses: ['pending', 'approved'] })
      .andWhere('a.expires_at <= :now', { now })
      .orderBy('a.expires_at', 'ASC')
      .take(APPROVAL_SWEEP_BATCH)
      .getMany();
    const ids = expiredApprovalIds(
      rows.map((r) => ({ id: Number(r.id), status: r.status, expiresAt: r.expiresAt })), now,
    );
    let updated = 0;
    if (ids.length) {
      const r = await this.approvals.createQueryBuilder()
        .update(AgentApproval)
        .set({ status: 'expired' })
        .whereInIds(ids)
        .execute();
      updated = r.affected ?? 0;
    }
    const report = {
      job: 'approval.expire_sweep', at: now.toISOString(),
      scanned: rows.length, eligible: ids.length, updated,
    };
    this.logger.log(`审批过期回写: ${JSON.stringify(report)}`);
    return report;
  }

  /** tool_idempotency TTL 清理：分批删，避免长事务；正好 30 天边界归 schedule.calc 管 */
  async runIdempotencyCleanup(now: Date = new Date()): Promise<JobReport> {
    const cutoff = idempotencyCutoff(now);
    let deleted = 0;
    let batches = 0;
    for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
      const page = await this.idem.createQueryBuilder('t')
        .select('t.id')
        .where('t.created_at <= :cutoff', { cutoff })
        .orderBy('t.id', 'ASC')
        .take(CLEANUP_BATCH)
        .getMany();
      if (!page.length) break;
      const r = await this.idem.createQueryBuilder()
        .delete()
        .from(ToolIdempotency)
        .whereInIds(page.map((x) => x.id))
        .execute();
      const n = r.affected ?? 0;
      deleted += n;
      batches += 1;
      if (n < CLEANUP_BATCH) break;   // 已删完
    }
    const report = {
      job: 'idempotency.ttl_cleanup', at: now.toISOString(),
      cutoff: cutoff.toISOString(), deleted, batches, batchSize: CLEANUP_BATCH,
    };
    this.logger.log(`幂等 TTL 清理: ${JSON.stringify(report)}`);
    return report;
  }
}
