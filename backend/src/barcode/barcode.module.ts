import { Module } from '@nestjs/common';
import { Controller, Post, Body, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { TenantGuard } from '../common/tenant.guard';
import { renderBarcodeToPng, renderQrcodeToPng, validateBarcode } from '../../core/barcode-renderer';

@Controller('barcode')
@UseGuards(TenantGuard)
export class BarcodeController {
  @Post('preview') preview(@Body() b: any, @Res() res: Response) {
    const buf = renderBarcodeToPng(b, b.dpi ?? 300);
    res.set('Content-Type', 'image/png').send(buf);
  }
  @Post('validate') validate(@Body() b: { sym: string; content: string }) {
    return validateBarcode(b.sym, b.content);
  }
  @Post('qrcode/preview') qrcode(@Body() b: any, @Res() res: Response) {
    const buf = renderQrcodeToPng(b, b.dpi ?? 300); // 真实环境接 @bwip-js
    res.set('Content-Type', 'image/png').send(buf);
  }
}

@Module({ controllers: [BarcodeController] })
export class BarcodeModule {}
