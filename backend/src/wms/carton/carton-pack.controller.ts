// =============================================================================
// CartonPackController —— 装箱出码 API
//   POST /wms/carton/pack   总件数 + 箱规 → 满箱/尾箱 SSCC + 可选打箱标
//   GET  /wms/carton/packs  已装箱清单（按 SSCC 列表，便于核对/补打）
// 挂 wms.inbound 模块（不开 UDI 套件也能用），打印仍走 PrintGateway。
// =============================================================================
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../common/tenant.guard';
import { RequireModule } from '../../common/module.guard';
import { Roles } from '../../common/roles.guard';
import { CartonPackService, PackDto } from './carton-pack.service';

@Controller('wms/carton')
@UseGuards(TenantGuard)
@RequireModule('wms.inbound')
export class CartonPackController {
  constructor(private svc: CartonPackService) {}

  @Post('pack')
  @Roles('admin', 'operator', 'warehouse_keeper')
  pack(@Body() body: PackDto) {
    return this.svc.pack(body ?? ({} as PackDto));
  }

  /** 箱规档位（PDA 选完物料拉一次，决定 packQty / 箱码 GTIN） */
  @Get('specs')
  specs(@Query('skuCode') skuCode: string) {
    return this.svc.specs(skuCode);
  }

  @Get('packs')
  list(@Query('limit') limit?: string) {
    return this.svc.listPacks(Number(limit) || 50);
  }
}
