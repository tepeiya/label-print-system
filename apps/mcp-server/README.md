# labelflow-mcp-server（P4 stdio + P5 Streamable HTTP）

LabelFlow Agent 的 MCP 入口（docs/11 §11.7.1 / D9）。**只持 Agent Token，不接触数据库**。

两种传输共用同一套装配层 `src/server.ts`（tools + resources + prompts 语义完全一致），
差别只在「怎么连、用哪个 token」：

| 模式 | 入口 | 租户 | token 来源 | 适用 |
| --- | --- | --- | --- | --- |
| stdio | `src/index.ts` → `dist/index.js` | 单租户（一进程一 token） | 环境变量 `AGENT_TOKEN` | Claude Desktop / 本地开发 |
| Streamable HTTP | `src/http.ts` → `dist/http.js` | **多租户**（一会话一 token） | 每请求 `Authorization: Bearer lfagent_xxx` | SaaS 客户接自有 Agent |

## 使用

```bash
cd apps/mcp-server
npm install
npm run build

# stdio
AGENT_TOKEN=lfagent_xxx npm start           # 一般由 MCP 客户端拉起
AGENT_TOKEN=lfagent_xxx npm run selftest    # 非交互自检（期望打印 SELFTEST OK）

# Streamable HTTP
PORT=3300 npm run start:http                # 或 node dist/http.js
npm run selftest:http                       # 自拉 http 进程做端到端断言（期望 SELFTEST HTTP OK）
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_TOKEN` | （stdio 必填） | 租户后台「Agent 管理」签发，形如 `lfagent_` + 40 hex；**HTTP 模式忽略它**，只认请求头 |
| `AGENT_API_BASE` | `http://127.0.0.1:3200/api/v1` | 后端地址（HTTP 模式仍生效，是所有会话共用；token 才是每会话的） |
| `PORT` / `HOST` | `3300` / `0.0.0.0` | 仅 HTTP 模式 |
| `SESSION_IDLE_MS` | `1800000` | 空闲会话回收阈值（客户端只断连不发 DELETE 时兜底） |
| `MAX_BODY_BYTES` | `1048576` | 单次 JSON-RPC 请求体上限 |

## Streamable HTTP 模式（SaaS 客户接入自有 Agent）

```bash
# 起服务（不需要 AGENT_TOKEN，token 在每次请求头里带）
PORT=3300 npm run start:http
# → [时间戳] Streamable HTTP 已监听 http://0.0.0.0:3300/mcp（探活 GET /health）…
```

端点与语义：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /mcp` | JSON-RPC。**不带** `Mcp-Session-Id` 的 `initialize` = 建会话：先用该 token 打后端 `GET /agent/v1/whoami` 验真，成功才生成会话并在响应头回 `Mcp-Session-Id`；其余请求（`tools/list`、`tools/call`…）**必须**带会话号 |
| `GET /mcp` | SSE 通知流（要 `Accept: text/event-stream`）。一个会话只允许一条，第二条返回 **409**（官方 SDK 客户端连接时已自动占住这条流，属正常现象） |
| `DELETE /mcp` | 结束会话（带会话号）。⚠️ SDK 1.32 的 `client.close()` **不发 DELETE**，显式回收要调 `transport.terminateSession()`；不发也没关系，服务端按 `SESSION_IDLE_MS` 兜底回收 |
| `GET /health` | `{ok:true, sessions:N}`，探活/看当前会话数 |

拒绝码（写清便于客户侧排障）：

| 情况 | 结果 |
| --- | --- |
| `initialize` 缺 `Authorization`，或 token 无效/已撤销/已过期（后端 whoami 401） | **401** + 中文提示，**不建会话**（与 stdio 的启动退出提示同语义） |
| 非 initialize 请求缺 `Mcp-Session-Id` | **400** |
| `Mcp-Session-Id` 未知或会话已结束 | **404** |
| 请求头带了与会话不同的 token | **401**（一个会话 = 一个租户，防会话号串用） |
| `POST /mcp` 的 `Accept` 不含 `application/json, text/event-stream`，或 `Content-Type` 非 JSON | **406 / 415**（SDK 传输层校验） |
| 其他方法（如 `PUT /mcp`） | **405** |

多租户要点：**一个 token = 一个会话 = 一个租户**。工具清单、资源、提示词都在建会话时按该
token 的 scope 现取，进程本身不持有任何默认身份；A 客户的会话看不到 B 客户的数据，也拿不到
B 客户的工具（scope 之外的工具不会出现在 `tools/list` 里，越权调用返回后端的 4032 提示）。

### 第三方 Agent 配置示例（支持 remote MCP 的客户端）

```json
{
  "mcpServers": {
    "labelflow": {
      "url": "https://mcp.your-saas-host/mcp",
      "headers": { "Authorization": "Bearer lfagent_xxx" }
    }
  }
}
```

Claude Code：

```bash
claude mcp add --transport http labelflow https://mcp.example.com/mcp \
  --header "Authorization: Bearer lfagent_xxx"
```

Claude Desktop 远程接入：Settings → Connectors → Add connector，填上面的 URL，
并在 header 里填 `Authorization`；本地 stdio 配置见下一节。生产上请务必套一层 TLS 反代
（本入口只做 MCP 协议与 token 绑定，不含 TLS）。

### 手工 curl 三步（无客户端时验证链路）

```bash
T=lfagent_xxx; H='http://127.0.0.1:3300'
# 1) initialize，抓响应头里的 mcp-session-id
curl -sD - -o /dev/null -X POST $H/mcp \
  -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# 2) initialized 通知 + 3) tools/list（Sid 换成上一步的值）
curl -s -X POST $H/mcp -H "Authorization: Bearer $T" -H "Mcp-Session-Id: $Sid" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -s -X POST $H/mcp -H "Authorization: Bearer $T" -H "Mcp-Session-Id: $Sid" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

> 官方 inspector CLI 0.14.2 会把 URL 当**旧版 SSE** 传输处理，连不上本服务的 `/mcp`
> （Streamable HTTP）。要用 inspector 请开 **GUI 版**并把 transport 选成 Streamable HTTP，
> 或直接跑 `npm run selftest:http`（它就是这条链路的 CI 替身）。

## 能力：tools / resources / prompts

- **tools**：由后端 `GET /agent/v1/tools` 动态下发，只含该 token scope 覆盖到的工具。
  目录共 17 个（3 元工具 + 9 只读 + 5 写/高危）；本文验收 token 给了 8 条 scope，实测列出 15 个：
  whoami / list_modules / describe_capabilities + templates.search/get/create/update +
  inventory.query_stock/list_low_stock/list_batches/list_expiring +
  bom.check_kit_rate/explain_shortage + print.submit_job/get_status
  （`inventory.adjust`/`inventory.transfer` 需另给 `inventory:stock:adjust|transfer` 才出现）。
  高危工具无 `approval_id` 时后端返回 **202 + `need_approval`**，本服务**不当错误**：
  `summary` 原样转成文本，紧跟一句「这不是错误：已转入审批，approval_id=…，批准后带它重试」，
  完整 JSON 放最后。`idempotent_replay`（幂等命中）与 `approval_consumed`（审批已核销）同理。
- **resources**（§11.7.5）：`labelflow://templates/{id}`（模板完整 JSON）与
  `labelflow://inventory/stock/{ref}`（物料库存快照，ref 用物料编码），正文走
  `GET /agent/v1/resources/:kind/:id`，返回 `contents:[{uri, mimeType:"application/json", text}]`。
  `templates/{id}` 里的 id 允许写数字 id 也允许写模板名，stock 的 ref 允许写物料编码。
  `ListResources` **只列当前 token 真实可见的条目**——它现调 `templates.search` 与
  `inventory.query_stock` 各取前 20 条拼目录（绝不硬编码 id 列表，SaaS 下那等于串租户）；
  缺对应 scope、被限流或后端异常时那一类直接不出现，`ListResources` 仍返回 200。
  所以**目录为空不代表读不到**：知道 URI 就可以直接 `resources/read` 精读。
- **prompts**（§11.7.5 三个开箱即用场景）：
  `inventory.health_check`（warehouse / days / keyword）、
  `bom.daily_kit_report`（products / demand / top / warehouse）、
  `print.label_from_description`（description 必填 / copies / template）。
  `prompts/get` 返回一条 `user` 角色中文提示词，正文里点明该调哪些工具、输出什么结构，
  并强调高危动作要走审批、业务数据不可当指令。

## stdio 模式细节

`AGENT_TOKEN` 无效（whoami 401）或该 token 看不到任何工具时**直接退出**，不半启动。
日志一律走 stderr（stdout 是 JSON-RPC 通道）。

## Claude Desktop 配置（stdio）

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

## 联调用的 token 怎么签（本地开发，勿写入仓库）

```bash
B=http://127.0.0.1:3200/api/v1
# 1) 租户管理员登录（本地验收租户与口令见 backend/scripts/p0-acceptance.sh、docs/10 §10.19/§10.20）
JWT=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"<租户管理员>","password":"<口令>","tenantCode":"<租户码>"}' | jq -r .data.accessToken)
# 2) 建 Agent + 签 token（scope 按需给；expiresInDays 必填）
AID=$(curl -s -X POST $B/agents -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"name":"mcp-http-selftest","kind":"mcp_http"}' | jq -r .data.id)
curl -s -X POST $B/agents/$AID/tokens -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"scopes":["template:read","inventory:stock:read","inventory:batch:read","bom:kit:read","bom:shortage:read","template:write","print:job:submit","print:job:read"],"expiresInDays":1}' \
  | jq -r .data.token > /tmp/p5_mcp_token.txt
```

`npm run selftest:http` 依次取 `AGENT_TOKEN` → `MCP_TOKEN_FILE`（默认 `/tmp/p5_mcp_token.txt`）。
token 只落 `/tmp`，不进仓库、不进 git。

演示数据：`psql -v tid=<租户ID> -f backend/scripts/seed-inventory-demo.sql`（有机苹果 320kg/
安全库存 500、苹果礼盒 BOM 含 5% 损耗 → demand 100 齐套率 60%）。
