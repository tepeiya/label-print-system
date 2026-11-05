import { Module, Controller, Post, Body, Res, Get, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { TenantGuard } from '../common/tenant.guard';
import {
  renderBarcodeToPng, renderQrcodeToPng, validateBarcode,
  renderBarcodeSvg, renderQrcodeSvg, supportedSymbologies, is2d,
} from '../../core/barcode-renderer';
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

@Module({ controllers: [BarcodeController] })
export class BarcodeModule {}
