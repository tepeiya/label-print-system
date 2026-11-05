#!/usr/bin/env node
// =============================================================================
// LabelFlow Agent MCP server —— Streamable HTTP 入口（P5，docs/11 §11.7.1 / D9）
// 面向 SaaS 多租户：一个进程服务多个客户，租户身份来自每个会话的 Authorization 头，
// 「一 token = 一会话 = 一租户」——会话建立时先打 GET /agent/v1/whoami 验真，
// 验不过（401）就完全不建会话，避免拿伪造 token 占住服务端连接资源。
// 只用 Node 原生 http + SDK 的 StreamableHTTPServerTransport（不引入 express）。
// HTTP 模式没有 stdout 通道冲突，日志走 stdout 并统一加 ISO 时间戳前缀，便于容器采集。
// =============================================================================
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AgentApiClient, AgentApiError, AgentToolDto } from './client/agent-api.js';
import { createLabelFlowServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3300);
const HOST = process.env.HOST ?? '0.0.0.0';
/** 客户端只断连不发 DELETE 时的兜底回收（多租户进程长跑，会话表不能只增不减） */
const IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 30 * 60 * 1000);
/** 单次 JSON-RPC 请求体上限：防超大 body 打爆内存（工具入参正常只有几 KB） */
const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024);

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}] [labelflow-mcp-http]`, ...a);

interface Session {
  id: string;
  token: string;
  api: AgentApiClient;
  server: Server;
  transport: StreamableHTTPServerTransport;
  whoami: string;
  lastSeen: number;
}

/** Mcp-Session-Id → 会话。SDK 只负责校验头与自身的会话状态，跨请求路由由这张表完成。 */
const sessions = new Map<string, Session>();

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** 传输层自己的拒绝也按 JSON-RPC 错误体返回，客户端（SDK）能直接把它当协议错误读出来 */
function rpcError(res: ServerResponse, status: number, code: number, message: string) {
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

function bearer(req: IncomingMessage): string {
  const h = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? '';
}

/** 不引入 body-parser：自己收流并 JSON.parse，解析结果透传给 transport 的 parsedBody */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: boolean; value?: unknown; message?: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return { ok: false, message: `请求体超过 ${MAX_BODY} 字节上限` };
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch (e) {
    return { ok: false, message: `请求体不是合法 JSON：${(e as Error).message}` };
  }
}

const isInitializeBody = (value: unknown): boolean => {
  const list = Array.isArray(value) ? value : [value];
  return list.some((m) => (m as any)?.method === 'initialize');
};

async function dropSession(id: string, why: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  // server.close() 会连带 transport.close()；两边都兜住，回收失败不能让会话表卡死
  try { await s.server.close(); } catch { /* 已关闭 */ }
  try { await s.transport.close(); } catch { /* 已关闭 */ }
  log(`会话结束 ${id}（${why}）；当前会话数 ${sessions.size}`);
}

/** initialize：验 token → 建 AgentApiClient/Server/Transport → 交给 SDK 发 Mcp-Session-Id */
async function establishSession(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const token = bearer(req);
  if (!token) {
    rpcError(res, 401, -32001, '缺少 Agent Token：请在 Authorization 头带 Bearer lfagent_xxx（租户后台「Agent 管理」签发）');
    return;
  }
  let api: AgentApiClient;
  try {
    api = new AgentApiClient(process.env.AGENT_API_BASE, token);
  } catch (e) {
    rpcError(res, 401, -32001, `Agent Token 不可用：${(e as Error).message}`);
    return;
  }
  let whoami = '（whoami 无摘要）';
  let tools: AgentToolDto[] | undefined;
  try {
    whoami = (await api.whoami())?.data?.summary ?? whoami;
    // 会话建立时就把工具清单取下来：第一次 tools/list 不再打后端，token scope 有问题也能立刻体现在日志里
    tools = (await api.listTools())?.data ?? [];
  } catch (e) {
    if (e instanceof AgentApiError && e.httpStatus === 401) {
      log('whoami 401，拒绝建会话');
      rpcError(res, 401, -32001, 'Token 无效/已撤销/已过期——请在租户后台「Agent 管理」重新签发');
      return;
    }
    log('whoami/tools 预取失败，会话仍建立（工具改为首次 tools/list 时懒取）：', (e as Error).message);
  }

  const pending: { id?: string } = {};
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // SDK 在 initialize 响应里回 Mcp-Session-Id 之前回调，在这里登记会话，后续请求才有处可查
    onsessioninitialized: (sessionId) => {
      pending.id = sessionId;
      sessions.set(sessionId, { id: sessionId, token, api, server, transport, whoami, lastSeen: Date.now() });
      log(`会话建立 ${sessionId}；工具 ${tools?.length ?? '待懒取'} 个；${whoami}`);
    },
    onsessionclosed: (sessionId) => { void dropSession(sessionId, '客户端 DELETE'); },
  });
  const server = createLabelFlowServer(api, { tools, log: (m, ...r) => log(`[${pending.id ?? 'init'}]`, m, ...r) });

  transport.onclose = () => { if (transport.sessionId) void dropSession(transport.sessionId, 'transport close'); };
  transport.onerror = (err) => log('transport 错误：', err.message);

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** 已建立会话的请求：按 Mcp-Session-Id 路由到对应 transport，SDK 自己校验头与协议版本 */
async function routeSession(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const sid = String(req.headers['mcp-session-id'] ?? '');
  if (!sid) {
    rpcError(res, 400, -32000, '缺少 Mcp-Session-Id 头：请先 POST /mcp 发 initialize，用响应头里的 Mcp-Session-Id 续接会话');
    return;
  }
  const s = sessions.get(sid);
  if (!s) {
    rpcError(res, 404, -32001, `会话不存在或已结束：${sid}（请重新 initialize）`);
    return;
  }
  // 会话已绑定 token，理论上不必再验；但带上 Authorization 时必须与建会话时同一个，防会话号串用
  const token = bearer(req);
  if (token && token !== s.token) {
    rpcError(res, 401, -32001, '该会话绑定的 Agent Token 与请求头不一致（一个会话 = 一个租户）');
    return;
  }
  s.lastSeen = Date.now();
  await s.transport.handleRequest(req, res, body);
}

const httpServer: HttpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, sessions: sessions.size });
      return;
    }
    if (url.pathname !== '/mcp') {
      json(res, 404, { ok: false, message: '未知路径。MCP 端点是 /mcp，探活是 /health' });
      return;
    }
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        rpcError(res, 400, -32700, parsed.message ?? '请求体解析失败');
        return;
      }
      if (isInitializeBody(parsed.value)) await establishSession(req, res, parsed.value);
      else await routeSession(req, res, parsed.value);
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      // GET = SSE 通知流（需 Accept: text/event-stream），DELETE = 结束会话；两者都没有请求体
      await routeSession(req, res, undefined);
      return;
    }
    res.writeHead(405, { Allow: 'GET, POST, DELETE' });
    res.end();
  } catch (e) {
    log('请求处理异常：', (e as Error).message);
    if (!res.headersSent) rpcError(res, 500, -32603, `服务端内部错误：${(e as Error).message}`);
    else res.end();
  }
});

/** 兜底回收：客户端异常退出（没发 DELETE）时释放会话与后端连接 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastSeen > IDLE_MS) void dropSession(s.id, `空闲超过 ${Math.round(IDLE_MS / 60000)} 分钟`);
  }
}, 60_000);
sweeper.unref();

async function shutdown(signal: string) {
  log(`${signal}：关闭 ${sessions.size} 个会话并退出`);
  clearInterval(sweeper);
  for (const id of [...sessions.keys()]) await dropSession(id, '进程退出');
  httpServer.close(() => process.exit(0));
  // 有 SSE 长连接挂着时 close() 不会立刻回调，留个兜底退出
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

httpServer.listen(PORT, HOST, () => {
  log(`Streamable HTTP 已监听 http://${HOST}:${PORT}/mcp（探活 GET /health）；`
    + `后端 ${process.env.AGENT_API_BASE ?? 'http://127.0.0.1:3200/api/v1'}；每会话绑一个 Agent Token`);
});
