#!/usr/bin/env node
// =============================================================================
// LabelFlow Agent MCP server —— stdio 入口（P4，docs/11 §11.7.1）
// 启动流程：读 AGENT_TOKEN → GET whoami 确认身份 → GET tools 拉当前 scope 可见工具
// → 逐个注册进 MCP。工具调用 = POST /agent/v1/tools/:name，返回值整体转文本块。
// 注意：日志一律走 stderr（stdout 是 JSON-RPC 通道）。
// =============================================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentApiClient, AgentApiError } from './client/agent-api.js';

const log = (...a: unknown[]) => console.error('[labelflow-mcp]', ...a);

const api = new AgentApiClient();

let whoamiText = '（whoami 获取失败）';
try {
  const env = await api.whoami();
  whoamiText = env?.data?.summary ?? whoamiText;
} catch (e) {
  log('whoami 失败：', (e as Error).message);
  if (e instanceof AgentApiError && e.httpStatus === 401) {
    log('Token 无效/已撤销/已过期——请在租户后台「Agent 管理」重新签发');
  }
  process.exit(1);
}

const toolsResp = await api.listTools();
const tools = toolsResp.data ?? [];
if (!tools.length) {
  log('该 token 看不到任何工具（scope 或订阅模块为空），退出');
  process.exit(1);
}

const server = new Server(
  { name: 'labelflow-agent-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    title: t.title ?? t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as never,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params?.name;
  const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
  try {
    const env = await api.callTool(String(name), args);
    const data = env?.data;
    // §11.6.3 统一信封 {summary, data, warnings, next_actions}：摘要给模型读，JSON 给程序读
    const text = data && typeof data.summary === 'string'
      ? `${data.summary}\n\n${JSON.stringify(data, null, 2)}`
      : JSON.stringify(data ?? env, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    const err = e as AgentApiError;
    const payload: Record<string, unknown> = { error: err?.message ?? String(e) };
    if (err?.envelope?.code) payload.code = err.envelope.code;
    if (err?.envelope?.action) payload.action = err.envelope.action;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`已连接 stdio；注册 ${tools.length} 个工具。${whoamiText}`);
