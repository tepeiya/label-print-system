// =============================================================================
// InventoryController —— 租户侧出入库 REST 入口
// 复用的仍是 Agent 工具那一套 InventoryService 写路径（FIFO / 行锁 / 事务台账），
// 这里只补 HTTP 外壳：模块门 + 三段式权限点 + 操作人来自租户上下文。
// =============================================================================
import { BadRequestException, Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenant, useTenantId } from '../common/tenant.context';
import { InventoryService } from './inventory.service';
import {
  QueryStockDto, StockAdjustDto, StockTransferDto, QueryMovesDto,
} from './dto/inventory.dto';

const operator = () => `user#${useTenant().userId}`;
const isDry = (v?: string) => v === 'true' || v === '1';

@Controller('inventory')
@UseGuards(TenantGuard)
@RequireModule('inventory')
export class InventoryController {
  constructor(private svc: InventoryService) {}

  // ---------------- 查询 ----------------

  @Get('stock')
  @RequirePermission('inventory:stock:read')
  stock(@Query() q: QueryStockDto) {
    return this.svc.queryStock(useTenantId(), {
      keyword: q.keyword, warehouse: q.warehouse, groupBy: q.groupBy,
      belowSafety: q.belowSafety === 'true' || q.belowSafety === '1',
      expiringDays: q.expiringDays, limit: q.limit,
    });
  }

  @Get('low-stock')
  @RequirePermission('inventory:stock:read')
  lowStock(@Query('keyword') keyword?: string) {
    return this.svc.listLowStock(useTenantId(), { keyword });
  }

  @Get('expiring')
  @RequirePermission('inventory:stock:read')
  expiring(@Query() q: QueryStockDto) {
    return this.svc.listExpiring(useTenantId(), {
      keyword: q.keyword, warehouse: q.warehouse, days: q.expiringDays, limit: q.limit,
    });
  }

  @Get('moves')
  @RequirePermission('inventory:stock:read')
  moves(@Query() q: QueryMovesDto) {
    return this.svc.queryMoves(useTenantId(), q);
  }

  @Get('materials')
  @RequirePermission('inventory:stock:read')
  materials(@Query('keyword') keyword?: string) {
    return this.svc.listMaterials(useTenantId(), keyword);
  }

  @Get('warehouses')
  @RequirePermission('inventory:stock:read')
  warehouses() {
    return this.svc.listWarehouses(useTenantId());
  }

  // ---------------- 写操作 ----------------

  @Post('inbound')
  @RequirePermission('inventory:stock:adjust')
  inbound(@Body() b: StockAdjustDto) {
    const delta = Math.abs(Number(b.delta));
    if (!delta) throw new BadRequestException('入库数量必须大于 0');
    return this.svc.adjustStock(useTenantId(), {
      sku: b.sku, warehouse: b.warehouse, batch_no: b.batchNo,
      location_id: b.locationId, delta, reason: b.reason,
    }, isDry(b.dryRun), operator());
  }

  @Post('outbound')
  @RequirePermission('inventory:stock:adjust')
  outbound(@Body() b: StockAdjustDto) {
    const delta = -Math.abs(Number(b.delta));
    if (!delta) throw new BadRequestException('出库数量必须大于 0');
    return this.svc.adjustStock(useTenantId(), {
      sku: b.sku, warehouse: b.warehouse, batch_no: b.batchNo,
      location_id: b.locationId, delta, reason: b.reason,
    }, isDry(b.dryRun), operator());
  }

  @Post('transfer')
  @RequirePermission('inventory:stock:transfer')
  transfer(@Body() b: StockTransferDto) {
    return this.svc.transferStock(useTenantId(), {
      sku: b.sku, from_warehouse: b.fromWarehouse, to_warehouse: b.toWarehouse,
      qty: b.qty, batch_no: b.batchNo, reason: b.reason,
      from_location_id: b.fromLocationId, to_location_id: b.toLocationId,
    }, isDry(b.dryRun), operator());
  }
}
