// =============================================================================
// IssuingController —— WMS 阶段二 API（17 个端点，docs/16 §8）
// 全局前缀 api/v1 → 实际 /api/v1/wms/work-orders/...；全部挂 @RequireModule('wms.issuing')。
// =============================================================================
import {
  Body, Controller, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../../common/tenant.guard';
import { RequireModule } from '../../../common/module.guard';
import { IssuingService } from '../services/issuing.service';

@Controller('wms')
@UseGuards(TenantGuard)
@RequireModule('wms.issuing')
export class IssuingController {
  constructor(private svc: IssuingService) {}

  /** 1) 手工建单（expandBom=true 按 active BOM 展开） */
  @Post('work-orders')
  create(@Body() b: any) { return this.svc.create(b); }

  /** 2) Excel 建单（部分成功） */
  @Post('work-orders/import')
  importOrders(@Body() b: { rows: any[] }) { return this.svc.importOrders(b?.rows ?? []); }

  /** 3) 工单列表 */
  @Get('work-orders')
  list(@Query() q: any) {
    return this.svc.list({
      status: q.status, keyword: q.keyword,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 20,
    });
  }

  /** 17) 发料记录查询（放前面，避免被 :id 吃掉；路径无冲突，保留以便前端直接用） */
  @Get('issue-records')
  issueRecords(@Query() q: any) {
    return this.svc.issueRecords({
      woId: q.woId ? +q.woId : undefined, materialCode: q.materialCode,
      since: q.since, until: q.until,
      page: q.page ? +q.page : 1, pageSize: q.pageSize ? +q.pageSize : 50,
    });
  }

  /** 4) 工单详情（含行/齐套摘要/发料与退料记录） */
  @Get('work-orders/:id')
  detail(@Param('id') id: string) { return this.svc.detail(+id); }

  /** 5) 改行/追加行（仅 CREATED） */
  @Post('work-orders/:id/lines')
  appendLines(@Param('id') id: string, @Body() b: { lines: any[] }) {
    return this.svc.appendLines(+id, b?.lines ?? []);
  }

  /** 6) 齐套检查（行级 + 整体；回写缺料标记） */
  @Post('work-orders/:id/kit-check')
  kitCheck(@Param('id') id: string) { return this.svc.kitCheck(+id); }

  /** 7) 下发 */
  @Post('work-orders/:id/release')
  release(@Param('id') id: string) { return this.svc.release(+id); }

  /** 8) 取消（仅 CREATED/RELEASED） */
  @Post('work-orders/:id/cancel')
  cancel(@Param('id') id: string, @Body() b: { reason?: string }) { return this.svc.cancel(+id, b?.reason); }

  /** 9) 开始发料 */
  @Post('work-orders/:id/issue-start')
  issueStart(@Param('id') id: string) { return this.svc.issueStart(+id); }

  /** 10) PDA 扫码校验（不回写库存） */
  @Post('work-orders/:id/issue-scan')
  issueScan(@Param('id') id: string, @Body() b: any) { return this.svc.issueScan(+id, b ?? {}); }

  /** 11) 发料过账（可部分行；force 强制放行留审计） */
  @Post('work-orders/:id/issue-post')
  issuePost(@Param('id') id: string, @Body() b: any) { return this.svc.issuePost(+id, b ?? {}); }

  /** 12) 发料完成（缺料清单随响应返回） */
  @Post('work-orders/:id/issue-done')
  issueDone(@Param('id') id: string, @Body() b: any) { return this.svc.issueDone(+id, b ?? {}); }

  /** 13) 缺料清单 */
  @Get('work-orders/:id/shortages')
  shortages(@Param('id') id: string) { return this.svc.shortages(+id); }

  /** 14) 退料冲销（ISSUED → ISSUING，需审批字段） */
  @Post('work-orders/:id/returns')
  createReturn(@Param('id') id: string, @Body() b: any) { return this.svc.createReturn(+id, b ?? {}); }

  /** 15) 关单 */
  @Post('work-orders/:id/close')
  close(@Param('id') id: string) { return this.svc.close(+id); }

  /** 16) 发料标签补打 */
  @Post('work-orders/lines/:lineId/reprint-label')
  reprint(@Param('lineId') lineId: string, @Body() b: { n?: number }) { return this.svc.reprintLabel(+lineId, b?.n); }
}
