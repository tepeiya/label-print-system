// 定时任务与消息通知基建模块（B2.4 / B2.5）
// 队列 'maintenance' 复用 app.module 的 BullModule.forRoot Redis 连接。
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Subscription } from '../entities/saas.entity';
import { AgentApproval, ToolIdempotency } from '../agent/agent.entity';
import { NotifyModule } from '../notify/notify.module';
import { MAINTENANCE_QUEUE } from './schedule.calc';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceScheduler } from './maintenance.scheduler';

@Module({
  imports: [
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
    TypeOrmModule.forFeature([Subscription, AgentApproval, ToolIdempotency]),
    NotifyModule,
  ],
  providers: [MaintenanceService, MaintenanceProcessor, MaintenanceScheduler],
  exports: [MaintenanceService],
})
export class JobsModule {}
