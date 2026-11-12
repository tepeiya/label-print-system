// 库存最小读模型模块（P4）——只导出查询服务给 Agent 工具/资源端点使用
import { Module } from '@nestjs/common';
// 代理版 TypeOrmModule：forFeature 注入的 Repository 按 TenantCtx.dataSourceKey 路由
import { TypeOrmModule } from '../common/tenant-typeorm.module';
import { Warehouse, Material, StockBatch, Bom, BomItem } from './inventory.entity';
import { InventoryService } from './inventory.service';

@Module({
  imports: [TypeOrmModule.forFeature([Warehouse, Material, StockBatch, Bom, BomItem])],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
