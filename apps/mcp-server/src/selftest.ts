// =============================================================================
// selftest —— 非交互式 MCP 链路自检（§11.11.2「inspector 能列出全部工具」的 CI 替身）
// 用官方 SDK Client + StdioClientTransport 拉起 dist/index.js 子进程：
//   1. tools/list 数量 ≥ 10；
//   2. callTool whoami 返回带租户名；
//   3. callTool inventory.query_stock（keyword=不存在的物料）→ 空数组 + 友好摘要。
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
