// =============================================================================
// P8.2 印刷级导出端点
// 与 /print/commands 同口径：调用方自带模板 JSON，不读业务库，因此不挂 TenantGuard；
// 所有变量/公式求值都在内存里完成，不产生数据库副作用。
// =============================================================================
import { Body, Controller, Post, Res, BadRequestException } from '@nestjs/common';
import { IsArray, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { Response } from 'express';
import { buildExportSvgs } from './vector-renderer';
import { sheetsToPdf } from './pdf-export';

export class ExportDto {
  @IsObject()
  templateContent: { page: any; elements: any[] };

  @IsOptional() @IsArray()
  rows?: Record<string, any>[];

  @IsOptional() @IsInt() @Min(1) @Max(500)
  copies?: number;

  /** PDF 栅格化 DPI（72–1200，默认 600） */
  @IsOptional() @IsInt() @Min(72) @Max(1200)
  dpi?: number;

  @IsOptional()
  serialMap?: Record<string, string[]>;
}

@Controller('print/export')
export class PrintExportController {
  /** 整标签真矢量 SVG：返回所有拼版 sheet（前端可逐张下载或合成） */
  @Post('svg')
  svg(@Body() b: ExportDto) {
    try {
      const out = buildExportSvgs({
        templateContent: b.templateContent, rows: b.rows,
        copies: b.copies, serialMap: b.serialMap,
      });
      return {
        format: 'svg',
        sheets: out.sheets,
        sheetWidthMm: out.sheetWidthMm,
        sheetHeightMm: out.sheetHeightMm,
        labelCount: out.labelCount,
        perSheet: out.perSheet,
        cols: out.cols,
        rows: out.rows,
        warnings: out.warnings,
      };
    } catch (e: any) {
      throw new BadRequestException(String(e?.message ?? e));
    }
  }

  /** 多页 PDF：每页尺寸按 mm→pt 精确换算，600dpi 位图，无水印 */
  @Post('pdf')
  async pdf(@Body() b: ExportDto, @Res() res: Response) {
    let out: Awaited<ReturnType<typeof buildExportSvgs>>;
    try {
      out = buildExportSvgs({
        templateContent: b.templateContent, rows: b.rows,
        copies: b.copies, serialMap: b.serialMap,
      });
    } catch (e: any) {
      throw new BadRequestException(String(e?.message ?? e));
    }
    let pdf: Awaited<ReturnType<typeof sheetsToPdf>>;
    try {
      pdf = await sheetsToPdf(out.sheets, out.sheetWidthMm, out.sheetHeightMm, {
        dpi: b.dpi, title: 'LabelFlow Label Export',
      });
    } catch (e: any) {
      throw new BadRequestException(`PDF 生成失败：${String(e?.message ?? e)}`);
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="labelflow-${Date.now()}.pdf"`,
      'X-LabelFlow-Pages': String(pdf.pageCount),
      'X-LabelFlow-Warning-Count': String(out.warnings.length + pdf.warnings.length),
      // header 只放 ASCII：中文 warnings 用 encodeURIComponent，完整文案在 svg 端点里
      'X-LabelFlow-Warnings': encodeURIComponent([...out.warnings, ...pdf.warnings].join(' | ')).slice(0, 1800),
      'Cache-Control': 'no-store',
    });
    res.send(pdf.bytes);
  }
}
