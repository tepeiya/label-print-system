// 定时任务（B2.4 / B2.5）与自动化触发（P8.1）模块
// 队列 'maintenance' / 'trigger' 复用 app.module 的 BullModule.forRoot Redis 连接。
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Subscription } from '../entities/saas.entity';
import { AgentApproval, ToolIdempotency } from '../agent/agent.entity';
import { AuditModule } from '../audit/audit.module';
import { NotifyModule } from '../notify/notify.module';
import { PrintModule } from '../print/print.module';
import { MAINTENANCE_QUEUE } from './schedule.calc';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceScheduler } from './maintenance.scheduler';
import { TRIGGER_QUEUE } from './trigger.calc';
import { PrintTrigger, TriggerDelivery } from './trigger.entity';
import { TriggerService } from './trigger.service';
import { TriggerProcessor } from './trigger.processor';
import { HotFolderService } from './hotfolder.service';
import { TriggerController } from './trigger.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
    BullModule.registerQueue({ name: TRIGGER_QUEUE }),
    TypeOrmModule.forFeature([Subscription, AgentApproval, ToolIdempotency, PrintTrigger, TriggerDelivery]),
    NotifyModule,
    PrintModule,      // PrintService（print 动作）/ PrintEvents
    AuditModule,      // AuditService（触发器 CRUD 与投递留痕）
  ],
  controllers: [TriggerController],
  providers: [
    MaintenanceService, MaintenanceProcessor, MaintenanceScheduler,
    TriggerService, TriggerProcessor, HotFolderService,
  ],
  exports: [MaintenanceService, TriggerService],
})
export class JobsModule {}
