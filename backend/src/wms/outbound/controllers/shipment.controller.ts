// WMS 成品发运 API（9 个端点）——全部挂订阅门 @RequireModule('wms.outbound')。
// 全局前缀 api/v1 → 实际路径 /api/v1/wms/shipments...
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../../common/tenant.guard';
import { RequireModule } from '../../../common/module.guard';
import { useTenantId, useTenant } from '../../../common/tenant.context';
import { ShipmentService } from '../services/shipment.service';
import {
  CancelShipmentDto, CreateShipmentDto, PickLineDto, SignShipmentDto,
} from '../dto/shipment.dto';

@Controller('wms')
@UseGuards(TenantGuard)
@RequireModule('wms.outbound')
export class ShipmentController {
  constructor(private svc: ShipmentService) {}

  @Post('shipments')
  create(@Body() b: CreateShipmentDto) {
    const { userId } = useTenant();
    return this.svc.create(useTenantId(), b, userId ?? null);
  }

  @Get('shipments')
  list(@Query() q: any) {
    return this.svc.list(useTenantId(), {
      status: q.status, shipType: q.shipType, keyword: q.keyword,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20,
    });
  }

  @Get('shipments/:id')
  get(@Param('id') id: number) { return this.svc.detail(useTenantId(), +id); }

  @Get('shipments/:id/recommend')
  recommend(@Param('id') id: number) { return this.svc.recommend(useTenantId(), +id); }

  @Post('shipments/:id/lines/:lineId/pick')
  pick(@Param('id') id: number, @Param('lineId') lineId: number, @Body() b: PickLineDto) {
    const { userId } = useTenant();
    return this.svc.pick(useTenantId(), +id, +lineId, b, userId ?? null);
  }

  @Post('shipments/:id/post')
  post(@Param('id') id: number) {
    const { userId } = useTenant();
    return this.svc.post(useTenantId(), +id, userId ?? null);
  }

  @Post('shipments/:id/sign')
  sign(@Param('id') id: number, @Body() b: SignShipmentDto) {
    const { userId } = useTenant();
    return this.svc.sign(useTenantId(), +id, b.receiver, userId ?? null);
  }

  @Post('shipments/:id/cancel')
  cancel(@Param('id') id: number, @Body() b: CancelShipmentDto) {
    const { userId } = useTenant();
    return this.svc.cancel(useTenantId(), +id, b.reason ?? '', userId ?? null);
  }
}
