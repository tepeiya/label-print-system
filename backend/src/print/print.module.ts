import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { BullModule } from '@nestjs/bullmq';
import { PrintJob, PrintLog, Printer } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { PrintService } from './print.service';
import { PrintController, PrintPreviewController, PrintCommandsController, PrintEventsController, SymbologyController } from './print.controller';
import { PrintExportController } from './export.controller';
import { PrintProcessor } from './print.processor';
import { RenderService } from './render.service';
import { PrintEvents } from './events.event';
import { SerialModule } from '../serial/serial.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
// P8.1：打印完成事件要跨进程投递到触发队列（进程内 EventEmitter 对 worker 无效）
import { TRIGGER_QUEUE } from '../jobs/trigger.calc';

@Module({
  imports: [
    TypeOrmModule.forFeature([PrintJob, PrintLog, Template, Printer]),
    BullModule.registerQueue({ name: 'print' }),
    BullModule.registerQueue({ name: TRIGGER_QUEUE }),
    SerialModule,
    AuditModule,
    BillingModule,
  ],
  providers: [PrintService, PrintProcessor, RenderService, PrintEvents],
  controllers: [PrintController, PrintPreviewController, PrintCommandsController, PrintEventsController, SymbologyController, PrintExportController],
  exports: [PrintService, RenderService, PrintEvents],
})
export class PrintModule {}
