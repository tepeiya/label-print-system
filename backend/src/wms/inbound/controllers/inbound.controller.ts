// WMS 收货上架 API（8 个端点）——全部挂订阅门 @RequireModule('wms.inbound')。
// 全局前缀 api/v1 → 实际路径 /api/v1/wms/...（C8）。
import {
  Body, Controller, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../../common/tenant.guard';
import { RequireModule } from '../../../common/module.guard';
import { InboundService } from '../services/inbound.service';
import {
  CreateReceiptDto, AppendLineDto, ReceiveScanDto, ConfirmPutawayDto, ImportReceiptDto,
} from '../dto/inbound.dto';

@Controller('wms')
@UseGuards(TenantGuard)
@RequireModule('wms.inbound')
export class InboundController {
  constructor(private svc: InboundService) {}

  @Post('receipts')
  create(@Body() b: CreateReceiptDto) { return this.svc.createReceipt(b); }

  @Post('receipts/import')
  import(@Body() b: ImportReceiptDto) { return this.svc.importReceipt(b); }

  @Get('receipts')
  list(@Query() q: any) {
    return this.svc.listReceipts({ status: q.status, page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20 });
  }

  @Get('receipts/:id')
  get(@Param('id') id: number) { return this.svc.getReceipt(+id); }

  @Post('receipts/:id/lines')
  appendLines(@Param('id') id: number, @Body() b: AppendLineDto) { return this.svc.appendLines(+id, b); }

  @Post('receipts/:id/receive-scan')
  receiveScan(@Param('id') id: number, @Body() b: ReceiveScanDto) { return this.svc.receiveScan(+id, b); }

  @Post('receipts/:id/post')
  post(@Param('id') id: number) { return this.svc.postReceipt(+id); }

  @Get('putaway-tasks')
  listTasks(@Query() q: any) {
    return this.svc.listPutawayTasks({ status: q.status, page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20 });
  }

  @Get('putaway-tasks/:id/recommend')
  recommend(@Param('id') id: number) { return this.svc.getRecommend(+id); }

  @Post('putaway-tasks/:id/confirm')
  confirm(@Param('id') id: number, @Body() b: ConfirmPutawayDto) { return this.svc.confirmPutaway(+id, b); }

  @Post('receipts/lines/:lineId/reprint-label')
  reprint(@Param('lineId') lineId: number) { return this.svc.reprintLabel(+lineId); }
}
