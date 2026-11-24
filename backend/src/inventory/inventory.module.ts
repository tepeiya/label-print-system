// 库存最小读模型模块（P4）——只导出查询服务给 Agent 工具/资源端点使用
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Template } from '../entities/template.entity';
import { Printer } from '../entities/print.entity';
import { PrintModule } from '../print/print.module';
import {
  Warehouse, WarehouseLocation, ProductGroup, Material, MaterialGtin, MaterialFieldDefinition,
  StockBatch, StockMove, Bom, BomItem, StockAdjustment, StockAdjustmentLine,
} from './inventory.entity';
import { AlertRule, AlertEvent } from './alert.entity';
import { InventoryService } from './inventory.service';
import { StockAdjustmentService } from './stock-adjustment.service';
import { AlertService } from './alert.service';
import { InventoryController } from './inventory.controller';
import { MasterdataController } from './masterdata.controller';
import { AlertController } from './alert.controller';
import { BomController } from './bom.controller';
import { StockAdjustmentController } from './stock-adjustment.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Warehouse, WarehouseLocation, ProductGroup, Material, MaterialGtin, MaterialFieldDefinition,
      StockBatch, StockMove, Bom, BomItem, Template, Printer, AlertRule, AlertEvent,
      StockAdjustment, StockAdjustmentLine,
    ]),
    PrintModule,
  ],
  controllers: [InventoryController, MasterdataController, AlertController, BomController, StockAdjustmentController],
  providers: [InventoryService, AlertService, StockAdjustmentService],
  exports: [InventoryService, AlertService],
})
export class InventoryModule {}
