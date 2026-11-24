import http from './index';

export type KbAiSource = 'tenant' | 'platform' | 'env' | 'none';

export interface AssistantRef {
  tag: string;
  slug: string;
  title: string;
  category: string;
  summary: string | null;
  score: number;
  snippet: string;
}

export interface AssistantAnswer {
  answer: string;
  answeredBy: 'llm' | 'kb' | 'llm_failed';
  aiSource: KbAiSource;
  model: string | null;
  confident: boolean;
  refs: AssistantRef[];
  durationMs: number;
  note: string | null;
}

export interface AssistantStatus {
  configured: boolean;
  source: KbAiSource;
  model: string | null;
  baseUrl: string | null;
  note: string;
}

export interface AssistantSuggestion {
  slug: string;
  title: string;
  category: string;
  question: string;
}

export interface AssistantArticle {
  slug: string;
  title: string;
  category: string;
  summary: string | null;
  content: string;
}

/** 问答：后端只用租户层知识库，租户 id 由 token 上下文决定（前端不传） */
export const apiAssistantAsk = (question: string, limit?: number): Promise<AssistantAnswer> =>
  http.post('/assistant/ask', { question, ...(limit ? { limit } : {}) }, { timeout: 60_000 });

export const apiAssistantStatus = (): Promise<AssistantStatus> => http.get('/assistant/status', { silent: true });

export const apiAssistantSuggestions = (limit = 6): Promise<{ items: AssistantSuggestion[] }> =>
  http.get('/assistant/suggestions', { params: { limit }, silent: true });

export const apiAssistantArticle = (slug: string): Promise<AssistantArticle> =>
  http.get(`/assistant/articles/${encodeURIComponent(slug)}`);
