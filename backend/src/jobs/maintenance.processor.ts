// =============================================================================
// MaintenanceProcessor —— BullMQ 维护队列消费端（B2.4）
// 与 PrintProcessor 同款：@Processor 在 API 进程与 worker 进程都会起 Worker，
// BullMQ 保证同一个 job 只被一个 Worker 消费，不会重复执行。
// 分发只认 MAINTENANCE_JOBS 里登记的名字，未知 job 记 warn 并跳过（不抛错，避免死信刷屏）。
// =============================================================================
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MAINTENANCE_QUEUE, isKnownJob } from './schedule.calc';
import { MaintenanceService, JobReport } from './maintenance.service';

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private logger = new Logger('MaintenanceProcessor');

  constructor(private maintenance: MaintenanceService) { super(); }

  async process(job: Job): Promise<JobReport | { skipped: boolean; reason: string }> {
    if (!isKnownJob(job.name)) {
      this.logger.warn(`未知维护任务 ${job.name}（id=${job.id}），跳过`);
      return { skipped: true, reason: 'unknown_job' };
    }
    // 用 job 触发时刻而不是 Date.now()：重试/补跑时判定基准稳定，单测也能复现
    const now = new Date(Number(job.timestamp) || Date.now());
    switch (job.name) {
      case 'subscription.renewal_reminder':
        return this.maintenance.runRenewalReminders(now);
      case 'approval.expire_sweep':
        return this.maintenance.runApprovalSweep(now);
      case 'idempotency.ttl_cleanup':
        return this.maintenance.runIdempotencyCleanup(now);
      default:
        return { skipped: true, reason: 'unhandled_job' };
    }
  }
}
