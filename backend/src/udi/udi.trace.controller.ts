// =============================================================================
// UdiTraceController —— UDI 追溯/留痕 API（UDI 里程碑 U2）
// 全部挂在 /udi 下（与 encode/parse/scan-verify 同一控制器前缀不冲突）。
// 订阅门：与 UdiController 一致，未开通 udi.compliance 的租户 4031。
// =============================================================================
import {
  Body, Controller, Get, Header, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../common/tenant.guard';
import { RequireModule } from '../common/module.guard';
import { UdiTraceService } from './udi.trace.service';

@Controller('udi')
@UseGuards(TenantGuard)
@RequireModule('udi.compliance')
export class UdiTraceController {
  constructor(private svc: UdiTraceService) {}

  /** 能力自述（追溯/报表可用性探活） */
  @Get('trace/status')
  traceStatus() {
    return this.svc.status();
  }

  /** 批量建档（打印派码后回填；部分成功） */
  @Post('units/register')
  register(
    @Body() body: { rows: any[]; templateCode?: string; workOrderNo?: string },
  ) {
    return this.svc.registerUnits(body?.rows ?? [], { templateCode: body?.templateCode, workOrderNo: body?.workOrderNo });
  }

  /** 记录追溯事件（收货/发料/出库/退料/作废/换包） */
  @Post('units/events')
  event(@Body() body: any) {
    return this.svc.recordEvent(body ?? {});
  }

  /** 单元列表 */
  @Get('units')
  list(@Query() q: any) {
    return this.svc.listUnits(q ?? {});
  }

  /** 一码追溯：单品 UDI / SSCC / udiKey 均可 */
  @Get('trace/:code')
  trace(@Param('code') code: string) {
    return this.svc.trace(code);
  }

  /** 建/挂包装（SSCC 层级：单元 → 中包 → 托盘） */
  @Post('packages')
  packages(@Body() body: { rows: any[] }) {
    return this.svc.upsertPackages(body?.rows ?? []);
  }

  /** 包装详情（含子包装与包内单元） */
  @Get('packages/:sscc')
  packageDetail(@Param('sscc') sscc: string) {
    return this.svc.packageDetail(sscc);
  }

  /** 打印留痕报表（按天/按模板） */
  @Get('report/print-audit')
  printAudit(@Query() q: any) {
    return this.svc.printAudit(q ?? {});
  }

  /** 导出台账 CSV（Excel 直接可开） */
  @Get('export/units.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportUnits(@Query() q: any) {
    const { csv } = await this.svc.exportUnitsCsv(q ?? {});
    return csv;
  }

  /**
   * D5/U6：导出国家 UDI 数据库格式（Excel/XML）。
   * 返回 base64 + 文件名，前端解码下载；字段映射见 udi.export.calc.ts 的 UDI_DB_COLUMNS。
   */
  @Get('export/units.file')
  exportUnitsFile(@Query() q: any) {
    return this.svc.exportUnitsFile(q ?? {});
  }

  /** 导出留痕报表 CSV */
  @Get('export/print-audit.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportAudit(@Query() q: any) {
    const { csv } = await this.svc.exportPrintAuditCsv(q ?? {});
    return csv;
  }
}
