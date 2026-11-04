// Vision LLM 适配器：OpenAI 兼容协议（/v1/chat/completions）
// 可对接 OpenAI 官方，也可对接任何 OpenAI 兼容网关（Qwen / 智谱 / Ollama / 自建）。
import sharp from 'sharp';

export interface VisionConfig {
  /** 形如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 额外请求体字段（部分网关需要） */
  extra?: Record<string, any>;
}

export interface VisionResult {
  /** 模型返回的原始文本（应为 JSON 字符串） */
  raw: string;
  model: string;
  durationMs: number;
  usage?: any;
}

/** 从环境变量读取默认配置 */
export function configFromEnv(): VisionConfig | null {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_VISION_API_KEY || '';
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || process.env.AI_VISION_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: process.env.OPENAI_MODEL || process.env.AI_VISION_MODEL || 'gpt-4o',
    temperature: 0,
    maxTokens: 4000,
  };
}

/** 压缩图片供模型读取：长边 ≤ 1280，JPEG q=80，控制在 ~1MB 内 */
export async function prepareImageForLlm(buf: Buffer): Promise<string> {
  const meta = await sharp(buf).metadata();
  const maxSide = 1280;
  let pipeline = sharp(buf).flatten({ background: '#ffffff' });
  if (meta.width && meta.height && Math.max(meta.width, meta.height) > maxSide) {
    pipeline = pipeline.resize({ width: meta.width >= meta.height ? maxSide : undefined, height: meta.height > meta.width ? maxSide : undefined, fit: 'inside' });
  }
  const out = await pipeline.jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

/**
 * 调用 Vision 模型，要求返回 JSON。
 * @param imageDataUrl  data:image/jpeg;base64,...
 * @param systemPrompt  系统提示词（含输出契约）
 * @param userText      用户提示词（含尺寸/OCR/条码先验）
 */
export async function callVision(
  cfg: VisionConfig,
  imageDataUrl: string | null | undefined,
  systemPrompt: string,
  userText: string,
  timeoutMs = 90000,
): Promise<VisionResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const userContent: any[] = [{ type: 'text', text: userText }];
    if (imageDataUrl) {
      userContent.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } });
    }
    const body: any = {
      model: cfg.model,
      temperature: cfg.temperature ?? 0,
      max_tokens: cfg.maxTokens ?? 4000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      ...(cfg.extra ?? {}),
    };

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
      throw new Error(`Vision LLM 调用失败：${msg}`);
    }
    const raw = json?.choices?.[0]?.message?.content ?? '';
    if (!raw) throw new Error('Vision LLM 返回内容为空');
    return { raw: String(raw), model: cfg.model, durationMs: Date.now() - t0, usage: json?.usage };
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出中提取 JSON（容忍 ```json 包裹 / 前后废话） */
export function extractJson(raw: string): any {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试括号截取 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    try { return JSON.parse(slice); } catch { /* ignore */ }
  }
  throw new Error('Vision LLM 输出不是合法 JSON');
}

/** 健康检查：一次极小的文本请求，确认 key/endpoint 可用 */
export async function pingVision(cfg: VisionConfig, timeoutMs = 20000): Promise<{ ok: boolean; message?: string; durationMs: number }> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: json?.error?.message || `HTTP ${res.status}`, durationMs: Date.now() - t0 };
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), durationMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
