import { Module, Controller, Post, Body, Res, Get, Param } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { Response } from 'express';
import {
  renderBarcodeToPng, renderQrcodeToPng, validateBarcode,
  renderBarcodeSvg, renderQrcodeSvg, supportedSymbologies, is2d,
} from '../../core/barcode-renderer';
// P8.4：GS1 AI 字典与合规校验（单一真源在 core/gs1-ai.ts）
import { gs1Catalog, gs1FieldHelp, validateGs1 } from '../../core/gs1-ai';
import { BarcodeRenderDto, BarcodeValidateDto } from '../common/dto/render-and-ai.dto';

@Controller('barcode')
export class BarcodeController {
  /** 支持码制清单（公开，前端下拉/文档使用） */
  @Get('types')
  types() {
    return { ...supportedSymbologies(), validation: 'POST /barcode/validate' };
  }

  /** 一维码 PNG（按 dpi 出图） */
  @Post('preview')
  async preview(@Body() b: BarcodeRenderDto, @Res() res: Response) {
    const buf = await renderBarcodeToPng(b as any, b.dpi ?? 300); // BarcodeSpec 的可选深度字段不进 DTO（透传，whitelist:false 保留）
    res.set('Content-Type', 'image/png').send(buf);
  }

  /** 二维码/2D 码 PNG */
  @Post('qrcode/preview')
  async qrcode(@Body() b: BarcodeRenderDto, @Res() res: Response) {
    const buf = await renderQrcodeToPng(b as any, b.dpi ?? 300);
    res.set('Content-Type', 'image/png').send(buf);
  }

  /** 统一 SVG 端点：前端预览/打印内联（返回 { svg, naturalWidthMm }） */
  @Post('svg')
  svg(@Body() b: BarcodeRenderDto) {
    const sym = b.sym || b.barcode?.sym || b.qrcode?.sym;
    const spec = (b.barcode || b.qrcode || b) as any;
    const svg = is2d(sym) ? renderQrcodeSvg(spec) : renderBarcodeSvg(spec);
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    return {
      svg,
      naturalWidthMm: vb ? +(parseFloat(vb[1]) * 25.4 / 72).toFixed(2) : null,
      naturalHeightMm: vb ? +(parseFloat(vb[2]) * 25.4 / 72).toFixed(2) : null,
    };
  }

  @Post('validate')
  validate(@Body() b: BarcodeValidateDto) {
    return validateBarcode(b.sym, b.content);
  }
}

// =============================================================================
// P8.4 GS1 向导 / 合规校验端点
// 与 /barcode/* 同为无状态端点：不读业务库、不产生副作用，前端可离线调用。
// 高级 GS1 向导的 UI 由这些结构化数据驱动（AI 目录 + 字段提示 + 校验结果），
// 不在前端另写一份 AI 表，避免与生成器漂移。
// =============================================================================
export class Gs1ValidateDto {
  @IsString()
  @Length(1, 4000, { message: 'content 必填且不超过 4000 字符' })
  content!: string;
}

@Controller('gs1')
export class Gs1Controller {
  /** AI 目录：分组、长度、类型、示例、模式族说明与「非全量字典」声明 */
  @Get('ai-catalog')
  catalog() { return gs1Catalog(); }

  /** 单个 AI 的输入提示（选中 AI 后显示「定长 14 位 · 含模 10 校验位」） */
  @Get('ai/:ai/help')
  help(@Param('ai') ai: string) { return gs1FieldHelp(String(ai ?? '')); }

  /** 整串合规校验：errors / warnings / 字段解析 / 编码数据流 / FNC1 分隔数 */
  @Post('validate')
  validate(@Body() b: Gs1ValidateDto) {
    const v = validateGs1(b.content);
    return {
      ...v,
      encodable: v.ok,
      hint: v.ok
        ? '校验通过，可直接用于 GS1-128 / GS1 DataMatrix 编码'
        : '存在错误，请先修正后再编码（data 字段仍返回供排查）',
      disclaimer: 'AI 字典覆盖常用项，非 GS1 General Specifications 全量；行业专用码请以最新官方手册复核',
    };
  }
}

@Module({ controllers: [BarcodeController, Gs1Controller] })
export class BarcodeModule {}
