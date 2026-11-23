// WMS 阶段二模块（wms.issuing 工单发料与齐套）。
// 依赖边界沿用阶段一：只依赖 InventoryModule/AgentModule/AuditModule 的导出服务与 Gateway。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '../../common/tenant-typeorm.module';
import {
  WmsWorkOrder, WmsWoLine, WmsIssueRecord, WmsWoReturn,
} from './entities/wo.entity';
import { Material, Warehouse, WarehouseLocation, Bom, BomItem } from '../../inventory/inventory.entity';
import { InventoryModule } from '../../inventory/inventory.module';
import { AgentModule } from '../../agent/agent.module';
import { AuditModule } from '../../audit/audit.module';
import { UdiModule } from '../../udi/udi.module';
import { IssuingService } from './services/issuing.service';
import { IssuingController } from './controllers/issuing.controller';
import { InventoryGateway } from '../gateways/inventory.gateway';
import { PrintGateway } from '../gateways/print.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WmsWorkOrder, WmsWoLine, WmsIssueRecord, WmsWoReturn,
      Material, Warehouse, WarehouseLocation, Bom, BomItem,
    ]),
    InventoryModule,
    AgentModule,
    AuditModule,
    UdiModule,
  ],
  controllers: [IssuingController],
  providers: [IssuingService, InventoryGateway, PrintGateway],
  exports: [IssuingService, InventoryGateway, PrintGateway],
})
export class IssuingModule {}
