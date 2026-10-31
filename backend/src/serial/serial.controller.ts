import { Controller, Get, Post, Put, Body, Param, Query, UseGuards } from '@nestjs/common';
import { SerialModuleService } from './serial.service';
import { TenantGuard } from '../common/tenant.guard';
import { useTenantId } from '../common/tenant.context';

@Controller('serial-sequences')
@UseGuards(TenantGuard)
export class SerialController {
  constructor(private svc: SerialModuleService) {}
  // 列表/创建/更新/重置等常规 CRUD 略，聚焦核心分配（供 PrintService 调用）
  @Get(':id/segment-preview') async preview(@Param('id') id: number, @Query('n') n = 100) {
    const seg = await this.svc.allocate(useTenantId(), `id:${id}`, +n);
    return { from: seg.startValue, to: seg.endValue, preview: seg.values.slice(0, 20) };
  }
}
