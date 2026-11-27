// =============================================================================
// 成品入库 API（wms.fg）—— 挂在入库模块权限 wms.inbound 下（成品入库同属入库作业）
// 全局前缀 api/v1 → 实际路径 /api/v1/wms/fg-receipts...
// =============================================================================
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../../common/tenant.guard';
import { RequireModule } from '../../../common/module.guard';
import { useTenantId } from '../../../common/tenant.context';
import { FgService } from '../services/fg.service';

@Controller('wms')
@UseGuards(TenantGuard)
@RequireModule('wms.inbound')
export class FgController {
  constructor(private svc: FgService) {}

  /** 建单：有工单=完工报工；无工单=零星入库（必须写原因） */
  @Post('fg-receipts')
  create(@Body() b: any) { return this.svc.create(b); }

  @Get('fg-receipts')
  list(@Query() q: any) {
    return this.svc.list({
      status: q.status, keyword: q.keyword,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20,
    });
  }

  /** 报工上下文：工单成品、需求、已入库、剩余可入、是否可报 */
  @Get('fg-receipts/wo/:woNo')
  woContext(@Param('woNo') woNo: string) { return this.svc.woContext(woNo); }

  @Get('fg-receipts/:id')
  detail(@Param('id') id: number) { return this.svc.detail(+id); }

  /** 过账：increaseStock（批次/台账/幂等/质量初始状态由 Gateway 负责） */
  @Post('fg-receipts/:id/post')
  post(@Param('id') id: number) { return this.svc.post(+id); }

  @Post('fg-receipts/:id/cancel')
  cancel(@Param('id') id: number, @Body() b: { reason?: string }) {
    return this.svc.cancel(+id, b?.reason);
  }
}
