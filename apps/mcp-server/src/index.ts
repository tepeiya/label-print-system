#!/usr/bin/env node
// =============================================================================
// LabelFlow Agent MCP server —— stdio 入口（P4，docs/11 §11.7.1）
// 启动流程：读 AGENT_TOKEN → GET whoami 确认身份 → GET tools 拉当前 scope 可见工具
// → 交给共享装配层 src/server.ts 注册 tools/resources/prompts → 连 stdio。
// P5 起 HTTP 入口（src/http.ts）复用同一个 createLabelFlowServer，本文件只保留
// stdio 特有的「启动即失败」策略：token 无效（401）或工具为空就退出，不半死不活地等客户端调用。
// 注意：日志一律走 stderr（stdout 是 JSON-RPC 通道）。
// =============================================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentApiClient, AgentApiError } from './client/agent-api.js';
import { createLabelFlowServer } from './server.js';

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

const server: Server = createLabelFlowServer(api, { tools });

const transport = new StdioServerTransport();
await server.connect(transport);
log(`已连接 stdio；注册 ${tools.length} 个工具。${whoamiText}`);
