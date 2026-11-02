import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PrintJob, PrintLog, Printer } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { PrintService } from './print.service';
import { PrintController, PrintPreviewController, PrintCommandsController } from './print.controller';
import { PrintProcessor } from './print.processor';
import { RenderService } from './render.service';
import { SerialModule } from '../serial/serial.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PrintJob, PrintLog, Template, Printer]),
    BullModule.registerQueue({ name: 'print' }),
    SerialModule,
    AuditModule,
  ],
  providers: [PrintService, PrintProcessor, RenderService],
  controllers: [PrintController, PrintPreviewController, PrintCommandsController],
  exports: [PrintService, RenderService],
})
export class PrintModule {}
