// UDI 模块（医疗合规赋码）：码构造/解析/扫码复核（无库）+ 追溯单元/包装/事件/留痕报表（有库）。
// 表结构见 scripts/udi_p1_trace.sql；实体见 entities/udi.entity.ts。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { UdiController } from './udi.controller';
import { UdiTraceController } from './udi.trace.controller';
import { UdiService } from './udi.service';
import { UdiTraceService } from './udi.trace.service';
import { UdiUnit, UdiPackage, UdiEvent } from './entities/udi.entity';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([UdiUnit, UdiPackage, UdiEvent]), AuditModule],
  controllers: [UdiController, UdiTraceController],
  providers: [UdiService, UdiTraceService],
  exports: [UdiService, UdiTraceService],
})
export class UdiModule {}
