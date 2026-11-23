// =============================================================================
// UDI API（医疗合规赋码）—— 全局前缀 api/v1 → /api/v1/udi/...
//
// 端点设计依据：三个真实调用方
//   1) 模板设计器 / 打印页：POST /udi/encode 拿 HRI + 元素串 + DataMatrix 规格
//   2) PDA 现场：POST /udi/scan-verify 扫一枪就知道"是不是这一批/这一件"
//   3) Excel 批量建标签：POST /udi/batch 逐行返回，部分成功
// 订阅门：模块 code 待定（udi.compliance），当前未挂 @RequireModule，避免未开通租户被误拦；
//   商业化开通时在 modules/tenant_modules 加行并挂守卫即可（见 docs/18 §5）。
// =============================================================================
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { UdiService, ScanExpectation } from './udi.service';
import { UdiInput } from './udi.calc';
import { printerAdapterPayload, printerProfileById } from './udi.printer-profiles';

@Controller('udi')
export class UdiController {
  constructor(private svc: UdiService) {}

  /** 能力与边界自述（销售/实施现场可直接给客户看） */
  @Get('status')
  status() {
    return {
      module: 'udi.compliance',
      capabilities: {
        encode: 'GTIN 补位+校验位、GS1 日期、批号/序列号、DI/PI 拆分、HRI、元素串(FNC1)',
        barcode: 'GS1 DataMatrix（bwip 原生 gs1datamatrix，已做 zxing 回环验证）',
        parse: 'HRI 与原始元素串双向解析（含 <GS>/\\u001D 兼容）',
        scanVerify: '扫到的码 vs 预期逐字段比对（gtin/expiry/lot/serial）',
        batch: 'Excel 行批量构造，部分成功口径',
        templates: '3 个 UDI 模板包（单件/箱/试剂瓶）',
      },
      notIncluded: [
        'ISO/IEC 15415 打印质量等级判定（需硬件验证仪）',
        '国家 UDI 数据库自动上报（先做导出，接口待客户确认）',
        '真机合格样张验收（矩阵与校准清单已提供，机型 status=POC 待现场签字，见 docs/18 §6）',
      ],
    };
  }

  /** 真机适配矩阵 + 现场校准清单（实施/销售直接给客户看） */
  @Get('printer-profiles')
  printerProfiles() { return printerAdapterPayload(); }

  /** 单机型参数 */
  @Get('printer-profiles/:id')
  printerProfile(@Param('id') id: string) { return printerProfileById(id) ?? { error: '未收录该机型' }; }

  /** UDI 模板包清单 */
  @Get('templates')
  templates() { return this.svc.templates(); }

  /** 取模板 JSON（直接喂给 POST /api/v1/templates/import） */
  @Get('templates/:code')
  template(@Param('code') code: string) { return this.svc.templatePayload(code); }

  /** 构造 UDI */
  @Post('encode')
  encode(@Body() b: UdiInput & { templateCode?: string }) { return this.svc.encode(b); }

  /** 解析扫码内容（HRI / 原始元素串） */
  @Post('parse')
  parse(@Body() b: { code: string }) { return this.svc.parse(b); }

  /** PDA 扫码复核：与预期比对 */
  @Post('scan-verify')
  scanVerify(@Body() b: { code: string; expect: ScanExpectation; strict?: boolean }) { return this.svc.scanVerify(b); }

  /** 批量构造（Excel 导入） */
  @Post('batch')
  batch(@Body() b: { rows: Array<UdiInput & { rowNo?: number }> }) { return this.svc.batchEncode(b); }
}
