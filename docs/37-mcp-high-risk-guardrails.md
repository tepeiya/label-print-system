# MCP 高危接口风险与规避

> 阶段：P6 上线前加固
> 日期：2026-11-25
> 依据：`apps/mcp-server`（29 个工具）+ `backend/src/agent/*` 真实代码，本机实库复跑

---

## 1. 结论先行

MCP 侧只有 **3 个高危工具**，风险不在「Agent 会不会乱来」，而在四件事：

1. **参数合法但业务错**（把 5kg 填成 5000kg，审批人照批）；
2. **审批人被信息遮蔽**（审批页看不到完整参数，等于盲批）；
3. **质量状态被洗白**（本次复现并已修复，见 §4）；
4. **凭证与通道**（token 泄露、明文 HTTP、长期有效）。

代码里已有的护栏足以挡住「乱来」，挡不住「合规矩地错」。后者必须靠流程 + 配置。

---

## 2. 高危工具与最坏后果

| 工具 | 最坏后果 | 一次调用的物理影响 |
|---|---|---|
| `inventory.adjust` | 账面库存与实际不符，GMP 飞检直接判不合格；金额上等于资产失真 | 改库存台账 + 批次行，落 `stock_moves` |
| `inventory.transfer` | 货没搬、账已搬；或目标仓凭空多出一行批次（账实分离） | 扣源仓 + 加目标仓，可能新建批次行 |
| `print.submit_job` | **打错的 UDI/标签贴到产品上** = 合规事故，比浪费纸严重 | 真实打印机出纸，消耗打印流水号 |

其余 26 个工具（只读查询、模板 CRUD、alerts.ack、print.cancel_job/retry_job、datasource.refresh）风险量级低一档，最坏是「读到脏数据 / 误取消一个待打任务」，不产生不可逆账务。

---

## 3. 已有的七道防线（代码位置 + 实测行为）

| # | 防线 | 实现 | 实测 |
|---|---|---|---|
| 1 | 工具授权 | `tools.service.ts` 调用链：scope(4032) → 订阅模块(4031) → 执行器可用 → D7 开关(4035) → 限流(4037) → 配额(4033) → 幂等 → 审批(4034/202) | 无 token 401；越 scope 4032 |
| 2 | D7 开关 | `print.submit_job` 必须租户开 `feature_flags['agent.print.submit']`，默认关 | 未开 → 4035，`denied_feature` 落审计 |
| 3 | 人工审批 | 高危 + 非 `dry_run` → 202 + `approval_id`，**零副作用** | `inventory.adjust` 首调 202，库存未动 |
| 4 | 参数绑死 | `approval.calc.ts::approvalVerdict`：`approved` 且未超时 → 必须 `row.argsHash === incomingArgsHash`，否则 `hash_mismatch`「审批绑定的参数与本次请求不一致，禁止执行」 | 审批单 #4（qty=3）批准后，改 qty=50 带单重试 → `{"code":4034,...,"approval_status":"hash_mismatch"}` |
| 5 | 时效 + 一次性 | pending 30 分钟；approved 5 分钟窗口；执行成功 `consume` | 单据状态 `pending → approved → consumed` |
| 6 | 幂等 | 写工具缺 `idempotency_key` 400；同 key 不同参数 → `idempotency_conflict`；同 key 同参数 → 回放原结果不重复副作用 | 同 key 重放不再扣库存 |
| 7 | 出域脱敏 + 审计 | `egress()` 统一出口（`redaction.calc`）；每次调用写 `agent_calls`（tool/args/结果码/耗时/approval_id/idemKey） | `idempotent_replay`、`need_approval` 均计量并留痕 |

补充两条设计细节：

- **`approval_id` 不参与参数指纹**（`stripApprovalId`），否则 Agent 带单重试永远对不上；`dry_run` 参与，因为语义不同。
- **审批单去重**：`(tenantId, agentClientId, tool, argsHash, status='pending')` 命中即复用同一张单 → 同一个大额调整不会刷出 30 张审批单逼人点同意（防审批疲劳）。

---

## 4. 本次修复：`inventory.transfer` 可把待检批次洗成合格

**缺口（真实存在，已验证）**：`transferStock` 的 FIFO 分支只挑 `RELEASED`，但**指定 `batch_no` 的分支不过滤质量状态**；目标仓新建批次行也不带 `qualityStatus`，落库取列默认 `RELEASED`。

后果：Agent 用 `inventory.transfer` 指定一个 `PENDING`（待检）或 `REJECTED`（不合格）批次调到另一个仓，**源仓待检品在目标仓变成合格品**，绕过 P0-1 质量闸门，且审批页 args 里只有 sku/批号/数量，审批人看不出来。

**修复**（`backend/src/inventory/inventory.service.ts`）：

1. 指定批次时校验质量状态，非 `RELEASED` 直接 400；
2. 目标仓新建批次行显式继承源批次 `qualityStatus`（将来若放开过滤，状态随货走而不是被默认值洗白）。

**实测**（本机 PG14 + 后端 :3202 + Agent token，构造 `QC-PENDING-TEST` 批次 qty=10）：

```
POST /agent/v1/tools/inventory.transfer  batch_no=QC-PENDING-TEST
→ {"code":400,"message":"批次 QC-PENDING-TEST 质量状态为「待检」，不允许调拨（需先检验/放行）"}
```

回归：`RELEASED` 批次 `B2026-0815` 调 5kg → 202 审批单 #3 → approve → 带 `approval_id=3` 重试 → 「WH-SH：300 → 295；WH-JX：0 → 5」，单状态 `consumed`，目标仓新行 `quality_status=RELEASED`。

> 顺带确认 `inventory.adjust` 不受此问题影响：Agent 调用走 `adjustStock(..., allow_qc 默认 ['RELEASED'])`，待检/不合格批次出库本就 400；FIFO 跨批次扣减在事务内 `pessimistic_write` 加锁复核，并发不会扣成负数。

---

## 5. 上线前必须做的六件事（不写进代码，靠配置与流程）

1. **通道加密**：MCP 必须挂在 `deploy/nginx/mcp.conf` 后，禁止外网直连 3300。容器内 `AGENT_API_BASE=http://api:3200` 是内网，可明文。
2. **token 最小化**：一用途一 token。只读巡检 Agent 只签 `*:read`；能改库存的 Agent 才签 `inventory:stock:*`。有效期按 90 天，到期重签。
3. **D7 只对试点开**：`agent.print.submit` 先只给 1 个租户/1 条产线开，观察 `agent_calls` 里的 `print.submit_job` 成功数与实际出纸数是否一致。
4. **审批角色收窄**：种子把 `sys:agent:approve` 给了 `tenant_admin / manager / warehouse_keeper`。GMP 讲操作与复核分离，客户上线时应把「批库存调整」的权限收给仓储主管或质量主管，不要留给仓管本人。
5. **强制「先预演再执行」的作业规范**：`inventory.adjust / inventory.transfer` 调 `dry_run:true`（免审批、不消耗幂等键与审批单）→ 人看过预演结果 → 再去掉 `dry_run`。打印则强制先 `print.preview` / `print.commands` 看渲染结果。
6. **日结三方对账**：`stock_moves`（账）× 实物盘点 × `agent_calls`（谁让 Agent 干的）。异常单直接 `POST /agents/:id/status` 停用该 Agent。

---

## 6. 仍然存在的缺口（诚实清单）

| 缺口 | 影响 | 现状/建议 |
|---|---|---|
| 审批页参数被折叠 | `compactPreview` 把长字符串截到 120 字符、数组只留 2 条样本；`print.submit_job` 的 rows、模板 JSON 审批人看不全 → 盲批 | 未做。建议审批单附只读「预演结果」快照（先调 `dry_run`/`preview` 落库再挂到单上） |
| 审批无金额/数量阈值 | 1kg 与 1000kg 走同一套审批 | 未做。建议按 delta/qty 分级：超阈值要求双人确认 |
| approve 权限不按工具细分 | 能批打印的人也能批库存调整 | 未做。建议 `sys:agent:approve` 拆为 `:inventory` / `:print` |
| token 无 IP/网段约束、无法自助轮换 | 泄露后有效期内一直可用 | 未做。现只能手工 `revoke` 或整 Agent `status=disabled` |
| stdio 模式 token 在进程环境变量 | 同机其他用户可读 `/proc/<pid>/environ` | 设计如此（一进程一租户）。建议只在专用容器/专用账号下跑 |
| 审计保留期未定义 | 合规追溯长度不确定 | `agent_calls` 全量留存，无归档/清理策略，需按客户要求定 |
| 无 Prompt Injection 硬防护 | 物料名/备注里的文字可能被模型当指令 | 硬防护靠审批 + scope + 参数 hash；不要给 MCP 挂全自动编排（人在环） |

---

## 7. 复跑方法

```bash
# 后端（agent 模块须已开通，否则 4031）
cd backend && node dist/src/main.js          # :3202

# 待检批次拦截
curl -s -X POST localhost:3202/api/v1/agent/v1/tools/inventory.transfer \
  -H "Authorization: Bearer $(cat /tmp/mcp_token.txt)" -H 'Content-Type: application/json' \
  -d '{"sku":"M-PEAR-001","from_warehouse":"WH-SH","to_warehouse":"WH-JX","qty":5,
       "batch_no":"QC-PENDING-TEST","dry_run":true,"idempotency_key":"qc-test-1"}'
# 期望：400 批次 QC-PENDING-TEST 质量状态为「待检」，不允许调拨

# 参数篡改（审批后改 qty 重试）
# 期望：{"code":4034,...} / hash_mismatch「审批绑定的参数与本次请求不一致（args_hash 校验失败），禁止执行」
```
