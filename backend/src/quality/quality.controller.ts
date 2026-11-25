// =============================================================================
// 质量闸门 API（/api/v1/quality/...）—— 三个域共用一套守卫
//   · 检验单：待检清单 / 开单 / 录项 / 判定 / 作废
//   · 成品放行：提交 / 签批（密码）/ 作废
//   · 批记录：开单 / 工序 / 提交 / 批准退回
// 全部挂 @RequireModule('quality.qms')：没开这个模块的租户看不到也调不到。
// =============================================================================
import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { useTenant, useTenantId } from '../common/tenant.context';
import { QualityService } from './quality.service';
import { ReleaseService } from './release.service';
import { BatchRecordService } from './batch-record.service';

@Controller('quality')
@UseGuards(TenantGuard)
@RequireModule('quality.qms')
export class QualityController {
  constructor(
    private qc: QualityService,
    private rel: ReleaseService,
    private br: BatchRecordService,
  ) {}

  // ------------------------------------------------------------ 概览
  @Get('summary')
  async summary() {
    const tenantId = useTenantId();
    const [inspections, releases, records] = await Promise.all([
      this.qc.summary(tenantId), this.rel.summary(tenantId), this.br.summary(tenantId),
    ]);
    return { inspections, releases, records };
  }

  // ------------------------------------------------------------ 检验单
  @Get('inspections')
  listInspections(@Query() q: any) {
    return this.qc.list(useTenantId(), {
      status: q.status, inspType: q.inspType, keyword: q.keyword,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20,
    });
  }

  @Get('inspections/:id')
  getInspection(@Param('id') id: number) { return this.qc.detail(useTenantId(), +id); }

  /** 待检批次清单（库存里 PENDING 的批次，未开单的会标 hasDraft=false） */
  @Get('pending-batches')
  pendingBatches() { return this.qc.listPending(useTenantId()); }

  @Post('inspections')
  createInspection(@Body() b: any) {
    const { userId } = useTenant();
    return this.qc.create(useTenantId(), b, userId ?? null);
  }

  /** 一键补开：扫待检批次，缺单的自动开 DRAFT 检验单 */
  @Post('inspections/auto-open')
  autoOpen() {
    const { userId } = useTenant();
    return this.qc.autoOpenForPending(useTenantId(), userId ?? null);
  }

  @Put('inspections/:id/items')
  saveItems(@Param('id') id: number, @Body() b: { items: any[] }) {
    return this.qc.saveItems(useTenantId(), +id, b?.items ?? []);
  }

  @Post('inspections/:id/judge')
  judge(@Param('id') id: number, @Body() b: any) {
    const { userId } = useTenant();
    return this.qc.judge(useTenantId(), +id, b, userId ?? null);
  }

  @Post('inspections/:id/cancel')
  cancelInspection(@Param('id') id: number, @Body() b: { reason: string }) {
    const { userId } = useTenant();
    return this.qc.cancel(useTenantId(), +id, b?.reason ?? '', userId ?? null);
  }

  // ------------------------------------------------------------ 成品放行
  @Get('releases')
  listReleases(@Query() q: any) {
    return this.rel.list(useTenantId(), {
      status: q.status, keyword: q.keyword,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20,
    });
  }

  @Get('releases/:id')
  getRelease(@Param('id') id: number) { return this.rel.detail(useTenantId(), +id); }

  @Post('releases')
  submitRelease(@Body() b: any) {
    const { userId } = useTenant();
    return this.rel.submit(useTenantId(), b, userId ?? null);
  }

  /** QA 电子签：body 必须带 password（当前账号密码二次校验） */
  @Post('releases/:id/sign')
  signRelease(@Param('id') id: number, @Body() b: any) {
    const { userId } = useTenant();
    return this.rel.sign(useTenantId(), +id, b, userId ?? null, null);
  }

  @Post('releases/:id/cancel')
  cancelRelease(@Param('id') id: number, @Body() b: { reason: string }) {
    const { userId } = useTenant();
    return this.rel.cancel(useTenantId(), +id, b?.reason ?? '', userId ?? null);
  }

  // ------------------------------------------------------------ 批记录
  @Get('batch-records')
  listRecords(@Query() q: any) {
    return this.br.list(useTenantId(), {
      status: q.status, keyword: q.keyword,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20,
    });
  }

  @Get('batch-records/:id')
  getRecord(@Param('id') id: number) { return this.br.detail(useTenantId(), +id); }

  @Post('batch-records')
  createRecord(@Body() b: any) {
    const { userId } = useTenant();
    return this.br.create(useTenantId(), b, userId ?? null);
  }

  @Post('batch-records/:id/steps')
  addStep(@Param('id') id: number, @Body() b: any) {
    return this.br.addStep(useTenantId(), +id, b);
  }

  @Put('batch-records/:id/steps/:stepId')
  updateStep(@Param('id') id: number, @Param('stepId') stepId: number, @Body() b: any) {
    return this.br.updateStep(useTenantId(), +id, +stepId, b);
  }

  @Delete('batch-records/:id/steps/:stepId')
  deleteStep(@Param('id') id: number, @Param('stepId') stepId: number) {
    return this.br.deleteStep(useTenantId(), +id, +stepId);
  }

  @Post('batch-records/:id/submit')
  submitRecord(@Param('id') id: number) {
    const { userId } = useTenant();
    return this.br.submit(useTenantId(), +id, userId ?? null);
  }

  @Post('batch-records/:id/approve')
  approveRecord(@Param('id') id: number, @Body() b: any) {
    const { userId } = useTenant();
    return this.br.approve(useTenantId(), +id, b, userId ?? null);
  }
}
