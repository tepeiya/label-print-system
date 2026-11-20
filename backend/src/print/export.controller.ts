// =============================================================================
// P8.2 印刷级导出端点 + 第二层印刷级打磨（矢量 PDF / 印前标记 / 交叉合并 / 拆分）
// 与 /print/commands 同口径：调用方自带模板 JSON，不读业务库，因此不挂 TenantGuard；
// 所有变量/公式求值都在内存里完成，不产生数据库副作用。
// =============================================================================
import { Body, Controller, Post, Res, BadRequestException } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';
import { Response } from 'express';
import { buildExportSvgs } from './vector-renderer';
import { sheetsToPdf } from './pdf-export';
import { buildVectorDoc, renderVectorPdf, translateDocOps } from './vector-pdf';
import { applyPrintMarks, hasAnyMarks, type PrintMarksOptions } from './print-marks';
import { splitPdfBytes, splitPdfEvery } from './impose';
// P8.3：水印层（纯函数夹取 + 转义；指令通道不叠加）
import { normalizePolicy, watermarkSvgLayer } from '../governance/governance.calc';

export class ExportDto {
  @IsObject()
  templateContent: { page: any; elements: any[] };

  @IsOptional() @IsArray()
  rows?: Record<string, any>[];

  @IsOptional() @IsInt() @Min(1) @Max(500)
  copies?: number;

  /** PDF 栅格化 DPI（72–1200，默认 600）；矢量模式下作为 CJK/二维码位图块的 DPI */
  @IsOptional() @IsInt() @Min(72) @Max(1200)
  dpi?: number;

  @IsOptional()
  serialMap?: Record<string, string[]>;

  /** P8.3 水印规格（可选）；由 governance.calc.normalizePolicy 夹取后生效 */
  @IsOptional() @IsObject()
  watermark?: any;

  /** 第二层：标签顺序。true=逐份交叉 ABC/ABC（默认），false=按行堆叠 AA/BB/CC */
  @IsOptional() @IsBoolean()
  collate?: boolean;

  /** 第二层：PDF 走真矢量通道（默认 false 保持栅格化兼容） */
  @IsOptional() @IsBoolean()
  vector?: boolean;

  /** 第二层：印前标记（出血/裁切线/套准线/色标/专色） */
  @IsOptional() @IsObject()
  marks?: PrintMarksOptions;
}

/** PDF 拆分请求体：接收 base64 PDF 或页码范围 */
export class SplitPdfDto {
  /** base64 编码的源 PDF（或 data:application/pdf;base64, 前缀） */
  @IsOptional()
  pdfBase64?: string;

  /** 按页范围拆分（1-based，含首尾）；与 every 二选一 */
  @IsOptional() @IsArray()
  ranges?: Array<{ from: number; to: number }>;

  /** 按固定页数拆分 */
  @IsOptional() @IsInt() @Min(1) @Max(500)
  every?: number;
}

/** 构造水印 SVG 层：无规格 / 未启用 → 空串（对 P8.2 行为零变化） */
function svgWatermarkLayer(b: ExportDto): string {
  const spec = b.watermark ? normalizePolicy({ watermark: b.watermark }).watermark : null;
  if (!spec?.enabled) return '';
  const page = b.templateContent?.page ?? { widthMm: 40, heightMm: 30 };
  const now = new Date();
  return watermarkSvgLayer(spec, page, {
    printDate: now.toISOString().slice(0, 10),
    printTime: now.toISOString().slice(11, 19),
  });
}

@Controller('print/export')
export class PrintExportController {
  /** 整标签真矢量 SVG：返回所有拼版 sheet（前端可逐张下载或合成） */
  @Post('svg')
  svg(@Body() b: ExportDto) {
    try {
      const out = buildExportSvgs({
        templateContent: b.templateContent, rows: b.rows,
        copies: b.copies, serialMap: b.serialMap, collate: b.collate,
        watermarkLayer: svgWatermarkLayer(b),
      });
      let sheets = out.sheets;
      let sheetW = out.sheetWidthMm, sheetH = out.sheetHeightMm;
      const markWarnings: string[] = [];
      if (b.marks && hasAnyMarks(b.marks)) {
        const marked = applyPrintMarks(sheets, sheetW, sheetH, b.marks);
        sheets = marked.sheets; sheetW = marked.sheetWidthMm; sheetH = marked.sheetHeightMm;
        markWarnings.push(...marked.warnings);
      }
      return {
        format: 'svg',
        sheets,
        sheetWidthMm: sheetW,
        sheetHeightMm: sheetH,
        labelCount: out.labelCount,
        perSheet: out.perSheet,
        cols: out.cols,
        rows: out.rows,
        warnings: [...out.warnings, ...markWarnings],
      };
    } catch (e: any) {
      throw new BadRequestException(String(e?.message ?? e));
    }
  }

  /** 多页 PDF：默认 600dpi 位图；vector=true 走真矢量通道；支持印前标记 */
  @Post('pdf')
  async pdf(@Body() b: ExportDto, @Res() res: Response) {
    const watermark = svgWatermarkLayer(b);
    let warnings: string[] = [];
    let pdf: { bytes: Buffer; pageCount: number; warnings: string[] };

    try {
      if (b.vector) {
        // 第二层：真矢量通道。水印层作为额外文本提示（矢量层不叠加像素水印，如实标注）
        const doc = buildVectorDoc({
          templateContent: b.templateContent, rows: b.rows,
          copies: b.copies, serialMap: b.serialMap, collate: b.collate,
        });
        warnings = [...doc.warnings];
        if (watermark) warnings.push('矢量 PDF 不叠加像素水印；如需水印请用 raster PDF 或 SVG 通道');
        // 印前标记：出血平移内容并扩大页面；标记 ops 交给渲染器绘制
        let marks: { ops: any[] } | undefined;
        if (b.marks && hasAnyMarks(b.marks)) {
          const bleed = Math.max(0, Math.min(20, Number(b.marks.bleedMm) || 0));
          translateDocOps(doc, bleed, bleed);
          const marked = applyPrintMarks([], doc.pages[0].widthMm - 2 * bleed, doc.pages[0].heightMm - 2 * bleed, b.marks);
          // 底部标记区额外加在页高上（内容已在顶部，不需要再平移）
          doc.pages.forEach((p) => { p.heightMm = marked.sheetHeightMm; });
          marks = { ops: marked.pdfOps };
          warnings.push(...marked.warnings);
        }
        pdf = await renderVectorPdf(doc, { title: 'LabelFlow Vector Export', textDpi: b.dpi }, marks);
      } else {
        const out = buildExportSvgs({
          templateContent: b.templateContent, rows: b.rows,
          copies: b.copies, serialMap: b.serialMap, collate: b.collate,
          watermarkLayer: watermark,
        });
        warnings = [...out.warnings];
        let sheets = out.sheets;
        let sheetW = out.sheetWidthMm, sheetH = out.sheetHeightMm;
        if (b.marks && hasAnyMarks(b.marks)) {
          const marked = applyPrintMarks(sheets, sheetW, sheetH, b.marks);
          sheets = marked.sheets; sheetW = marked.sheetWidthMm; sheetH = marked.sheetHeightMm;
          warnings.push(...marked.warnings);
        }
        pdf = await sheetsToPdf(sheets, sheetW, sheetH, { dpi: b.dpi, title: 'LabelFlow Label Export' });
        warnings.push(...pdf.warnings);
      }
    } catch (e: any) {
      throw new BadRequestException(`PDF 生成失败：${String(e?.message ?? e)}`);
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="labelflow-${b.vector ? 'vector-' : ''}${Date.now()}.pdf"`,
      'X-LabelFlow-Pages': String(pdf.pageCount),
      'X-LabelFlow-Vector': b.vector ? '1' : '0',
      'X-LabelFlow-Warning-Count': String(warnings.length),
      // header 只放 ASCII：中文 warnings 用 encodeURIComponent，完整文案在 svg 端点里
      'X-LabelFlow-Warnings': encodeURIComponent(warnings.join(' | ')).slice(0, 1800),
      'Cache-Control': 'no-store',
    });
    res.send(pdf.bytes);
  }

  /** 第二层：PDF 拆分。传 base64 PDF + ranges 或 every，返回多段 PDF（JSON base64） */
  @Post('pdf/split')
  async split(@Body() b: SplitPdfDto) {
    if (!b.pdfBase64) throw new BadRequestException('缺少 pdfBase64');
    const bytes = Buffer.from(String(b.pdfBase64).replace(/^data:application\/pdf;base64,/i, ''), 'base64');
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('pdfBase64 不是合法 PDF');
    let parts;
    try {
      parts = b.every
        ? await splitPdfEvery(bytes, b.every)
        : await splitPdfBytes(bytes, b.ranges ?? []);
    } catch (e: any) {
      throw new BadRequestException(`PDF 拆分失败：${String(e?.message ?? e)}`);
    }
    if (!parts.length) throw new BadRequestException('没有有效的拆分范围');
    return {
      format: 'pdf-split',
      parts: parts.map((p) => ({
        from: p.from, to: p.to, pageCount: p.pageCount,
        pdfBase64: p.bytes.toString('base64'),
      })),
      warnings: ['拆分仅重排/分组页面，不重新渲染内容'],
    };
  }
}
