// =============================================================================
// MCP server 装配层（P5，docs/11 §11.7.1 / D9）——stdio 与 Streamable HTTP 共用。
// 为什么要抽这一层：两种传输只差「怎么连、用哪个 token」，tools / resources / prompts
// 的语义必须完全一致，否则同一个 Agent Token 在本地 stdio 和 SaaS HTTP 下会看到不同能力。
// 继续用 SDK 低层 Server API（P4 决策）：工具清单是后端动态下发的（无静态 zod schema），
// 低层 API 直接透传 inputSchema 最省事，也不引入 zod 依赖。
// =============================================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
  ErrorCode, McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { AgentApiClient, AgentApiError, AgentToolDto } from './client/agent-api.js';
import { listVisibleResources, readResourceUri } from './resources.js';
import {
  PROMPTS, RemotePromptDef, renderPrompt, renderRemotePrompt, toMcpPrompt,
} from './prompts.js';

export interface LabelFlowServerOptions {
  /** 已取到的工具清单；不传则在第一次 tools/list 时向后端要（HTTP 模式会话建立时不阻塞） */
  tools?: AgentToolDto[];
  /** 日志出口：stdio 必须走 stderr，HTTP 模式走带时间戳的 stdout */
  log?: (msg: string, ...rest: unknown[]) => void;
  serverName?: string;
}

export function createLabelFlowServer(api: AgentApiClient, opts: LabelFlowServerOptions = {}): Server {
  const log = opts.log ?? ((m: string, ...r: unknown[]) => console.error('[labelflow-mcp]', m, ...r));
  const server = new Server(
    { name: opts.serverName ?? 'labelflow-agent-mcp', version: '0.1.0' },
    // capabilities 三件套齐声明（§11.7.5）：低层 Server 会按 capabilities 决定能否注册对应 handler
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // ---------------- tools（后端 /agent/v1/tools 动态下发，会话内缓存一次） ----------------
  let toolCache: AgentToolDto[] | null = opts.tools ?? null;
  let toolLoading: Promise<AgentToolDto[]> | null = null;
  const loadTools = async (): Promise<AgentToolDto[]> => {
    if (toolCache) return toolCache;
    // 并发首次 tools/list 时共享同一个请求，避免同会话重复打后端
    toolLoading ??= api.listTools().then((r) => (toolCache = r.data ?? []));
    return toolLoading;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await loadTools();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as never,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const env = await api.callTool(String(name), args);
      const data = env?.data;
      // 统一信封是 {code,message,data:ToolResult}，而 ToolResult = {summary, data, warnings, next_actions}。
      // 后端把 need_approval / idempotent_replay / approval_id 放在 ToolResult.data 这一层
      //（controller 判 202 也是看 result.data.need_approval），所以两层都要取，别只查一层。
      const flags = { ...(data?.data ?? {}), ...(data ?? {}) };
      // §11.7.6：202 need_approval / 幂等命中都是「正常业务状态」，绝不能标 isError，
      // 否则模型会当成失败去重试刷审批单。summary 原样放第一行，紧跟一句「接下来怎么做」，
      // 完整 JSON 放最后——提示不能被埋在大段数据后面，模型经常只读到前半截。
      const notes: string[] = [];
      if (flags.need_approval === true) {
        notes.push(`（这不是错误：高危操作已转入审批，approval_id=${flags.approval_id ?? '见下方 JSON'}。`
          + '请等员工在租户后台确认后，用完全相同的参数并带上 approval_id 重试，idempotency_key 保持不变。）');
      }
      if (flags.idempotent_replay === true) {
        notes.push('（这不是重复执行：本次命中幂等键，返回的是首次执行的结果，重试安全。）');
      }
      if (flags.approval_consumed === true) {
        notes.push('（审批单已核销：本次是审批通过后的真实执行，同一 approval_id 不能再用。）');
      }
      // §11.6.3 统一信封 {summary, data, warnings, next_actions}：摘要给模型读，JSON 给程序读
      const summary = data && typeof data.summary === 'string' ? data.summary : '';
      const text = [summary, notes.join('\n'), JSON.stringify(data ?? env, null, 2)].filter(Boolean).join('\n\n');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      const err = e as AgentApiError;
      const payload: Record<string, unknown> = { error: err?.message ?? String(e) };
      if (err?.envelope?.code) payload.code = err.envelope.code;
      if (err?.envelope?.action) payload.action = err.envelope.action;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }
  });

  // ---------------- resources（labelflow:// URI，正文走 GET /agent/v1/resources） ----------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const authorized = (await loadTools()).map((t) => t.name);
    return { resources: await listVisibleResources(api, log, authorized) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = String(req.params?.uri ?? '');
    const item = await readResourceUri(api, uri);
    // §11.7.5：资源正文是模板/库存的真实 JSON，统一 application/json
    return { contents: [{ uri: item.uri, mimeType: item.mimeType, text: item.text }] };
  });

  // ---------------- prompts（§11.7.5；P6.5 改为服务端下发 + 本地兜底） ----------------
  // 服务端清单 = 系统默认 + 租户覆盖（已过滤 enabled）。60s TTL：租户在后台改完提示词，
  // 正在跑的 MCP 会话最迟一分钟生效，不需要重启客户端。
  // 拉取失败时用本文件 PROMPTS 兜底，并继续返回「上次成功」的缓存（没有就静态），
  // 让「后端抖一下」不至于让模型失去全部提示词。
  let promptCache: RemotePromptDef[] | null = null;
  let promptCacheAt = 0;
  let promptLoading: Promise<RemotePromptDef[] | null> | null = null;
  const PROMPT_TTL_MS = 60_000;
  const loadPrompts = async (): Promise<RemotePromptDef[] | null> => {
    if (promptCache && Date.now() - promptCacheAt < PROMPT_TTL_MS) return promptCache;
    if (!promptLoading) {
      promptLoading = api.listPrompts()
        .then((r) => {
          promptCache = ((r.data ?? []) as RemotePromptDef[]).filter((p) => (p as any).enabled !== false);
          promptCacheAt = Date.now();
          return promptCache;
        })
        .catch((e) => {
          log('prompts 拉取失败，回落内置文案：', (e as Error)?.message ?? e);
          return promptCache;
        })
        .finally(() => { promptLoading = null; });
    }
    return promptLoading;
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const remote = await loadPrompts();
    if (remote) return { prompts: remote.map(toMcpPrompt) };
    return { prompts: PROMPTS.map(toMcpPrompt) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = String(req.params?.name ?? '');
    const args = (req.params?.arguments ?? {}) as Record<string, string>;
    const remote = await loadPrompts();
    if (remote) {
      const def = remote.find((p) => p.name === name);
      if (!def) throw new McpError(ErrorCode.InvalidParams, `未知提示词：${name}`);
      let text: string;
      try {
        text = renderRemotePrompt(def, args);
      } catch (e) {
        throw new McpError(ErrorCode.InvalidParams, (e as Error).message);
      }
      return {
        description: def.description,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      };
    }
    // 后端不可达：用本地静态副本兜底（渲染函数自带默认值，如 days=30）
    let text: string;
    try {
      text = renderPrompt(name, args);
    } catch (e) {
      throw new McpError(ErrorCode.InvalidParams, (e as Error).message);
    }
    const def = PROMPTS.find((p) => p.name === name)!;
    return {
      description: def.description,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  });

  return server;
}
