// =============================================================================
// InternalPrintController —— WMS 打印契约的内部 HTTP 端点
// POST /api/v1/internal/print-jobs
//
// @Public() 跳过全局 JWT/模块/权限守卫；认证由 service token（Bearer lfagent_）+ scope 承担。
// 该端点属于打印服务边界（方向 A），WMS 只经 PrintGateway 走 HTTP 调用。
// =============================================================================
import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { InternalPrintService, InternalPrintResult } from './internal-print.service';
import { InternalPrintJobDto } from '../print/dto/internal-print.dto';

@Controller('internal')
@Public()
export class InternalPrintController {
  constructor(private svc: InternalPrintService) {}

  @Post('print-jobs')
  async create(
    @Body() body: InternalPrintJobDto,
    @Headers('authorization') auth?: string,
  ): Promise<InternalPrintResult> {
    const m = /^Bearer\s+(\S+)$/i.exec(String(auth ?? '').trim());
    if (!m) throw new UnauthorizedException('缺少 service token（Authorization: Bearer lfagent_xxx）');
    return this.svc.submit(m[1], body);
  }
}
