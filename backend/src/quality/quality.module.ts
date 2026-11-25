// 质量闸门模块（quality.qms）
//   · 检验单 / 成品放行 / 批记录 三个域共用一个 controller，减少守卫与菜单配置面。
//   · 依赖边界：库存写一律经 WmsModule 导出的 InventoryGateway（与 WMS 同一条硬约束），
//     本模块不直接 UPDATE stock_batches。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import {
  QcInspection, QcInspectionItem, QaRelease, BatchRecord, BatchRecordStep,
} from './entities/quality.entity';
import { Material, StockBatch, Warehouse } from '../inventory/inventory.entity';
import { WmsWorkOrder } from '../wms/issuing/entities/wo.entity';
import { UdiUnit } from '../udi/entities/udi.entity';
import { User } from '../entities/tenant.entity';
import { WmsModule } from '../wms/wms.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { QualityService } from './quality.service';
import { ReleaseService } from './release.service';
import { BatchRecordService } from './batch-record.service';
import { QualityController } from './quality.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      QcInspection, QcInspectionItem, QaRelease, BatchRecord, BatchRecordStep,
      Material, StockBatch, Warehouse, WmsWorkOrder, UdiUnit, User,
    ]),
    WmsModule,
    AuthModule,
    AuditModule,
  ],
  controllers: [QualityController],
  providers: [QualityService, ReleaseService, BatchRecordService],
  exports: [QualityService, ReleaseService, BatchRecordService],
})
export class QualityModule {}
