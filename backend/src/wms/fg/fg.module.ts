// 成品入库模块（wms.fg）—— 挂 wms.inbound 订阅门，不新增独立订阅模块
// 依赖边界沿用阶段一/三：只依赖 InventoryModule / AuditModule 的导出服务与 InventoryGateway。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '../../common/tenant-typeorm.module';
import { WmsFgReceipt, WmsFgReceiptLine } from './entities/fg.entity';
import { WmsWorkOrder } from '../issuing/entities/wo.entity';
import { Material, Warehouse, WarehouseLocation } from '../../inventory/inventory.entity';
import { InventoryModule } from '../../inventory/inventory.module';
import { AuditModule } from '../../audit/audit.module';
import { FgService } from './services/fg.service';
import { FgController } from './controllers/fg.controller';
import { InventoryGateway } from '../gateways/inventory.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WmsFgReceipt, WmsFgReceiptLine, WmsWorkOrder,
      Material, Warehouse, WarehouseLocation,
    ]),
    InventoryModule,
    AuditModule,
  ],
  controllers: [FgController],
  providers: [FgService, InventoryGateway],
  exports: [FgService, InventoryGateway],
})
export class FgModule {}
