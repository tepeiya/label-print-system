import { Controller, Post, Get, Param, Body, Query, UseGuards } from '@nestjs/common';
import { PrintService } from './print.service';
import { TenantGuard } from '../common/tenant.guard';

@Controller('print/jobs')
@UseGuards(TenantGuard)
export class PrintController {
  constructor(private svc: PrintService) {}
  @Post() create(@Body() b: any) { return this.svc.createJob(b); }           // 202 风格：立即返回 jobId
  @Get(':id') get(@Param('id') id: number) { return this.svc.getJob(+id); }
  @Post(':id/cancel') cancel(@Param('id') id: number) { return this.svc.cancel(+id); }
  @Get('logs') logs(@Query() q: any) { return this.svc.logs(q); }
}
