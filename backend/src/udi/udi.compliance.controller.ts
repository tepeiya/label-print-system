// =============================================================================
// UdiComplianceController —— UDI 合规闭环接口（DI 台账 / 校验 / 召回 / 申报）
// 前缀同 UdiTraceController（/udi），路径不重叠：
//   /udi/di*          DI 台账与包装层级树
//   /udi/validate     提交前规则校验
//   /udi/recall*      召回影响面
//   /udi/submissions* 申报记录与提交
//   /udi/nmpa/probe   国家 UDID 连通性自检
// 订阅门：与 UDI 其它接口一致（udi.compliance）。
// =============================================================================
import { Body, Controller, Delete, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { useTenantId } from '../common/tenant.context';
import { UdiComplianceService } from './udi.compliance.service';
import type { DiInput } from './udi.compliance.service';

@Controller('udi')
@UseGuards(TenantGuard)
@RequireModule('udi.compliance')
export class UdiComplianceController {
  constructor(private svc: UdiComplianceService) {}

  // ------------------------------------------------------------------ DI 台账

  @Get('di')
  listDi(@Query() q: any) {
    return this.svc.listDi(useTenantId(), q ?? {});
  }

  /** 批量写入（按 DI upsert；校验位不过的行直接拒，并逐行回报原因） */
  @Post('di')
  saveDi(@Body() body: { rows: DiInput[] }) {
    return this.svc.saveDi(useTenantId(), null, body?.rows ?? []);
  }

  @Delete('di/:di')
  removeDi(@Param('di') di: string) {
    return this.svc.removeDi(useTenantId(), di);
  }

  /** 包装层级树 PALLET → CARTON → UNIT */
  @Get('di-tree')
  diTree() {
    return this.svc.diTree(useTenantId());
  }

  // ------------------------------------------------------------ 提交前校验

  @Post('validate')
  validate(@Body() body: { dis?: string[] }) {
    return this.svc.validate(useTenantId(), body?.dis ?? []);
  }

  // ------------------------------------------------------------ 召回范围

  @Get('recall')
  recall(@Query() q: any) {
    return this.svc.recallScope(useTenantId(), q ?? {});
  }

  @Get('recall/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="udi-recall.csv"')
  async recallExport(@Query() q: any) {
    const { content } = await this.svc.recallCsv(useTenantId(), q ?? {});
    return content;
  }

  // ------------------------------------------------------------ 申报提交

  @Post('submissions')
  createSubmission(@Body() body: { channel: string; mode?: string; dis?: string[] }) {
    return this.svc.createSubmission(useTenantId(), null, body ?? ({} as any));
  }

  @Get('submissions')
  listSubmissions(@Query() q: any) {
    return this.svc.listSubmissions(useTenantId(), q ?? {});
  }

  @Get('submissions/:id')
  submissionDetail(@Param('id') id: string) {
    return this.svc.submissionDetail(useTenantId(), +id);
  }

  /** 国家 UDID 连通性/凭据自检（销售现场可用来判断客户网络） */
  @Get('nmpa/probe')
  nmpaProbe() {
    return this.svc.nmpaProbe();
  }
}
