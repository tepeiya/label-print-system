// AI 模板生成模块
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModelConfig, AiTemplateJob } from '../entities/ai-template.entity';
import { Template } from '../entities/template.entity';
import { AuditModule } from '../audit/audit.module';
import { AiTemplateController } from './ai-template.controller';
import { AiTemplateService } from './ai-template.service';

@Module({
  imports: [TypeOrmModule.forFeature([AiTemplateJob, AiModelConfig, Template]), AuditModule],
  controllers: [AiTemplateController],
  providers: [AiTemplateService],
  exports: [AiTemplateService],
})
export class AiTemplateModule {}
