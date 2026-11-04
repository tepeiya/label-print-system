// AI 模板生成 API
import {
  Controller, Get, Post, Delete, Body, Param, Query,
  UploadedFile, UseInterceptors, UseGuards, BadRequestException, ParseFilePipeBuilder,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../common/tenant.guard';
import { Roles } from '../common/roles.guard';
import { AiTemplateService } from './ai-template.service';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'];

@Controller('ai-template')
@UseGuards(TenantGuard)
export class AiTemplateController {
  constructor(private svc: AiTemplateService) {}

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
