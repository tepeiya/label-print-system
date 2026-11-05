import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PrintJob, PrintLog, Printer } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { PrintService } from './print.service';
import { PrintController, PrintPreviewController, PrintCommandsController, PrintEventsController } from './print.controller';
import { PrintProcessor } from './print.processor';
import { RenderService } from './render.service';
import { PrintEvents } from './events.event';
import { SerialModule } from '../serial/serial.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PrintJob, PrintLog, Template, Printer]),
    BullModule.registerQueue({ name: 'print' }),
    SerialModule,
    AuditModule,
    BillingModule,
  ],
  providers: [PrintService, PrintProcessor, RenderService, PrintEvents],
  controllers: [PrintController, PrintPreviewController, PrintCommandsController, PrintEventsController],
  exports: [PrintService, RenderService, PrintEvents],
})
export class PrintModule {}
