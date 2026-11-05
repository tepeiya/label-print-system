// =============================================================================
// selftest-http —— Streamable HTTP 传输的端到端自检（P5，docs/11 §11.7.1 / D9）
// 自己拉起 dist/http.js（独立端口，避免撞开发中的 3300），等 GET /health 就绪后用官方 SDK
// StreamableHTTPClientTransport 连接，断言：
//   1. 不带 token 的 initialize 被拒（401）——多租户网关的第一道闸；
//   2. capabilities 齐声明 tools/resources/prompts；tools/list ≥10 且含写/高危工具；
//   3. prompts/list 含 §11.7.5 三个场景，prompts/get 返回 user 角色中文正文；
//   4. resources/list 不报错，resources/read 能按 URI 取回 JSON；
//   5. tools/call inventory.query_stock 返回非空文本；
//   6. GET /mcp 返回 SSE 流（200）或 409（本会话已有一条流）；缺 Mcp-Session-Id → 400、未知会话号 → 404；
//   7. transport.terminateSession() 发 DELETE → 服务端会话数归零（会话表不泄漏）。
// token：AGENT_TOKEN 优先，否则读 MCP_TOKEN_FILE（默认 /tmp/p5_mcp_token.txt，联调时由
// 后端 /agents/<id>/tokens 签发后写入，不入库不入仓库）。失败 exit 1 并打印原因。
// =============================================================================
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SELFTEST_HTTP_PORT ?? 3399);
const BASE = process.env.AGENT_API_BASE ?? 'http://127.0.0.1:3200/api/v1';
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => { console.error('SELFTEST HTTP FAIL:', msg); process.exit(1); };

const token = (process.env.AGENT_TOKEN ?? '').trim()
  || (() => { try { return readFileSync(process.env.MCP_TOKEN_FILE ?? '/tmp/p5_mcp_token.txt', 'utf8').trim(); } catch { return ''; } })();
if (!token) fail('既没有 AGENT_TOKEN 也没有可读的 token 文件（MCP_TOKEN_FILE，默认 /tmp/p5_mcp_token.txt）');

const child = spawn('node', [path.join(__dirname, 'http.js')], {
  env: { ...process.env, AGENT_TOKEN: token, AGENT_API_BASE: BASE, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// 服务日志默认吞掉（只在 SELFTEST_DEBUG=1 时透传），否则断言输出会被时间戳日志淹没
if (process.env.SELFTEST_DEBUG) child.stdout!.on('data', (d) => process.stderr.write(`[http] ${d}`));
child.on('exit', (code, sig) => { if (code !== 0 && code !== null && sig !== 'SIGTERM') console.error(`（http 子进程提前退出 code=${code} signal=${sig}）`); });
// fail() 里是 process.exit()，finally 不会跑——用 exit 事件兜底，绝不把 http 进程留在端口上
process.on('exit', () => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } });
const watchdog = setTimeout(() => fail('超过 60s 未完成自检（后端或 MCP 服务未就绪？）'), 60_000);

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* 端口还没起来 */ }
    await sleep(200);
  }
  fail(`${HEALTH_URL} 在 20s 内没有就绪`);
}

try {
  await waitReady();
  const health0 = await (await fetch(HEALTH_URL)).json();
  console.log(`GET /health → ${JSON.stringify(health0)}`);

  // 1. 无 token 的 initialize 必须被拒（不建会话）
  const bad = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'no-token', version: '0' } } }),
    signal: AbortSignal.timeout(10_000),
  });
  const badBody = await bad.text();
  console.log(`无 token initialize → HTTP ${bad.status}：${badBody.slice(0, 90).replace(/\s+/g, ' ')}`);
  if (bad.status !== 401) fail(`无 token 应返回 401，实际 ${bad.status}`);
  const healthAfterBad = await (await fetch(HEALTH_URL)).json();
  if (healthAfterBad?.sessions !== 0) fail(`被拒的 initialize 不该留下会话，实际 ${healthAfterBad?.sessions}`);

  // 1b. 会话号相关的路由错误：无 Mcp-Session-Id → 400，未知会话号 → 404（README 里承诺的行为）
  const noSid = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(10_000),
  });
  await noSid.text();
  const ghostSid = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': 'no-such-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(10_000),
  });
  await ghostSid.text();
  console.log(`无会话号 POST → HTTP ${noSid.status}；未知会话号 POST → HTTP ${ghostSid.status}`);
  if (noSid.status !== 400) fail(`缺 Mcp-Session-Id 应 400，实际 ${noSid.status}`);
  if (ghostSid.status !== 404) fail(`未知 Mcp-Session-Id 应 404，实际 ${ghostSid.status}`);

  // 2. 正常建会话
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  } as never);
  const client = new Client({ name: 'labelflow-selftest-http', version: '0.0.1' });
  await client.connect(transport);
  console.log(`initialize → 服务端 ${JSON.stringify(client.getServerVersion())}，会话 ${transport.sessionId?.slice(0, 8)}…`);
  const caps = client.getServerCapabilities() ?? {};
  for (const c of ['tools', 'resources', 'prompts']) {
    if (!(c in caps)) fail(`capabilities 缺 ${c}：${JSON.stringify(caps)}`);
  }

  // 3. tools/list
  const { tools } = await client.listTools();
  console.log(`tools/list → ${tools.length} 个`);
  if (tools.length < 10) fail(`工具数 ${tools.length} < 10`);
  for (const n of ['inventory.query_stock', 'print.submit_job']) {
    if (!tools.some((t) => t.name === n)) fail(`工具清单缺 ${n}`);
  }

  // 4. prompts
  const { prompts } = await client.listPrompts();
  console.log(`prompts/list → ${prompts.map((p) => p.name).join(', ')}`);
  for (const n of ['inventory.health_check', 'bom.daily_kit_report', 'print.label_from_description']) {
    if (!prompts.some((p) => p.name === n)) fail(`缺提示词 ${n}`);
  }
  const got = await client.getPrompt({ name: 'inventory.health_check', arguments: { days: '45' } });
  const promptText = String((got.messages?.[0]?.content as any)?.text ?? '');
  if (got.messages?.[0]?.role !== 'user' || promptText.length < 200) fail(`prompts/get 正文异常（role=${got.messages?.[0]?.role}，长度 ${promptText.length}）`);
  if (!promptText.includes('45')) fail('prompts/get 未把 days 参数渲染进正文');
  console.log(`prompts/get(inventory.health_check, days=45) → ${promptText.slice(0, 60).replace(/\s+/g, ' ')}…`);

  // 5. resources
  const { resources } = await client.listResources();
  console.log(`resources/list → ${resources.length} 条：${resources.slice(0, 3).map((r) => r.uri).join(' ')}${resources.length > 3 ? ' …' : ''}`);
  if (resources.length) {
    const read = await client.readResource({ uri: resources[0].uri });
    // 资源正文按规范是 text（本服务只发 application/json），blob 分支不参与断言
    const text = String((read.contents?.[0] as any)?.text ?? '');
    if (read.contents?.[0]?.mimeType !== 'application/json' || text.length < 10) fail(`resources/read 正文异常：${JSON.stringify(read.contents)?.slice(0, 120)}`);
    console.log(`resources/read(${resources[0].uri}) → ${text.slice(0, 60).replace(/\s+/g, ' ')}…`);
  }

  // 6. tools/call
  const call = await client.callTool({ name: 'inventory.query_stock', arguments: { limit: 2 } });
  const callText = String((call.content as any)?.[0]?.text ?? '');
  if (call.isError || !callText.trim()) fail(`inventory.query_stock 调用失败：${JSON.stringify(call).slice(0, 200)}`);
  console.log(`tools/call inventory.query_stock → ${callText.slice(0, 70).replace(/\s+/g, ' ')}…`);

  // 7. GET /mcp = SSE 通知流。SDK 客户端 connect() 时已经占用了本会话唯一的一条 GET 流，
  //    所以这里再 GET 通常返回 409「Only one SSE stream per session」——两者都证明端点在服役。
  const sse = await fetch(MCP_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Mcp-Session-Id': transport.sessionId!, 'MCP-Protocol-Version': '2025-03-26' },
    signal: AbortSignal.timeout(10_000),
  });
  const ctype = sse.headers.get('content-type') ?? '';
  await sse.body?.cancel().catch(() => { /* 已关闭 */ });
  console.log(`GET /mcp(SSE) → HTTP ${sse.status} ${ctype}`);
  if (sse.status !== 200 && sse.status !== 409) fail(`SSE 通知流端点异常（HTTP ${sse.status} ${ctype}）`);
  if (sse.status === 200 && !ctype.includes('text/event-stream')) fail(`SSE 响应头不是 text/event-stream：${ctype}`);

  // 8. 会话回收：注意 SDK 1.32 的 client.close() 只 abort 本地连接、**不会**发 DELETE，
  //    显式结束会话要用 transport.terminateSession()（close() 之后再调就发不出去了）。
  await transport.terminateSession();
  await client.close();
  let sessionsLeft = -1;
  for (let i = 0; i < 20; i++) {
    sessionsLeft = (await (await fetch(HEALTH_URL)).json())?.sessions ?? -1;
    if (sessionsLeft === 0) break;
    await sleep(200);
  }
  console.log(`terminateSession(DELETE) 后 → GET /health sessions=${sessionsLeft}`);
  if (sessionsLeft !== 0) fail(`会话未回收，剩余 ${sessionsLeft} 个`);

  console.log('SELFTEST HTTP OK');
} catch (e) {
  fail((e as Error)?.message ?? String(e));
} finally {
  clearTimeout(watchdog);
  child.kill('SIGTERM');
}
