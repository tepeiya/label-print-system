// AI 模板生成模块
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModelConfig, AiTemplateJob } from '../entities/ai-template.entity';
import { Template } from '../entities/template.entity';
import { AiQuota } from '../entities/ai-quota.entity';
import { AuditModule } from '../audit/audit.module';
import { AiTemplateController } from './ai-template.controller';
import { AiTemplateService } from './ai-template.service';
import { AiQuotaService } from './ai-quota.service';

@Module({
  imports: [TypeOrmModule.forFeature([AiTemplateJob, AiModelConfig, Template, AiQuota]), AuditModule],
  controllers: [AiTemplateController],
  providers: [AiTemplateService, AiQuotaService],
  exports: [AiTemplateService, AiQuotaService],
})
export class AiTemplateModule {}
