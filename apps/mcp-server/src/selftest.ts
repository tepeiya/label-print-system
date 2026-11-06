// =============================================================================
// selftest —— 非交互式 MCP 链路自检（§11.11.2「inspector 能列出全部工具」的 CI 替身）
// 用官方 SDK Client + StdioClientTransport 拉起 dist/index.js 子进程：
//   1. tools/list 数量 ≥ 10；
//   2. callTool whoami 返回带租户名；
//   3. prompts/list 含 P6.5 的三个场景且 prompts/get 能把参数渲染进正文；
//   4. callTool inventory.query_stock（keyword=不存在的物料）→ 空数组 + 友好摘要。
// 环境变量：AGENT_TOKEN / AGENT_API_BASE 透传给子进程；失败 exit 1。
// =============================================================================
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, 'index.js');

const transport = new StdioClientTransport({
  command: 'node',
  args: [entry],
  env: {
    ...process.env,
    AGENT_TOKEN: process.env.AGENT_TOKEN ?? '',
    AGENT_API_BASE: process.env.AGENT_API_BASE ?? 'http://127.0.0.1:3200/api/v1',
  },
} as never);

const client = new Client({ name: 'labelflow-selftest', version: '0.0.1' });
await client.connect(transport);

const fail = (msg: string) => { console.error('SELFTEST FAIL:', msg); process.exitCode = 1; };

const { tools } = (await client.listTools()) as { tools: Array<{ name: string; description?: string }> };
console.log(`tools/list → ${tools.length} 个：${tools.map((t) => t.name).join(', ')}`);
if (tools.length < 10) fail(`工具数 ${tools.length} < 10`);
if (!tools.some((t) => t.name === 'inventory.query_stock')) fail('缺 inventory.query_stock');

const who = (await client.callTool({ name: 'whoami', arguments: {} })) as
  { content: Array<{ type: string; text: string }>; isError?: boolean };
const whoText = who?.content?.[0]?.text ?? '';
console.log('whoami →', whoText.slice(0, 100).replace(/\n/g, ' '));
if (who.isError || !whoText.includes('租户')) fail('whoami 未返回租户信息');

// 2b. prompts：P6.5 起清单来自 GET /agent/v1/prompts（系统默认 + 租户覆盖），
//     所以这里同时验证「服务端下发通了」和「{{arg}} 渲染口径一致」。
const { prompts } = (await client.listPrompts()) as { prompts: Array<{ name: string }> };
console.log(`prompts/list → ${prompts.map((p) => p.name).join(', ')}`);
for (const n of ['inventory.health_check', 'bom.daily_kit_report', 'print.label_from_description']) {
  if (!prompts.some((p) => p.name === n)) fail(`缺提示词 ${n}`);
}
const got = (await client.getPrompt({ name: 'inventory.health_check', arguments: { days: '45' } })) as
  { messages: Array<{ role: string; content: { type: string; text?: string } }> };
const promptText = String(got.messages?.[0]?.content?.text ?? '');
if (got.messages?.[0]?.role !== 'user' || promptText.length < 200) {
  fail(`prompts/get 正文异常（role=${got.messages?.[0]?.role}，长度 ${promptText.length}）`);
}
if (!promptText.includes('45')) fail('prompts/get 未把 days=45 渲染进正文');

const empty = (await client.callTool({
  name: 'inventory.query_stock',
  arguments: { keyword: '不存在物料XYZ' },
})) as { content: Array<{ type: string; text: string }>; isError?: boolean };
const emptyText = empty?.content?.[0]?.text ?? '';
console.log('query_stock(无数据) →', emptyText.slice(0, 120).replace(/\n/g, ' '));
if (empty.isError) fail('空数据查询不应报错');
if (!/未查询到|没有|空/.test(emptyText)) fail('空数据缺少友好摘要');
// JSON.stringify(data, null, 2) 下空数组渲染为 "items": []
if (!emptyText.includes('"items": []') && !emptyText.includes('"items":[]')) fail('空数据 items 不是空数组');

await client.close();
if (!process.exitCode) console.log('SELFTEST OK');
