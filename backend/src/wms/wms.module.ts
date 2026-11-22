// WMS 模块（阶段一：wms.inbound 收货与上架）
// 依赖边界：只依赖 InventoryModule/AgentModule/AuditModule 的导出服务，
//   WMS 内部禁止 import src/print/** 与 src/inventory/** 的内部实现文件（Gateway 适配除外）。
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import {
  WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule,
} from './inbound/entities/wms.entity';
import { Material, Warehouse, WarehouseLocation } from '../inventory/inventory.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { AgentModule } from '../agent/agent.module';
import { AuditModule } from '../audit/audit.module';
import { InboundService } from './inbound/services/inbound.service';
import { InboundController } from './inbound/controllers/inbound.controller';
import { PrintGateway } from './gateways/print.gateway';
import { InventoryGateway } from './gateways/inventory.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WmsReceipt, WmsReceiptLine, WmsPutawayTask, WmsPutawayRule,
      Material, Warehouse, WarehouseLocation,
    ]),
    InventoryModule,
    AgentModule,
    AuditModule,
  ],
  controllers: [InboundController],
  providers: [InboundService, PrintGateway, InventoryGateway],
  exports: [InboundService, PrintGateway, InventoryGateway],
})
export class WmsModule {}
