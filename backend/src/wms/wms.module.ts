// WMS 模块（阶段一：wms.inbound 收货与上架）
// 依赖边界：只依赖 InventoryModule/AgentModule/AuditModule 的导出服务，
//   WMS 内部禁止 import src/print/** 与 src/inventory/** 的内部实现文件（Gateway 适配除外）。
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import {
  WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule,
} from './inbound/entities/wms.entity';
import { WmsWorkOrder } from './issuing/entities/wo.entity';
import { WmsShipment, WmsShipmentLine } from './outbound/entities/shipment.entity';
import { Material, MaterialGtin, Warehouse, WarehouseLocation, Bom, BomItem } from '../inventory/inventory.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { AgentModule } from '../agent/agent.module';
import { AuditModule } from '../audit/audit.module';
import { UdiModule } from '../udi/udi.module';
import { InboundService } from './inbound/services/inbound.service';
import { InboundController } from './inbound/controllers/inbound.controller';
import { ShipmentService } from './outbound/services/shipment.service';
import { ShipmentController } from './outbound/controllers/shipment.controller';
import { PrintGateway } from './gateways/print.gateway';
import { InventoryGateway } from './gateways/inventory.gateway';
import { CartonPackController } from './carton/carton-pack.controller';
import { CartonPackService } from './carton/carton-pack.service';
import { UdiPackage } from '../udi/entities/udi.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule,
      WmsShipment, WmsShipmentLine,
      Material, MaterialGtin, Warehouse, WarehouseLocation, Bom, BomItem, UdiPackage, WmsWorkOrder,
    ]),
    InventoryModule,
    AgentModule,
    AuditModule,
    UdiModule,
  ],
  controllers: [InboundController, ShipmentController, CartonPackController],
  providers: [InboundService, ShipmentService, PrintGateway, InventoryGateway, CartonPackService],
  exports: [InboundService, ShipmentService, PrintGateway, InventoryGateway, CartonPackService],
})
export class WmsModule {}
