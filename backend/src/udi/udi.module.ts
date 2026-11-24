// UDI 模块（医疗合规赋码）：码构造/解析/扫码复核（无库）+ 追溯单元/包装/事件/留痕报表（有库）
// + 合规闭环（DI 台账 / 提交前校验 / 召回影响面 / 申报提交）。
// 表结构见 scripts/udi_p1_trace.sql、udi_p3_compliance.sql；实体见 entities/udi.entity.ts。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { UdiController } from './udi.controller';
import { UdiTraceController } from './udi.trace.controller';
import { UdiComplianceController } from './udi.compliance.controller';
import { UdiService } from './udi.service';
import { UdiTraceService } from './udi.trace.service';
import { UdiComplianceService } from './udi.compliance.service';
import { NmpaUdidClient } from './udi.nmpa.client';
import { UdiUnit, UdiPackage, UdiEvent, UdiDiMaster, UdiSubmission } from './entities/udi.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([UdiUnit, UdiPackage, UdiEvent, UdiDiMaster, UdiSubmission]), AuditModule],
  controllers: [UdiController, UdiTraceController, UdiComplianceController],
  providers: [UdiService, UdiTraceService, UdiComplianceService, NmpaUdidClient],
  exports: [UdiService, UdiTraceService, UdiComplianceService],
})
export class UdiModule {}
