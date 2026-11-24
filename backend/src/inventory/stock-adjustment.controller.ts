// =============================================================================
// StockAdjustmentController —— 库存调整单 REST（2026-11-25，① 手工出入库单据化）
//
// 权限复用现有两点，不新增权限项（避免存量租户要补 role_permissions）：
//   读 inventory:stock:read / 写 inventory:stock:adjust
// 模块门 inventory（与库存页一致）。
// =============================================================================
import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenant, useTenantId } from '../common/tenant.context';
import { StockAdjustmentService } from './stock-adjustment.service';
import { CreateAdjustDto, CancelAdjustDto, ListAdjustDto } from './dto/stock-adjustment.dto';

const userId = () => {
  const n = Number(useTenant()?.userId);
  return Number.isFinite(n) && n > 0 ? n : null;
};

@Controller('inventory/adjustments')
@UseGuards(TenantGuard)
@RequireModule('inventory')
export class StockAdjustmentController {
  constructor(private svc: StockAdjustmentService) {}

  @Get()
  @RequirePermission('inventory:stock:read')
  list(@Query() q: ListAdjustDto) {
    return this.svc.list(useTenantId(), q);
  }

  @Get(':id')
  @RequirePermission('inventory:stock:read')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.svc.detail(useTenantId(), id);
  }

  @Post()
  @RequirePermission('inventory:stock:adjust')
  create(@Body() b: CreateAdjustDto) {
    return this.svc.create(useTenantId(), b as any, userId());
  }

  @Post(':id/post')
  @RequirePermission('inventory:stock:adjust')
  post(@Param('id', ParseIntPipe) id: number) {
    return this.svc.post(useTenantId(), id, userId());
  }

  @Post(':id/cancel')
  @RequirePermission('inventory:stock:adjust')
  cancel(@Param('id', ParseIntPipe) id: number, @Body() b: CancelAdjustDto) {
    return this.svc.cancel(useTenantId(), id, b?.reason ?? '', userId());
  }
}
