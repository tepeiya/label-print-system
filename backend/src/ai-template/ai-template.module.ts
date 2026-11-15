// AI 模板生成模块
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { AiModelConfig, AiTemplateJob } from '../entities/ai-template.entity';
import { Template } from '../entities/template.entity';
import { AiQuota } from '../entities/ai-quota.entity';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { AiTemplateController } from './ai-template.controller';
import { AiTemplateService } from './ai-template.service';
import { AiQuotaService } from './ai-quota.service';

@Module({
  imports: [TypeOrmModule.forFeature([AiTemplateJob, AiModelConfig, Template, AiQuota]), AuditModule, BillingModule],
  controllers: [AiTemplateController],
  providers: [AiTemplateService, AiQuotaService],
  exports: [AiTemplateService, AiQuotaService],
})
export class AiTemplateModule {}
