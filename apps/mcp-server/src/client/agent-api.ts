// /agent/v1 瘦客户端（docs/11 §11.7.1）：只带 Agent Token 打 REST，不持任何数据库凭证。
// 一个实例 = 一个 token = 一个租户：stdio 模式下一进程一个；HTTP 模式下每个会话一个（P5，§11.7.1）。
// token 可由构造函数显式传入，HTTP 入口就是用它把 header 里的 token 绑到对应会话。

export interface AgentToolDto {
  name: string;
  title?: string;
  description: string;
  permission: string | null;
  modules: string[];
  risk?: string;
  implemented?: boolean;
  inputSchema: Record<string, unknown>;
}

/** 租户 Prompt 库（P6.5，GET /agent/v1/prompts）：正文已在后端与租户覆盖合并，enabled 已过滤 */
export interface AgentPromptDto {
  name: string;
  title: string;
  description: string;
  arguments: Array<{
    name: string; title?: string; description?: string; required?: boolean; default?: string;
  }>;
  content: string;
  enabled: boolean;
  sortOrder: number;
  source?: 'system' | 'custom';
  overridden?: boolean;
}

export interface Envelope<T = any> {
  code: number;
  message: string;
  data: T;
  [k: string]: any;
}

export class AgentApiError extends Error {
  constructor(public httpStatus: number, public envelope: Envelope | null, message: string) {
    super(message);
  }
}

export class AgentApiClient {
  private base: string;
  private token: string;

  constructor(base?: string, token?: string) {
    this.base = (base ?? process.env.AGENT_API_BASE ?? 'http://127.0.0.1:3200/api/v1').replace(/\/+$/, '');
    this.token = token ?? process.env.AGENT_TOKEN ?? '';
    if (!this.token) {
      throw new Error('缺少 AGENT_TOKEN（在租户后台「Agent 管理」签发，形如 lfagent_…）');
    }
  }

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    let json: Envelope<T> | null = null;
    try { json = (await res.json()) as Envelope<T>; } catch { /* 非 JSON 响应 */ }
    if (!res.ok || (json && json.code !== 0)) {
      const msg = json?.message ?? `HTTP ${res.status}`;
      throw new AgentApiError(res.status, json, msg);
    }
    return json!;
  }

  whoami() { return this.req('GET', '/agent/v1/whoami'); }
  listTools() { return this.req<AgentToolDto[]>('GET', '/agent/v1/tools'); }
  /** P6.5：系统默认 + 租户覆盖合并后的启用提示词（MCP prompts/list 的来源） */
  listPrompts() { return this.req<AgentPromptDto[]>('GET', '/agent/v1/prompts'); }
  callTool(name: string, args: Record<string, unknown>) {
    return this.req('POST', `/agent/v1/tools/${encodeURIComponent(name)}`, args ?? {});
  }
  /** MCP ReadResource 的后端来源（§11.7.5：kind = template | stock） */
  getResource(kind: string, id: string) {
    return this.req('GET', `/agent/v1/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  }
}
