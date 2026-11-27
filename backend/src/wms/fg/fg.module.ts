// 成品入库模块（wms.fg）—— 挂 wms.inbound 订阅门，不新增独立订阅模块
// 依赖边界沿用阶段一/三：只依赖 InventoryModule / AgentModule / AuditModule 的导出服务与 Gateway。
// 坑：InventoryGateway 构造时注入 IdempotencyService（AgentModule 导出）与
// Material/MaterialGtin/Warehouse/WarehouseLocation/Bom/BomItem 六个仓储，
// 少声明任一项，Nest 启动即报 "can't resolve dependencies of the InventoryGateway"。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '../../common/tenant-typeorm.module';
import { WmsFgReceipt, WmsFgReceiptLine } from './entities/fg.entity';
import { WmsWorkOrder } from '../issuing/entities/wo.entity';
import { Material, MaterialGtin, Warehouse, WarehouseLocation, Bom, BomItem } from '../../inventory/inventory.entity';
import { InventoryModule } from '../../inventory/inventory.module';
import { AgentModule } from '../../agent/agent.module';
import { AuditModule } from '../../audit/audit.module';
import { FgService } from './services/fg.service';
import { FgController } from './controllers/fg.controller';
import { InventoryGateway } from '../gateways/inventory.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WmsFgReceipt, WmsFgReceiptLine, WmsWorkOrder,
      Material, MaterialGtin, Warehouse, WarehouseLocation, Bom, BomItem,
    ]),
    InventoryModule,
    AgentModule,
    AuditModule,
  ],
  controllers: [FgController],
  providers: [FgService, InventoryGateway],
  exports: [FgService, InventoryGateway],
})
export class FgModule {}
