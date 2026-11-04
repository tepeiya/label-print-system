// AI 模板生成主流程编排
import { Injectable, BadRequestException, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import sharp, { Metadata } from 'sharp';
import { AiModelConfig, AiTemplateJob } from '../entities/ai-template.entity';
import { Template } from '../entities/template.entity';
import { useTenant } from '../common/tenant.context';
import { AuditService } from '../audit/audit.module';
import { encrypt, decrypt } from '../datasource/sql-crypto';
import { detectBarcodes, toGray } from './barcode-reader';
import { recognize, disposeOcr } from './ocr-adapter';
import { detectColorRegions, detectLines } from './geometry';
import { buildTemplateFromPriors, AiWarning } from './heuristics';
import { createMapper } from './coords-transform';
import { buildSystemPrompt, buildUserPrompt, buildSingleElementSystemPrompt, buildSingleElementUserPrompt, buildCornerDetectSystemPrompt, buildCornerDetectUserPrompt, buildTextToTemplateSystemPrompt, buildTextToTemplateUserPrompt } from './prompt';
import { callVision, configFromEnv, extractJson, prepareImageForLlm, VisionConfig } from './vision-llm';
import { validateAiTemplate } from './validate-ai-template';
import { cornersToBbox, extractBbox, normalizeCorners } from './vision-rectify';
import { AiQuotaService } from './ai-quota.service';

export interface GenerateParams {
  widthMm: number;
  heightMm: number;
  dpi: number;
  lang?: string;
  useLlm?: boolean;
  variableHintKeywords?: string[];
}

export interface RegenerateElementParams extends GenerateParams {
  elementId: string;
  currentElement: any;
}

@Injectable()
export class AiTemplateService implements OnModuleDestroy {
  private readonly logger = new Logger('AiTemplate');

  constructor(
    @InjectRepository(AiTemplateJob) private jobs: Repository<AiTemplateJob>,
    @InjectRepository(AiModelConfig) private models: Repository<AiModelConfig>,
    @InjectRepository(Template) private tpl: Repository<Template>,
    private audit: AuditService,
    private quota: AiQuotaService,
  ) {}

  async onModuleDestroy() {
    await disposeOcr().catch(() => { /* ignore */ });
  }

  /** 解析 Vision 配置：DB 默认 > 环境变量 */
  async resolveVisionConfig(tenantId: number): Promise<VisionConfig | null> {
    const row = await this.models.findOne({ where: { tenantId, isDefault: true } }).catch(() => null);
    if (row) {
      const apiKey = row.apiKeyEnc ? this.decryptKey(row.apiKeyEnc) : '';
      if (apiKey && row.apiEndpoint && row.modelId) {
        return {
          baseUrl: row.apiEndpoint.replace(/\/+$/, ''),
          apiKey,
          model: row.modelId,
          temperature: Number(row.settings?.temperature ?? 0),
          maxTokens: Number(row.settings?.maxTokens ?? 4000),
          extra: row.settings?.extra,
        };
      }
    }
    return configFromEnv();
  }

  /** 主流程 */
  async generate(buf: Buffer, params: GenerateParams) {
    const ctx = useTenant();
    const t0 = Date.now();
    const { widthMm, heightMm, dpi } = params;
    if (!(widthMm > 0) || !(heightMm > 0) || !(dpi > 0)) {
      throw new BadRequestException('缺少有效的 widthMm / heightMm / dpi');
    }

    // 0. 基础校验
    let meta: Metadata;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      throw new BadRequestException('图片解码失败（文件损坏或不是图片）');
    }
    const imagePx = { w: meta.width ?? 0, h: meta.height ?? 0 };
    if (!imagePx.w || !imagePx.h) throw new BadRequestException('无法读取图片尺寸');
    if (imagePx.w < 60 || imagePx.h < 60) throw new BadRequestException('图片过小（宽高需 ≥ 60px）');

    const warnings: AiWarning[] = [];
    const warn = (message: string, level: AiWarning['level'] = 'low', elementId?: string) =>
      warnings.push({ level, message, elementId });
    const mapper = createMapper(imagePx, { w: widthMm, h: heightMm });

    // 1. 条码/二维码
    const barcodes = await detectBarcodes(buf).catch((e) => {
      this.logger.warn(`条码识别失败: ${e?.message}`);
      warn(`条码识别失败：${e?.message ?? e}`, 'medium');
      return [];
    });

    // 2. OCR
    const ocr = await recognize(buf, { lang: params.lang }).catch((e) => {
      this.logger.warn(`OCR 失败: ${e?.message}`);
      warn(`OCR 失败：${e?.message ?? e}`, 'high');
      return { lines: [], engine: 'tesseract' as const, warnings: [] as string[], durationMs: 0 };
    });
    for (const w of ocr.warnings ?? []) warn(w, 'medium');

    // 3. 几何
    const gray = await toGray(buf);
    const lines = detectLines(gray.data, gray.width, gray.height);
    const regions = await detectColorRegions(buf).catch(() => []);

    // 4. 彩色区域裁图（作为 image 元素的 src）
    const regionImages: string[] = [];
    for (const rg of regions) {
      try {
        const w = Math.max(1, rg.bboxPx.x1 - rg.bboxPx.x0);
        const h = Math.max(1, rg.bboxPx.y1 - rg.bboxPx.y0);
        const cropped = await sharp(buf)
          .extract({ left: Math.max(0, rg.bboxPx.x0), top: Math.max(0, rg.bboxPx.y0), width: w, height: h })
          .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        regionImages.push(`data:image/png;base64,${cropped.toString('base64')}`);
      } catch {
        regionImages.push('');
      }
    }

    // 5. 启发式初稿
    const heuristic = buildTemplateFromPriors({
      ocr: ocr.lines, barcodes, lines, regions, imagePx,
      targetMm: { w: widthMm, h: heightMm, dpi }, mapper, regionImages,
    });

    // 6. Vision LLM 修正
    let finalTemplate = {
      schemaVersion: 1,
      page: {
        widthMm, heightMm, dpi, orientation: 0, unit: 'mm',
        columns: 1, rows: 1, gapXMm: 2, gapYMm: 2, marginMm: 0,
        copies: 1, duplex: false, mediaType: 'gap', gapMm: 2, blackMarkMm: 3,
        offsetXMm: 0, offsetYMm: 0, calibrateXMm: 0, calibrateYMm: 0, guides: [],
      },
      variables: heuristic.variables,
      elements: heuristic.elements,
    };
    let confidence: Record<string, number> = { ...heuristic.confidence };
    let variableHints: any[] = [...heuristic.variableHints];
    let modelUsed = 'heuristic';
    let llmUsed = false;
    let llmError: string | null = null;

    const visionCfg = params.useLlm === false ? null : await this.resolveVisionConfig(ctx.tenantId);
    if (visionCfg) {
      try {
        const imageDataUrl = await prepareImageForLlm(buf);
        const priors = {
          ocrLines: ocr.lines.map((l) => ({
            text: l.text,
            bboxPx: [l.bboxPx.x0, l.bboxPx.y0, l.bboxPx.x1, l.bboxPx.y1],
            confidence: l.confidence,
          })),
          barcodes: barcodes.map((b) => ({
            format: b.format, text: b.text,
            bboxPx: [b.bboxPx.x0, b.bboxPx.y0, b.bboxPx.x1, b.bboxPx.y1],
          })),
          lines: lines.map((l) => ({ orientation: l.orientation, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 })),
          regions: regions.map((r) => ({
            bboxPx: [r.bboxPx.x0, r.bboxPx.y0, r.bboxPx.x1, r.bboxPx.y1],
            saturation: Math.round(r.saturation * 100) / 100,
          })),
          heuristic: {
            variables: heuristic.variables,
            elements: heuristic.elements.map((e) => ({
              type: e.type, x: e.x, y: e.y, w: e.w, h: e.h,
              text: e.text, content: e.barcode?.content ?? e.qrcode?.content,
            })),
            hints: heuristic.variableHints,
          },
        };

        // 配额检查（Vision 调用属于最贵的 kind）
        await this.quota.checkAndConsume(ctx.tenantId, 'vision');
        const res = await callVision(
          visionCfg,
          imageDataUrl,
          buildSystemPrompt(),
          buildUserPrompt(imagePx, { widthMm, heightMm, dpi }, priors),
        );
        const parsed = extractJson(res.raw);
        const checked = validateAiTemplate(parsed, { widthMm, heightMm, dpi });
        if (checked.template.elements.length) {
          finalTemplate = checked.template as any;
          for (const w of checked.warnings) warn(w, 'medium');
          confidence = this.inheritConfidence(checked.template.elements, heuristic, confidence);
          variableHints = heuristic.variableHints;
          modelUsed = res.model;
          llmUsed = true;
        } else {
          llmError = '模型输出无有效元素，已回退启发式结果';
          warn(llmError, 'medium');
        }
      } catch (e: any) {
        llmError = e?.message ?? String(e);
        this.logger.warn(`Vision LLM 失败，回退启发式: ${llmError}`);
        warn(`AI 视觉模型调用失败（${llmError}），本次结果由本地规则引擎生成`, 'medium');
      }
    } else {
      warn('未配置 AI 视觉模型，本次结果由本地规则引擎生成（可在「AI 模型」中配置 OpenAI 兼容接口）', 'low');
    }

    // 7. 低置信度告警
    for (const el of finalTemplate.elements as any[]) {
      const c = confidence[el.id];
      if (typeof c === 'number' && c < 0.6) {
        warn(`元素 ${el.id}（${el.type}）识别置信度较低（${Math.round(c * 100)}%），建议人工确认`, 'low', el.id);
      }
    }

    const result = {
      template: finalTemplate,
      meta: {
        elapsedMs: Date.now() - t0,
        model: modelUsed,
        llmUsed,
        llmError,
        inputImagePx: imagePx,
        targetMm: { w: widthMm, h: heightMm, dpi },
        engines: { barcode: 'zxing-wasm', ocr: ocr.engine, geometry: 'builtin' },
        counts: {
          barcodes: barcodes.length,
          ocrLines: ocr.lines.length,
          lines: lines.length,
          regions: regions.length,
          elements: finalTemplate.elements.length,
          variables: finalTemplate.variables.length,
        },
        confidence,
        warnings,
        variableHints,
      },
    };

    // 8. 落库（便于前端重放与问题复现）
    try {
      await this.jobs.save({
        tenantId: ctx.tenantId,
        status: 'done',
        params: { widthMm, heightMm, dpi, lang: params.lang, useLlm: params.useLlm !== false },
        result,
        elapsedMs: result.meta.elapsedMs,
        model: modelUsed,
        createdBy: ctx.userId || null,
        finishedAt: new Date(),
        imageBytes: buf.length,
      } as any);
    } catch (e: any) {
      this.logger.warn(`AI 任务落库失败: ${e?.message}`);
    }

    await this.audit.write(ctx.tenantId, 'ai_template.generate', {
      widthMm, heightMm, dpi, elements: finalTemplate.elements.length,
      llmUsed, elapsedMs: result.meta.elapsedMs,
    }, ctx.userId, 'ai_template', undefined);

    return result;
  }

  // ---------------------------------------------------------------------------
  // 单元素重算（省 token 的增量接口）
  // ---------------------------------------------------------------------------

  /** 只修正指定的一个元素——复用 OCR/条码/几何检测 + 单元素 Vision LLM */
  async regenerateElement(buf: Buffer, params: RegenerateElementParams) {
    const ctx = useTenant();
    const t0 = Date.now();
    const { widthMm, heightMm, dpi, elementId, currentElement } = params;
    if (!elementId || typeof elementId !== 'string') {
      throw new BadRequestException('缺少 elementId');
    }
    if (!currentElement || typeof currentElement !== 'object') {
      throw new BadRequestException('缺少 currentElement（前端传来的待修正元素）');
    }
    if (!(widthMm > 0) || !(heightMm > 0) || !(dpi > 0)) {
      throw new BadRequestException('缺少有效的 widthMm / heightMm / dpi');
    }

    // 0. 基础校验
    let meta: Metadata;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      throw new BadRequestException('图片解码失败（文件损坏或不是图片）');
    }
    const imagePx = { w: meta.width ?? 0, h: meta.height ?? 0 };
    if (!imagePx.w || !imagePx.h) throw new BadRequestException('无法读取图片尺寸');

    // 1. 条码/二维码
    const barcodes = await detectBarcodes(buf).catch((e) => {
      this.logger.warn(`[regen-element] 条码识别失败: ${e?.message}`);
      return [];
    });

    // 2. OCR
    const ocr = await recognize(buf, { lang: params.lang }).catch((e) => {
      this.logger.warn(`[regen-element] OCR 失败: ${e?.message}`);
      return { lines: [], engine: 'tesseract' as const, warnings: [] as string[], durationMs: 0 };
    });

    // 3. 几何
    const gray = await toGray(buf);
    const lines = detectLines(gray.data, gray.width, gray.height);
    const regions = await detectColorRegions(buf).catch(() => []);

    // 4. Vision LLM 单元素修正
    const visionCfg = params.useLlm === false ? null : await this.resolveVisionConfig(ctx.tenantId);
    if (!visionCfg) {
      throw new BadRequestException('未配置 AI 视觉模型（需要先在「AI 模型」里设置默认模型）');
    }

    let fixedElement: any = null;
    let confidence = 0.5;
    let llmError: string | null = null;
    let model = visionCfg.model;

    try {
      await this.quota.checkAndConsume(ctx.tenantId, 'vision');
      const imageDataUrl = await prepareImageForLlm(buf);
      const res = await callVision(
        visionCfg,
        imageDataUrl,
        buildSingleElementSystemPrompt(),
        buildSingleElementUserPrompt(
          imagePx,
          { widthMm, heightMm, dpi },
          {
            elementId,
            currentElement,
            ocrLines: ocr.lines.map((l) => ({
              text: l.text,
              bboxPx: [l.bboxPx.x0, l.bboxPx.y0, l.bboxPx.x1, l.bboxPx.y1],
              confidence: l.confidence,
            })),
            barcodes: barcodes.map((b) => ({
              format: b.format, text: b.text,
              bboxPx: [b.bboxPx.x0, b.bboxPx.y0, b.bboxPx.x1, b.bboxPx.y1],
            })),
            lines: lines.map((l) => ({ orientation: l.orientation, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 })),
            regions: regions.map((r) => ({
              bboxPx: [r.bboxPx.x0, r.bboxPx.y0, r.bboxPx.x1, r.bboxPx.y1],
              saturation: Math.round(r.saturation * 100) / 100,
            })),
            variableHints: params.variableHintKeywords,
          },
        ),
      );

      const parsed = extractJson(res.raw);
      if (parsed?.element && typeof parsed.element === 'object') {
        const el = parsed.element;
        // 强制保留 elementId——前端要原地替换
        el.id = elementId;
        fixedElement = el;
        confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
        model = res.model;
      } else {
        llmError = '模型输出缺少 element 字段';
      }
    } catch (e: any) {
      llmError = e?.message ?? String(e);
      this.logger.warn(`[regen-element] Vision LLM 失败: ${llmError}`);
      // LLM 失败回退：返回启发式 currentElement 本身，confidence 给 0.3
      fixedElement = { ...currentElement, id: elementId };
      confidence = 0.3;
    }

    const warnings: AiWarning[] = [];
    if (confidence < 0.5) {
      warnings.push({ level: 'medium', message: `元素 ${elementId} 重算置信度较低（${Math.round(confidence * 100)}%），建议人工确认`, elementId });
    }

    const elapsedMs = Date.now() - t0;
    await this.audit.write(ctx.tenantId, 'ai_template.regenerate_element', {
      elementId, originalType: currentElement?.type,
      fixedType: fixedElement?.type, llmError, elapsedMs,
    }, ctx.userId, 'ai_template_element');

    return {
      element: fixedElement,
      confidence,
      warnings,
      model,
      llmUsed: true,
      llmError,
      elapsedMs,
    };
  }

  // ---------------------------------------------------------------------------
  // 透视矫正（Vision LLM 自动检测四边 + sharp bbox 裁剪）
  // ---------------------------------------------------------------------------

  async rectify(buf: Buffer, params: { corners?: any[] | any } = {}) {
    const ctx = useTenant();
    const t0 = Date.now();

    let meta: Metadata;
    try { meta = await sharp(buf).metadata(); } catch { throw new BadRequestException('图片解码失败'); }
    const imgW = meta.width ?? 0, imgH = meta.height ?? 0;
    if (!imgW || !imgH) throw new BadRequestException('无法读取图片尺寸');

    // 1. 取 corners：优先用前端手动传的，否则 Vision LLM 检测
    let corners = params.corners ? normalizeCorners(params.corners) : null;
    let llmUsed = false;
    let llmConfidence = 0;
    let llmError: string | null = null;

    if (!corners) {
      llmUsed = true;
      const visionCfg = await this.resolveVisionConfig(ctx.tenantId).catch(() => null);
      if (!visionCfg) {
        throw new BadRequestException('未配置 AI 视觉模型，无法自动检测四边。请手动传入 corners（前端 canvas 点选 4 点）');
      }
      try {
        await this.quota.checkAndConsume(ctx.tenantId, 'vision');
        const imageDataUrl = await prepareImageForLlm(buf);
        const res = await callVision(
          visionCfg,
          imageDataUrl,
          buildCornerDetectSystemPrompt(),
          buildCornerDetectUserPrompt(),
        );
        const parsed = extractJson(res.raw);
        corners = normalizeCorners(parsed?.corners) ?? null;
        llmConfidence = typeof parsed?.confidence === 'number' ? parsed.confidence : 0;
        if (!corners) throw new Error('模型输出缺少合法 corners');
      } catch (e: any) {
        llmError = e?.message ?? String(e);
        this.logger.warn(`[rectify] Vision LLM 检测四边失败: ${llmError}`);
        throw new BadRequestException(`AI 自动检测失败：${llmError}。请手动传入 corners 参数（4 个角点 px 坐标）`);
      }
    }

    // 2. 取 bbox + sharp extract
    const bbox = cornersToBbox(corners, imgW, imgH, 0.01);
    if (bbox.width < imgW * 0.1 || bbox.height < imgH * 0.1) {
      throw new BadRequestException('裁剪区域过小，可能 corners 不准。corners 需要覆盖图片主要标签区域');
    }
    const cropped = await extractBbox(buf, bbox);
    const elapsedMs = Date.now() - t0;

    await this.audit.write(ctx.tenantId, 'ai_template.rectify', {
      llmUsed, llmConfidence, bbox, originalSize: { w: imgW, h: imgH }, elapsedMs,
    }, ctx.userId);

    return {
      cropped,
      bbox,
      originalSize: { w: imgW, h: imgH },
      cornersPx: corners,
      cornersConfidence: llmConfidence,
      llmUsed,
      llmError,
      elapsedMs,
    };
  }

  // ---------------------------------------------------------------------------
  // 纯文本描述生成模板（text-only，不需要图片）
  // ---------------------------------------------------------------------------

  async textToTemplate(params: { description: string; widthMm?: number; heightMm?: number }) {
    const ctx = useTenant();
    const t0 = Date.now();
    if (!params.description?.trim()) {
      throw new BadRequestException('description 不能为空');
    }

    // 配额检查（vision kind 算 text generation 的同类）
    await this.quota.checkAndConsume(ctx.tenantId, 'vision');

    const visionCfg = await this.resolveVisionConfig(ctx.tenantId).catch(() => null);
    if (!visionCfg) {
      throw new BadRequestException('未配置 AI 视觉模型');
    }

    const sizeHint = params.widthMm && params.heightMm
      ? { widthMm: params.widthMm, heightMm: params.heightMm }
      : undefined;

    const res = await callVision(
      visionCfg,
      null,   // ← text-only，不传图片
      buildTextToTemplateSystemPrompt(),
      buildTextToTemplateUserPrompt(params.description, sizeHint),
      60000,
    );

    const parsed = extractJson(res.raw);
    if (!parsed || !Array.isArray(parsed.elements) || !parsed.page) {
      throw new BadRequestException(`LLM 输出不是合法模板 JSON：${res.raw.slice(0, 300)}`);
    }
    const widthMm = params.widthMm ?? parsed.page?.widthMm ?? 60;
    const heightMm = params.heightMm ?? parsed.page?.heightMm ?? 40;
    const validated = validateAiTemplate(parsed, { widthMm, heightMm, dpi: parsed.page?.dpi ?? 300 });

    await this.audit.write(ctx.tenantId, 'ai_template.text_to_template', {
      elementCount: validated.template.elements.length, elapsedMs: Date.now() - t0,
    }, ctx.userId);

    return { template: validated.template, warnings: validated.warnings, elapsedMs: Date.now() - t0, model: visionCfg.model };
  }

  /** 用启发式 bbox 与 LLM 元素做 IoU 匹配，继承置信度 */
  private inheritConfidence(elements: any[], heuristic: any, existing: Record<string, number>): Record<string, number> {
    const conf: Record<string, number> = {};
    const boxes = heuristic.elements.map((e: any) => ({
      id: e.id, x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h, c: existing[e.id] ?? 0.8,
    }));
    for (const el of elements) {
      const x0 = el.x, y0 = el.y, x1 = el.x + el.w, y1 = el.y + el.h;
      let best = 0, bestC = 0.85;
      for (const b of boxes) {
        const ix = Math.max(0, Math.min(x1, b.x1) - Math.max(x0, b.x0));
        const iy = Math.max(0, Math.min(y1, b.y1) - Math.max(y0, b.y0));
        const inter = ix * iy;
        const uni = (x1 - x0) * (y1 - y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
        const iou = uni > 0 ? inter / uni : 0;
        if (iou > best) { best = iou; bestC = b.c; }
      }
      conf[el.id] = best > 0.3 ? bestC : 0.85;
    }
    return conf;
  }

  /** 最近生成记录 */
  async listJobs(limit = 20) {
    const ctx = useTenant();
    const rows = await this.jobs.find({
      where: { tenantId: ctx.tenantId },
      order: { id: 'DESC' },
      take: Math.min(50, Math.max(1, limit)),
    });
    return rows.map((r) => ({
      id: r.id, status: r.status, model: r.model, elapsedMs: r.elapsedMs,
      createdAt: r.createdAt, params: r.params,
      counts: r.result?.meta?.counts ?? null,
    }));
  }

  /** 保存生成结果为正式模板 */
  async saveAsTemplate(body: { template: any; name?: string; category?: string }) {
    const ctx = useTenant();
    if (!body?.template?.page || !Array.isArray(body.template.elements)) {
      throw new BadRequestException('template 不合法');
    }
    const name = body.name || `AI 生成 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const saved = await this.tpl.save({
      tenantId: ctx.tenantId,
      name,
      category: body.category ?? 'AI 生成',
      tags: ['ai-generated'],
      schemaVersion: 1,
      content: body.template,
      currentVersion: 1,
      createdBy: ctx.userId || null,
      updatedBy: ctx.userId || null,
    } as any);
    await this.audit.write(ctx.tenantId, 'ai_template.save', { templateId: saved.id, name }, ctx.userId, 'template', saved.id);
    return { id: saved.id, name: saved.name };
  }

  /** 模型配置 CRUD */
  async listModels() {
    const ctx = useTenant();
    const rows = await this.models.find({ where: { tenantId: ctx.tenantId }, order: { id: 'ASC' } });
    return rows.map((r) => ({
      id: r.id, name: r.name, provider: r.provider, apiEndpoint: r.apiEndpoint,
      modelId: r.modelId, isDefault: r.isDefault,
      apiKeySet: !!r.apiKeyEnc,
      settings: r.settings,
      createdAt: r.createdAt,
    }));
  }

  async createModel(dto: any) {
    const ctx = useTenant();
    if (!dto?.name || !dto?.modelId || !dto?.apiEndpoint) {
      throw new BadRequestException('缺少 name / modelId / apiEndpoint');
    }
    if (dto.isDefault) {
      await this.models.update({ tenantId: ctx.tenantId }, { isDefault: false });
    }
    const row = await this.models.save({
      tenantId: ctx.tenantId,
      name: String(dto.name),
      provider: String(dto.provider ?? 'openai'),
      apiEndpoint: String(dto.apiEndpoint),
      modelId: String(dto.modelId),
      apiKeyEnc: dto.apiKey ? this.encryptKey(String(dto.apiKey)) : null,
      isDefault: !!dto.isDefault,
      settings: dto.settings ?? {},
    } as any);
    await this.audit.write(ctx.tenantId, 'ai_model.create', { id: row.id, name: row.name, modelId: row.modelId }, ctx.userId, 'ai_model', row.id);
    return { id: row.id };
  }

  async removeModel(id: number) {
    const ctx = useTenant();
    await this.models.delete({ id, tenantId: ctx.tenantId });
    await this.audit.write(ctx.tenantId, 'ai_model.delete', { id }, ctx.userId, 'ai_model', id);
    return { ok: true };
  }

  /** 测试模型连通性 */
  async testModel(id: number) {
    const ctx = useTenant();
    const row = await this.models.findOne({ where: { id, tenantId: ctx.tenantId } });
    if (!row) throw new BadRequestException('模型配置不存在');
    const apiKey = row.apiKeyEnc ? this.decryptKey(row.apiKeyEnc) : '';
    if (!apiKey) throw new BadRequestException('该配置未设置 API Key');
    const { pingVision } = await import('./vision-llm');
    return pingVision({ baseUrl: row.apiEndpoint.replace(/\/+$/, ''), apiKey, model: row.modelId });
  }

  private encryptKey(plain: string): string {
    // 复用 SQL 数据源的 AES-256-GCM 实现，避免两套密钥管理
    return encrypt(plain);
  }

  private decryptKey(enc: string): string {
    try {
      return decrypt(enc);
    } catch {
      return '';
    }
  }
}
