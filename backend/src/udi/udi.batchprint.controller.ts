// =============================================================================
// UdiBatchPrintController —— 主从层级打印入口（一箱 N 件）
//   POST /udi/pack-print        建箱 + N 件登记 + 单件标/箱标两个打印任务
//   GET  /udi/pack-print/meta   可用模板、公司前缀、单次上限（给前端填表单）
// =============================================================================
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { useTenantId } from '../common/tenant.context';
import { UdiBatchPrintService, PackPrintDto } from './udi.batchprint.service';

@Controller('udi')
@UseGuards(TenantGuard)
@RequireModule('udi.compliance')
export class UdiBatchPrintController {
  constructor(private readonly svc: UdiBatchPrintService) {}

  @Post('pack-print')
  packPrint(@Body() b: PackPrintDto) {
    return this.svc.packPrint(b, useTenantId());
  }

  @Get('pack-print/meta')
  meta() {
    return this.svc.meta(useTenantId());
  }
}
