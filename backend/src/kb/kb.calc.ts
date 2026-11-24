/**
 * 知识库检索与回答编排的纯函数层（D6 知识库 / AI 助手）。
 *
 * 为什么单独抽出来：检索打分、prompt 拼装、降级答案这三个最容易"改一处坏一处"，
 * 抽成纯函数就能用 node --test 覆盖，不必起 Nest、不必连库。
 */

export interface KbArticle {
  slug: string;
  title: string;
  category: string;
  tags: string;
  summary: string | null;
  content: string;
  sort?: number;
}

export interface KbHit {
  slug: string;
  title: string;
  category: string;
  summary: string;
  score: number;
  /** 与问题最相关的一小段原文，给前端展示"凭什么这样答" */
  snippet: string;
}

/** 把问题切成词：中文按 2-4 字滑窗 + 英文/数字按词，去掉标点与停用词 */
export function tokenize(q: string): string[] {
  const raw = String(q ?? '').toLowerCase();
  const cleaned = raw.replace(/[\s，。？！、；：“”‘’（）【】《》…—,.?!;:()"'<>]+/g, ' ');
  const latin = cleaned.match(/[a-z0-9_.\-]{2,}/g) ?? [];
  const cjkChunks = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const out = new Set<string>(latin);
  for (const chunk of cjkChunks) {
    // 双字起步：太长的问题整块匹配不上，滑窗能提高召回
    for (let i = 0; i + 2 <= chunk.length; i += 1) out.add(chunk.slice(i, i + 2));
    if (chunk.length >= 4) out.add(chunk);
  }
  // 高频但无区分度的词
  const stop = new Set(['怎么', '如何', '什么', '为什', '么办', '可以', '能不', '不能', '一个', '这个', '那个', '是不', '不是', '请问', '帮我', '系统', '标签', '应该']);
  return [...out].filter((t) => !stop.has(t));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

/** 取命中最密的一段作为 snippet（按 token 命中数找窗口，不引整篇） */
export function bestSnippet(content: string, tokens: string[], width = 160): string {
  const text = String(content ?? '');
  if (!text) return '';
  if (!tokens.length) return text.slice(0, width);
  let bestAt = 0;
  let bestScore = -1;
  const step = Math.max(1, Math.floor(width / 4));
  for (let at = 0; at < text.length; at += step) {
    const win = text.slice(at, at + width).toLowerCase();
    const score = tokens.reduce((s, t) => s + countOccurrences(win, t), 0);
    if (score > bestScore) { bestScore = score; bestAt = at; }
  }
  const head = bestAt === 0 ? '' : '…';
  const tail = bestAt + width >= text.length ? '' : '…';
  return head + text.slice(bestAt, bestAt + width).replace(/\n+/g, ' ').trim() + tail;
}

/**
 * 打分：标题命中权重最高，其次标签，最后正文；命中个数 × 权重。
 * 不用 TF-IDF：知识库只有十几篇，权重稳定比统计模型更可控、也更好解释。
 */
export function scoreArticle(a: KbArticle, tokens: string[]): number {
  if (!tokens.length) return 0;
  const title = String(a.title ?? '').toLowerCase();
  const tags = String(a.tags ?? '').toLowerCase();
  const summary = String(a.summary ?? '').toLowerCase();
  const body = String(a.content ?? '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 6;
    if (tags.includes(t)) score += 3;
    if (summary.includes(t)) score += 2;
    score += Math.min(3, countOccurrences(body, t)); // 正文同一词最多计 3 次，防单篇刷分
  }
  return score;
}

/** 检索：过滤 0 分，按分数降序，同分按 sort/标题稳定排序 */
export function searchArticles(articles: KbArticle[], question: string, limit = 5): KbHit[] {
  const tokens = tokenize(question);
  const scored = articles
    .map((a) => ({ a, score: scoreArticle(a, tokens) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || (x.a.sort ?? 100) - (y.a.sort ?? 100) || x.a.title.localeCompare(y.a.title));
  return scored.slice(0, limit).map(({ a, score }) => ({
    slug: a.slug,
    title: a.title,
    category: a.category,
    summary: (a.summary ?? '').slice(0, 200),
    score,
    snippet: bestSnippet(a.content, tokens),
  }));
}

/** 给模型的 system prompt：只许用给定片段，不许编 */
export const KB_SYSTEM_PROMPT = [
  '你是 LabelFlow 标签打印与 UDI 合规系统的使用助手。',
  '规则：',
  '1. 只能依据 <knowledge> 里给出的资料回答；资料没写的内容一律回答“知识库没有写这部分，建议联系管理员”，不要推测。',
  '2. 回答用中文，先给结论，再给可执行步骤（1. 2. 3.）。单个问题不超过 300 字。',
  '3. 涉及具体数据（某张工单、某个库存数量）时，告诉用户去哪个页面查，不要假装能查到。',
  '4. 不要编造按钮名、接口名、错误码。',
  '5. 末尾用一行标注你依据的文章编号，如“依据：K1、K3”。',
].join('\n');

/** 拼 user message：把命中文章编号化，便于模型引用、也便于前端对齐 */
export function buildChatMessages(question: string, hits: Array<{ title: string; content: string }>) {
  const knowledge = hits
    .map((h, i) => `[K${i + 1}] 标题：${h.title}\n${h.content.slice(0, 4000)}`)
    .join('\n\n---\n\n');
  return [
    { role: 'system' as const, content: KB_SYSTEM_PROMPT },
    { role: 'user' as const, content: `<knowledge>\n${knowledge || '（无匹配资料）'}\n</knowledge>\n\n用户问题：${question}` },
  ];
}

/**
 * 没有可用模型时的降级答案：只详述**最相关的那一篇**的开头一段，
 * 其余命中降级为"延伸阅读"标题，避免四五篇原文拼在一起、答非所问。
 * 明确标注未配置 AI，避免用户以为这是模型生成的判断。
 */
export function composeKbAnswer(question: string, hits: KbHit[], articles: KbArticle[]): string {
  if (!hits.length) {
    return [
      `没有找到与「${question.trim()}」相关的知识库内容。`,
      '',
      '可以试试：',
      '1. 换成现象描述（例如“PDA 扫箱码后库存没变”）；',
      '2. 用页面名或模块名提问（例如“发料作业 退料”）；',
      '3. 在左侧「知识库」里按分类浏览。',
    ].join('\n');
  }
  const bySlug = new Map(articles.map((a) => [a.slug, a]));
  const top = hits[0];
  const body = bySlug.get(top.slug)?.content ?? top.snippet ?? '';
  // 只摘前 10 个非空行：够讲清第一步，又不会把整篇贴进 400px 宽的对话气泡
  const lead = body.split('\n').filter((l) => l.trim()).slice(0, 10).join('\n');
  const others = hits.slice(1, 4);

  return [
    '> 未配置 AI 模型，以下是知识库原文里最相关的一段（不是模型生成）。',
    '',
    `**${top.title}**（${top.category}）`,
    lead,
    ...(others.length
      ? ['', '**延伸阅读**', ...others.map((h, i) => `- K${i + 2} ${h.title}（${h.category}）${h.summary ? `—— ${h.summary}` : ''}`)]
      : []),
    '',
    `依据：${hits.slice(0, 4).map((_, i) => `K${i + 1}`).join('、')}`,
  ].join('\n');
}

/** 命中数太少就认为"没找到"，避免给一堆弱相关答案 */
export function isConfident(hits: KbHit[]): boolean {
  return hits.length > 0 && hits[0].score >= 6;
}
