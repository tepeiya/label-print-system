# labelflow-mcp-server（P4 stdio）

LabelFlow Agent 的 MCP stdio 入口（docs/11 §11.7.1）。**只持一个 Agent Token，不接触数据库**。

## 使用

```bash
cd apps/mcp-server
npm install
npm run build
AGENT_TOKEN=lfagent_xxx npm start          # stdio 服务（一般由 MCP 客户端拉起）
AGENT_TOKEN=lfagent_xxx npm run selftest   # 非交互自检（tools/list + whoami + 空数据摘要）
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_TOKEN` | （必填） | 租户后台 /agents 签发，形如 `lfagent_` + 40 hex；只读 scope 即可查库存/齐套 |
| `AGENT_API_BASE` | `http://127.0.0.1:3200/api/v1` | 后端地址 |

## Claude Desktop 配置

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "labelflow": {
      "command": "node",
      "args": ["/绝对路径/label-print-system/apps/mcp-server/dist/index.js"],
      "env": { "AGENT_TOKEN": "lfagent_xxx" }
    }
  }
}
```

工具清单由后端 `GET /agent/v1/tools` 动态下发（P4：whoami / list_modules / describe_capabilities +
templates.search/get + inventory.query_stock/list_low_stock/list_batches/list_expiring +
bom.check_kit_rate/explain_shortage，共 11 个；scope 不含的工具不会出现在列表里）。

## 官方 inspector 调试

```bash
AGENT_TOKEN=lfagent_xxx npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

演示数据：`psql -v tid=<租户ID> -f backend/scripts/seed-inventory-demo.sql`（有机苹果 320kg/
安全库存 500、苹果礼盒 BOM 含 5% 损耗 → demand 100 齐套率 60%）。
