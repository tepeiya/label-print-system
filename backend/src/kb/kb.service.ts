import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KbArticle, KbAssistantLog } from './kb.entity';
import { AiModelConfig } from '../entities/ai-template.entity';
import { decrypt } from '../datasource/sql-crypto';
import {
  searchArticles, composeKbAnswer, buildChatMessages, isConfident,
  type KbArticle as KbArticleShape, type KbHit,
} from './kb.calc';

/** 平台级 AI 配置存放在 ai_model_configs 的 tenant_id = 0（平台自己不是一个租户） */
export const PLATFORM_AI_TENANT = 0;

export interface EffectiveAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 配置来源：租户自己的 / 平台级的 / 环境变量 / 无 */
  source: 'tenant' | 'platform' | 'env' | 'none';
  tenantId: number | null;
}

@Injectable()
export class KbService {
  private logger = new Logger('KbService');

  constructor(
    @InjectRepository(KbArticle) private articles: Repository<KbArticle>,
    @InjectRepository(KbAssistantLog) private logs: Repository<KbAssistantLog>,
    @InjectRepository(AiModelConfig) private models: Repository<AiModelConfig>,
  ) {}

  // ------------------------------------------------------------------ 文章
  async list(q: { category?: string; keyword?: string; limit?: number } = {}) {
    const qb = this.articles.createQueryBuilder('a').where('a.published = true');
    if (q.category) qb.andWhere('a.category = :c', { c: String(q.category) });
    if (q.keyword) {
      const kw = `%${String(q.keyword).trim()}%`;
      qb.andWhere('(a.title ILIKE :kw OR a.tags ILIKE :kw OR a.content ILIKE :kw OR a.summary ILIKE :kw)', { kw });
    }
    const rows = await qb.orderBy('a.sort', 'ASC').addOrderBy('a.id', 'ASC')
      .limit(Math.min(200, Number(q.limit ?? 200))).getMany();
    return {
      items: rows.map((r) => ({
        slug: r.slug, title: r.title, category: r.category, tags: r.tags,
        summary: r.summary, sortOrder: r.sort, updatedAt: r.updatedAt,
        // 列表接口不带全文，避免一次拉几万字
      })),
      categories: await this.categories(),
    };
  }

  async categories() {
    const rows: Array<{ category: string; n: string }> = await this.articles.query(
      `SELECT category, count(*)::text AS n FROM kb_articles WHERE published = true GROUP BY category ORDER BY min(sort)`,
    );
    return rows.map((r) => ({ category: r.category, count: Number(r.n) }));
  }

  async getBySlug(slug: string) {
    const row = await this.articles.findOne({ where: { slug: String(slug) } });
    if (!row || !row.published) throw new NotFoundException(`知识库文章不存在：${slug}`);
    return {
      slug: row.slug, title: row.title, category: row.category, tags: row.tags,
      summary: row.summary, content: row.content, updatedAt: row.updatedAt,
    };
  }

  // ------------------------------------------------------------------ 检索
  private async loadAll(): Promise<KbArticleShape[]> {
    const rows = await this.articles.find({ where: { published: true } });
    return rows.map((r) => ({
      slug: r.slug, title: r.title, category: r.category, tags: r.tags,
      summary: r.summary, content: r.content, sort: r.sort,
    }));
  }

  async search(question: string, limit = 5): Promise<KbHit[]> {
    if (!String(question ?? '').trim()) throw new BadRequestException('问题不能为空');
    return searchArticles(await this.loadAll(), question, limit);
  }

  // ------------------------------------------------------------------ AI 配置
  /**
   * 配置解析顺序（用户明确要求的优先级）：
   *   1. 租户自己的默认模型配置（api_key / endpoint / model 齐全才算可用）
   *   2. 平台级配置（tenant_id = 0）
   *   3. 环境变量（AI_KB_BASE_URL / AI_KB_API_KEY / AI_KB_MODEL）
   *   4. 都没有 → source='none'，助手降级为"知识库原文整理"
   */
  async resolveAiConfig(tenantId?: number | null): Promise<EffectiveAiConfig> {
    const pick = async (tid: number): Promise<EffectiveAiConfig | null> => {
      const row = await this.models.findOne({ where: { tenantId: tid }, order: { isDefault: 'DESC', id: 'ASC' } }).catch(() => null);
      if (!row) return null;
      const apiKey = row.apiKeyEnc ? safeDecrypt(row.apiKeyEnc) : '';
      if (!apiKey || !row.apiEndpoint || !row.modelId) return null;
      return {
        baseUrl: String(row.apiEndpoint).replace(/\/+$/, ''),
        apiKey,
        model: row.modelId,
        temperature: Number(row.settings?.temperature ?? 0.2),
        maxTokens: Number(row.settings?.maxTokens ?? 800),
        source: tid === PLATFORM_AI_TENANT ? 'platform' : 'tenant',
        tenantId: tid,
      };
    };

    if (tenantId != null && Number(tenantId) > 0) {
      const own = await pick(Number(tenantId));
      if (own) return own;
    }
    const platform = await pick(PLATFORM_AI_TENANT);
    if (platform) return platform;

    const envKey = process.env.AI_KB_API_KEY || '';
    const envUrl = process.env.AI_KB_BASE_URL || '';
    const envModel = process.env.AI_KB_MODEL || '';
    if (envKey && envUrl && envModel) {
      return {
        baseUrl: envUrl.replace(/\/+$/, ''), apiKey: envKey, model: envModel,
        temperature: 0.2, maxTokens: 800, source: 'env', tenantId: null,
      };
    }
    return { baseUrl: '', apiKey: '', model: '', temperature: 0.2, maxTokens: 800, source: 'none', tenantId: null };
  }

  /** 平台端"AI 设置"读：只看当前生效来源与可用性（不回显 key 明文） */
  async aiStatus(tenantId?: number | null) {
    const cfg = await this.resolveAiConfig(tenantId);
    return {
      configured: cfg.source !== 'none',
      source: cfg.source,
      model: cfg.model || null,
      baseUrl: cfg.baseUrl ? redactUrl(cfg.baseUrl) : null,
      priority: ['tenant', 'platform', 'env', 'none'],
      note: cfg.source === 'none'
        ? '未配置 AI：助手仍可用，但只返回知识库原文整理'
        : `当前生效：${cfg.source === 'tenant' ? `租户 ${cfg.tenantId} 的模型配置` : cfg.source === 'platform' ? '平台级模型配置' : '环境变量'}`,
    };
  }

  /** 平台端保存平台级 AI 配置（写 ai_model_configs 的 tenant_id=0） */
  async savePlatformAi(dto: { name?: string; provider?: string; apiEndpoint?: string; apiKey?: string; modelId?: string; settings?: any }) {
    if (!dto?.apiEndpoint || !dto?.modelId) throw new BadRequestException('缺少 apiEndpoint / modelId');
    const name = String(dto.name || 'platform-kb-assistant').slice(0, 60);
    const provider = ['qwen', 'openai', 'zhipu', 'ollama', 'custom'].includes(String(dto.provider)) ? String(dto.provider) : 'custom';
    const existing = await this.models.findOne({ where: { tenantId: PLATFORM_AI_TENANT, name } });
    // key 缺省时保留旧值（改模型不想重填 key）
    const apiKeyEnc = dto.apiKey
      ? (await import('../datasource/sql-crypto')).encrypt(String(dto.apiKey))
      : existing?.apiKeyEnc ?? null;
    const row = existing ?? this.models.create({ tenantId: PLATFORM_AI_TENANT, name, provider });
    row.name = name;
    row.provider = provider;
    row.apiEndpoint = String(dto.apiEndpoint);
    row.modelId = String(dto.modelId).slice(0, 120);
    row.apiKeyEnc = apiKeyEnc ?? '';
    row.isDefault = true;
    row.settings = { ...(row.settings ?? {}), ...(dto.settings ?? {}), temperature: Number(dto.settings?.temperature ?? 0.2), maxTokens: Number(dto.settings?.maxTokens ?? 800) };
    await this.models.save(row);
    return { ok: true, name, modelId: row.modelId, source: 'platform' };
  }

  // ------------------------------------------------------------------ 问答
  async ask(question: string, opts: { tenantId?: number | null; limit?: number } = {}) {
    const q = String(question ?? '').trim();
    if (!q) throw new BadRequestException('问题不能为空');
    if (q.length > 1000) throw new BadRequestException('问题过长（≤1000 字）');
    const t0 = Date.now();

    const all = await this.loadAll();
    const hits = searchArticles(all, q, Math.min(5, Number(opts.limit ?? 4)));
    const confident = isConfident(hits);
    const cfg = await this.resolveAiConfig(opts.tenantId ?? null);

    let answer = '';
    let answeredBy: 'kb' | 'llm' | 'llm_failed' = 'kb';
    let model: string | null = null;
    let llmError: string | null = null;

    if (cfg.source !== 'none' && hits.length) {
      const bySlug = new Map(all.map((a) => [a.slug, a]));
      const ctx = hits.map((h) => ({ title: h.title, content: bySlug.get(h.slug)?.content ?? h.snippet }));
      try {
        const res = await this.callChat(cfg, buildChatMessages(q, ctx));
        answer = res.answer;
        model = cfg.model;
        answeredBy = 'llm';
      } catch (e: any) {
        // 模型挂了不能让用户空手：退回知识库整理，并把原因留在日志里
        llmError = String(e?.message ?? e).slice(0, 200);
        this.logger.warn(`kb ask: llm failed, degrade to kb (${llmError})`);
        answeredBy = 'llm_failed';
      }
    }

    if (answeredBy !== 'llm') answer = composeKbAnswer(q, confident ? hits : [], all);

    const durationMs = Date.now() - t0;
    void this.logs.save(this.logs.create({
      question: q.slice(0, 1000),
      tenantId: opts.tenantId ?? null,
      hits: hits.map((h) => ({ slug: h.slug, title: h.title, score: h.score })) as any,
      answeredBy, model, durationMs,
      detail: { confidence: confident, aiSource: cfg.source, llmError } as any,
    })).catch(() => undefined);

    return {
      answer,
      answeredBy,
      aiSource: cfg.source,
      model,
      confident,
      refs: hits.map((h, i) => ({
        tag: `K${i + 1}`, slug: h.slug, title: h.title, category: h.category,
        summary: h.summary, score: h.score, snippet: h.snippet,
      })),
      durationMs,
      note: cfg.source === 'none'
        ? '未配置 AI 模型：当前回答为知识库原文整理。'
        : answeredBy === 'llm_failed'
          ? `AI 调用失败（${llmError ?? '未知'}），已退回知识库原文整理。`
          : null,
    };
  }

  /** OpenAI 兼容的 chat 接口（qwen/openai/zhipu/custom 都走这一套；ollama 走 /api/chat 见下） */
  private async callChat(cfg: EffectiveAiConfig, messages: Array<{ role: string; content: string }>): Promise<{ answer: string; raw?: any }> {
    const isOllama = /:11434$/.test(cfg.baseUrl) || /\/api$/.test(cfg.baseUrl);
    const url = isOllama && !cfg.baseUrl.includes('/v1') ? `${cfg.baseUrl}/api/chat` : `${cfg.baseUrl}/chat/completions`;
    const body = isOllama && !cfg.baseUrl.includes('/v1')
      ? { model: cfg.model, messages, stream: false, options: { temperature: cfg.temperature } }
      : { model: cfg.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream: false };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error('返回不是 JSON'); }
      const answer = json?.choices?.[0]?.message?.content ?? json?.message?.content ?? '';
      if (!String(answer).trim()) throw new Error('模型返回空内容');
      return { answer: String(answer).trim(), raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeDecrypt(enc: string): string {
  try { return decrypt(enc); } catch { return ''; }
}

/** 只暴露"域名大致形态"，不泄露完整 endpoint（可能有 path 里带 key 的土办法） */
function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.hostname}${x.port ? `:${x.port}` : ''}/…`;
  } catch {
    return '已配置';
  }
}
