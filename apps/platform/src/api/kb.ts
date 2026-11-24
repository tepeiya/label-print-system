import http from './index';

/** 知识库列表项（不带全文） */
export interface KbArticleItem {
  slug: string;
  title: string;
  category: string;
  /** 后端是空格分隔的 text 列（如 "登录 首页 入门"），不是数组 */
  tags: string | null;
  summary: string | null;
  sortOrder: number;
  updatedAt: string;
}

/** 单篇全文 */
export interface KbArticleDetail extends KbArticleItem {
  content: string;
}

export interface KbCategory {
  category: string;
  count: number;
}

export interface KbArticleList {
  items: KbArticleItem[];
  categories: KbCategory[];
}

export interface KbHit {
  slug: string;
  title: string;
  category: string;
  summary: string | null;
  score: number;
  snippet: string;
}

/** 助手回答里引用的知识库文章 */
export interface KbRef {
  tag: string;
  slug: string;
  title: string;
  category: string;
  summary: string | null;
  score: number;
  snippet: string;
}

export type KbAiSource = 'tenant' | 'platform' | 'env' | 'none';

export interface KbAskResult {
  answer: string;
  answeredBy: 'llm' | 'kb' | 'llm_failed';
  aiSource: KbAiSource;
  model: string | null;
  confident: boolean;
  refs: KbRef[];
  durationMs: number;
  note: string | null;
}

export interface KbAiStatus {
  configured: boolean;
  source: KbAiSource;
  model: string | null;
  baseUrl: string | null;
  priority: string[];
  note: string;
}

export interface KbAiConfigPayload {
  name?: string;
  provider?: string;
  apiEndpoint: string;
  apiKey: string;
  modelId: string;
}

/** 文章列表：category / keyword 过滤，limit 缺省由后端兜底 */
export const apiKbArticles = (q: { category?: string; keyword?: string; limit?: number } = {}) =>
  http.get<KbArticleList>('/kb/articles', { params: q });

export const apiKbCategories = () => http.get<KbCategory[]>('/kb/categories');

export const apiKbArticle = (slug: string) => http.get<KbArticleDetail>(`/kb/articles/${slug}`);

export const apiKbSearch = (q: string, limit = 5) =>
  http.get<KbHit[]>('/kb/search', { params: { q, limit } });

/** 问答：tenantId 传了就按该租户的 AI 配置优先解析（平台身份才拿得到租户配置） */
export const apiKbAsk = (question: string, opts: { tenantId?: number | null; limit?: number } = {}) =>
  http.post<KbAskResult>('/kb/assistant/ask', {
    question,
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });

export const apiKbStatus = (tenantId?: number | null) =>
  http.get<KbAiStatus>('/kb/assistant/status', {
    params: tenantId ? { tenantId } : {},
    silent: true,
  });

/** 保存平台级 AI 配置（后端写 ai_model_configs 的 tenant_id=0，key 加密存储不回显） */
export const apiKbSaveConfig = (data: KbAiConfigPayload) =>
  http.post<{ ok: boolean; name: string; modelId: string; source: string }>('/kb/assistant/config', data);
