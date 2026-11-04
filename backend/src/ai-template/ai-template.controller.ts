// AI 模板生成 API
import {
  Controller, Get, Post, Delete, Body, Param, Query, Res,
  UploadedFile, UseInterceptors, UseGuards, BadRequestException, ParseFilePipeBuilder,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../common/tenant.guard';
import { Roles } from '../common/roles.guard';
import { AiTemplateService } from './ai-template.service';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'];

@Controller('ai-template')
@UseGuards(TenantGuard)
export class AiTemplateController {
  constructor(private svc: AiTemplateService) {}

  /** 纯文本描述生成模板：用户用中文描述标签 → LLM 直接输出模板 JSON（不需要图片） */
  @Roles('admin', 'operator')
  @Post('text-to-template')
  textToTemplate(@Body() body: { description: string; widthMm?: number; heightMm?: number }) {
    if (!body.description || typeof body.description !== 'string') {
      throw new BadRequestException('description 不能为空');
    }
    return this.svc.textToTemplate({
      description: body.description,
      widthMm: body.widthMm ? Number(body.widthMm) : undefined,
      heightMm: body.heightMm ? Number(body.heightMm) : undefined,
    });
  }

  /** 主入口：上传图片 + 尺寸 → 生成模板 */
  @Roles('admin', 'operator')
  @Post('generate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async generate(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    if (!file) throw new BadRequestException('缺少图片文件（字段名 file）');
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 jpg / png / webp / tiff 图片');
    }
    const widthMm = Number(body.widthMm ?? body.targetWidthMm);
    const heightMm = Number(body.heightMm ?? body.targetHeightMm);
    const dpi = Number(body.dpi ?? 300);
    if (!(widthMm > 0) || !(heightMm > 0)) {
      throw new BadRequestException('缺少 widthMm / heightMm');
    }
    return this.svc.generate(file.buffer, {
      widthMm,
      heightMm,
      dpi,
      lang: body.lang || undefined,
      useLlm: body.useLlm === 'false' ? false : body.useLlm === 'true' ? true : undefined,
      variableHintKeywords: body.variableHintKeywords
        ? String(body.variableHintKeywords).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
    });
  }

  /** 多联大图批量生成：上传一张包含 rows×cols 个相同标签的大图 → 切格 → 每格跑一次 generate */
  @Roles('admin', 'operator')
  @Post('batch-generate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async batchGenerate(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    if (!file) throw new BadRequestException('缺少图片文件（字段名 file）');
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 jpg / png / webp / tiff 图片');
    }
    const rows = Math.max(1, Math.min(10, Number(body.rows ?? 1)));
    const cols = Math.max(1, Math.min(10, Number(body.cols ?? 1)));
    if (rows * cols > 25) throw new BadRequestException('一次最多生成 25 个标签');

    const widthMm = Number(body.widthMm);
    const heightMm = Number(body.heightMm);
    const dpi = Number(body.dpi ?? 300);
    const gapMm = Number(body.gapMm ?? 0);

    // 动态 import（避免 controller 启动就 sharp load）
    const { tileCrop } = await import('./tile-crop');
    const tiles = await tileCrop(file.buffer, {
      rows, cols, gapMm, dpi,
      tileWidthMm: widthMm || undefined,
      tileHeightMm: heightMm || undefined,
    });

    const results = [];
    for (const tile of tiles) {
      try {
        const result = await this.svc.generate(tile.buf, {
          widthMm: widthMm || 60,
          heightMm: heightMm || 40,
          dpi,
          lang: body.lang || undefined,
          useLlm: body.useLlm === 'false' ? false : body.useLlm === 'true' ? true : undefined,
          variableHintKeywords: body.variableHintKeywords
            ? String(body.variableHintKeywords).split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
        });
        results.push({ row: tile.row, col: tile.col, ...result, _ok: true });
      } catch (e: any) {
        results.push({ row: tile.row, col: tile.col, _ok: false, error: e?.message ?? String(e) });
      }
    }

    const ok = results.filter((r: any) => r._ok).length;
    return { total: results.length, ok, failed: results.length - ok, results };
  }

  /** 单元素重算：前端发现某个元素识别不准时，只重算这一个省 token */
  @Roles('admin', 'operator')
  @Post('regenerate-element')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async regenerateElement(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    if (!file) throw new BadRequestException('缺少图片文件（字段名 file）');
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 jpg / png / webp / tiff 图片');
    }
    const widthMm = Number(body.widthMm);
    const heightMm = Number(body.heightMm);
    const dpi = Number(body.dpi ?? 300);
    if (!(widthMm > 0) || !(heightMm > 0)) {
      throw new BadRequestException('缺少 widthMm / heightMm');
    }
    if (!body.elementId || typeof body.elementId !== 'string') {
      throw new BadRequestException('缺少 elementId');
    }
    let currentElement: any;
    try {
      currentElement = typeof body.currentElement === 'string'
        ? JSON.parse(body.currentElement)
        : body.currentElement;
    } catch {
      throw new BadRequestException('currentElement 不是合法 JSON');
    }
    if (!currentElement || typeof currentElement !== 'object') {
      throw new BadRequestException('缺少 currentElement');
    }
    return this.svc.regenerateElement(file.buffer, {
      widthMm, heightMm, dpi,
      lang: body.lang || undefined,
      useLlm: body.useLlm === 'false' ? false : body.useLlm === 'true' ? true : undefined,
      variableHintKeywords: body.variableHintKeywords
        ? String(body.variableHintKeywords).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      elementId: body.elementId,
      currentElement,
    });
  }

  /** 透视矫正 / 自动裁边：Vision LLM 检测 4 角 → sharp bbox 裁剪，返回 PNG */
  @Roles('admin', 'operator')
  @Post('rectify')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async rectify(@UploadedFile() file: Express.Multer.File, @Body() body: any, @Res() res: any) {
    if (!file) throw new BadRequestException('缺少图片文件（字段名 file）');
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('仅支持 jpg / png / webp / tiff 图片');
    }
    let corners: any = undefined;
    if (body.corners) {
      try { corners = typeof body.corners === 'string' ? JSON.parse(body.corners) : body.corners; }
      catch { throw new BadRequestException('corners 不是合法 JSON'); }
    }
    const result = await this.svc.rectify(file.buffer, { corners });
    // 返回 JSON 元数据 + base64 图片（前端直接 `<img src="data:image/png;base64,${data}">` 预览）
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      code: 0,
      data: {
        bbox: result.bbox,
        originalSize: result.originalSize,
        cornersPx: result.cornersPx,
        cornersConfidence: result.cornersConfidence,
        llmUsed: result.llmUsed,
        llmError: result.llmError,
        elapsedMs: result.elapsedMs,
        dataUrl: `data:image/png;base64,${result.cropped.toString('base64')}`,
      },
    });
  }

  /** 保存为正式模板 */
  @Roles('admin', 'operator')
  @Post('save')
  save(@Body() body: any) { return this.svc.saveAsTemplate(body); }

  /** 最近生成记录 */
  @Get('jobs')
  jobs(@Query() q: any) { return this.svc.listJobs(Number(q.limit ?? 20)); }

  /** 模型配置 */
  @Roles('admin')
  @Get('models')
  listModels() { return this.svc.listModels(); }

  @Roles('admin')
  @Post('models')
  createModel(@Body() body: any) { return this.svc.createModel(body); }

  @Roles('admin')
  @Post('models/:id/test')
  testModel(@Param('id') id: number) { return this.svc.testModel(+id); }

  @Roles('admin')
  @Delete('models/:id')
  removeModel(@Param('id') id: number) { return this.svc.removeModel(+id); }
}
