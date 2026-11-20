// =============================================================================
// BomController —— 租户侧 BOM 齐套率 REST 入口（bom 模块，docs/11 §11.7 / §11.16）
// 模块门 bom（依赖 inventory 由订阅展开）；权限点三段式：
//   齐套率 bom:kit:read · 缺料明细 bom:shortage:read · 维护 BOM bom:bom:write。
// 齐套计算复用 InventoryService.checkKit（与 Agent 工具同一套口径）。
// =============================================================================
import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { RequirePermission } from '../common/permission.guard';
import { useTenantId } from '../common/tenant.context';
import { InventoryService, BomStatus } from './inventory.service';
import { shortageSummaryText } from './kit.calc';
import { CheckKitDto, SaveBomDto, QueryBomsDto } from './dto/bom.dto';

@Controller('inventory/bom')
@UseGuards(TenantGuard)
@RequireModule('bom')
export class BomController {
  constructor(private svc: InventoryService) {}

  // ---------------- 齐套率 / 缺料 ----------------

  /** 齐套率：可配套数 + 齐套率 + 各行应耗/可用/缺口 */
  @Get('check-kit')
  @RequirePermission('bom:kit:read')
  checkKit(@Query() q: CheckKitDto) {
    return this.svc.checkKit(useTenantId(), q);
  }

  /** 缺料明细：只返回 shortage>0 的行 + 友好摘要（与 Agent explain_shortage 同口径） */
  @Get('shortages')
  @RequirePermission('bom:shortage:read')
  async shortages(@Query() q: CheckKitDto) {
    const { product, bom, kit } = await this.svc.checkKit(useTenantId(), q);
    return {
      product: { id: product.id, code: product.code, name: product.name },
      bom: { id: Number(bom.id), version: bom.version },
      demand: kit.demand,
      kitRate: kit.kitRate,
      maxSets: kit.maxSets,
      items: kit.shortages,
      summary: shortageSummaryText(product.name, kit),
    };
  }

  // ---------------- BOM 维护 ----------------

  /** BOM 列表（可按产品过滤），供维护页选择 */
  @Get('list')
  @RequirePermission('bom:kit:read')
  listBoms(@Query() q: QueryBomsDto) {
    return this.svc.listBoms(useTenantId(), q.product);
  }

  /** BOM 详情（含明细行） */
  @Get(':id')
  @RequirePermission('bom:kit:read')
  getBom(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getBom(useTenantId(), id);
  }

  /** 新建 BOM */
  @Post()
  @RequirePermission('bom:bom:write')
  createBom(@Body() b: SaveBomDto) {
    return this.svc.saveBom(useTenantId(), b);
  }

  /** 更新 BOM（含明细全量替换），id 以路径为准 */
  @Put(':id')
  @RequirePermission('bom:bom:write')
  updateBom(@Param('id', ParseIntPipe) id: number, @Body() b: SaveBomDto) {
    return this.svc.saveBom(useTenantId(), { ...b, id });
  }

  /** 启停 BOM（启用时同产品其它 BOM 自动降为 inactive） */
  @Post(':id/status')
  @RequirePermission('bom:bom:write')
  setBomStatus(@Param('id', ParseIntPipe) id: number, @Body('status') status: BomStatus) {
    return this.svc.setBomStatus(useTenantId(), id, status);
  }

  /** 删除 BOM（启用中的须先停用） */
  @Delete(':id')
  @RequirePermission('bom:bom:write')
  deleteBom(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deleteBom(useTenantId(), id);
  }
}
