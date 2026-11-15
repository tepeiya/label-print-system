// =============================================================================
// MaintenanceScheduler —— 注册 repeatable 定时任务（B2.4）
//
// 为什么用 BullMQ repeatable 而不是 @nestjs/schedule 的 @Cron：
//   1. 打印队列已经用 BullMQ，复用同一 Redis，不引入第二套调度基础设施；
//   2. repeatable job 有队列级去重（同 name + 同 cron 只存在一个调度），
//      API 进程与 worker 进程同时注册也不会重复触发；
//   3. 执行记录/失败重试/死信都能在队列里查，运维面统一。
//
// 关闭开关：MAINTENANCE_SCHEDULER_ENABLED=0（例如只想让 worker 进程跑、或临时停调度）。
// =============================================================================
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MAINTENANCE_JOBS, MAINTENANCE_QUEUE } from './schedule.calc';

@Injectable()
export class MaintenanceScheduler implements OnModuleInit {
  private logger = new Logger('MaintenanceScheduler');

  constructor(@InjectQueue(MAINTENANCE_QUEUE) private queue: Queue) {}

  async onModuleInit() {
    if (String(process.env.MAINTENANCE_SCHEDULER_ENABLED ?? '1') === '0') {
      this.logger.log('维护任务调度已按环境变量显式关闭（MAINTENANCE_SCHEDULER_ENABLED=0）');
      return;
    }
    for (const j of MAINTENANCE_JOBS) {
      await this.queue.add(j.name, {}, {
        repeat: { pattern: j.pattern },
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      });
      this.logger.log(`已注册 ${j.name}（${j.pattern} UTC / ${j.localTime}）：${j.desc}`);
    }
  }
}
