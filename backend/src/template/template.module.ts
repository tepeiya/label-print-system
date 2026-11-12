import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Template, TemplateVersion } from '../entities/template.entity';
import { TemplateService } from './template.service';
import { TemplateController } from './template.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([Template, TemplateVersion]), AuditModule],
  providers: [TemplateService],
  controllers: [TemplateController],
  exports: [TemplateService],
})
export class TemplateModule {}
