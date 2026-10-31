import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintJob, PrintLog } from '../entities/print.entity';
import { Template } from '../entities/template.entity';
import { PrintService } from './print.service';
import { PrintController } from './print.controller';
import { PrintProcessor } from './print.processor';
import { RenderService } from './render.service';
import { SerialModule } from '../serial/serial.module';

@Module({
  imports: [TypeOrmModule.forFeature([PrintJob, PrintLog, Template]), SerialModule],
  providers: [PrintService, PrintController, PrintProcessor, RenderService],
  controllers: [PrintController],
  exports: [PrintService],
})
export class PrintModule {}
