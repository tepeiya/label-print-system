// 库存最小读模型模块（P4）——只导出查询服务给 Agent 工具/资源端点使用
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Warehouse, Material, StockBatch, Bom, BomItem } from './inventory.entity';
import { InventoryService } from './inventory.service';

@Module({
  imports: [TypeOrmModule.forFeature([Warehouse, Material, StockBatch, Bom, BomItem])],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
