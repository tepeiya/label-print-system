// P8.3 企业治理模块。
// 依赖方向：GovernanceModule 不 import TemplateModule / PrintModule，
// 后者 import 本模块 → 单向依赖，不会形成循环（Nest DI 图已在编译产物上探测通过）。
// 需要的 Template / PrintJob 实体直接用 forFeature 注册，不通过模块导入拿 Repository。
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Template } from '../entities/template.entity';
import { PrintJob } from '../entities/print.entity';
import { AuditModule } from '../audit/audit.module';
import { NotifyModule } from '../notify/notify.module';
import {
  GovernanceSetting, TemplateGovernance, TemplateReview, PrintDedupe,
} from './governance.entity';
import { GovernanceService } from './governance.service';
import { GovernanceController } from './governance.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernanceSetting, TemplateGovernance, TemplateReview, PrintDedupe,
      Template, PrintJob,
    ]),
    AuditModule,       // 审批 / 策略变更留痕
    NotifyModule,      // 审批结果站内信（旁路，失败不回滚状态迁移）
  ],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}
