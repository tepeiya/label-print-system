# 10. 开发交接文档（面向接手的 AI / 开发者）

> 本文档目标：**任何 AI 或开发者读完本文即可无缝接手继续开发**，不需要再翻历史对话。
> 阅读顺序建议：§10.1 速览（**先看 §10.1.5 交付状态总表：做完的 / 没做的都在里面**） → §10.5 核心约定 → §10.9 已知问题 → **§10.15 SaaS P0（做订阅/权限相关开发前必读）** → **§10.16 SaaS P1 前端动态化（做前端必读）** → §10.17 校验底座 → **§10.18 P2 平台运营后台（动 /platform 或 platform_users 前必读）** → **§10.19 P3 计费闭环（动账单/配额/计量前必读）** → **§10.20 P4 Agent/MCP（动 /agent/v1、agent token、库存只读模型前必读）** → **§10.21 P5 Agent 写工具与审批流（动 Agent 写路径/限流/幂等/MCP HTTP 前必读）** → **§10.22 P6.1 RLS 兜底（动数据库角色/连接、写任何原生 SQL 前必读）** → **§10.23 P6.3 租户数据导出与硬删 + Agent 前端入口（动 /platform/tenants/:id/export|purge、表清单口径前必读）** → **§10.24 P6.4 白标 D6 + P6.3 platform 前端（动 /branding、登录 Host 解析、主题注入前必读）** → **§10.25 P6.2 独立库租户阶段 A（动 datasource 注册/按库导出前必读）** → **§10.26 P6.5 Prompt 库（动 /agent-prompts、MCP prompts、Agent 下发模板前必读）**。
> 最后更新：2026-11-06（P0–P5 已落地；**P6 五个子项全部动手：P6.1 RLS + P6.3 导出/硬删 + P6.4 白标 + P6.5 Prompt 库四项完整；P6.2 独立库租户只完成阶段 A（注册 + 平台侧按库导出/删除），开通编排与业务读写接管未做**；
> 本轮新增 **§10.26**；单测 217 条 / 验收 267 项（A–Q 段）/ RLS 冒烟 22 项；P6 只剩 P6.2 阶段 B（见 §10.25.8）。
> 同日另交付**设计器 Vue 化**（§10.7.2）：`web/` 的 render/interactions/store 已搬进 `apps/console`，Designer 页的 iframe 删除，
> `web/` 转为「老版本对照客户端」并**已标记弃用（DEPRECATED）**：只在对照行为时启动，不再新增功能；
> 待 `apps/console` / `apps/platform` 功能全部完善后整目录删除（删除前需确认无脚本/Caddy 配置再引用 `web/`）。
> Playwright 18 项 E2E 全绿。
> **接手先读 §10.1.5「交付状态总表」：已完成 15 项、未完成按 🔴/🟡/⚪ 分级列全。**）
>
> ## 🔄 2026-11-13 本轮增量（隐性重点补齐，详见新增 §10.27）
>
> 按「未完成的隐性重点」逐项收口，新增/改动均在 `backend/`，**前端本轮未改**：
> - **B2.2 配置 fail-fast**：`common/config.guard.ts` 接入 `main.ts` bootstrap，生产带 dev 密钥/弱口令拒绝启动；
> - **B2.6 护栏 7 脱敏**：`agent/redaction.calc.ts` + `ToolsService.egress()`，**四个出域返回点全部覆盖**（补上了此前漏掉的幂等重放分支）；
> - **B3 限流细分**：agent/tool/token 三维 + `X-RateLimit-*` / `Retry-After` 响应头，后两维默认关闭（不无预警收紧存量租户）；
> - **B2.4 定时任务 + B2.5 通知基建**：`jobs/`（BullMQ `maintenance` 队列三个 repeatable 任务）+ `notify/`（站内信 + 可扩展通道）+ `scripts/saas_p7_notifications.sql`；
> - **B1 P6.2 阶段 B**：`common/tenant-routing.*` 全局 Repository/事务代理（16 个模块接入）、`TenantContextInterceptor` 读真实 `data_source_key`、
>   `dedicated.orchestration.calc.ts` 状态机 + `dedicated.provision.service.ts` 开通编排、`dedicated.ops.calc.ts` 池/SSL/健康检查 + 退库回收巡检。
>
> **实跑基线**：`npm run typecheck` 0 error、`npm test` **297 条全绿**（290 pass / 7 skip / 0 fail）、
> `tsc -p tsconfig.json` 全量编译通过、Nest DI 图构建通过（已走到 TypeOrmModule 连接阶段，无依赖解析错误）。
> ⚠️ **沙盒无 PostgreSQL / Redis 实例**，因此「独立库真连库验收」「定时任务真实触发」「站内信真实落库」**未实跑**，
> 只能确认纯逻辑与 DI；不得据此对外宣称这些链路已验收，见 §10.27.4。
>
> ⚠️ **2026-11-05 历史瘦身**：`.pnpm-store`（232 MB pnpm 包缓存，被 `95b4970` 误提交）已从
> `feat/dev-base` 的**全部历史**中移除，`.git` 从 54 MB 降到 1.4 MB。
> 后果：`95b4970` 及其之后所有 commit 的哈希都变了（P0/P1 那批提交现在是新哈希），
> `main`（`951a17b`）与更早的 `c822386` 未受影响、内容树逐字节不变。
> 远端 `origin/trae/agent-WjnhKu` **仍是重写前的旧历史**（本轮未推送），
> 要和远端对照请以本地新哈希为准；重写前的完整历史备份在 `/tmp/pre-slim-backup.bundle`
> （沙盒回收即失效，长期留档需自行转存）。

---

## 10.1 一页速览

### 10.1.1 这是什么

LabelFlow —— 专业级标签设计与打印系统。核心能力：
拖拽式设计器（原生 DOM，非 Canvas/Konva）+ Vue 3 后台管理、模板版本管理、变量/公式/流水号、条码二维码、
多打印机通道（浏览器 / 9100 TCP / 图像）、批量打印队列（BullMQ）、多租户 + RBAC + ACL、
审计日志、SQL 数据源、备份恢复、AI 图片自动生成模板、**AI 透视矫正 / 单元素重算 / 文本生模板 / 多联大图切分**。

### 10.1.2 本机运行现状

| 项 | 值 |
| --- | --- |
| 前端 | Vue 3 后台 `http://localhost:5173`（`apps/console/` · pnpm dev）——**设计器已在 Console 内原生 Vue 实现**，不再依赖 iframe |
| 老版前端 | ⚠️ **已弃用（DEPRECATED）**：`web/` 原生 HTML5，`node web/serve.mjs 5180` 仅作行为对照，不新增功能，待新前端完善后删除 |
| 后端 | `http://localhost:3200/api/v1` |
| 数据库 | PostgreSQL `localhost:5433`，库/用户/密码均 `labelflow` |
| Redis | `localhost:6380` |
| 默认租户 | `id=1`，`code=default` |
| 管理员 | `admin` / `admin123` |
| 操作员 | `operator` / `op123`（**手工建的，见 §10.4.3**） |
| 端口 3000 | **禁止占用**，属其他项目 |

> ⚠️ 本机 `PATH` 被工具链改写，常见命令（`ls`/`git`/`curl`/`node`）可能找不到。统一用绝对路径：
> `export PATH=/home/richard/.workbuddy/binaries/node/versions/22.12.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
> 找不到 node 时：`readlink /proc/<后端PID>/exe`

### 10.1.3 启动 / 重启

```bash
# 后端：编译 → 杀端口 → 启动
cd backend
export PATH=/home/richard/.workbuddy/binaries/node/versions/22.12.0/bin:/usr/local/bin:/usr/bin:/bin
npx tsc -p tsconfig.json
fuser -k 3200/tcp 2>/dev/null; sleep 2
DB_PORT=5433 REDIS_URL=redis://localhost:6380 JWT_SECRET=dev-secret PORT=3200 \
SQL_SECRET_KEY=3a9f1b2c4d5e6f7890abcdef1234567890abcdef1234567890abcdef123456789 \
nohup node -r reflect-metadata dist/src/main.js > /tmp/labelflow-backend.log 2>&1 &

# 前端：一套 Vue 3 后台（设计器已 Vue 化，直接跑在 5173 里）
# —— 开发态：Vite dev server 5173 自动代理 /api 到后端
cd apps/console && pnpm dev

# —— 老版原生 DOM 前端（web/）⚠️ 已弃用（DEPRECATED）：仅作行为对照，不新增功能，待新前端完善后删除
node web/serve.mjs 5180

# —— 生产部署：Vue 3 构建产物托管到 NestJS 静态目录
cd apps/console && pnpm build          # 产物 dist/
cp -r dist/* backend/public/           # NestJS 自动托管 public/ 目录
```

`SQL_SECRET_KEY` 用于 AES-256-GCM 加密 SQL 连接串与 AI API Key；不配会用内置 dev key 并打 WARN。

### 10.1.4 一条命令自测

```bash
TOKEN=$(curl -s -X POST http://localhost:3200/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
curl -s http://localhost:3200/api/v1/auth/me -H "Authorization: Bearer $TOKEN"
# P0 后期望：{"code":0,...,"data":{"username":"admin","roles":["admin","tenant_admin"],
#            "modules":[...],"permissions":[37 条],"menus":[...],"features":{...},"dataScopes":[...]}}
# 更完整的登录要带租户码：-d '{"username":"admin","password":"admin123","tenantCode":"default"}'
```

---

### 10.1.5 交付状态总表（2026-11-08 复核更新，交接以本节为准）

> 结论先说：**P0–P5 六个阶段已完整交付；P6 的五个子项里，P6.1 / P6.3 / P6.4 / P6.5 四项完整**。
> **2026-11-13 更新：P6.2 阶段 B 的代码已全部落地**（业务读写路由 / 开通编排 / 退库巡检 / 运维面，见 §10.27），
> B2.2 / B2.4 / B2.5 / B2.6 / B3 也同步收口。**但阶段 B 缺少真连库验收**（沙盒只有一套 PG、无 Redis），
> 所以对外承诺口径仍是「独立库能力已实现、待真连库验收」，不是「独立库已交付」。清单见 B1 与 §10.27.4。
> 下面「未完成」按「会挡住什么」排序，不按工作量排序；标 🔴 的会挡住对外承诺，标 🟡 的是上线前必须处理，
> 标 ⚪ 的是功能缺口（不影响已交付主线）。本轮之后剩余项以 §10.27.4 的「待验收 / 未做」表为准。

> **⚠️ 2026-11-08 最新优先级调整**：SaaS/Agent 主线（P0–P6）已基本闭环，下一轮开发回到**条码设计与打印核心能力**——
> 这是产品的"命根子"，目前与 BarTender / ZebraDesigner / NiceLabel 等专业系统差距显著，详见后续待补 §10.7.3。
> 本轮复核实跑基线：单测 **217/0**（210 pass / 7 skip，0 fail）、apps/console + apps/platform + apps/mcp-server 三构建全绿、
> 默认租户 admin/operator + 新开租户 hdzz001（刚重置密码）+ 平台 platform 四账号**全部实测登录 201**。

#### A. 已完成（每一项都有可重跑的验证，不是「写完了」）

| # | 阶段 / 能力 | 交付内容 | 关键落点 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 基础产品 | 模板/版本/收藏、原生设计器、变量公式、流水号、条码二维码、打印队列（BullMQ + SSE）、ZPL/TSPL、Excel/CSV/SQL 数据源、审计、备份恢复、AI 生成模板（透视矫正/单元素重算/文本生模板/切分）、PWA | `backend/src/{template,print,datasource,backup,ai-template}`、`web/`、`apps/console` | 单测 + 手工/历史验收，见 §10.8 |
| 2 | **P0 权限订阅底座** | tenants/plans/modules/subscriptions/permissions/feature_flags、ModuleGuard/PermissionGuard、`/auth/me` 五件套、单事务开通 | `backend/src/saas/`、`scripts/saas_p0*.sql` | 验收 A–H 段 |
| 3 | **P1 前端动态化** | 菜单只读 `/auth/me.menus`、路由守卫、`v-permission`/`v-module`、未订阅落地页、订阅页 | `apps/console/src/{router,layouts,views,store}` | 验收 D–G 段 + menu.catalog 单测 |
| 4 | **P2 平台运营后台** | 平台 JWT scope、租户开通/停用/加购、套餐配置、平台审计、`apps/platform` | `backend/src/saas/platform-admin/`、`apps/platform` | 验收 I–J 段 |
| 5 | **P3 计费闭环** | 用量采集、配额软/硬限、账单/行项/收款/作废、发票登记、租户账单页 | `backend/src/billing/` | 验收 K 段 19 项 |
| 6 | **P4 Agent/MCP 只读** | agent 表、`/agent/v1`、stdio MCP、6 只读工具 + 3 元工具、resources | `backend/src/agent/`、`apps/mcp-server` | 验收 L 段 20 项 + MCP selftest |
| 7 | **P5 Agent 增强** | 5 个写/高危工具、幂等表、审批流（202 need_approval）、Agent 维度限流、`actor_type=agent` 审计、Streamable HTTP | 同上 + `scripts/saas_p5_agent_tools.sql` | 验收 M 段 31 项 |
| 8 | **P5.5 审批前端** | Agent 客户端 / Token / 待确认三页、参数摘要组件 | `apps/console/src/views/{Agents,AgentApprovals}.vue` | 验收 N 段菜单断言 |
| 9 | **P6.1 RLS 兜底** | `labelflow_app`（无 BYPASSRLS）/`labelflow_platform`、39 张表 `tenant_isolation`、事务级 GUC、fail-closed | `scripts/saas_p6_rls.sql`、`common/tenant-data-source.manager.ts` | `p6-rls-smoke.sh` 22/0 |
| 10 | **P6.2 独立库阶段 A** | `tenants.data_source_key`、数据源注册/诊断/注销、平台侧导出/硬删按库路由、provision 拒绝 dedicated | `scripts/saas_p6_dedicated.sql`、`saas/platform-admin/dedicated.*` | 验收 P 段 30 项（真连库需 `D2_DSN`） |
| 11 | **P6.3 导出/硬删（D12）** | gzip JSON 导出落 `tenant_backups`、硬删三道闸门、`purge-pre` 快照、表清单走 `pg_catalog`、保留期看板 | `saas/platform-admin/tenant-data.service.ts` | 验收 N 段 |
| 12 | **P6.4 白标（D6）** | 域名 TXT 校验、仅 verified 参与 Host 解析、品牌 7 白名单键 + CSS 变量、平台强校验通道 | `saas/branding/`、`scripts/saas_p6_branding.sql` | 验收 O 段 24 项 |
| 13 | **P6.5 Prompt 库（D8）** | 系统默认在代码、租户覆盖/自定义、`/agent-prompts` CRUD+预览、MCP 动态下发、Console 页面 | `agent/prompt.*`、`scripts/saas_p6_prompts.sql`、`views/PromptLibrary.vue` | 验收 Q 段 18 项 + 单测 8 条 |
| 14 | **设计器 Vue 化** | render/interactions/store 三件套搬进 Console：12 类元素 WYSIWYG、手势（拖动/八向缩放/旋转/框选/平移/吸附）、标尺参考线、四页签检查器、撤销重做、快捷键、模板库与版本弹窗、打印预览；iframe 已删除 | `apps/console/src/views/designer/`、`views/Designer.vue` | Playwright 18 项 E2E 全绿（0 JS 错误）+ `pnpm build`/`lint` 0 问题，见 §10.7.2 |
| 15 | **质量基线** | 单测 217、验收 267、RLS 冒烟 22、lint 0 error、console 构建、MCP 双 selftest | 命令见 §10.1.4 / §10.15.6 | 2026-11-06 全绿 |
| 16 | **WP1 码制单一真源** | `core/symbology.capabilities.ts` + EPL 生成器、ZPL/TSPL 对齐、Console 属性面板同步 | `backend/core/`、`apps/console/src/views/designer/` | 单测 +19（P7 码制测试） |
| 17 | **上线前加固（B2.2 / B2.6 / B3）** | 启动期配置强校验、Agent 出域字段脱敏（四个返回点全覆盖）、三维限流 + `X-RateLimit-*` 响应头 | `common/config.guard.ts`、`agent/redaction.calc.ts`、`agent/rate.calc.ts`、`agent/agent-rate.service.ts` | 单测 +25 / typecheck 0 |
| 18 | **定时任务 + 通知基建（B2.4 / B2.5）** | `maintenance` 队列三个 repeatable 任务、站内信表/实体/通道接口/API、调度计划纯函数 | `jobs/`、`notify/`、`scripts/saas_p7_notifications.sql` | 单测 +9 / 编译通过（真触发待验收） |
| 19 | **P6.2 阶段 B（B1）** | 全局 Repository/事务租户路由（16 模块）、拦截器读真实 key、开通编排状态机与执行器、退库巡检、per-key 池/SSL/健康检查 | `common/tenant-routing.*`、`saas/platform-admin/dedicated.*.calc.ts`、`dedicated.provision.service.ts` | 单测 +21 / DI 图构建通过（真连库待验收，见 §10.27.4） |

#### B. 未完成清单（按「会挡住什么」排序）

**🔴 B1. P6.2 阶段 B：不做就不能对外承诺「独立库已交付」**

| # | 缺口 | 现状 | 要做什么 / 验收口径 | 落点 |
| --- | --- | --- | --- | --- |
| 1 | 业务读写接管 | 所有 Repository 仍绑默认 DataSource，独立库只在**平台侧导出/硬删**里生效 | 按 `TenantCtx.dataSourceKey` 把业务事务路由到 `tdsm.get(ctx)`；验收：独立库租户建模板/打库存，共享库 0 行 | `common/tenant-data-source.manager.ts` 的所有注入点 |
| 2 | 开通编排 | provision 对 `type=dedicated` 直接 400（防假隔离） | 建库 → 跑全量 DDL → 迁移租户行与业务数据 → 行数校验 → 切 `data_source_key` → 回滚预案；验收：一条命令开通且失败可回滚 | `saas/provision.service.ts` + 新脚本 |
| 3 | 退库回收 | 注销要求「先迁走」，没有任何回收动作 | 硬删后决定保留/销毁独立库；至少一条巡检「库还在、租户已删」 | `tenant-data.service.ts` |
| 4 | 运维面 | 只有全局 `DB_DEDICATED_POOL`（默认 4） | 每租户池上限、SSL 参数、DSN 轮换、健康检查 | `tenant-data-source.manager.ts` |
| 5 | 备份 | 只有逻辑 JSON gzip，不是 PITR；独立库物理备份没有 | 独立库物理备份/恢复方案，或明确写入合同「只保证逻辑导出」 | 运维文档 |

> **2026-11-13 阶段 B 落地说明（逐项对照上表，详细见 §10.27）**
> 1️⃣ 业务读写接管：`common/tenant-routing.ts` 的动态 Repository 代理 + `tenant-typeorm.module.ts`（16 个模块统一改 import 一行，业务 Service 零改动）；
> `TenantContextInterceptor` 从目录库读真实 `data_source_key`（此前硬编码 `'default'`，是路由闭环的关键缺口）；事务走 `TENANT_DATASOURCE` 代理。
> 2️⃣ 开通编排：`dedicated.orchestration.calc.ts` 状态机（`switch_key` 仅在 `verify_counts` 通过后可达）+ `dedicated.provision.service.ts`（建库 → DDL → 搬数据 → 行数校验 → 注册 → 切 key → 逆序回滚），
> 平台端点 `POST /platform/tenants/dedicated`（一条命令开通）与 `POST /platform/tenants/:id/dedicated/plan|provision`。**失败时租户仍留在共享库，天然回滚；绝不自动 DROP DATABASE。**
> 3️⃣ 退库回收：`GET /platform/datasources` 新增 `reclaimable`（库还在、租户已删）、`unregisteredRefs`；`POST /platform/datasources/:key/reclaim` 注销孤儿连接池（不删物理库）。
> 4️⃣ 运维面：`dedicated.ops.calc.ts` 的 per-key 池上限 / 超时 / SSL（严格校验证书）已接入 `TenantDataSourceManager.buildDedicated`；`GET /platform/datasources/health` 出健康快照。
> 5️⃣ 备份：**仍未做**（独立库物理备份 / PITR 依旧缺，需运维文档明确「只保证逻辑导出」）。
>
> ⚠️ 上述 1–4 项的**代码与纯逻辑已验证，真连库验收未做**（沙盒无第二套 PG / 无 Redis）。因此本表 🔴 状态从「未做」改为「已实现、待真连库验收」，**不是「已交付」**。

**🟡 B2. 上线前必须处理（不挡开发，但挡上线）**

1. **主链路仍是 owner 连库**：RLS 目前只是第二道防线，`labelflow` 是 owner/超管会绕过策略。
   切到 `labelflow_app` 的条件与顺序见 §10.22.4；切的时候必须同时把「按域名公开解析租户」改走平台角色连接，否则 fail-closed 会让白标静默失效。
2. ~~**弱口令/密钥**~~ → **2026-11-13 已收口**：`common/config.guard.ts` 在 `main.ts` bootstrap 最前面做 fail-fast（生产带 dev 密钥/弱口令拒绝启动），dev/test 只 warn；密钥明文绝不进日志/错误。**仍需运维侧**用密钥管理注入真实值（代码不再允许默认值上生产）。
3. **白标真实 DNS 未验证**：TXT 比对只有单测 + 平台强校验通道覆盖；上线前拿真域名走一遍并关掉逃生口，ACME 证书自动化未做。
4. ~~**定时任务缺失**~~ → **2026-11-13 已收口**：`jobs/` 的 BullMQ `maintenance` 队列注册三个 repeatable 任务（订阅到期前 7 天提醒 / 审批过期批量回写 / `tool_idempotency` 30 天 TTL 分批清理），判定逻辑在纯函数 `jobs/schedule.calc.ts`。**待验收**：沙盒无 Redis，未真实触发过调度（见 §10.27.4）。
5. ~~**消息/通知基建缺失**~~ → **2026-11-13 已落地 V1**：`notifications` 表（含 RLS 兜底与 dedupe 唯一索引）、站内信通道、`NotificationChannel` 扩展接口、`/api/v1/notifications` 四个端点。**邮件/飞书/短信仍未提供实现**，只有接口与注册中心。
6. ~~**敏感数据**~~ → **2026-11-13 已收口**：`agent/redaction.calc.ts` 字段级脱敏经 `ToolsService.egress()` 覆盖**全部四个出域返回点**（正常返回 / need_approval / 两处幂等重放），命中时写 `warnings` 显式告知模型数据被裁剪。

**⚪ B3. 功能缺口（不影响已交付主线，按需排期）**

- MCP 工具未注册：`print.estimate`、`print.wait_for_job`、`print.cancel_job`、`ai.*`、`alerts.*`（目录里没有条目，调用是 404，不是占位）。
- ~~限流只有 Agent 维度~~ → **2026-11-13 已收口**：`rate.calc.ts` 扩到 agent / tool / token 三维（后两维默认关闭，靠 `rollout.tool_rpm|token_rpm|per_tool` 按需开启，不无预警收紧存量租户），成功与 429 都下发 `X-RateLimit-*` + `Retry-After`；agent 维度 key 保持 `lf:agent:rl:<tenant>:<client>:<桶>` 不变以兼容验收 M 段。
- D10 反向 MCP（`external_mcp_servers`）只有表，不实现。
- P6.5 Prompt：无版本历史/回滚、不按角色或用户分、无调用量/采纳率统计。
- P3：税务发票开具、支付回调/自动扣款、退款红字冲正、续费提醒、按量计费、账单 PDF、多币种均未做（V1 口径见 §10.19.5）。
- 数据源仅 `postgresql://`；MySQL/SQLServer 未实现。
- 测试盲区：无 Nest 容器级 e2e、无前端测试、无打印 worker 测试；`web/js` 原生前端无 lint。
- 白标：按套餐 gating、自定义字体/租户 CSS 文件、一个租户多域名分别品牌均未做（多域名共用一套）。

**⚪ B4. 刻意不做 / 设计取舍（别当 bug 修）**

- 系统提示词权威副本在代码，DB 只存租户覆盖；同名覆盖、删除回落（避免 N 份存量文案）。
- `provision` 对 dedicated 明确 400：宁可拒绝，也不制造「以为隔离了」的假象。
- MCP 提示词清单 60s TTL：改完最迟一分钟生效，不要求重启客户端。
- 单测禁止 import TypeORM 实体/Nest module（`tsx` 不产装饰器元数据）：可测逻辑必须抽纯函数。
- `meta.permission` 单值、家生子仅单层 FK、`bom_items` 走父表 EXISTS。
- 独立库 DSN 永不落库，只存 `data_source_key`。

#### C. 交接第一天：把环境跑起来

```bash
# 1) 数据库（沙盒里数据目录是 /tmp/pfdata，端口 5433；系统盘 cluster 14/main 是空的，别用错）
su postgres -c "/usr/lib/postgresql/14/bin/pg_ctl -D /tmp/pfdata -o '-p 5433 -k /tmp' -l /tmp/pfdata.log start"
redis-server --port 6380 --daemonize yes

# 2) 建表顺序（全部幂等，可重跑）
#    docs/03-database.sql → backend/scripts/seed.sql → saas_p0.sql → saas_p0_roles.sql
#    → saas_p2_platform.sql → saas_p3_billing.sql → saas_p4_agent.sql → saas_p5_agent_tools.sql
#    → saas_p6_rls.sql → saas_p6_tenant_data.sql → saas_p6_branding.sql → saas_p6_dedicated.sql
#    → saas_p6_prompts.sql → saas_p7_notifications.sql

# 3) 后端
cd backend && npx tsc -p tsconfig.json
setsid env PORT=3200 DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=labelflow DB_PASS=labelflow DB_NAME=labelflow \
  DB_RLS_USER=labelflow_app DB_RLS_PASSWORD=labelflow_app REDIS_PORT=6380 \
  JWT_SECRET=<32+字符> SQL_SECRET_KEY=<60 hex> BRANDING_DEV_VERIFY=1 \
  D2_DSN='postgres://labelflow:labelflow@127.0.0.1:5433/labelflow_d2' \
  node -r reflect-metadata dist/src/main.js </dev/null >/tmp/api.log 2>&1 &

# 4) 全量验收（每次换新的 T_CODE/T2_CODE，否则 A.1 撞租户唯一约束）
cd /app/label-print-system && DB_RLS_USER=labelflow_app D2_DSN='...' T_CODE=hand1 T2_CODE=hand1pro \
  bash backend/scripts/p0-acceptance.sh     # 期望「通过 267 / 失败 0」
```

账号：默认租户 `admin/admin123`；平台后台 `platform/platform#2026`；验收脚本自建租户的密码统一 `P0accept#2026`。

#### D. 验收基线（2026-11-06 实跑，重跑数值应一致）

| 命令 | 基线 | 覆盖 |
| --- | --- | --- |
| `cd backend && npm test` | **217 / 0** | 纯函数 + 守卫 + 校验 + 计费/Agent/P6 各 calc |
| `bash backend/scripts/p0-acceptance.sh` | **267 / 0**（A–Q） | 权限订阅、平台、计费、Agent 读写/审批/限流、RLS、导出/硬删、白标、独立库、Prompt |
| `bash backend/scripts/p6-rls-smoke.sh` | **22 / 0 / 0** | fail-closed、跨租户不可见、角色属性 |
| `npm run lint`（backend） | 0 error / 13 warning（存量） | 新增文件 0 error |
| `apps/console` `npm run build` | 通过 | vue-tsc + vite |
| `apps/mcp-server` `npm run selftest[:http]` | 通过 | 工具/prompts/resources/会话回收 |

细节索引：P0 §10.15 · P1 §10.16 · 校验 §10.17 · P2 §10.18 · P3 §10.19 · P4 §10.20 · P5 §10.21 ·
P6.1 §10.22 · P6.3 §10.23 · P6.4 §10.24 · P6.2 §10.25 · **P6.5 §10.26**。

#### E. 环境注意（沙盒特有，接手先看）

- `github.com:443` 在本沙盒不可达；推送走 `api.github.com` 的 Git Data API（本地 commit 与远端内容一致，提交哈希不同）。
- 沙盒重启后 PostgreSQL/Redis 都要手动拉起（见 C.1），API 必须重新 `npx tsc` 并重启。
- 新增 TypeORM 实体必须同时加到 `backend/src/entities/index.ts`，否则运行时报
  `EntityMetadataNotFoundError`（接口表现是 500 而不是 400）。
- 验收脚本会真实建租户/删数据，只对自建靶租户操作；跑之前确认 `D2_DSN` **不是**共享库本身。

---

## 10.2 技术栈与目录结构

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端（后台） | Vue 3 + TS + Vite + Element Plus + Pinia | `apps/console/`；pnpm build 出包后托管到 NestJS 静态目录；设计器已 Vue 化（见 §10.7.2） |
| 前端（设计器） | 原生 HTML5 + CSS + ES Modules | `web/` 目录；DOM 拖拽（非 Canvas/Konva），后续逐步 Vue 化 |
| 后端 | NestJS 10 + TypeScript（commonjs） | 单进程；队列 Worker 在同一进程内 |
| ORM | TypeORM 0.3 + SnakeNamingStrategy | `synchronize: false`，DDL 走 `docs/03-database.sql` |
| DB / 队列 | PostgreSQL 16 / Redis 7 + BullMQ | |
| 图片/条码 | `sharp` / `zxing-wasm` / `@bwip-js/node` | |
| OCR | PaddleOCR HTTP（可选）/ `tesseract.js`（兜底） | |
| LLM | OpenAI 兼容 `/chat/completions` | 可指向 OpenAI / Qwen / 智谱 / Ollama |

```
label-print-system/
├── backend/
│   ├── core/                     # 纯函数引擎（ZPL/TSPL/公式/校验位/PNG 编码）
│   │   └── __tests__/            # 16 个单测（引擎层；P0 后 src 下另有 126 个，见 §10.15.6）
│   ├── printer/                  # PrinterProvider 抽象与实现
│   ├── assets/tessdata/          # OCR 语言包（.gitignore，需下载）
│   └── src/
│       ├── main.ts               # 引导：全局守卫/拦截器/过滤器 + seed 管理员
│       ├── app.module.ts         # 所有 Module 汇总
│       ├── common/               # 守卫/装饰器/上下文/响应/异常
│       ├── entities/             # 全部 TypeORM 实体（index.ts 统一导出）
│       ├── auth/ template/ serial/ formula/ barcode/
│       ├── printer/ print/ datasource/ audit/ user/
│       └── ai-template/          # AI 图片→模板（11 个文件）
├── web/                          # ⚠️ 已弃用（DEPRECATED）：老版原生 HTML5 前端，仅作对照，待新前端完善后删除
│   ├── index.html                # 老版页签
│   ├── css/app.css
│   ├── js/                       # 原生 ES Module：app/store/model/render/...
│   ├── serve.mjs                 # 静态服务器
│   └── sw.js / manifest.webmanifest   # PWA
├── docs/                         # 01 需求 / 02 架构 / 03 DDL / 04 schema /
│                                 # 05 API / 08 计划 / 09 AI 生成 / 10 本文档
└── docker-compose.yml
```

---

## 10.3 后端模块地图

> 所有路由前缀都带全局前缀 `/api/v1`。默认全局守卫：`JwtAuthGuard` → `RolesGuard`；
> 控制器上的 `TenantGuard` 负责校验并写入租户上下文。

| Module | 路由前缀 | 关键文件 | 写权限（`@Roles`） |
| --- | --- | --- | --- |
| AuthModule | `auth` | `auth.controller.ts` `auth.service.ts` | 公开：`login` `refresh`；登录：`me` `logout` |
| TemplateModule | `templates` | `template.controller.ts` `template.service.ts` | admin/operator |
| SerialModule | `serial-sequences` | `serial.controller.ts` `serial.service.ts` | 读：任意登录 |
| FormulaModule | `formula` | `formula.module.ts` + `core/formula-engine.ts` | 任意登录 |
| BarcodeModule | `barcode` | `barcode.module.ts` + `core/barcode-renderer.ts` | 任意登录 |
| PrinterModule | `printers` | `printer.module.ts` | admin/operator |
| PrintModule | `print/jobs`、`print/preview`、`print/commands`、`print-stream` | `print.controller.ts` `print.service.ts` `print.processor.ts` `render.service.ts` `html-renderer.ts` `events.event.ts` | 提交/取消/重打：admin/operator |
| DataSourceModule | `data-sources` | `datasource.module.ts` `sql-crypto.ts` `sql-executor.ts` | 上传/删除：admin/operator；SQL 执行：admin/sql |
| AuditModule | `audit/logs` | `audit.module.ts` | 导出：**仅 admin** |
| UserAdminModule | `users` | `user/user.module.ts` | **仅 admin** |
| AiTemplateModule | `ai-template` | 见 §10.6 | admin/operator（模型配置仅 admin） |

### 10.3.1 请求生命周期（务必理解）

```
请求
 → JwtAuthGuard（全局）        解析 Bearer 或 ?token= → req.user = {sub, tenantId, roles}
 → RolesGuard（全局）          读 @Roles 元数据，admin 永不拦截
 → TenantGuard（控制器级）      校验 tenantId，兜底写入 AsyncLocalStorage
 → TenantContextInterceptor    用 tenantStorage.run(ctx) 包裹整条调用链
 → Controller → Service         业务层一律通过 useTenantId() / useTenant() 取上下文
 → ResponseInterceptor          统一包成 { code: 0, message: 'ok', data, traceId }
 → AllExceptionsFilter          异常统一为 { code, message, data: null }
```

关键点：**业务代码禁止从 body/query 读 tenantId**，只能 `useTenantId()`。

---

## 10.4 数据库

### 10.4.1 表清单

| 分组 | 表 |
| --- | --- |
| 租户鉴权 | `tenants` `users` `user_roles` `refresh_tokens` |
| 模板 | `templates` `template_versions` `template_assets` `template_shares` |
| 流水号 | `serial_sequences` `serial_usage_log` |
| 打印 | `printers` `print_jobs` `print_logs` |
| 数据 | `data_sources` `data_rows` |
| 审计/备份 | `audit_logs` `tenant_backups` |
| AI | `ai_template_jobs` `ai_model_configs` |

完整 DDL：`docs/03-database.sql`。

### 10.4.2 建表方式

```bash
DB_URL="postgresql://labelflow:labelflow@localhost:5433/labelflow" \
  psql "$DB_URL" -f docs/03-database.sql
```

- `user_roles.role` 的 CHECK 约束必须是 `('admin','operator','sql','viewer')`，
  与 `backend/src/common/roles.guard.ts` 的 `RoleName` 保持一致（历史文档写过旧角色名，已修正）。
- `ai_template_jobs` / `ai_model_configs` 在 DDL 的 §8.5 节。

### 10.4.3 手工补的数据（新环境必须做）

**一键方案（推荐）**：已存 [backend/scripts/seed.sql](file:///workspace/backend/scripts/seed.sql)，包含租户 `default` + 用户 `admin/admin123` + `operator/op123` + 角色绑定：

```bash
PGPASSWORD=labelflow psql -h localhost -U labelflow -d labelflow \
  -f backend/scripts/seed.sql
```

也可以让 `main.ts` 首次启动时自动种入（幂等），但 `backend/scripts/seed.sql` 同时显式提供 bcrypt hash 值，**避免接手人需要自己跑 bcrypt 生成**。

> ⚠️ 如果跳过 seed.sql 或 main.ts 种入步骤，直接用一个空 DB 启动后端，你会得到 "tenant not found" / "invalid credentials" 错误——这是 e2e 实测确认过的。

---

## 10.5 核心设计约定（改代码前必读）

### 10.5.1 单位与坐标

- 画布 / 模板 / 打印**统一用 mm**；屏幕像素 `px = mm × (96/25.4) × zoom`。
- 字号例外：`font.size` 是 **pt**（不是 mm），1mm ≈ 2.83pt。
- 打印 HTML 用 mm + `@page`，与设计器共用 `render.js` 的渲染语义。

### 10.5.2 元素 Schema（最容易踩坑的地方）

以 `web/js/model.js` 的 `createElement()` 产物为准（前端渲染器直接消费）：

| 类型 | 关键字段 | 陷阱 |
| --- | --- | --- |
| `text` | `text` + `font{family,size,color,bold,italic,align,vAlign,wrap}` | 字号是 pt |
| `barcode` | `barcode{sym,content,moduleWidthMm,wideRatio,heightMm,showText,textPosition,checksum,quietZoneMm,textFont}` | `sym` 取值 `CODE128/CODE39/EAN13/UPC_A/ITF14/...` |
| `qrcode` | `qrcode{sym,content,ecc,moduleSizeMm,quietZoneMm,version}` | `sym` 固定 **`QRCODE`**（不是 `QR`）；纠错级字段名是 **`ecc`**（不是 `errorLevel`） |
| `line` | `x,y,x2,y2` + `stroke{width,color,style}` | **用端点坐标**，不是 w/h；w/h 仅供选中框 |
| `rect`/`ellipse` | `fill` + `stroke` | |
| `table` | `rows,cols,cells[],showBorder,borderWidth,borderColor,headerRow,headerBg,font` | `cells` 是**扁平数组**（行优先，长度 = rows×cols） |
| `image` | `src` | 支持 `data:image/...;base64,` 内联 |
| `serial` | `serial{sequenceRef,digits,prefix,suffix}` + `font` | 真实号段由后端 `SerialNumberService` 分配 |

变量结构：`{ name, type: 'text'|'number'|'date'|'boolean'|'image', label, defaultValue, required, unique }`。
模板顶层：`{ schemaVersion: 1, page, variables, elements }`。

### 10.5.3 打印链路

```
POST /print/jobs
 → PrintService.createJob      预分配流水号号段（行锁，不重号）
 → print_jobs 记录 queued      BullMQ add('print', jobId: print-<id>)
 → PrintProcessor (@Processor)  逐张渲染 → PrinterProvider 下发 → 写 print_logs
                                → PrintEvents.publish() 推 SSE
 → GET /print-stream/events?token=  前端 EventSource 实时进度
```

- 通道由 `PrinterProviderRegistry` 路由：`raw_tcp` / `browser` / `image` / `windows_spooler`。
- ZPL / TSPL 生成器在 `backend/core/`，**必须按码制输出原生指令**，不得统一降级为 Code128/QR。
- `POST /print/commands` 返回 `warnings`（不支持的码制、TSPL 中文字库依赖），不得静默降级。

### 10.5.4 RBAC（P0 后已升级为四层模型，详见 §10.15）

- 旧四档角色：`admin` / `operator` / `sql` / `viewer`，定义在 `common/roles.guard.ts`。
  **D11 起 `sql` 并入 `manager`**，但兼容期两个码同时回显（`["sql","manager"]`），`@Roles('sql')` 仍然可用。
- D11 内置角色（`roles` 表）：`tenant_admin` / `manager` / `operator` / `warehouse_keeper` / `purchaser` / `viewer`。
- 用法：`@Roles('admin', 'operator')` 贴 handler 或 controller；命中其一即可，`admin`/`tenant_admin` 对任何声明**无条件放行**（便于运维）。
- 新增两层拦截（`main.ts:75` 全局守卫链）：
  `@RequireModule('print')` = 订阅层（未订阅 → 403/4031），`@RequirePermission('template:write')` = 权限点层（不足 → 403/4032）。
  口诀：**模块是门，权限是钥匙**。
- 前端 `app.js` 的 `applyRoleConstraints()` 会按角色禁用/隐藏危险按钮——
  这只是 UX，**真正的权限必须在后端**；动态菜单数据源是 `/auth/me.menus`（前端尚未接入，属 P1）。

### 10.5.5 统一响应与错误

- 成功：`{ code: 0, message: 'ok', data, traceId }`
- 失败：`{ code: <httpStatus 或业务码>, message, data: null }`
- 业务校验失败请抛 `BadRequestException`，**不要抛裸 `Error`**（会被包成 500）。

---

## 10.6 AI 模板生成模块（最近新增，最需要理解）

### 10.6.1 流水线（10 步）

```
上传图片 + 宽高mm/DPI
 1 sharp.metadata()            取像素尺寸
 2 toRgba()/toGray()           解码（必须 flatten 白底，否则透明图整片黑）
 3 detectBarcodes()            zxing-wasm；整图扫 → 无结果再 2×2 / 3×3 分块
 4 recognize()                 PaddleOCR HTTP → 失败回落 tesseract.js
 5 detectLines()               Otsu 二值化 + 行/列最长暗串 → 水平/垂直线
 6 detectColorRegions()        降采样 + 饱和度连通域 → logo/产品图，sharp 裁出 data URL
 7 buildTemplateFromPriors()   启发式组装元素 + 变量（详见 §10.6.3）
 8 callVision()（可选）         把 OCR/条码/几何/初稿作为先验塞给 OpenAI 兼容模型
 9 validateAiTemplate()        LLM 输出校验：类型白名单/码制枚举/坐标 clamp/变量补全
10 落库 ai_template_jobs + 审计
```

### 10.6.2 文件职责

| 文件 | 职责 |
| --- | --- |
| `barcode-reader.ts` | zxing-wasm 封装；`toRgba/toGray`；`toBarcodeSym()` 码制映射 |
| `ocr-adapter.ts` | PaddleOCR HTTP（兼容多种返回形状）→ tesseract.js 兜底；worker 复用 |
| `geometry.ts` | Otsu、长直线检测、彩色连通域、`insideRatio/overlaps` |
| `heuristics.ts` | 分类规则、变量命名、条码区域抑制、px→mm 组装、置信度 |
| `coords-transform.ts` | px→mm、`estimateFontPt`、模块宽估算 |
| `prompt.ts` | System/User prompt（含完整字段契约） |
| `vision-llm.ts` | OpenAI 兼容调用、图片压缩（长边 1280/JPEG 80）、JSON 提取、ping |
| `validate-ai-template.ts` | LLM 输出校验与修正 |
| `ai-template.service.ts` | 编排 + 置信度 IoU 继承 + 落库 + 审计 |
| `ai-template.controller.ts` | 7 个路由 |

### 10.6.3 启发式规则（要改分类逻辑从这里入手）

- **KV 键值对**：`Label: value` → 值替换成 `{{var}}`，整行保留（不拆成两个元素）。
- **日期 / 时间**：`YYYY-MM-DD`、`DD/MM/YYYY` → `datetime` 变量（默认 `expiryDate`）。
- **长数字串**（≥6 位纯数字）→ `serialNo`；**字母+数字编码** → `batchNo`。
- **零售码制**（EAN/UPC）→ 变量 `barcodeNo`（商品条码），**不要**判成流水号。
- **名称映射表**：`NAME_RULES`（中文关键词 → 英文变量名），加关键词改这里。
- **条码区域抑制**（关键）：
  - zxing 对一维码上报的 bbox **不含**条码下方明文 → 判断时纵向放宽 `60%`（`expandV`）。
  - 双重判定：元素中心点落入 + 水平覆盖率 > 55%。
  - 另用「密集竖线簇」（≥8 条、间距 <12px、y 区间重叠 >60%）反推**未解码**的一维码区域。
- **文本清洗**：`cleanText()` 去行尾噪声（含英文行尾部误识别的 CJK 碎片）。
  ⚠️ **分类与替换必须基于同一份清洗后文本**，否则 `replaceFrom` 匹配失败（曾是真实 bug）。
- **文本框收紧**：`tightBox()` 用字级 bbox；注意 tesseract 返回的 `data.blocks` 需要
  `worker.recognize(buf, {}, { blocks: true })` 才会填充，否则 `words` 为空。

### 10.6.4 配置优先级

`ai_model_configs(is_default=true)` → 环境变量 `OPENAI_API_KEY/BASE_URL/MODEL` → 都没有则只跑规则引擎
（在 `meta.warnings` 明确提示，不报错）。

---

## 10.7 前端结构

### 10.7.1 Vue 3 后台（apps/console/ —— 新增于 2026-11-04）

```
apps/console/src/
├── main.ts                    Element Plus + Pinia + Router 入口
├── App.vue                    纯 router-view
├── styles/main.css            登录 / 布局 / 通用
├── api/index.ts               axios：auth / users / print / backups / ai 6 组 API
├── store/auth.ts              Pinia：login + fetchMe + logout + hasPermission()
├── router/index.ts            动态菜单 + permission 路由守卫
├── layouts/MainLayout.vue     顶部导航（动态菜单过滤）+ 头像下拉
└── views/
    ├── Login.vue              租户 / 用户名 / 密码
    ├── Dashboard.vue          ECharts 打印统计仪表盘
    ├── UserManagement.vue     完整 CRUD + 角色 checkbox + 重置密码 + 删除
    ├── PrintJobs.vue          打印任务列表
    ├── Backups.vue            备份中心（P2 新增）
    ├── Templates.vue          引导页（模板管理在设计器里）
    ├── Designer.vue           设计器宿主页（2026-11-06 起为原生 Vue 实现，iframe 已删除）
    └── designer/              设计器本体，见 §10.7.2
```

### 10.7.2 Vue 化设计器（apps/console/src/views/designer/ —— 2026-11-06）

> 原生版（`web/`）的三个大件按 `render.js → 组件` / `interactions.js → 组合式` / `store.js → Pinia`
> 搬进了 Console，模板 JSON 语义、mm 坐标、快照式撤销重做、WYSIWYG 表现与原生版**逐项对齐**；
> `web/` 保留为老版本独立客户端，行为口径以它为准（改设计器时先看它，再看这里）。

```
apps/console/src/views/designer/
├── types.ts                   元素/页面/变量 schema（对齐 web/js/model.js，唯一事实来源不变）
├── model.ts                   TOOLS / createElement() / defaultTemplate() —— 逐字段照搬原生
├── store.ts                   Pinia(options)：template + 选中 + 历史栈（HISTORY_LIMIT 80）
├── designer.css               全套样式端口（--d-* 变量，类名与原生版一致）
├── useShortcuts.ts            窗口级快捷键（Ctrl+Z/Y/A/D/C/V/X/S/G、方向键、Delete、Enter）
├── useAutosave.ts             400ms 防抖写 localStorage
├── useTemplateIO.ts           保存/另存为/打开/导入导出（走 §10.5 的 /templates 契约）
├── useGestures.ts             Pointer 手势：选中/拖动/八向缩放/旋转/框选/平移/吸附/参考线
├── engine/                    无框架依赖的纯函数层（可单测、可被打印复用）
│   ├── util.ts                MM2PX / r2 / clamp / deepClone（JSON 往返，见下方坑）
│   ├── context.ts             buildContext() + 白名单公式求值器
│   ├── barcode.ts             bwip-js 4.11.4 SVG（scale 4）+ 编码自检
│   ├── render.ts              元素尺寸/样式计算，等价 render.js
│   └── print.ts               buildPrintHtml()：@page + 拼版 + parseData（JSON/CSV/TSV）
└── components/
    ├── DesignerToolbar.vue    名称、脏标记、#id vN、撤销重做、缩放、标尺、层级、复制删除、导入导出保存
    ├── DesignerToolbox.vue    左侧元素库（12 类，落点居中 + clamp）
    ├── DesignerCanvas.vue     视口/页面/元素/覆盖层（选中框、手柄、框选、文本编辑器）
    ├── DesignerElement.vue    单元素渲染 = render.js#renderElement 的声明式版
    ├── DesignerRulers.vue     标尺 + 从标尺拖出参考线
    ├── InspectorPanel.vue     四页签容器（属性/页面/图层/变量）+ COMMIT_KEY 事务
    ├── PropsPanel.vue         按类型分支的属性表单
    ├── PagePanel.vue          页面尺寸/介质/拼版/校准
    ├── LayersPanel.vue        图层列表 + 排序 + 锁定/隐藏
    ├── VariablesPanel.vue     变量定义与校验
    ├── fields/                FInput / FSelect / FColor / FNumber … 通用字段（focus 快照、blur 提交）
    ├── TemplateLibraryDialog.vue  模板库：列表/搜索/收藏/打开/复制/导出/删除 + 版本对比/载入/回滚
    └── PrintPreviewDialog.vue     打印预览：数据源 + 份数/流水号 + srcdoc iframe
```

**三条实现纪律（改这里之前先读）**

1. **类名与 `data-*` 是手势层契约**：`.lf-el[data-id]`、`[data-page]`、`[data-handle]`、`[data-guide-id]`
   不能改名——`useGestures` 直接对真实 DOM 做命中测试（和原生版一样），改了静默失效。
2. **历史粒度统一**：手势用 `snapshot()` → 松手 `commitSnapshot(before)`；表单用 `COMMIT_KEY` 的
   `begin()/end()`（focus 打快照、change/blur 提交）；标尺拖新参考线用 `addGuideSilent` + 一次提交。
   任何「拖动过程中每帧 push 历史」的写法都会把 HISTORY_LIMIT 撑爆并毁掉撤销体验。
3. **`deepClone` 必须走 JSON 往返**：Pinia 的 `template` 是 reactive Proxy，`structuredClone(proxy)`
   会抛 `DataCloneError`，表现为「拖不动 + 撤销全废」且只在浏览器里报错。原生版用 `structuredClone`
   是因为它的数据是普通对象，这里不能照抄。

**验证口径**：Playwright 18 项 E2E（登录 → 打开 `/designer` → 加元素 → 撤销/重做 → 拖动 → 缩放 →
属性回写 → 一维码 SVG → 标尺拖参考线 → 保存出版本 → 模板库列表/缩略图/打开 → 打印预览含 `@page`）
全绿，0 条 JS 错误；`pnpm build` + `pnpm lint` 0 问题。已知差异：Console 侧不引 SheetJS，
Excel 数据文件仍在原生版/后端解析，预览弹窗只吃 JSON/CSV/TSV。

### 10.7.3 条码设计与打印核心能力差距盘点（2026-11-08，产品命根子）

> **核心事实**：前端**能选** 14 种一维码 + 6 种二维码，但后端真正能**直接输出原生指令**的码制不到一半——
> `zpl-generator.ts` 第 203 行 `return zplBarcodeLine('CODE128', ...)` 把所有未识别码制静默降级为 Code128；
> `tspl-generator.ts` 第 133 行 `return map[s] ?? map[uppercased] ?? '128'` 同样统一回落。
> 这不是"能跑就行"的问题——**医药/零售/物流客户按码制合规性（如 GS1-128 的 FNC1 语义、ITF-14 的固定宽度、
> EAN/UPC 的前缀/校验位规则）买专业标签系统**，静默降级等于丢客户。

#### A. 码制覆盖现状（2026-11-08 扫描）

| 类别 | 码制 | 前端可选 | 后端位图编码 | ZPL 原生指令 | TSPL 原生指令 | 现状 |
|---|---|---|---|---|---|---|
| 一维线性 | CODE128 | ✅ | ✅ 内置 `code128` | ✅ `^BC` | ✅ `128` | ✔ 全链路 |
| 一维线性 | GS1_128 | ✅ | — 回落 Code128 | ✅ `^BC` + FNC1 前缀 | ✅ `128` | ⚠ ZPL 有 GS1，TSPL 未显式处理 FNC1 |
| 一维线性 | CODE39 | ✅ | — 回落 bwip-js | ✅ `^B3` | ✅ `39` | ✔ |
| 一维线性 | CODE93 | ✅ | — 回落 bwip-js | ✅ `^B9` | ✅ `93` | ✔ |
| 一维线性 | EAN13 | ✅ | ✅ 内置 `ean13` | ✅ `^BE` | ✅ `EAN13` | ✔ |
| 一维线性 | EAN8 | ✅ | — 回落 bwip-js | ✅ `^B8` | ✅ `EAN8` | ✔ |
| 一维线性 | UPC_A | ✅ | — 回落 bwip-js | ✅ `^BU` | ✅ `UPCA` | ✔ |
| 一维线性 | UPC_E | ✅ | — 回落 bwip-js | ✅ `^B0` | ✅ `UPCE` | ✔ |
| 一维线性 | ITF14 | ✅ | — 回落 bwip-js | ✅ `^BE` 包装 | ✅ `ITF14` | ✔ |
| 一维线性 | ITF | ✅ | — 回落 bwip-js | ✅ `^BI` | ✅ `ITF` | ✔ |
| 一维线性 | CODABAR | ✅ | — 回落 bwip-js | ✅ `^BK` | ✅ `CODABAR` | ✔ |
| 一维线性 | MSI | ✅ | — 回落 bwip-js | ❌ **统一降级 Code128** | ✅ `MSI` | 🔴 必须修 |
| 一维线性 | PHARMACODE | ✅ | — 回落 bwip-js | ❌ **统一降级 Code128** | ❌ **128 回落** | 🔴 必须修 |
| 一维线性 | CODE16K | ✅ | — 回落 bwip-js | ❌ **统一降级 Code128** | ❌ **128 回落** | 🔴 必须修 |
| 二维 | QRCODE | ✅ | ✅ bwip-js | ✅ `^BQ` | ✅ `QRCODE` | ✔ |
| 二维 | MICROQR | ✅ | — 回落 bwip-js | ⚠ 未显式 | ❌ | 🟡 需补 |
| 二维 | DATAMATRIX | ✅ | ✅ bwip-js | ✅ `^BX` | ❌ 无 TSPL DataMatrix 命令 | 🟡 TSPL 缺 |
| 二维 | DATAMATRIX_RECT | ✅ | — | ❌ | ❌ | 🟡 需补 |
| 二维 | PDF417 | ✅ | ✅ bwip-js | ✅ `^B2` | ❌ | 🟡 TSPL 缺 |
| 二维 | AZTEC | ✅ | — 回落 bwip-js | ❌ | ❌ | 🟡 需补 |

> **后端位图编码**：只有 `barcode-encoder.ts` 里手写了 Code128 和 EAN13 两个编码器，其余全部在打印链路里走 bwip-js（前端预览也是 bwip-js）。
> 这意味着：**只要不走到自定义位图渲染路径（HTML 打印），大部分码制能工作；一旦生成器不支持，就静默降级**。

#### B. 缺失的专业能力（对比 BarTender / ZebraDesigner / NiceLabel）

**🔴 B1. 指令生成器不支持但承诺支持的码制**
- MSI / PHARMACODE / CODE16K：ZPL 生成器统一回落 Code128，TSPL 生成器同样回落。前端可选、预览可用（bwip-js），但打印到 Zebra 或 TSC 标签机上**就是错的**。
- MICROQR / DATAMATRIX_RECT / AZTEC：二维码类，ZPL/TSPL 都缺指令。

**🔴 B2. ZPL 统一回落 Code128（文档硬伤）**
- `zpl-generator.ts` 末尾的 `default: return zplBarcodeLine('CODE128', ...)` 违反 `docs/05-api.md` §8.3 的硬约束："不得统一降级为 Code128 或 QR 码替代；必须按条码码制输出对应原生指令，否则返回 warnings 字段提示不支持的码制"。
- 修复方向：①移除默认分支，不支持码制抛 `BadRequestException('ZPL 不支持码制 XXX')` 并走 warnings 通道；②把当前 `BARCODE_SYMS` 里前端可选但生成器不支持的码制从选项里标记"预览可用、打印受限"。

**🟡 B3. GS1-128 / GS1 DataMatrix / GS1 QR 的 FNC1 语义**
- GS1-128（ZPL 名 UCC/EAN-128）需要 FNC1 前置 `>;`（ZPL `^BC` 第七参数），用于解析 AI 应用标识符。当前 ZPL 生成器有这个处理，但 TSPL 生成器的 `BARCODE` 指令没有。
- GS1 DataMatrix / GS1 QR 需要 FNC1 模式 1 前缀、GS1 DataMatrix 需要 Macro06/Macro05 等结构——目前完全没实现。

**🟡 B4. 条码元素属性的专业调优**
| 属性 | 现状 | 专业系统能力 |
|---|---|---|
| 模块宽 `moduleWidthMm` | 有，0.05–0.6 | 有，且**受 DPI 对齐约束**（打印机最小点 mm = 25.4/DPI，模块宽不能小于此值） |
| 窄/宽比 `wideRatio` | 有，1.5–3.0 | 有，但不同码制有不同默认（Code128=2.0，Code39=2.2-3.0） |
| 条码高度 `heightMm` | 有 | 有，且**一维码高度与模块宽正相关**（高度建议 = 模块宽 × 8-12） |
| 静区 `quietZoneMm` | 有，固定 2mm | 应按码制自动（EAN13=左侧7/右侧7，Code128=左右各 10×moduleWidth） |
| 明文位置 | 有 top/bottom | 有，**GS1/EAN/UPC 明文位置有严格规范**（UPC-A 明文必须在条码内部） |
| 明文字体大小 | 有 | 有，但需**校验与模块宽匹配**（太小看不清、太大溢出） |
| 方向/旋转 | ❌ PropsPanel 无 | ZPL/TSPL 都有 orient 参数（N/R/I/B），前端元素可旋转，但条码明文**旋转时位置会错** |
| 边框/反色 | ❌ | 专业系统支持条码外包边框、反色打印（白条码黑底） |
| 纠错级覆盖 | 只有 QRCODE 的 L/M/Q/H | DataMatrix 有 ECC 0-200（自动/用户选）、PDF417 有安全级 0-8 |

**🟡 B5. 打印通道的条码指令覆盖**
- 当前打印通道：Zebra ZPL、TSC TSPL、浏览器 Canvas、原始 TCP、PNG 图像。
- **缺失通道**：EPL（旧 Zebra 兼容）、ESC-POS（热敏小票）、IPL（Intermec）、CSL（Citizen）、POSTEK。
- **建议**：先把 ZPL/TSPL 做对，再补 EPL——这三个覆盖 90% 工业标签机市场。

**🟡 B6. 条码预览引擎**
- 前端预览用 bwip-js 生成 SVG，打印时**重新编码**（ZPL/TSPL/PNG），两者可能不一致（码制宽度计算、静区、校验位追加时机）。
- BarTender 的预览是**最终渲染**——所见即所得。这里要保证：`designer/engine/barcode.ts`（bwip-js SVG）与 `backend/core/barcode-encoder.ts`（位图）与 `backend/core/zpl-generator.ts`（指令）三者对同一份内容产出**完全相同的条码图案**。

#### C. 下一轮开发路线（P7 条码打印核心修复）

> **总目标**：让前端能选的每一个码制都能正确打印到 Zebra/TSC 标签机上，不静默降级。

| 子任务 | 工作量 | 优先级 | 落点 | 状态 |
|---|---|---|---|---|
| **P7.1 移除 ZPL/TSPL 统一回落** | 1 天 | 🔴 必做 | `zpl-generator.ts` / `tspl-generator.ts`：不支持码制出 BadRequest + warnings | **✅ 2026-11-08 已完成** |
| **P7.2 码制覆盖复核 + 降级策略** | 2 天 | 🔴 必做 | ZPL 一维 12 全齐 / 二维 6 全齐；TSPL 一维 12 全齐、MICROQR 降级标准 QR、DM/PDF417/Aztec 精确引导 | **✅ 2026-11-08 已完成** |
| **P7.3 TSPL DataMatrix / PDF417** | 1 天 | 🟡 | TSPL 原生 `DATAMATRIX` / `PDF417` 指令，或走二维码降级 warnings | ⏳ |
| **P7.4 GS1 FNC1 语义** | 1.5 天 | 🟡 | TSPL BARCODE 加 FNC1 前缀、GS1 DataMatrix/QR 结构 | ⏳ |
| **P7.5 前端码制列表加"受限"标记** | 0.5 天 | 🟡 | `BARCODE_SYMS` 里不支持打印的加 `(预览仅)` 后缀 | ⏳ |
| **P7.6 条码属性专业调优** | 2 天 | 🟢 | 静区自动计算、模块宽受 DPI 约束、旋转时明文位置修正 | ⏳ |
| **P7.7 新增 EPL 通道（旧 Zebra 兼容）** | 1 天 | 🟢 | 先做一维码 + QR，其他回 warnings | ⏳ |
| **P7.8 单测补齐** | 2 天 | 🟢 | 每个码制的 ZPL/TSPL 指令快照测试（golden file） | ⏳ |

**P7.1 已落地的关键改动**（2026-11-08 commit `efXXXXXX`）：
- `backend/core/zpl-generator.ts`：`generateZpl` 返回 `{ text, warnings }`，新增 `SUPPORTED_ZPL_BARCODES` 显式白名单（12 个码制），`default` 分支移除，不支持码制在 warnings 里明确提示并跳过输出
- `backend/core/tspl-generator.ts`：`generateTspl` / `buildJob` 同样返回 `{ text/buffer, warnings }`，`tsplSym` 移除 `?? '128'` fallback 改为返回 undefined
- `backend/src/print/print.controller.ts`：commands 接口合并生成器 warnings + 原有 buildWarnings，返回 `[...new Set(genWarnings, buildWarnings)]`
- 调用方适配：`backend/printer/printer-provider.interface.ts`、`backend/src/printer/printer.module.ts`
- 单测：`backend/core/__tests__/engines.test.ts` 新增两条 P7.1 验证（不支持码制出 warning 不静默降级）
- 实测：219 条单测全绿（pass 212 / fail 0 / skip 7），commands 接口对 CODE16K 模板返回清晰 warnings、指令里无 `^BC` 回落

**P7.2 已落地的关键改动**（2026-11-08）：
- 复核结论：**ZPL 侧其实已完整覆盖**——一维 12 种（含 `^BM` MSI）+ 二维 6 种（QR/MicroQR `^BQ`、DM 含矩形 `^BX`、PDF417 `^B2`、Aztec `^BO`）；
  真正缺原生指令的只有 `PHARMACODE` / `CODE16K`（ZPL 手册确无对应 `^B`，且属小众码制）。
- **TSPL 侧**：一维 12 种全齐；二维只有 `QRCODE`，`MICROQR` 改为**降级输出标准 QRCODE**（形状变但可扫，比整块丢弃更有价值），
  `DATAMATRIX` / `PDF417` / `AZTEC` 手册无原生命令 → 跳过并精确引导（改 ZPL 或 `protocol=image`）。
- warnings 从笼统的"不支持"升级为**可执行的修复建议**，并区分两种根因：
  `ZPL_NO_NATIVE_BARCODES`（手册无此指令）vs（本产品暂未覆盖）。
- 修掉 `print.controller.ts` 里 `buildWarnings` 的**过时矛盾提示**：原先会对 DATAMATRIX 说"已按 QRCODE 输出"，
  而生成器 P7.1 之后实际是跳过——同一响应里两条 warnings 自相矛盾。现码制维度提示统一由生成器产出，`buildWarnings` 只保留字体维度。
- 实测：219 单测全绿；TSPL DATAMATRIX 只回 1 条"已跳过"提示；TSPL MICROQR 回 1 条"已降级"提示且指令里确有 `QRCODE`；ZPL DATAMATRIX 无 warnings 且输出 `^BX`。

**验收标准**（P7 全完）：
1. 前端 `BARCODE_SYMS` 里可选的每一个码制，都能在 ZPL 或 TSPL 生成器里找到对应 `case` 分支（没有统一回落）。
2. `print/commands` 接口对每张模板输出的指令里，warnings 字段**不会因为不支持码制而有值**（除非前端选了受限码制）。
3. 新增 P7 验收脚本（类似 `p0-acceptance.sh` 的条码段），每个码制 3 条（短内容、边界长度、带校验位），对比 bwip-js 预览与 ZPL/TSPL 打印结果**图案一致**（mm 级位置偏差 <0.1mm）。

### 10.7.4 原生 DOM 设计器（web/ —— 老版本独立客户端）

| 文件 | 职责 |
| --- | --- |
| `app.js` | 启动、页签切换、工具栏、快捷键、RBAC UI 约束、审计导出 |
| `store.js` | 模板状态 + 历史栈（撤销/重做）+ 发布订阅 |
| `model.js` | `TOOLS`、`createElement()`、`defaultTemplate()` —— **元素 schema 的唯一来源** |
| `render.js` | DOM 渲染元素 + `buildContext()` 变量求值；打印 HTML 也复用其语义 |
| `interactions.js` | Pointer 事件：选中/拖动/八向缩放/旋转/框选/平移 |
| `inspector.js` | 右侧属性面板（注意：选择指纹变化时要强制重建表单） |
| `print.js` / `jobs.js` / `printers.js` / `templates.js` / `guides.js` | 各页签 |
| `ai-template.js` | AI 生成页签：上传、生成、结果表、载入画布、模型配置 |
| `users.js` | 用户管理页签（2026-11-04 新增） |
| `api.js` | 统一请求封装（401 → refresh → 失败重登 → 重试一次） |

页签：`design` / `print` / `jobs` / `printers` / `templates` / `audit` / `ai` / `users`。
`switchTab('xxx')` 会派发 `xxx-refresh` 事件，各模块自行监听。

**载入 AI 结果为可编辑模板**：`store.loadTemplate(json)` + `resetCurrentTemplateId()`，
与「导入 JSON」完全同一条路径。

---

## 10.8 已完成功能清单

| 模块 | 状态 | 备注 |
| --- | --- | --- |
| 多租户 + JWT/Refresh + bcrypt | ✅ | 租户隔离靠 `AsyncLocalStorage` |
| RBAC 四档角色 + 守卫 | ✅ | admin/operator/sql/viewer |
| 模板 CRUD / 复制 / 收藏 / 搜索 / 版本快照 / 回滚 | ✅ | 版本表已用 |
| 模板缩略图自动生成 | ✅ | `thumbnail-renderer.ts`（sharp + SVG composite，图形/条码/二维码全可见，服务端保存模板时自动渲染） |
| 设计器（12 类元素、标尺/网格/参考线、撤销重做、快捷键、复制粘贴） | ✅ | 原生实现 + **Console 内 Vue 版（§10.7.2，2026-11-06）** |
| 变量 / 公式引擎（自研 AST + 循环依赖） | ✅ | `core/formula-engine.ts` |
| 流水号（行锁 + 号段预分配） | ✅ | 有并发测试 |
| 条码/二维码（前端渲染 + 服务端出图） | ✅ | bwip-js（前端 vendor 打包） |
| 打印机管理（增删改/校准/测试连通/测试打印/指令预览） | ✅ | 页签 `printers` |
| 打印队列 + 重试/取消/重打 + SSE 实时进度 | ✅ | BullMQ + EventEmitter |
| ZPL / TSPL 指令生成（多码制） | ✅ | 有 warnings 提示 |
| Excel/CSV 导入 + 字段映射 + 后端 Excel 上传 | ✅ | `POST /data-sources/upload-excel` |
| SQL 数据源（AES 加密连接串 + 参数化 + 只读强制） | ✅ | 仅 postgres 驱动 |
| 审计日志 + CSV/JSON 导出（admin） | ✅ | |
| 用户管理 API + 前端页签 | ✅ | 列用户/CRUD/启停/重置密码/角色 checkbox；审计自动写入 |
| AI 图片生成模板（条码/OCR/几何/启发式/LLM/校验） | ✅ | 页签 `ai` |
| PWA（manifest + SW） | ✅ | 网络优先缓存 `labelflow-v3` |

### 10.8.1 自动化测试（P0 后已不再是「只有 16 条」）

```bash
cd backend && npm test     # 217 条全通过（当前基线，分布见 §10.15.6；本节其余描述是 P0 时的状态）
```

覆盖已补到：守卫链（Module/Permission/Roles）、`/auth/me` 菜单裁剪、模块依赖闭包、数据范围、
业务异常码 4031/4032、`sql-executor.assertReadOnly`（含引号内分号、注释走私、真实 PG 集成）、
`validate-ai-template` 脏输入。RBAC、AI 校验、SQL 只读这三块正是 §10.9 #5 点名的缺口，现已闭合。
仍**无测试**的是：需要起 Nest 容器的端到端测试、前端、打印队列 worker。

---

## 10.9 已知问题 / 技术债（接手后建议优先处理）

> 按「影响 × 修复成本」排序。修改前建议先写一条 curl 复现。

### 🔴 高优先级

> 以下 1–3 已落地修复（2026-11-04），标记 ✅。

1. **✅ 已修复** 审计日志的 `actorId` 全是 null
   `audit.write()` 共 **22 处调用**，无一传 `actorId`（传的都是 `undefined`），
   而 `TenantContextInterceptor` 其实已经把 `userId` 写进了上下文。
   修复：在 `AuditService.write()` 内部加兜底 `actorId ?? useTenant().userId`，
   调用方不再需要显式传参。
   落点：`backend/src/audit/audit.module.ts`（`write` 方法顶部）。

2. **✅ 已修复** 登录硬编码租户
   原 `backend/src/auth/auth.service.ts:27`：`where: { username, tenantId: 1 }`。
   修复：注入 `Tenant` 仓库，按 `tenant.code` 先查租户 → 校验 `status` → 再查用户。
   未传 `tenantCode` 时默认回退到 `TENANT_CODE` 环境变量（兼容单租户部署）。
   落点：`backend/src/auth/auth.service.ts`（`login` 方法前半段）。

3. **✅ 已修复** JWT 密钥 4 处重复读取
   原 4 处：`app.module.ts`（global）、`auth/auth.module.ts`、`main.ts`、`print/print.controller.ts`（SSE）。
   修复：抽 `backend/src/common/config.ts` 单点导出 `JWT_SECRET / PORT / SQL_SECRET_KEY`，4 处全部改用。
   密钥从环境变量 `JWT_SECRET` 读取，默认值只用于本地开发。

### 🟡 中优先级

4. **✅ 已完成** 没有 dotenv / 没有进程守护
   落地：`backend/.env.example`（DB / Redis / JWT / SQL_SECRET_KEY / AI / OCR 全覆盖）
   + `backend/ecosystem.config.cjs`（PM2 守护，双进程：`labelflow-api` + `labelflow-worker`，自动重启 + 开机自启）
   + `backend/src/main.ts` 顶部 `import 'dotenv/config'`。
   运行：`pm2 start ecosystem.config.cjs` → `pm2 save && pm2 startup`。

5. **✅ 已完成** 后端零单测
   原建议四项：`RolesGuard`、`assertReadOnly`、`validate-ai-template` 按位落地，
   `datasource.service.testSql` 改为在 executor 层覆盖（原因见下）。新增：
   `roles.guard` 7 条 + `saas-guards` 10 条（4031/4032/放行/OR 语义/通配）、
   `sql-executor` 14 条（含引号内分号、注释走私、真实 PG 集成，PG 不可达自动 skip）、
   `validate-ai-template` 23 条（脏输入）、`menu.catalog` 12 条、`module-deps` 6 条、
   `data-scope` 7 条、`permission-match` 8 条、`errors.filter` 4 条。
   `cd backend && npm test` → **217 条全通过**（当前基线；当时是 125 条，P1–P6 陆续补到 217，见 §10.1.5）。
   ⚠️ 唯一没按原建议做的是 `datasource.service.testSql` 的 service 级测试：`npx tsx` 不产装饰器元数据，
   import 实体就 `ColumnTypeUndefinedError`，因此覆盖下沉到 executor 层，原因写在
   `src/datasource/__tests__/sql-executor.test.ts` 头注释。

6. **✅ 已完成** 后端 `/users` 无前端页签
   落地：新 tab `👥 用户管理`（index.html）+ `web/js/users.js`（搜索 / 状态筛选 / 新增模态框 / 编辑模态框 / 重置密码模态框 / 行内角色 checkbox / 删除确认 / 自我保护）
   + `web/js/api.js` 新增 `createUser / updateUser / deleteUser / resetUserPassword` 四个方法。

7. **✅ 已修复** `print_jobs.createdBy` 依赖前端传参
   修复：`print.service.ts` 从上下文 `useTenant().userId` 直接写入，不再依赖前端 DTO。

8. **TCP 通道端口默认值不一致**
   `printer.module.ts` 的测试连通用 `9100`，但 `docs/05-api.md` 写过 9000（笔误）。以代码 9100 为准。
   文档已在 §05-api.md v2 里修正。

### 🟢 低优先级

9. **✅ 已修正** `docs/05-api.md` 与实际实现有偏差（历史设计稿）
   原 `/users/me` → 实际是 `/auth/me`；原 `PUT /users/:id/roles` → 实际是
   `POST /users/:id/roles` + `DELETE /users/:id/roles/:role`。已在 §5.1 完整重写为实际接口。
10. **✅ 已完成** 模板缩略图纯白占位
    落地：`backend/src/print/thumbnail-renderer.ts`（sharp + SVG composite，图形/条码/二维码/表格全可见，
    文本简化为占位框）。`TemplateService.save` 保存时自动渲染缩略图写入 `templates.thumbnail` 字段。
11. SQL 数据源仅支持 `postgresql://`，MySQL/SQLServer 未实现。
12. 原生 `web/js/` 无 lint/格式化配置。Vue 3 后台 `apps/console/` 也未加 ESLint（TS 严格模式已开），后续可补。

---

## 10.10 未完成路线图（历史：单租户时代）

> **⚠️ 本节是 2026-11-04 的旧规划，P0–P2 已完成，仅作背景保留。**
> SaaS 化之后的「做完的 / 没做的」以 **§10.1.5 交付状态总表**为准，别再按本节排期。
>
> **⚠️ 重大规划变更**：项目将从「单租户内部系统」升级为 **SaaS 多租户 + 模块订阅 + MCP 智能体接入**。
> 完整设计、DDL、权限模型、路线（P0–P6）见 **`docs/11-saas-and-agent-architecture.md`**（决策 D1–D12 已锁定）。
> 做 SaaS 相关开发前**必须先读该文档 §11.15**，其中的硬性约束会改变本文档 §10.5.4 的角色定义（`sql` 角色将废弃）。

### P0（商用必备缺口）✅ 本轮已完成

| 项 | 说明 | 状态 |
| --- | --- | --- |
| 修 #1/#2/#3 | 审计操作人、租户登录、密钥单点 | ✅ 全部修复，见 §10.9 |
| 部署持久化 | dotenv + pm2/systemd + 开机自启 | ✅ `.env.example` + `ecosystem.config.cjs` |
| 用户管理前端 | 列用户 + 授权/撤权 | ✅ 新 tab + `web/js/users.js` + 完整 CRUD 后端 |

### P1（重要增强）✅ 全部完成

| 项 | 说明 | 状态 | 落点 |
| --- | --- | --- | --- |
| 多联/多行排布 | `page.columns/rows/gapX/gapY` 拼版 | ✅ html-renderer.ts 已实现 + 10 条单元测试全过 | `backend/src/print/__tests__/html-renderer.test.ts` |
| 批量统计仪表盘 | 完成率 / 平均耗时 / 失败率 / 打印机分组 / p50 | ✅ `GET /print/jobs/stats?days=N` | `backend/src/print/print.service.ts#stats` |
| 模板缩略图真实渲染 | 复用 sharp 输出 PNG | ✅ 服务端保存模板时自动渲染 | `backend/src/print/thumbnail-renderer.ts` |
| AI：透视矫正 / 四边检测 | Vision LLM 自动检测 4 角 → sharp bbox 裁剪 | ✅ 可选手动 corners（前端 canvas 点选）或 LLM 自动 | `POST /ai-template/rectify` · `vision-rectify.ts` |
| AI：表格结构识别（合并单元格） | 扁平 cells 扩展 mergedCells [{row,col,rowSpan,colSpan}] | ✅ prompt 契约 + validate 校验 + html-renderer 渲染三处联动 | `prompt.ts` · `validate-ai-template.ts` · `html-renderer.ts#table` |
| AI：单元素重算接口 | 省 token 的增量修正 | ✅ 只 Vision 单元素 prompt，LLM 失败优雅降级 | `POST /ai-template/regenerate-element` |

### P2（可选）✅ 全部完成

| 项 | 说明 | 落点 |
| --- | --- | --- |
| 多联标签大图自动切分 | sharp tile-crop 按 rows/cols/gap 切格 → 每格跑 generate | `POST /ai-template/batch-generate` · `tile-crop.ts` |
| 纯文本描述生成模板 | Vision LLM text-only（image_url=null）直接输出模板 JSON | `POST /ai-template/text-to-template` · `prompt.ts#buildTextToTemplatePrompt` |
| RBAC 资源级 ACL | `templates.acl` (jsonb: {public, users, roles, writeUsers, writeRoles}) → list 过滤 + get 读检查 + update/remove 写检查 | `backend/src/common/acl-check.ts` · `template.service.ts` |
| 整租户备份/恢复 | dump 全租户 15 张表 → gzip(JSON) → bytea 存 `tenant_backups.data`；restore 事务 upsert | `BackupService` · `GET/POST/DELETE /backups`（admin 专属）|
| AI 每日调用配额 | `ai_quotas` 表（tenant_id + date + kind 唯一）→ Vision 调用前原子 FOR UPDATE 扣减 | `AiQuotaService` · 三处 `callVision` 拦截 |
| PaddleOCR 一键部署脚本 | `bash scripts/setup-paddleocr.sh`（Docker Compose + 交互式 / 全自动） | `backend/scripts/setup-paddleocr.sh` |

---

## 10.11 踩坑记录（已修复，别重踩）

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| 所有条码/二维码都识别失败 | PNG 带透明通道，`greyscale()` 后透明区变黑 | `sharp().flatten({background:'#ffffff'})` 后再处理 |
| EAN13/DataMatrix/Code93 识别不到 | 纯 JS 版 `@zxing/library` 能力弱 | 换 `zxing-wasm`（zxing-cpp WASM） |
| 条码竖条被识别成 27 条线元素 | 竖线检测无法区分条码条纹 | 条码框纵向放宽 60% + 线段中点判定 |
| 条码下方明文变成重复文本元素 | zxing bbox 不含明文行，未覆盖 | 水平覆盖率 >55% 判定后丢弃 |
| `Product: {{productName}}` 没生效 | 分类用原始文本、替换用清洗后文本，`replaceFrom` 不匹配 | 统一用 `cleanText()` 结果做分类 |
| OCR `data.words` 为空 | tesseract.js v6 需显式 `{blocks:true}` 输出 | `recognize(buf, {}, {blocks:true})` |
| tesseract 首次运行 `fetch failed` | 默认从 CDN 拉语言包 | 预先下载到 `backend/assets/tessdata/`，配 `langPath` |
| 服务端 500 而非 400 | 抛裸 `Error` | 改抛 `BadRequestException` |
| SSE 路由 500 / 与 `/print/jobs` 冲突 | 同前缀两个 controller | 独立前缀 `print-stream` + `@Public()` + query.token 手动验签 |
| `user_roles` 插入违反 CHECK | DDL 里是旧角色名 | 约束改为 `('admin','operator','sql','viewer')` |
| 属性面板不跟随选中切换 | 焦点在旧输入框时跳过重建 | 加选择指纹校验，指纹变化强制重建 |
| `git push` 报 HTTP2 framing layer | 本机网络对 github.com 抖动 | `git -c http.version=HTTP/1.1 push` + 补全 PATH（askpass 需要 mktemp/cat） |
| **BackupModule 启动报依赖失败**（2026-11-04 e2e） | `BackupService` 注入 `AuditService` 但 `BackupModule.imports` 没 `AuditModule` | 加 `imports: [AuditModule, TypeOrmModule.forFeature([TenantBackup])]` |
| **`POST /backups` 500：column "data" does not exist**（2026-11-04 e2e） | `TenantBackup` Entity 有 `data: bytea` 列但 `03-database.sql` 里 DDL 没加 | PG 执行 `ALTER TABLE tenant_backups ADD COLUMN data bytea;`（DDL 后续补版本号） |
| **BackupService TENANT_TABLES 有假表名**（2026-11-04 e2e） | 写了 `printer_models` / `ai_models` / `serial_assignments`，但仓库真实表是 `printers` / `ai_model_configs` / `serial_usage_log` | 对齐 [backup.service.ts#L17-L28](file:///workspace/backend/src/backup/backup.service.ts#L17-L28) 的真实表清单；恢复时顺序：主表→子表 |
| **后端监听 `[::1]:3200` IPv6 导致 curl localhost 连不上**（2026-11-04 e2e） | `app.listen(PORT)` 默认绑 IPv6 loopback，沙盒 curl 默认 IPv4 | `app.listen(PORT, '0.0.0.0')` 强制 IPv4（[main.ts#L66](file:///workspace/backend/src/main.ts#L66)） |
| **Vite 代理 `/api` 502**（2026-11-04 e2e） | ① `target: 'localhost:3000'`（端口错，后端跑 3200）② `localhost` 在 Vite 里解析成 IPv6 `::1` | 改 `target: 'http://127.0.0.1:3200'` 强制 IPv4 + 正确端口（[vite.config.ts#L16](file:///workspace/apps/console/vite.config.ts#L16)） |
| **Dashboard 0 数据显示 NaN% / NaNs**（2026-11-04 e2e） | `successRate * 100` 没防御，`avgDurationMs / 1000` 没防御；还错误引用了不存在的 `byStatus.success`（后端已改 `counts.success`） | 加 `|| 0` 链 + 用 `counts.success`（[Dashboard.vue#L8-L22](file:///workspace/apps/console/src/views/Dashboard.vue#L8-L22)） |
| **Playwright / Puppeteer 自动测试 Vue 3 组件 v-model 值不生效** | 浏览器自动化工具无法完全模拟 Vue 受控组件的事件链 | 临时绕过：`page.evaluate('...')` 直接 set DOM + 手动触发 input 事件；或直接调 `/api/v1/auth/login` 拿 JWT 手动 set localStorage，再刷新 |
| **后端起不来：`DataTypeNotSupportedError: Data type "Object" in "Tenant.planId"`**（2026-11-04 P0） | TS 联合类型（`number \| null`、字面量联合）反射出来是 `Object`，TypeORM 猜不到列类型 | 所有联合类型 `@Column` 必须显式写 `type`（bigint / varchar）；已修 `tenant.entity.ts` + `saas.entity.ts` 共 8 处 |
| **`POST /platform/tenants` 500：duplicate key `tenants_pkey` Key (id)=(1)**（2026-11-04 P0） | `seed.sql` 用显式 id 插入数据，序列还停在 1，新租户拿到同一个 id | `saas_p0_roles.sql` §11 按 `pg_depend` 把 P0 相关表序列统一 `setval(max(id)+1)`，幂等 |
| **`GET /backups` 500：column TenantBackup.data does not exist**（2026-11-04 P0 复现） | 同上面那条，但这次是**读**路径也炸；`03-database.sql` 一直缺列 | `saas_p0_roles.sql` §13 `ADD COLUMN IF NOT EXISTS data BYTEA` + `docs/03-database.sql` 建表语句补列（两边已同步，别再只改一处） |
| **同一用户同秒二次登录 500：duplicate `refresh_tokens_token_hash`**（2026-11-04 P0） | refresh token payload 只有 `{sub}`，同一秒内 `iat` 相同 → 签出完全相同的 JWT | 签发时加 `jti: crypto.randomUUID()`（`auth.service.ts#issue`） |
| **viewer 写模板返回 403/403 而不是 4032**（2026-11-04 P0） | 当时只有 audit / datasource / backup 挂了 `@RequireModule`/`@RequirePermission`，模板等核心路由仍只靠 `@Roles` | 把装饰器铺到 templates / print / printers / users / ai-template / serial（§10.15.3 表），并跑验收脚本 H 段确认旧角色没被削弱 |
| **`SELECT 1; DROP TABLE users` 通过只读校验**（2026-11-04 P0） | 旧 `assertReadOnly` 只在**分号数 > 1** 时报错；单分号时它只把最后一个分号前的内容拿去查前缀，后面的语句直接不校验（实际执行的是原始 SQL）。附带问题：字符串里含 2 个以上分号的合法 SELECT 会被误拒 | 改成按引号状态扫描的 `splitStatements()`，切出 >1 条即拒；合法语句里的引号分号不误伤。pg 扩展协议本身也会以 42601 拒多语句，所以这是**应用层独立防线**而非唯一防线（`sql-executor.ts` 头注释已写明） |
| **单测里 import 实体就报 `ColumnTypeUndefinedError`**（2026-11-04） | `npm test` 走 `node --import tsx`，esbuild 不生成装饰器元数据 | 单测只测纯函数 / 类边界；需要真实实体的行为下沉到 executor 层测（见 `sql-executor.test.ts` 头注释），跑 Nest 容器要等接进 `tsc` 编译后再测 |
| **`vue-tsc` 报 `Property 'value' does not exist on type '{...}'`，指向 `dlg.form.connectionUrl`**（2026-11-04 P1） | vue-tsc 3.3 对模板里 `v-model` 绑定 `reactive()` 的三层路径会去探测 `.value`；`reactive<any>` 的老页面（UserManagement）因为类型是 `any` 所以一直没暴露 | 该表单改成 `ref({ visible, saving, form })`，模板自动解包、脚本显式 `.value`（`DataSources.vue` 头注释）。新表单别学 reactive 三层路径 |
| **`v-permission` + `v-module` 叠在同一个按钮上，未订阅模块的按钮照样能点**（2026-11-04 P1） | 两个指令都往同一 DOM 写 `disabled`，后 mounted/updated 的那个把前一个结论覆盖掉 | 一个元素只挂一个指令；要双重条件写 `v-if="auth.hasModule(x) && auth.hasPermission(y)"`（§10.16.4） |
| **原生前端 admin 看不到「用户管理」页签**（2026-11-04 P1 顺带修的旧缺陷） | `setAttribute('hidden', String(!isAdmin))` 会写 `hidden="false"`，HTML 规范里属性只要存在即生效 | 改 `el.hidden` 布尔属性（`web/js/app.js#hideById`） |
| **点「删除备份」一直 404**（2026-11-04 P1） | `backup.controller.ts` 的 `remove()` 标的是 `@Post(':id')`，而 docs/10 §10.3 和前端都按 `DELETE /backups/:id` 实现 | 路由改回 `@Delete(':id')`，并补 `@RequirePermission('backup:write')`（原来只有 `@Roles('admin')`） |

### 端到端实测验证证据（2026-11-04）

本次 e2e 实测把后端真正跑了起来（PostgreSQL 16 + Redis 7 + 种子数据），**之前只跑单测的 P2 新功能现在都确认了能集成工作**：

```sql
-- 审计 actor_id 修复（10.9 #1）真实验证
SELECT actor_id, action, target_type FROM audit_logs;
 actor_id |    action     | target_type
----------+---------------+-------------
        1 | backup.create |             ← ✅ actor_id 有值（之前全 null）
```

| 端点 | 结果 | 备注 |
|------|------|------|
| `POST /auth/login` + tenantCode | ✅ 200 | admin/admin123 bcrypt 验证通过 |
| `GET /auth/me` | ✅ 200 | roles=["admin"], tenantId=1 |
| `GET /users` | ✅ 200 | 2 用户 + 角色标签 + tenant 隔离 |
| `GET /print/jobs/stats?days=7` | ✅ 200 | 空数据结构完整（counts/p50/byDay） |
| **`POST /backups`（P2 新增）** | ✅ **200** | 742 bytes gzip，18 表全 dump，48ms |
| **`GET /backups`（P2 新增）** | ✅ **200** | createdBy=1（TenantCtx 正确） |

---

## 10.12 自测清单（改动后按需执行）

### 0. 环境准备（全新沙盒 / 新机器第一次跑必须做）

```bash
# ===== PostgreSQL + Redis（Ubuntu/Debian）=====
sudo apt-get install -y postgresql redis-server
sudo pg_ctlcluster 16 main start               # 或 systemctl start postgresql
redis-server --port 6380 --daemonize yes       # 本机约定 6380（默认 6379 属其他项目）

# ===== 建库 =====
sudo -u postgres psql -c "CREATE USER labelflow WITH PASSWORD 'labelflow';"
sudo -u postgres psql -c "CREATE DATABASE labelflow OWNER labelflow;"

# ===== DDL + 种子 + SaaS P0（顺序不能换，见 §10.15.2）=====
PGPASSWORD=labelflow psql -h localhost -p 5433 -U labelflow -d labelflow -f docs/03-database.sql
PGPASSWORD=labelflow psql -h localhost -p 5433 -U labelflow -d labelflow -f backend/scripts/seed.sql
PGPASSWORD=labelflow psql -h localhost -p 5433 -U labelflow -d labelflow -f backend/scripts/saas_p0.sql
PGPASSWORD=labelflow psql -h localhost -p 5433 -U labelflow -d labelflow -f backend/scripts/saas_p0_roles.sql
# 校验（期望 >0，否则说明第 1 步顺序错了）：
#   SELECT count(*) FROM subscriptions; SELECT count(*) FROM tenant_modules; SELECT count(*) FROM permissions;  -- 37

# ===== 后端 .env（参考 backend/.env.example）=====
# DB_HOST / DB_PORT=5433 / DB_USER / DB_PASS / DB_NAME
# REDIS_URL=redis://localhost:6380 / JWT_SECRET / SQL_SECRET_KEY
# PORT=3200（与 apps/console/vite.config.ts proxy target 对齐）

# ===== 起服务 =====
# 后端
cd backend && npx tsc -p tsconfig.json && \
  node -r reflect-metadata dist/src/main.js        # 需要 reflect-metadata！
# 前端
cd apps/console && pnpm dev                         # Vite 5173
# 设计器
cd web && node serve.mjs 5180                       # 可选
```

> ⚠️ **后端必须先 `tsc` 编译再 `node -r reflect-metadata dist/src/main.js`**，直接 `npx tsx src/main.ts` 会报 `ColumnTypeUndefinedError`（装饰器元数据在非编译模式下丢失）。
>
> ⚠️ **没有 sudo 的沙盒（接手 AI 常见环境）**：`sudo pg_ctlcluster` / `sudo -u postgres` 都不可用，
> 且发行版集群默认监听 5432（本项目约定 5433）。实测可行的起法是自己建一份数据目录、
> 用 `su postgres` 直接拉 `pg_ctl`，socket 放 `/tmp`：
>
> ```bash
> su postgres -c "/usr/lib/postgresql/14/bin/initdb -D /tmp/pfdata --auth=trust -U labelflow"
> su postgres -c "/usr/lib/postgresql/14/bin/pg_ctl -D /tmp/pfdata -l /tmp/pg.log -o '-p 5433 -k /tmp' start"
> su postgres -c "psql -h /tmp -p 5433 -U labelflow -d postgres -c \"CREATE DATABASE labelflow OWNER labelflow\""
> redis-server --port 6380 --daemonize no --save '' &      # 注意：--daemonize yes 在某些环境会被父进程 wait 卡住
> # 之后 §0 的 psql 建表命令照跑，只是 -h 用 /tmp 或 localhost 都行（trust 认证，不需要 PGPASSWORD）
> ```

# 1. 鉴权 & 角色
curl -s http://localhost:3200/api/v1/auth/me -H "$H"
curl -s http://localhost:3200/api/v1/users -H "$H"                    # admin 才有

# 2. 模板
curl -s "http://localhost:3200/api/v1/templates?page=1&pageSize=5" -H "$H"

# 3. 打印机 / 打印队列
curl -s http://localhost:3200/api/v1/printers -H "$H"
curl -s "http://localhost:3200/api/v1/print/jobs?page=1&pageSize=5" -H "$H"

# 4. 审计导出（admin）
curl -s "http://localhost:3200/api/v1/audit/logs/export?format=csv&limit=10" -H "$H" | head -3

# 5. SQL 数据源（只读强制：INSERT 应返回 400）
curl -s -X POST http://localhost:3200/api/v1/data-sources/save-sql -H "$H" \
  -H 'Content-Type: application/json' \
  -d '{"name":"t","connectionUrl":"postgresql://labelflow:labelflow@localhost:5433/labelflow","queryTemplate":"SELECT 1"}'

# 6. AI 生成（本地规则引擎，不依赖 LLM；请自备一张标签图）
curl -s -X POST http://localhost:3200/api/v1/ai-template/generate -H "$H" \
  -F "file=@/path/to/your_label.png" -F "widthMm=100" -F "heightMm=60" -F "dpi=300" -F "useLlm=false"

# 7. SSE（应持续输出 hello / ping）
curl -N "http://localhost:3200/api/v1/print-stream/events?token=$TOKEN"

# 8. 单元测试
cd backend && npm test     # 期望 125 条全绿（PG 不可达时 118 pass / 7 skip）

# 9. SaaS P0 验收（§11.11.1 六条 + 旧角色回归，需要后端 + PG + Redis 都在跑）
cd backend && T_CODE=p0a1 T2_CODE=p0a2 bash scripts/p0-acceptance.sh   # 期望「通过 62 / 失败 0」

# 10. SaaS P1 前端（§10.16）：类型检查 + 构建必须 0 error
cd apps/console && npm run build            # vue-tsc -b && vite build
cd backend && npx tsc -p tsconfig.json      # 后端编译（改了 menu.catalog / subscription.controller 必跑）
npx esbuild --format=esm --outfile=/dev/null web/js/app.js    # 原生前端零构建，只能这样验语法
npx esbuild --format=esm --outfile=/dev/null web/js/api.js
```

RBAC 回归（用 operator 登录 `operator/op123`，`tenantCode` 传 `default`）：
`/audit/logs/export` → 403、`/users` → 403、`POST /print/jobs` → 201、`/data-sources/:id/sql-exec` → 403。

---

## 10.13 给接手 AI 的协作规范

### 改代码前必读（按任务类型）

| 任务 | 必读文件 |
| --- | --- |
| 改元素/渲染 | `web/js/model.js`（schema 唯一来源）→ `web/js/render.js` → `docs/04-template-schema.md` |
| 改打印/指令 | `backend/core/zpl-generator.ts` `tspl-generator.ts` → `print.processor.ts` |
| 改权限 | `common/roles.guard.ts` → `common/module.guard.ts` `permission.guard.ts` → 各 controller 的 `@Roles`/`@RequireModule`/`@RequirePermission` → `docs/10` §10.15.3 |
| 改订阅/套餐/菜单 | `docs/11` §11.15.1（硬性约束）→ `src/saas/` → `backend/scripts/saas_p0*.sql` → 跑 `scripts/p0-acceptance.sh` |
| 改 AI | `docs/09-ai-template-generation.md` → `ai-template/heuristics.ts`（分类规则集中在这里） |
| 改数据库 | `docs/03-database.sql` + `src/entities/*.ts`（两边必须同步） |
| 改前端页签 | `index.html` 的 `#main-tabs` + `#view-<name>` → `app.js#switchTab` → 新 `js/<name>.js` |

### 硬性约定

1. **单位一律 mm**；字号 pt；打印输出用 mm + `@page`。
2. **多租户**：业务查询必须带 `tenantId: useTenantId()`，禁止信任入参。
3. **权限在后端**：前端禁用按钮只是 UX。
4. **异常用 Nest 内置 HttpException**（`BadRequestException` / `NotFoundException` / `ForbiddenException`）。
5. **不要引入前端构建链**（保持原生 ES Module，零构建）。
6. **不要提交**：`node_modules/`、`dist/`、`.env`、`backend/assets/tessdata/*.gz`（30MB 语言包）。
7. **端口**：3200 后端 / 5180 前端；**3000 属于其他项目，禁动**。
8. **改 DDL 必须同时改** `docs/03-database.sql` 与对应 entity。
9. **新增后端模块**要：建 module → 在 `app.module.ts` 注册 → 在 `entities/index.ts` 导出实体。
10. **提交规范**：Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:`），
    一个逻辑变更一个提交，提交信息写「为什么」而不只是「做了什么」。

### 环境坑提醒

- 本机 PATH 可能缺失基础命令，统一用绝对路径或在命令前 `export PATH=...`（见 §10.1.2）。
- `git push` 若报 `HTTP2 framing layer`，加 `-c http.version=HTTP/1.1`；
  若报 askpass 找不到 `mktemp`，是因为 PATH 不完整，补全后重试。
- 后端改动必须 `npx tsc -p tsconfig.json` 重新编译再重启（`dist/` 才是运行目标）。

---

## 10.14 关键文件索引（速查）

```
核心 3 个「改了影响全局」的文件：
  web/js/model.js                   元素 schema / 默认模板
  backend/src/common/roles.guard.ts  角色定义与全局权限
  backend/src/common/tenant.context.ts  租户上下文（所有查询依赖）

2026-11-04 新增 / 重点文件：
  backend/src/common/config.ts        JWT_SECRET / PORT / SQL_SECRET_KEY 单点配置入口（替代 4 处硬编码）
  backend/src/user/user.module.ts      用户管理完整后端（CRUD + 自我保护 + 审计）
  backend/src/print/thumbnail-renderer.ts  模板缩略图真实渲染引擎（sharp + SVG composite）
  backend/ecosystem.config.cjs         PM2 守护（labelflow-api + labelflow-worker 双进程）
  backend/.env.example                 环境变量样例（DB / Redis / JWT / AI / OCR）
  web/js/users.js                      用户管理前端页签（搜索 / 筛选 / 模态框 / 行内角色）

最容易出错的服务：
  backend/src/print/print.processor.ts   队列消费 / SSE 推送 / 状态机
  backend/src/ai-template/heuristics.ts  分类规则（改 AI 效果先看这里）
  web/js/interactions.js                 画布交互（Pointer 事件 + 包围盒）

SaaS P0 底座（2026-11-04 新增，详见 §10.15）：
  backend/src/saas/                      平台运营 / 开通 / 订阅 / 模块依赖 / 菜单目录 / 租户配置
  backend/src/saas/provision.service.ts  一步开通（单事务，改这里 = 改验收 A 段）
  backend/src/saas/module-deps.ts        依赖闭包纯函数（加购与开通共用，先跑测试再改）
  backend/src/saas/menu.catalog.ts       动态菜单目录（前端 P1 的数据源）
  backend/src/common/module.guard.ts     4031 模块未订阅
  backend/src/common/permission.guard.ts 4032 权限不足
  backend/src/common/roles.guard.ts      D11 兼容期新旧双码（RoleAlias / effectiveRoles）
  backend/src/common/tenant-data-source.manager.ts D2 连接路由钩子 + app.tenant_id
  backend/scripts/saas_p0.sql            P0 基础 DDL + 模块/套餐/权限字典种子
  backend/scripts/saas_p0_roles.sql      P0 生命周期 + roles 两步迁移 + 序列复位（13 节，幂等）
  backend/scripts/p0-acceptance.sh       §11.11.1 可重跑验收脚本

全局入参校验底座（2026-11-05 新增，详见 §10.17）：
  backend/src/main.ts                  useGlobalPipes(ValidationPipe)（transform:true / whitelist:false）
  backend/src/common/errors.filter.ts   class-validator 的 string[] → 「参数校验失败：…」+ errors 明细
  backend/src/{auth,template,user,datasource,print,printer,backup,saas}/dto/*.dto.ts  各域 DTO
  backend/src/common/dto/render-and-ai.dto.ts  barcode / formula / ai-template 共用 DTO
  backend/src/common/__tests__/validation-pipe.test.ts  8 条单测（500→400 根因回归）

SaaS P1 前端动态化（2026-11-04 新增，详见 §10.16）：
  apps/console/src/api/index.ts          唯一 axios 出口：拆信封 + 401 单飞刷新 + 4031/4032 业务码
  apps/console/src/store/auth.ts         menus/features/dataScopes/tenant + menuPaths
  apps/console/src/directives/permission.ts  v-permission / v-module（UX 层，不是安全边界）
  apps/console/src/router/index.ts       异步守卫：L2 模块 → L1 权限点 → menus 兜底
  apps/console/src/layouts/MainLayout.vue    菜单只渲染 auth.menus + 到期横幅
  apps/console/src/views/Blocked.vue     未订阅 / 权限不足统一落地页
  web/js/app.js                          原生前端：权限点优先 + 角色兜底 + 页签按模块裁剪

文档入口：
  docs/01-requirements.md   功能矩阵与优先级
  docs/03-database.sql      完整 DDL
  docs/04-template-schema.md 模板 schema
  docs/05-api.md            API 清单（v2 已对齐代码实际实现）
  docs/08-plan.md           里程碑与人日
  docs/09-ai-template-generation.md  AI 生成完整设计 + 落地说明
  docs/10-dev-handover.md   本文档
  docs/11-saas-and-agent-architecture.md  SaaS 化（订阅/权限分级）+ MCP 智能体接入（设计稿）
```

---

## 10.15 SaaS P0 权限与订阅底座（2026-11-04 落地）

> 设计依据：`docs/11` §11.4（四层权限）、§11.11.1（P0 验收标准）、§11.15.1（D1–D12 硬性约束）。
> 本节只记「实际落成了什么 / 与文档的偏差 / 怎么复现验收」，不复述设计稿。
> **状态：P0 六条验收全绿**（`backend/scripts/p0-acceptance.sh` → 通过 62 / 失败 0）。

### 10.15.1 代码地图

| 位置 | 作用 |
| --- | --- |
| `backend/src/saas/saas.module.ts` | P0 底座总装（providers + exports），`app.module.ts` 引入 |
| `backend/src/saas/provision.service.ts` | `POST /platform/tenants` 一步开通（D4/§11.15.1 第 3 条，单事务） |
| `backend/src/saas/modules.service.ts` | 租户生效模块（60s 缓存）、加购/停用、`source='addon'` |
| `backend/src/saas/permissions.service.ts` | 角色 → 权限点展开（含通配符） |
| `backend/src/saas/tenant-config.service.ts` | `feature_flags`、`data_scopes`、租户 plan/seat 摘要 |
| `backend/src/saas/subscription.service.ts` | 升降级 / 续订 / 退订（写 `canceled_at`，D12） |
| `backend/src/saas/module-deps.ts` | 纯函数：模块依赖闭包展开 + 停用依赖校验 + 套餐配置自检 |
| `backend/src/saas/menu.catalog.ts` | 动态菜单目录（§11.4.6），纯函数 `buildMenus(modules, permissions)` |
| `backend/src/saas/platform.controller.ts` | `/platform/*` 运营接口（本版仅 `@Roles('admin')`，平台独立账号体系是 P2） |
| `backend/src/saas/subscription.controller.ts` | 租户侧只读：`GET /subscription`、`GET /subscription/usage` |
| `backend/src/common/business.errors.ts` | `4031 模块未订阅` / `4032 权限不足` 异常（带 action 提示） |
| `backend/src/common/module.guard.ts` | `@RequireModule(...)`（L2 门） |
| `backend/src/common/permission.guard.ts` | `@RequirePermission(...)`（L1 钥匙） |
| `backend/src/common/permission-match.ts` | 通配符匹配（`print:*`、`*`） |
| `backend/src/common/data-scope.ts` | L3 数据范围解析（all / dept / warehouse / self 并集） |
| `backend/src/common/tenant-data-source.manager.ts` | D2 连接路由钩子 + `applyTenantScope()`（`set_config('app.tenant_id', …, true)`） |
| `backend/src/common/tenant-context.interceptor.ts` | 往 ALS 补 `plan / features / dataScopes / dataSourceKey` |
| `backend/src/entities/saas.entity.ts` | modules/plans/plan_modules/subscriptions/tenant_modules/permissions |
| `backend/src/entities/tenant.entity.ts` | tenants 扩展列 + roles / role_permissions / user_roles.role_id / feature_flags / data_scopes / tenant_domains / external_mcp_servers |
| `backend/scripts/saas_p0.sql` | P0 基础 DDL + 模块/套餐/权限字典/4 旧角色权限展开种子 |
| `backend/scripts/saas_p0_roles.sql` | 生命周期列 + roles 两步迁移 + data_scopes + feature_flags + 序列复位（共 13 节） |
| `backend/scripts/p0-acceptance.sh` | §11.11.1 可重跑验收脚本（91 条断言：A–K 段，K=P3 计费） |

### 10.15.2 DDL 执行顺序（错了不报错，静默得到空订阅）

```
docs/03-database.sql → backend/scripts/seed.sql → backend/scripts/saas_p0.sql → backend/scripts/saas_p0_roles.sql
```

> 空库实测（2026-11-04，`labelflow_fresh`）：按此顺序跑 4 个脚本 0 error，结果
> `subscriptions=1`、`tenant_modules=5`（BASIC 展开）、`permissions=37`、`roles=12`（6 模板 + default 租户复制的 6）、
> `feature_flags=2`、`user_roles.role_id IS NULL` 计数 0；再把 `saas_p0_roles.sql` 重跑一遍，无 error 且行数不变（幂等）。

三条实测踩过的坑：

1. `saas_p0.sql` 里「默认订阅 + `tenant_modules` 展开」依赖 `tenants.code='default'` 已存在，而 default 租户是 `seed.sql` 建的。顺序颠倒不会报错，只会得到 `subscriptions=0 / tenant_modules=0`，然后所有接口 4031。
2. `docs/03-database.sql` 没有 `IF NOT EXISTS`，同一库重跑会报 `relation "tenants" already exists` 并中断；
   重跑前先 `DROP DATABASE labelflow; CREATE DATABASE labelflow OWNER labelflow;`（最干净），
   或者 `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO labelflow;`。
3. `seed.sql` 用了显式 `id`（tenants id=1…），序列停在 1 → `POST /platform/tenants` 直接撞 `tenants_pkey`（`duplicate key … Key (id)=(1) already exists`）。`saas_p0_roles.sql` §11 把 P0 相关表（tenants/users/user_roles/roles/subscriptions/tenant_modules/plans/data_scopes）的序列统一推到 `max(id)+1`，幂等。

`saas_p0_roles.sql` 全文幂等（`IF NOT EXISTS` / `ON CONFLICT` / `WHERE NOT EXISTS`），PG14 实测连跑 3 遍 0 error、行数零漂移，可以当「补丁式迁移」反复执行；新加的列一律放这个脚本，不要再改 `03-database.sql` 之外的历史脚本。

### 10.15.3 守卫链（`backend/src/main.ts:75`）

执行顺序 = 注册顺序：`JwtAuthGuard → ModuleGuard(4031) → PermissionGuard(4032) → RolesGuard(403)`

| 守卫 | 声明方式 | 判定逻辑 | 未通过 |
| --- | --- | --- | --- |
| `ModuleGuard` | `@RequireModule('print')` | 租户生效模块（active/trial 且未过期，**不关心 source**，D1）命中任一 | `403 {code:4031, message:'模块未订阅: xxx'}` + `action: 'upgrade'` |
| `PermissionGuard` | `@RequirePermission('template:write')` | 用户角色 → `role_permissions` 展开（支持 `print:*` / `*`），**多参数是 OR** | `403 {code:4032}` + `action: 'contact_admin'` |
| `RolesGuard` | `@Roles('admin','operator')` | 旧码/新码双向别名（§10.15.4） | `403 {code:403}` |

两个必须知道的实现约束（新加守卫/中间件时最容易踩）：

- **守卫跑在拦截器之前**：`TenantContextInterceptor` 还没往 `AsyncLocalStorage` 里写 `modules/permissions`，所以 `ModuleGuard` / `PermissionGuard` **自己查库**（各自带缓存）。在守卫里调 `useTenant()` 一定拿到空值。
- **不写装饰器 = 放行**，所以对未改造的路由零侵入；`PermissionGuard` 对 `admin` / `tenant_admin` 无条件放行（`SUPER_ROLES`）。

已挂装饰器的控制器（模块是门，权限是钥匙）：

| 控制器 | L2 门 | L1 钥匙 |
| --- | --- | --- |
| `template/template.controller.ts` | `templates` | `template:read` / `template:write` / `template:favorite` |
| `print/print.controller.ts` | `print` | `print:job:read` / `print:job:write`,`print:job:submit`（OR）/ `print:job:cancel`,`print:job:write`（OR）/ `print:stats:read` |
| `printer/printer.module.ts` | `print` | **只上门不上钥匙**：加 `print:printer:manage` 会削弱旧 operator（旧行为能管打印机），故兼容期不挂 |
| `user/user.module.ts` | `users` | `sys:user:read` / `sys:user:manage` |
| `ai-template/ai-template.controller.ts` | `ai` | `ai:generate` / `ai:regenerate` / `ai:text-to-template` / `ai:rectify` / `ai:models:manage` / `template:write`（保存到模板库）；`/ai-template/jobs` 不挂钥匙 |
| `serial/serial.controller.ts` | `serial` | 未挂（沿用旧 `@Roles`） |
| `datasource/datasource.module.ts` | `datasource` | `datasource:read` / `datasource:write` |
| `backup/backup.controller.ts` | `backup` | `backup:read` / `backup:write` / `backup:restore` / `backup:download` |
| `audit/audit.module.ts` | `audit` | `audit:read` / `audit:export` |

### 10.15.4 D11 角色现状（兼容期双码）

| 旧码（`user_roles.role`） | 新码（`roles.code`） | 关系 |
| --- | --- | --- |
| `admin` | `tenant_admin` | 别名互认，双写双回显 |
| `operator` | `operator` | 同名 |
| `sql` | `manager` | **D11 废弃 sql**，登录后回显 `["sql","manager"]` |
| `viewer` | `viewer` | 同名 |
| — | `warehouse_keeper` / `purchaser` | 新增业务角色，旧 JWT 里不存在 |

- `user_roles` **双写**：`role`（字符串，DDL CHECK 目前仍只认 4 个旧码）+ `role_id`（指向 `roles.id`）。`saas_p0_roles.sql` §5 已把存量行回填 `role_id`（校验：`SELECT COUNT(*) FROM user_roles WHERE role_id IS NULL` 期望 0）。
- 内置模板角色 6 个（`tenant_id IS NULL`）：tenant_admin / manager / operator / warehouse_keeper / purchaser / viewer；开通新租户时在事务内复制一份（§11.12.2 第 2 步），后续可自定义。
- 权限字典 **37** 条（`saas_p0.sql` 24 + `saas_p0_roles.sql` §3 13），`tenant_admin` = 全量 37，`viewer` 除 `template:favorite` 外全是 `*:read`。
- ⚠️ §11.15.1 第 5 条要求 `RoleName` 里「禁止再出现 `sql`」，本版按 §11.12.3 兼容期**故意保留** `LegacyRoleName`（`roles.guard.ts`），否则现网 4 个账号会全挂。下个大版本删 `RoleAlias` + `LegacyRoleName` 才算收口。

### 10.15.5 与 docs/11 的有意偏差（接手前必读，别再照着设计稿改代码）

| # | 偏差 | 原因 / 影响 |
| --- | --- | --- |
| 1 | **套餐模块集合 ≠ §11.16**：实际 BASIC = `print,templates,ai,serial,users`；PRO = BASIC + `datasource,backup,audit,agent`；ENTERPRISE 目前与 PRO 同集合 | `saas_p0.sql` 是按「现有 8 个功能模块」种的历史基线，P0 的硬目标是**现有租户零回归**（default 在 BASIC，若按 §11.16 重排会当场失去 templates/ai/users 权限）。要落 §11.16 的商业口径必须产品重新确认，且改 seed 前先想清对现网 default 的影响 |
| 2 | `inventory/masterdata/bom/alert` 不进任何套餐，只能加购 | 符合 D1（`tenant_modules.source='addon'`），验收 F 段覆盖依赖闭包补齐（订 bom → 自动开 inventory + masterdata，`source='addon'`） |
| 3 | `tenants.status` 仍是 `SMALLINT`（1/0），未改成 §11.5.2 的 VARCHAR 枚举 | 推翻它要动 `auth.service` 的 `status !== 1` 判定，属无收益的破坏性改动。订阅生命周期由 `subscriptions.status` 表达，硬删时间由 `tenants.canceled_at` 表达（D12 已满足） |
| 4 | `role_permissions` 主键仍是 `role` 字符串，只额外加可空 `role_id` | §11.12.3 兼容期，切换在 §11.12.2 第 4 步之后做 |
| 5 | `seat_limit` 来自 `POST /platform/tenants` 入参（`dto.seats ?? 5`），`plans` 表没有 `seat_limit`/额度列 | §11.3.5 限额模型整体属于 P3；验收 E.7 只是证明字段能贯通到 `/auth/me` |
| 6 | `feature_flags` 没有 key 白名单，`PUT /platform/tenants/:id/flags` 可写任意 key | P0 只要求 `agent.print.submit` 默认 false（D7，验收 E.4 通过）。白名单 + 灰度 rollout 等 P2 运营后台 |
| 7 | `viewer` 持有 `template:favorite`（非 read 动作） | 与 §11.11.1「viewer 只有 `*:read`」有出入，是 saas_p0.sql 原始种子；验收 D.2 做了显式豁免注释，改它属于产品决策 |
| 8 | `TenantDataSourceManager` 目前只在 `provision.service` 事务里用到（`get()` + `applyTenantScope()`） | §11.15.1 第 1 条要求所有取连接都走它。P0 先把入口和钩子建好，**普通查询链路仍直接 `@InjectRepository`**，P6 接独立库/RLS 时统一替换（工作量集中在 Repository 注入点） |

### 10.15.6 测试与验收覆盖

```bash
cd backend && npm test                       # 217 条（原 26 → P0 +89 → P1 +2 → 校验 +8 → P2 +5 → P3 +12 → P4 +18 → P5 +20 → P6.3 +9 → P6.4 +13 → P6.2 +7 → P6.5 +8）
# O 段（白标）要后端带 BRANDING_DEV_VERIFY=1；N 段要 DB_RLS_USER（两者缺一按对应断言判失败并给提示）
# P 段真连独立库要传 D2_DSN（指向一个已跑完 docs/03 + saas_*.sql 的库）；不传则只跑控制面校验并 SKIP P.13+
DB_RLS_USER=labelflow_app D2_DSN='postgres://user:pw@127.0.0.1:5432/labelflow_d2' T_CODE=p6q1 T2_CODE=p6q1pro bash backend/scripts/p0-acceptance.sh  # 267 项断言（A–Q 段），期望「通过 267 / 失败 0」（重跑换新 T_CODE/T2_CODE）
bash backend/scripts/p6-rls-smoke.sh         # 22 项：RLS 兜底专用冒烟（必须用 labelflow_app DSN 才有效，见 §10.22.3）

# 前置 DDL（顺序敏感；saas_* 都幂等可重跑）：
#   docs/03-database.sql → backend/scripts/seed.sql → saas_p0.sql → saas_p0_roles.sql
#   → saas_p2_platform.sql → saas_p3_billing.sql → saas_p4_agent.sql → saas_p5_agent_tools.sql
#   → saas_p6_rls.sql（角色 + 39 张表策略，缺它 N.1 直接判失败）
#   → saas_p6_tenant_data.sql（放宽 tenant_backups.kind CHECK，缺它导出必 500 / 23514）
#   → saas_p6_branding.sql（tenant_domains 补列 + sys:branding:manage，缺它 O 段整段红）
#   → saas_p6_dedicated.sql（tenants.data_source_key + 2 CHECK + 部分唯一索引，缺它 P.1 判失败）
#   → saas_p6_prompts.sql（agent_prompts + tenant_isolation + sys:prompt:manage，缺它 Q 段整段红）
```

- 单测分布（本轮新增）：`validate-ai-template` 23、`sql-executor` 14（含真实 PG 集成，PG 不可达自动 skip）、`saas-guards` 10、`menu.catalog` 12（P1 加了 AI 入口 + 菜单/路由一致性两条）、`data-scope` 7、`roles.guard` 7、`module-deps` 6、`permission-match` 8、`errors.filter` 4。
- 验收脚本覆盖：A 单事务开通（subscriptions=1、tenant_modules ≥ 套餐、6 角色复制、`user_roles` 双写、trial 状态、flag 默认值）→ B 4031（BASIC 拒 / 同接口 PRO 200）→ C 4032（viewer 建备份）→ D tenant_admin=37 / viewer 只读 → E `/auth/me` 五件套（modules/permissions/menus/features/dataScopes + plan/seatLimit）→ F 加购与依赖闭包 → G 开关与退订（`canceled_at` + 90 天硬删时间 + 幂等）→ H 旧 4 角色回归（登录、双码回显、读模板、读任务、operator 可写、viewer 被拒）。
- ⚠️ **`npx tsx` 跑测试时不生成装饰器元数据**：任何 import TypeORM 实体或 Nest module 的测试文件都会 `ColumnTypeUndefinedError`。因此 `datasource.service.testSql` 的覆盖下沉到 `sql-executor` 层（见 `src/datasource/__tests__/sql-executor.test.ts` 头注释）。被测代码要走纯函数/服务类边界，别在单测里拉起 `DataSource`。
- 脚本会真实建 2 个租户 + 1 次加购 + 1 次退订，数据留在库里（可重跑，用新的 `T_CODE`/`T2_CODE`）。

### 10.15.7 P0 明确没做（别当成已完成）

- RLS（P6）、独立库租户（D2 → P6）、`platform_users` 独立 JWT scope（P2）、计费/额度/账单（P3）、Agent/MCP（P4/P5）、白标域名校验（D6 → P6）。
- ~~前端 `apps/console` 仍是硬编码菜单、未订阅引导页、订阅页~~ → **P1 已做完，见 §10.16**。
- 平台运营后台（`apps/platform`）仍不存在（P2）；`/platform/*` 接口已就绪但只有 Swagger/curl 能用。

---

## 10.16 SaaS P1 前端动态化（2026-11-04 落地）

> 目标（docs/11 §11.10 / §11.4.6）：**前端不再硬编码菜单**，路由、菜单、按钮、页签一律按
> L1 权限点 + L2 订阅模块判定；被拦时给「模块未订阅 → 升级引导」而不是空白页或裸 403。
>
> 本轮同时改两套前端：`apps/console`（Vue 3 + Element Plus，要构建，设计器 Vue 版在这里）和
> `web/`（零构建原生 DOM，老版本独立客户端）。两套读的是同一个 `/auth/me`，只改一套会出现
> 「console 里看不到的入口，在原生设计器里照样能点」。

### 10.16.1 代码地图

| 文件 | 作用 | 本轮改动 |
| --- | --- | --- |
| `apps/console/src/api/index.ts` | 唯一 axios 出口 | **拆信封**：成功返回 `data`，失败抛带 `bizCode/httpStatus/modules/permissions/action` 的 `ApiError`；401 刷新单飞（并发只发一次 refresh）；新增 `apiLogout` / 数据源 / 审计（含 `auditExportUrl` 走 `?token=`）/ AI 系列 |
| `apps/console/src/store/auth.ts` | Pinia 登录态 | 新增 `menus` / `features` / `dataScopes` / `tenant` 与 `menuPaths`（菜单树叶子展平）；`isAdmin` 认 `admin` + `tenant_admin`；`hasPermission` 对超管直接放行（与后端 `PermissionGuard` 一致） |
| `apps/console/src/directives/permission.ts` | **`v-permission` / `v-module`** | 新增：数组 = OR；`.hide` 移除节点，否则 `disabled` + `data-denied` + 半透明；`main.ts` 在 pinia 之后注册 |
| `apps/console/src/router/index.ts` | 路由 + 守卫 | 守卫改异步：无 `user` 先 `fetchMe()`（刷新页面时 store 是空的）→ `meta.always` 放行 → L2 模块 → L1 权限点 → `menuPaths` 兜底；不通过跳 `/blocked?kind=&code=&from=` |
| `apps/console/src/layouts/MainLayout.vue` | 顶栏 | 菜单**只渲染 `auth.menus`**（两级 `el-sub-menu` + 图标）；套餐标签取 `tenant.plan/planName`；试用/到期横幅；退出登录改为先调 `POST /auth/logout` 吊销 refreshToken |
| `apps/console/src/views/Blocked.vue` | 统一拦截落地页 | 新增：4031 给套餐/已开通模块/加购引导，4032 给角色与权限点；「重新检查权限」按钮重跑 `fetchMe` |
| `apps/console/src/views/DataSources.vue` `AuditLogs.vue` `AiGenerate.vue` | 三个此前只有后端的页面 | 新增（数据源 CRUD + 测试连接、审计列表 + 导出、AI 图生/文生模板 + 保存为模板 + 最近任务） |
| `apps/console/src/views/Backups.vue` `UserManagement.vue` `Templates.vue` | 存量页面 | `!auth.isAdmin` → 权限点判定（`backup:write/restore`、`sys:user:manage`、`template:write`、`audit:export`、`datasource:read/write`） |
| `apps/console/src/constants/modules.ts` | 模块中文名 | 新增，**纯文案表**：只给「租户没订阅、接口里查不到名字」的模块兜底显示，不是菜单/权限来源 |
| `backend/src/saas/menu.catalog.ts` | 菜单目录 | 补 AI 入口（`module: 'ai'` + `permission: 'ai:generate'`）；写明 `serial` 为何不进菜单 |
| `backend/src/saas/subscription.controller.ts` | `GET /subscription` | 加 `moduleDetails`（名称/图标/说明/`isCore`），`modules` 数组保持原样 |
| `backend/src/backup/backup.controller.ts` | 备份 | `remove()` 的 `@Post(':id')` → `@Delete(':id')` + `@RequirePermission('backup:write')` |
| `backend/src/datasource/datasource.module.ts` | 数据源 | 10 处 `throw new Error(...)` → `BadRequestException`（用户输错原来是 500） |
| `web/js/api.js` | 原生前端请求层 | 新增 `BIZ_CODE` / `bizError()`：4031/4032 转成「模块未订阅：x，需要升级套餐」/「缺少权限：y，请联系管理员」，其余沿用后端 message |
| `web/js/app.js` | 原生前端主控 | `applyRoleConstraints()` 改「权限点优先 + 角色兜底」；新增 `hasPerm/hasModule/applyModuleTabs/setTabLockMark`，按订阅模块显隐 8 个页签 |

### 10.16.2 一次页面刷新的完整链路

```
浏览器 → router.beforeEach（无 user）→ GET /auth/me
       → store 落 modules/permissions/menus/features/dataScopes/tenant
       → 守卫按 L2(module) → L1(permission) → menus 路径 三级校验
            不通过 → /blocked?kind=module|permission&code=xxx&from=/yyy
       → MainLayout 渲染 auth.menus（后端已裁剪，前端不再判断该不该显示）
       → 页面内按钮 v-permission / auth.hasPermission
       → 请求真的被后端拦时，axios 层把 4031/4032 翻成中文 toast（不做二次跳转，
          避免和路由守卫互相打转）
```

`hasPermission` 的通配规则与 `backend/src/common/permission-match.ts` 逐条对齐：
`*` 全通、`template:*` 放行 `template:read`、三段码兜底裁到 `模块:*`。**前端判定只是 UX，
安全性一律在后端守卫**——这句话在指令文件头注释里也写了，别把它当成访问控制。

### 10.16.3 加一个新页面的正确姿势（三步，顺序无所谓）

1. `backend/src/saas/menu.catalog.ts` 加目录项：`path` 必须和前端路由一致，
   `module` / `permission` 必须和该页面对应控制器的 `@RequireModule` / `@RequirePermission` 一致。
2. `apps/console/src/router/index.ts` 加路由 + `meta: { title, icon, module, permission }`。
3. 视图里的写操作按钮加 `v-permission`。

漏第 1 步 = 菜单里看不到入口（路由还能靠手输 URL 进，守卫会按 meta 拦）；
漏第 2 步 = 点了菜单进通配重定向。**这条已经有单测兜着**：
`menu.catalog.test.ts` 会遍历 `MENU_CATALOG` 的每个叶子 path，断言它出现在
`apps/console/src/router/index.ts` 里（找不到源码文件时自动 skip，不会让只跑后端的 CI 变红）。

### 10.16.4 指令的两个坑（踩过）

- **别在一个元素上叠 `v-permission` 和 `v-module`**：两个指令都往同一个 DOM 上写
  `disabled`，后执行的会把前一个的结论覆盖掉，出现「有权限点但没订阅模块，按钮照样能点」。
  需要双重条件时写 `v-if="auth.hasModule('x') && auth.hasPermission('y')"`。
- **`el-popconfirm` / `el-tooltip` 这类包一层的组件用 `v-if`，别用 `v-permission.hide`**：
  指令是直接 `removeChild`，会把 reference 插槽一起摘掉。`Backups.vue`、`UserManagement.vue`
  的删除确认都是这么处理的。
- 超管在前端也走放行（`isAdmin` → `admin || tenant_admin`），否则会出现「后端能调、按钮却灰着」。

### 10.16.5 原生前端（`web/`）的裁剪口径

- 页签是固定 DOM，不是后端菜单树 → 用 `TAB_MODULES` 做「页签名 → 模块码」映射，
  未订阅的页签 `hidden` 并在文案后加 `🔒`（纯文本标记，重复调用幂等，不动样式结构）。
- `users` 页签要同时满足「订阅 users」+「有 `sys:user:read`」；拿不到 `permissions`
  （老登录态）时退回原来的 admin 判断，**行为与改动前逐条等价**。
- `hasModule()` 在 `modules` 缺失/为空时返回 `true`：宁可多显示入口（点了被后端 4031 拦、
  有中文提示），也不要因为一次登录态异常把所有页签裁光。
- 顺带修了个旧缺陷：原来写 `setAttribute('hidden', String(!isAdmin))` 会输出 `hidden="false"`，
  按 HTML 规范属性只要存在就生效 → admin 反而看不到「用户管理」页签。现改 `el.hidden` 布尔属性。

### 10.16.6 怎么验证（本轮全部实跑通过）

```bash
# 1) 前端类型检查 + 构建（期望 0 error）
cd apps/console && npm run build

# 2) 后端编译 + 单测（P1 新增 1 条菜单/路由一致性断言）
cd backend && npx tsc -p tsconfig.json && npm test
#    PG 起着：125 tests / 125 pass；PG 不可达：125 tests / 118 pass / 7 skip（sql-executor 集成用例自动跳过）

# 3) P0 验收回归（P1 没动守卫链，期望仍是「通过 62 / 失败 0」）
cd backend && T_CODE=p0a1 T2_CODE=p0a2 bash scripts/p0-acceptance.sh

# 4) 原生前端语法检查（无构建，只能用 esbuild 过一遍）
npx esbuild --format=esm --outfile=/dev/null web/js/app.js
npx esbuild --format=esm --outfile=/dev/null web/js/api.js
```

手工验收（default 租户是 BASIC：`print/templates/ai/users/serial`）：

- admin 登录后菜单只有 仪表盘 / 打印（任务·设计器·模板库）/ AI 生成模板 / 系统管理（用户管理）/ 我的订阅；
  数据源、审计、备份**不出现**——因为模块没订阅，不是权限点问题。
- 手输 `/datasource` → `/blocked?kind=module&code=datasource`，页面显示当前套餐与已开通模块 + 升级引导。
- 用 `POST /platform/tenants/1/modules` 加购（body 是 **单个** `{"moduleCode":"datasource","source":"addon"}`，
  不是数组）→ 同进程内**立即**生效：`provision.addModule()` 会显式 `ModulesService.invalidate()`，
  实测 `/auth/me.menus` 下一请求就多出 `/datasource`、`GET /data-sources` 从 4031 变 200。
  只有跨进程（api ↔ worker）才受 60s TTL 限制，前端点「重新检查权限」即可看到新入口。
  验证完用 `DELETE /platform/tenants/1/modules/datasource` 还原。
- 拿 viewer 登录后 AI 按钮应灰掉（`ai:generate` 不在 viewer 权限集合里）。

### 10.16.7 P1 明确没做

- `apps/platform` 平台运营前端（P2）；`/platform/*` 仍只能 Swagger/curl。
- `web/` 没接 `features`（D7 灰度）：`web/index.html` 的 AI 视图里没有透视矫正按钮，
  `api.rectifyAiImage()` 是前端零调用的死接口 —— 没有可挂的 UI，就没做猜测性映射。
  `web/` 也没消费 `me.menus` 菜单树（页签是固定 DOM，见 §10.16.5）。
- L3 数据范围（`dataScopes`）只读回来了，UI 上没有体现（属 P2/P6）。
- `/serial` 没有页面：后端 `serial-sequences` 只有 `segment-preview`，没有列表/CRUD。
- ~~`POST /templates` 仍无 DTO 校验，缺字段直接撞 `23502` → HTTP 500~~（2026-11-05 已修，见 §10.17）。
  原 P0 验收 H.5 就是被这个坑到的（§10.15.6），现在缺 content 在门口就 400。

---

## 10.17 全局入参校验底座（2026-11-05 落地）

> 起因：45 个 `@Body()` 全是 `any` 或裸 TS 类型（运行时擦成 Object），少传字段会一路穿透到
> TypeORM 撞数据库约束 → HTTP 500。P0 验收 H.5 当年就是把用例改对了、根因还留着
> （§10.15.6）。本轮把它堵上，并顺手修了一个真实的前端契约 bug。

### 10.17.1 做了什么

1. `main.ts` 注册全局 `ValidationPipe({ transform: true, whitelist: false, forbidNonWhitelisted: false })`。
2. 新增 9 个 DTO 文件（各域 `dto/` 目录 + `common/dto/render-and-ai.dto.ts`），覆盖全部 45 个
   `@Body()` 写入口中的 40 个；剩下的 5 个是 multipart（`@UploadedFile`）或 `/print/preview`
   这类自由 JSON 端点，pipe 对 `Object` metatype 本来就跳过，行为不变。
3. `errors.filter.ts`：class-validator 的报错是 `string[]`，现在拼成
   `message: "参数校验失败：content 必须是对象…"` 并把明细放进 `errors` 字段，前端能直接 toast。
4. 顺手修了真实 bug：`apps/console/src/api/index.ts` 的 `apiResetUserPassword` 一直在发
   `{ password }`，而后端收 `newPassword`（`web/js/api.js` 是对的）——**console 重置密码必失败**。
5. `class-validator` / `class-transformer` 从 devDependencies 挪进 dependencies（运行时真实依赖）。

### 10.17.2 三个关键决策（改之前先读）

- **`whitelist: false`，故意不开白名单剔除**：web 设计器、AI 保存、打印机临时创建
  （`web/js/printers.js` 的 `tempCreate` spread 整个 draft）历史上一律「整包透传」，
  多余字段靠 TypeORM 忽略未知列兜着。开白名单会静默丢字段，那是比 500 更难查的坑。
- **DTO 只挡「形状」，业务规则仍在服务层**：密码最短位数、连接串前缀、copies 1..500、
  角色取值集合这些校验有专门的中文报错文案，还留在服务里，DTO 不重复（避免两处文案漂移）。
- **DTO 类不要用 extends 复用必填字段**：class-validator 的装饰器沿原型链**累加**不覆盖，
  子类把 `name` 改成可选是没用的（PrinterDto 踩过，最后 UpdatePrinterDto 平铺全可选）。

### 10.17.3 验证（全部实跑）

- `npx tsc -p tsconfig.json` 0 error；`npm test` **125/0**（新增
  `src/common/__tests__/validation-pipe.test.ts` 8 条：缺 content→400、白名单不丢字段、
  Object 跳过、filter 拼 message 等）。
- `p0-acceptance.sh` **65/0**（新增 I.1–I.3 三项校验回归，T_CODE 要用没跑过的）。
- curl 实测：`POST /templates` 缺 content → `400 + 参数校验失败：content 必须是对象…`；
  带 `legacyExtra` 的正常请求 → 201 且多余字段原样落库。
- `apps/console npm run build` 0 error。

### 10.17.4 没做（记入下一轮）

- `@Query()` 的 DTO 化（list 接口的 page/pageSize/keyword 仍是裸 `any`，风险低）。
- `forbidNonWhitelisted: true`（多传字段报 400 而不是忽略）——与「整包透传」兼容策略冲突，不做。
- AI 模型配置等深校验（settings 内部结构）；DTO 里的 `@IsAny` 型自由字段维持透传。

---

## 10.18 P2 平台运营后台（2026-11-05 落地）

> 对应 docs/11 §11.11 P2 行 + §11.6.2 平台 API 契约。范围：平台运营身份、租户运营、
> 套餐配置、用量看板、到期提醒。计费/账单（P3）、模拟登录、`/platform/v1` 前缀迁移不在本轮。

### 10.18.1 平台身份体系（最重要的行为变化）

- 新表 `platform_users`（scripts/saas_p2_platform.sql，含种子账号 `platform / platform#2026`，幂等）。
- `POST /platform/auth/login` 签 `scope='platform'` 的 JWT（2h，无 refresh，过期重登）。
- **P0 时代拿租户 admin JWT 直接调 /platform 写接口的用法已关闭**：`PlatformJwtGuard`
  只认 scope=platform，租户 JWT 得 403（验收 J.1）。租户 admin 现在只能读三个目录接口。
- 目录查询（GET /platform/modules、/plans、/permissions）挂 `PlatformOrAdminGuard`：
  平台运营或租户 admin 都能读（console 订阅页靠它做套餐对比，P1 不能回归），operator 403。
- p0-acceptance.sh 相应升级：0.2 平台登录拿 `PT`，运营写调用全部换 `PT`（`AT` 只剩目录）。

### 10.18.2 运营接口（platform-admin/ 目录）

| 接口 | 说明 |
| --- | --- |
| GET /platform/tenants | 租户列表（订阅状态/席位/试用到期/退订时间，复用 provision.listTenants） |
| POST /platform/tenants | 开通（同 P0 语义，单事务） |
| POST /platform/tenants/:id/suspend \| /resume | 停用/恢复（tenants.status 翻转 + invalidate） |
| POST /platform/tenants/:id/cancel | 退订（D12：canceled_at → 90 天硬删） |
| POST/DELETE /platform/tenants/:id/modules[/:code] | 加购（自动补依赖）/ 停用（依赖检查） |
| GET/PUT /platform/tenants/:id/flags | D7 灰度开关（从租户 admin JWT 迁到平台身份） |
| GET /platform/plans + PUT /platform/plans/:code | 套餐配置：moduleCodes 全量替换 plan_modules + invalidateAll |
| GET /platform/usage | 全局看板：totals 聚合 + byPlan 分布 + expiringSoon |
| GET /platform/audit | 平台审计（最近 200 条） |

### 10.18.3 平台审计与到期提醒

- **platform_audit_logs 独立表**：租户 audit_logs.tenant_id 有 FK（REFERENCES tenants），
  平台动作没有租户上下文，写 0 会撞 FK —— 所以平台侧另建表，别混用 AuditService。
- 到期提醒：`expire.util.ts` 纯函数（单测不连实体，见 §10.15.6 脚注）+
  服务 `onModuleInit` 启动 10s 后首扫、之后每 24h 一次，3 天内到期的 trial 打 WARN 日志；
  看板 `usage.expiringSoon` 同源。P3 接消息通道后把 console.warn 换成推送。

### 10.18.4 验证（全部实跑）

- `npx tsc` 0 error；`npm test` **130/0**（新增 platform-admin.test.ts 5 条）；
- p0-acceptance.sh **72/0**（0.2 + J.1–J.6：scope 隔离、看板、列表、suspend/resume、审计）；
- curl 实测：租户 JWT → 运营接口 403；平台 token → 租户业务接口 403（缺租户上下文）；suspend 后
  该租户登录 401「该租户已停用」，resume 恢复；PUT plans/BASIC 换模块后目录立即变化。

### 10.18.5 P2 明确没做（接 P3/P6）

- ~~计费/账单/发票（P3）~~ → **计费/账单已由 §10.19 落地**（税务发票开具仍未做）；`/platform/v1` 独立前缀（仍挂在 /api/v1 下）；
- 模拟登录 impersonate（§11.6.2 列了，风险高，单独排期）；
- platform_users 的 CRUD UI（后台只有种子账号，加人直接 SQL）；refresh token 机制。

---

## 10.19 P3 计费闭环（2026-11-05 落地）

> 对应 docs/11 §11.11 P3 行 + §11.7 计量规则 + D5（支付先手动登记）。
> 范围：用量采集、配额软/硬上限（4033）、出账、收款登记、租户账单查询、运营端账单中心。
> 明确没做的见 §10.19.5。DDL：`backend/scripts/saas_p3_billing.sql`（幂等，执行顺序写在文件头注释）。

### 10.19.1 数据模型（5 张新表 + plans 加列）

| 表 | 关键点 |
| --- | --- |
| `plans.price_cents` | 月费，**分**（BIGINT）。BASIC=0（未定价）、PRO=29900、ENTERPRISE=99900，改价走 `PUT /platform/plans/:code`（`UpsertPlanDto.priceCents`） |
| `usage_meters` | 原始计量（对账的事实源）：tenant_id/meter/quantity NUMERIC(14,2)/module_code/user_id/meta/occurred_at |
| `usage_daily` | 日聚合，PK(tenant_id,meter,day)。**配额检查只读这张**（§11.7：别让每次打印去扫原始表） |
| `quotas` | PK(tenant_id,meter)：soft_limit（超过只告警）、hard_limit（超过拒绝 4033）、period month/day |
| `invoices` | number `INV-<t>-<yymm>-<seq>` 唯一；amount_cents；status draft/issued/paid/void/overdue；**detail JSONB 出账快照**（套餐/行项/单价冻结，之后改价不影响已出账单） |
| `payments` | D5：`provider='manual'` 为主（wechat/alipay/stripe/bank 是预留枚举）；累计收款 ≥ 应付自动转 paid |

- **钱一律用分**，杜绝浮点；pg 的 numeric/bigint 读出来是字符串，服务层统一 `Number()` 后再进响应。
- 权限点 `sys:billing:read`（users 模块），种子直接授予 admin/tenant_admin。
- 偏差：docs/11 §11.5 把计费表写在 `platform.` schema，实际沿用 P0/P2 的 public（表名不与租户业务表冲突），不单独引 schema。

### 10.19.2 计量写路径（两个真实计费事件）

- 流程：写 `usage_meters` → **同请求内即时 upsert `usage_daily`**（`ON CONFLICT DO UPDATE quantity += EXCLUDED`）；另有每小时定时任务用原始表幂等重算「今天+昨天」兜底（无 @nestjs/schedule，沿用 P2 的 unref 定时器模式）。
- `print_labels`：`print.service.createJob`，数量 = rows×copies（张），入队成功后记账；`ai_generate`：`ai-template.controller` generate=1、batch-generate=成功格数。
- 容错口径「**宁可漏检不漏印**」：配额查询/计量写入自身故障 → warn 日志放行；只有 4033 向上抛。
- 与老的 `AiQuotaService`（按日次数防跑 token 滥用）**并存不合并**：那个防滥用，这个管计费。
- ⚠️ 单测只能 import `billing.calc.ts` 纯函数（checkQuota/invoiceNumber/maxSeqOf/monthPeriod/sumLineCents/isSettled）；任何 import 实体的测试文件在 tsx 下必炸（§10.15.6 老坑），12 条新单测全走纯函数。

### 10.19.3 配额与新业务码 4033

- `assertQuota`：hard 判定用 `used + qty > hard`（拦在事前，防「超限后空任务照发」）；soft 命中只回 `{warn:true}`，打印响应带 `quotaWarn`、AI 响应注入 `quotaWarn` 字段。
- `QuotaExceededException` → **BizCode 4033**（HTTP 403），detail 带 `meter/used/limit/period/action:'upgrade'/suggestion`，前端按 4031 同款「升级引导」处理（business.errors.ts）。
- 配额管理只开放平台身份：`PUT /platform/tenants/:id/quotas/:meter`（字段传 null=取消该侧限制；soft>hard → 400），`DELETE` 整条删除；租户 JWT 调用 → scope 403（验收 K.6）。

### 10.19.4 出账 → 收款 → 租户对账

- 运营侧接口（全在 PlatformAdminController，scope=platform）：
  `POST/GET /platform/invoices`、`GET /platform/invoices/:id`、`POST :id/issue`（dueDays 默认 15）、`POST :id/void`（已付拒绝 400）、`POST :id/payments`（返回含 payments/balanceCents）；
  配额/计量：`GET/PUT/DELETE tenants/:id/quotas[/:meter]`、`GET tenants/:id/meters`（月聚合+原始明细分页）。写操作全部落 platform_audit_logs（quota.set/remove、invoice.create/issue/void、payment.create）。
- 自动出账：不给 items/amountCents → 按当前订阅套餐（active→trial）月费生成单行账单项；无有效套餐（如已退订）→ 400 要求显式金额；0 元账单允许（未定价不阻断）。
- 逾期任务：启动 1min 后 + 每 24h，issued 且过 due_at → overdue。
- 租户侧 `GET /billing/usage|usage/series|invoices|invoices/:id|quotas`（sys:billing:read）：**draft/void 对租户不可见**；详情含收款流水，「可出账、可对账」的落点。
- `SubscriptionService.usage()` 从写死占位改为真实聚合（`printJobs/aiGenerations {used,limit}`，limit=hard 或 -1），前端订阅页零改动兼容；`GET /subscription` 的 plan 对象补 `priceCents`。
- ⚠️ 坑：`GET /platform/plans` 命中的是 PlatformController 目录版（控制器注册顺序遮蔽 platform-admin 同名 GET），价格字段要在**目录版**（modules.service.listPlans）加，本轮已补 `priceCents`。

### 10.19.5 P3 明确没做（接 P4+/V2）

- 支付回调/自动扣款（D5 决议 V1 不做）；**退款无红字冲正流程**（临时方案：手工出一张负向说明账单项或另开小票，V2 再设计）。
- 发票（税务发票开具）—— §11.11 P3 行里那一列没动，需接开票服务商，属商务基建。
- 续费/付款提醒消息通道（站内信/邮件/飞书）：通知基建缺失，到期与逾期仍只有日志 + 看板。
- 按量计费（usage 行项自动算钱出账）：V1 只有「套餐月费 + 手动行项」；`usage_meters` 数据已在，接量价随时能扩。
- 账单 PDF/导出；多币种（currency 字段留了，只按 CNY 出账）。

### 10.19.6 验证（全部实跑 2026-11-05）

- `npx tsc` 0 error；`npm test` **142/0**（新增 billing.calc.test.ts 12 条）；
- p0-acceptance.sh **91/0**：K.1–K.19 覆盖 设配额→打印带软告警→4033 硬拦→租户用量→订阅聚合真实值→越权写 403→自动出账→发单→部分收款→结清→已付拒作废→租户可见性→详情流水→退订租户出账保护→0 元账单→草稿隔离/作废→原始明细→运营筛选；
- 前端：apps/platform 账单中心 + 租户配额抽屉 + 套餐价格编辑；apps/console `/billing` 页（菜单目录 /billing + 路由一致性断言 #12 绿）。

---

## 10.20 P4 Agent/MCP（2026-11-05 落地）

> 目标（docs/11 §11.11 P4 行）：agent 表 + `/agent/v1` + stdio MCP + 只读工具；演示口径「Claude Desktop 可查库存/齐套」。
> 明确没做的见 §10.20.5。DDL：`backend/scripts/saas_p4_agent.sql`；演示数据：`backend/scripts/seed-inventory-demo.sql`（`psql -v tid=<租户ID>` 幂等）。

### 10.20.1 数据模型

- Agent 层四张表按 §11.5.3 原样：`agent_clients`（kind=mcp_stdio|mcp_http|internal，status=active|disabled）、`agent_tokens`（token_hash UNIQUE + scopes TEXT[] + expires_at/revoked/last_used_at）、`agent_approvals`（**只建表，审批流 P5 接线**）、`external_mcp_servers`（**D10 预留不实现**）。
- **库存最小读模型**（本阶段的关键前置：文档验收要求「无库存数据返回空数组+友好摘要」，而库内此前 inventory/bom 域零实现）：
  `warehouses`、`materials`（safety_stock NUMERIC(14,3)）、`stock_batches`（批次粒度，unit_cost_cents 分口径、expires_at DATE）、`boms`/`bom_items`（qty_per + loss_rate）。
  定位是「Agent 只读工具的数据面」，**没有租户 REST 控制器、没有出入库写路径**——完整 WMS（单据、流水、预警引擎）留给后续阶段在此模型上扩展。
- 权限字典补 3 码：`bom:shortage:read`、`inventory:stock:transfer`、`alert:event:ack`（其余 §11.7.2 所需码 P0 已种）；role_permissions 同步授 admin/tenant_admin（**legacy admin 此前只种了 4 个 sys 码，靠 SUPER_ROLES 兜底；为 Agent scope 校验字典完整显式补齐**）、warehouse_keeper 调拨、manager/viewer 缺料读。
- ⚠️ 又一次踩联合类型反射坑：`status: 'draft' | 'active' | 'inactive'` 这类**字面量联合**同样反射成 Object，必须显式 `type: 'varchar'`（agent.entity / inventory.entity 都有显式标注）。

### 10.20.2 Token 与鉴权链

- 形态：`lfagent_` + 40 hex（20 字节随机）；库里只存 **sha256 hex**，明文仅签发响应出现一次；列表只回 hash 尾 8 位（`agent.calc.ts` 纯函数，8 条单测）。
- `AgentTokenGuard`：Bearer → 形态校验（租户 JWT 打 /agent/v1 直接 401，不查库）→ hash 查 token → revoked/expires_at → client.status → tenant.status。
  身份无效一律 401；身份有效但客户端/租户停用 → 403。通过后写 `req.agentCtx = {tenantId, clientId, clientName, scopes, tokenId}`，**tenantId 只来自 token**（§11.6.3 禁止请求体传租户）；last_used_at 异步打点失败不阻断。
- 控制器：`/agent/v1` 类级 `@Public()` + 自有 Guard（P2 同款跳链模式）；`/agents` 管理面 `TenantGuard + @RequireModule('agent') + @RequirePermission('sys:agent:manage')`（PRO 套餐专属，BASIC → 4031，验收 L.4）。
- 签发护栏（§11.7.7）：scope ⊆ 创建者权限（admin/tenant_admin 跳过，与 PermissionGuard SUPER_ROLES 一致）；**不传 scopes = P4 默认只读五码**（defaultReadScopes）。

### 10.20.3 工具目录与 dispatch（ToolsService）

- `tool.catalog.ts`：23 个工具定义 —— 3 元（whoami/list_modules/describe_capabilities）+ 8 个业务只读执行器（templates.search/get、inventory.query_stock/list_low_stock/list_batches/list_expiring、bom.check_kit_rate/explain_shortage）+ 5 个**已注册未开放**（templates.create/update、inventory.adjust/transfer、print.submit_job，P4 调用 → 400「后续版本开放」）。
- ⚠️ 权限点用**库内真实码**：文档 §11.7.2 写 `print:template:read/write`，实际字典是两段式 `template:read/template:write`（P0 已种），目录按真实码走（偏离已记 docs/11 §11.15.2）。
- dispatch 顺序（验收 L.12 依赖此顺序）：**scope 检查（403/4032 + 审计 denied_scope）→ 订阅模块（4031 + 审计）→ 执行器可用性 → agent_calls 配额（4033）→ 执行 → 计量 + 审计**。
  只读 token 打 inventory.adjust 在第一步就 403 —— 即便该工具没有执行器；`visibleTools()`/运行时 scope 判定共用 `matchPermission`（通配 `inventory:*` 语义一致）。
- 返回统一信封 `{summary, data, warnings, next_actions}`（§11.6.3）；空数据路径返回 `items:[]` + 中文友好摘要（不报错）。
- 计量：`agent_calls` 每次 POST /tools/:tool 记 1（含执行报错的调用；被 scope/模块拒的不计），`GET /whoami` 也走 call 链所以计量，`GET /tools` 清单不计量；`/agent/v1/resources/:kind/:id`（template/stock）复用对应工具的完整检查链。
- 审计：`audit_logs.action = agent.tool.<name>`（≤40 字符截断），detail `{clientId, clientName, argsHash, scopes, status: ok|denied_scope|denied_module|not_open|denied_quota|error, durationMs}`；actorId 走 useTenant() 兜底=0（agent 无用户身份；`actor_type=agent` 规范化留 P5）。argsHash = 键排序稳定 JSON 的 sha256（P5 approval 绑定用同一实现）。

### 10.20.4 apps/mcp-server（stdio）

- 技术选型：`@modelcontextprotocol/sdk@1.32.2` **低层 Server API**（McpServer.registerTool 需要 zod，低层 setRequestHandler(ListTools/CallTool) 直接吃后端下发的 JSON Schema，零额外依赖）。ESM（type:module，NodeNext，tsc 编译到 dist/）。
- 启动流：AGENT_TOKEN 缺失即退出 → GET whoami（401 时 stderr 提示重签）→ GET tools → 逐个注册；tools/call → POST /agent/v1/tools/:name → 信封转「摘要 + 缩进 JSON」文本块，4xx/5xx 转 `isError` content。
- **只持 Agent Token，不碰数据库**（§11.7.1）；stdio 单租户 = 一进程一 token。
- `npm run selftest`：SDK `Client + StdioClientTransport` 拉起 dist/index.js，断言 tools≥10、whoami 含租户、空数据查询 items:[]+友好摘要；**§11.11.2 的 `npx @modelcontextprotocol/inspector` 也已实测**（`--cli node dist/index.js --method tools/list` 列出 11 个）。验收 L.14 跑 selftest，未装依赖时自动跳过。

### 10.20.5 P4 明确没做（留给 P5/P6）

- **写工具执行器 + 幂等键 + 限流 + approval 流**（agent_approvals 表已建；`/agent/v1/approvals` 现为明确 400 占位）；Streamable HTTP 多租户入口（D9：P5）。
- 库存/齐套的**租户 REST 页面与写路径**（adjust/transfer 只注册目录）；alerts.* 工具未注册（无 alert 数据表）。
- print.submit_job 的 D7 灰度（feature_flags key 已随 P0 建好，执行链路 P5）。
- actor_type=agent 的审计列规范化（现在在 detail JSON 里）；data_scope 字段脱敏（护栏 7）。
- MCP server 的 HTTP 模式、Resources/Prompts 暴露（§11.7.5 只做了 REST 端点，MCP 侧 prompts/resources 声明未注册）。

### 10.20.6 验证（全部实跑 2026-11-05）

- `npx tsc` 0 error；lint 0 error；`npm test` **160/0**（新增 agent.calc.test.ts 18 条：token 形态/hash/argsHash 键序无关/过期/scope 通配/默认只读 + kit 齐套口径含浮点临界与空行）。
- p0-acceptance.sh **115/0**：L.1–L.20 覆盖 加购模块→种子→建客户端→BASIC 4031→签发→whoami 租户/scope→tools≥11→sku/batch/below_safety 三种查法→**空数组+友好摘要**→齐套率 60%（含 5% 损耗）→缺料 205kg→**只读 token 打 adjust 403+审计**→resources 快照→**stdio MCP selftest**→agent_calls 日配额 4033→撤销后 401→租户 JWT 打 agent API 401→停用客户端存量 token 403。
- 手工冒烟：真 token 走 /agent/v1 全链 + inspector CLI tools/list + SDK Client 三断言全绿。

---

## 10.21 P5 Agent 增强（2026-11-05 落地）

> 目标（docs/11 §11.11 P5 行）：写工具 + 幂等 + 限流 + 审计 + 审批流 + Streamable HTTP，交付口径「SaaS 客户可接入自有 Agent」，同时闭合 §11.11.2 第五条。
> DDL：`backend/scripts/saas_p5_agent_tools.sql`（幂等，可重复执行）。明确没做的见 §10.21.8。

### 10.21.1 数据模型与 DDL

| 对象 | 内容 |
| --- | --- |
| `tool_idempotency` | **新建**（文档只说「幂等键」未给表）：`(tenant_id, tool, idem_key)` UNIQUE + `args_hash` + `result JSONB` + `approval_id`。语义见 §10.21.5 |
| `agent_approvals` | P4 建的表本轮接线：`args_preview JSONB`、`status`（pending/approved/rejected/expired/consumed）、`approved_by/approved_at/consumed_at`；补两个索引 `(agent_client_id,status)`、`(tenant_id,status,created_at DESC)` |
| `audit_logs.actor_type` | **新列** `VARCHAR(16) NOT NULL DEFAULT 'user'`（§11.7.6「agent_client_id、on_behalf_of、tool、args_hash、耗时、结果码」的结构化落点；P4 时全塞在 detail JSON 里） |
| 权限字典 | 新增 `sys:agent:approve`（module_code 用 `users` —— 库里 `sys:*` 码统一挂 users 模块，挂 `sys` 会撞外键），授 admin / tenant_admin / manager / warehouse_keeper |
| 限流阈值 | **复用 `feature_flags['agent.rate_limit'].rollout.rpm`**，不新建表、不加环境变量：运营 `PUT /platform/tenants/:id/flags` 即时生效（验收 M.19 就是这么把 rpm 压到 1 的） |

实体侧两个新类 `AgentApproval` / `ToolIdempotency`（`src/agent/agent.entity.ts`，`src/entities/index.ts` 导出）；`AuditLog` 加 `actorType` 列，`audit.write(...)` 尾部加可选参数 `actorType: 'user'|'agent' = 'user'`（P4 起的 3 个调用点零改动）。

### 10.21.2 错误码与 HTTP 语义

`BusinessException` 基类从 `extends ForbiddenException` 改为 **`extends HttpException` + 末位可选 `httpStatus = 403`**（P2/P3 的 4031/4032/4033 行为逐字节不变，验收 B/C/K 段仍绿），P5 新增四码：

| BizCode | HTTP | 类 | 触发 |
| --- | --- | --- | --- |
| 4034 `APPROVAL_INVALID` | 403 | `ApprovalInvalidException` | approval_id 缺失以外的所有无效态：pending / rejected / expired / consumed / hash_mismatch / 非数字 |
| 4035 `FEATURE_DISABLED` | 403 | `FeatureDisabledException` | D7：`agent.print.submit` 未开 |
| 4036 `IDEMPOTENCY_CONFLICT` | **409** | `IdempotencyConflictException` | 同幂等键不同 args_hash |
| 4037 `RATE_LIMITED` | **429** | `RateLimitedException` | 超 rpm（detail 带 `limit/window/retry_after/action`） |

⚠️ **`need_approval` 不是错误**：HTTP **202** + 正常信封 `{code:0,data:{summary,data:{need_approval:true,approval_id,args_hash,preview,expires_at,next_actions}}}`，由 `AgentV1Controller` 用 `@Res({passthrough:true})` 按 `data.need_approval===true` 改状态码 —— 模型读 202 信封就知道「等谁、多久内、怎么重试」，比 400/403 更省一轮对话。
⚠️ 异常信封的 detail 由 `AllExceptionsFilter` **平铺在顶层**（`data` 仍是 null），所以取 `approval_status`/`limit`/`retry_after` 用 `jget approval_status` 而不是 `jget data approval_status`（M.6/M.19 的断言按此写）。

### 10.21.3 dispatch 顺序（`ToolsService.call`，十步）

```
1 scope(403/4032, 审计 denied_scope)   2 订阅模块(4031, denied_module)   3 implemented(400, not_open)
4 D7 开关(4035, denied_feature)          5 限流(429, denied_rate)         6 agent_calls 配额(4033, denied_quota)
7 幂等键必给(400, denied_no_idem_key) → 已有 result？同 hash 重放 / 异 hash 409
8 审批：无 approval_id → 202 need_approval（零副作用）；有 → verdict≠ok 一律 403/4034
9 占坑 claim（并发/崩溃接管）  10 执行 → finish 回写 + consume 审批 + 计量 + 审计(ok/error)
```

顺序的理由：① **重放判定在审批之前** —— 已经成功过的幂等键不该再要求一张新审批单，否则模型重试会撞 4034 而不是拿到「上次已生效」；② **need_approval 早于 claim** —— 建审批单时不能往 `tool_idempotency` 塞占坑行，否则同键重试会被当成"上次执行中"；③ 限流/配额在幂等之前，被拒的调用不消耗服务也不计量。

计量口径：`agent_calls` 对 **ok / error / need_approval / idempotent_replay 各记 1**（真实消耗了服务），`denied_scope / denied_module / denied_rate / denied_quota / denied_no_idem_key` **不记**（验收 M.19b 用「放行数 == 计量增量」正证）。

### 10.21.4 审批流（§11.7.6）

- 状态机：`pending →(员工确认) approved →(Agent 重试命中) consumed`；`pending →(驳回) rejected`；pending/approved 过了 `expires_at` → `expired`（**读时判定** + `expireStale()` 顺手落库，没有定时任务）。
- 时限：approved = **5 分钟一次性**（文档硬规定）；pending = **30 分钟**（文档未规定，自拟，给员工留响应时间）。
- `args_hash` = 键排序稳定 JSON 的 sha256，**计算时剔除 `approval_id`**（重试必须把它带回来，否则永远对不上）；`dry_run`、`idempotency_key` 参与指纹 —— 所以「换个幂等键复用旧审批」也会被判 hash_mismatch，这是有意的（一次审批只授权一次执行）。
- 判定纯函数 `src/agent/approval.calc.ts`（14 条单测）：`approvalVerdict(row, incomingHash, now)` → ok/pending/rejected/expired/consumed/hash_mismatch/not_found + 中文提示表 `APPROVAL_MESSAGES`，异常与 202 信封共用同一份文案。
- 端点：Agent 侧 `POST /agent/v1/approvals`（主动建单）、`GET /agent/v1/approvals/:id`（只能查自己租户+自己 client+同工具的单）、`GET /agent/v1/approvals?status=`；租户侧 `GET /agents/approvals`、`POST /agents/:id/approve`、`POST /agents/:id/reject`（`@RequirePermission('sys:agent:manage','sys:agent:approve')`，OR 语义；viewer → 403/4032）。
- 高危 `dry_run=true` **免审批**（§11.7.4「高危可预演」，预演不产生副作用、不消耗审批与幂等键）。

### 10.21.5 幂等与限流

- **幂等**：`claim()` 插 `(result=null)` 占坑 → 执行成功 `finish(id, result)`；业务异常 `release(id)` 删占坑，同键可安全重试。已有 result 且同 hash → `replay()` 原样回存好的信封，summary 前缀「【幂等重放】」+ `data.idempotent_replay=true`（模型据此停止重试）；不同 hash → 409/4036。
- **限流**：Redis 固定窗口 `INCR lf:agent:rl:{tenant}:{client}:{minuteBucket}` + `pexpire`（窗口剩余 +5s），阈值 `resolveRpm(rollout)` 脏值回退 60、夹在 [1,600]；超限抛 429。Redis 不可用/未启动时退回**进程内 Map 窗口**（>5000 键清空），服务不因此中断。`GET /agent/v1/whoami` 里回 `rate_limit`（当前计数/阈值/剩余），模型可自查。
- ⚠️ **踩过的坑**：ioredis 配 `enableOfflineQueue:false` 时，进程启动后第一条 INCR 会在连接建立前直接失败 → 静默退回本地窗口，表现为「count 恒为 0、Redis 里没有 key」。改成默认离线队列 + `connectTimeout: 2000`，并把读取统一走 `currentCount()`（Redis 读失败才标 broken 并转本地）。`redisConnection()` 已从 `app.module.ts` 抽到 `common/config.ts` 供两处复用。

### 10.21.6 写执行器（库存 / 模板 / 打印）

- **库存（`InventoryService.adjustStock/transferStock`）**：FIFO 顺序 = `expires_at ASC → produced_at ASC → id ASC`（PG 默认 ASC NULLS LAST，不过期批次自然排最后）；出库不足**整笔拒绝**并在错误里给缺口数量；事务内 `pessimistic_write` 锁批次行复核余量，防并发把库存打成负数；入库无 `batch_no` 时生成 `ADJ-<时间戳>` 新批次；调拨把**同批次号带到目标仓**（目标仓没有就新建行，复制 producedAt/expiresAt/unitCostCents）→ 验收 M.17 实测总量守恒 320、目标仓批次行 1→2。
- **模板（护栏 8）**：Agent 给的 `content` 必过 `validateAiTemplate()`，非对象 → 400；未知元素类型 → **丢弃 + warning「N 个非法元素已丢弃」**（M.13 落库只剩 1 个元素）；`templates.update` 走版本链 `currentVersion+1`（M.16 → v2）。⚠️ `TemplateService.update` 用 `{...t, ...dto}` save，`name: undefined` 会污染返回对象，所以摘要里的名字取**定位到的 `tpl.name`**（DB 值未被破坏）。
- **打印（D7）**：`print.submit_job` 必须 ① `feature_flags['agent.print.submit']=true` ② 有效 `approval_id` ③ `copies×rows ≤ 500`（`batchOverLimit`，超限 400）；走 PrintService 正常队列 → 复用 P3 `print_labels` 配额；任务 `created_by = onBehalfOf`（M.18b 实测 = Agent 创建人用户 id），配 `print.get_status` 轮询。
- **ALS 关键点**：`/agent/v1` 是 `@Public()`，`TenantContextInterceptor` 只会给一个 `tenantId=0/userId=0` 的空上下文，所以领域服务一律包在 `inAgentTenant(ctx, fn)` 里 —— 它 `tenantStorage.run({tenantId, userId: onBehalfOf, roles:[], modules:[], permissions:[], plan:null, features:{}, dataScopes:null, dataSourceKey:'default'}, fn)`；**`onBehalfOf` 为空（客户端没有创建人）时写操作直接拒绝**，宁可不做也不做无主写。

### 10.21.7 apps/mcp-server：Streamable HTTP + resources / prompts（§11.7.1 / §11.7.5 / D9）

- 抽出共享装配层 `src/server.ts`（`createLabelFlowServer(api)` 注册 ListTools/CallTool + ListResources/ReadResource + ListPrompts/GetPrompt），stdio 入口 `src/index.ts` 改为复用同一工厂（行为与日志不变，验收 L.14 仍绿）。
- 新增 `src/http.ts`：SDK `StreamableHTTPServerTransport` + Node 原生 `http`（零新依赖），端点 `POST/GET/DELETE /mcp` + `GET /health`；**每个会话绑一个 `Authorization: Bearer lfagent_...`**（whoami 401 直接拒建会话），`Mcp-Session-Id` 路由到 session map，默认端口 3300 —— 这就是「SaaS 客户接入自有 Agent」的多租户形态：一 token 一会话，权限完全由 token 的 scope 决定。
- `src/resources.ts` 暴露 `labelflow://templates/{id}`、`labelflow://inventory/stock/{ref}`（转调 `GET /agent/v1/resources/:kind/:id`，与工具链同一套 scope 检查）；`src/prompts.ts` 给出 D8 要求的 3 个开箱即用场景 `inventory.health_check` / `bom.daily_kit_report` / `print.label_from_description`。
- `CallTool` 对 `need_approval` / `idempotent_replay` **不判为错误**，把 summary 原样转文本给模型 —— 模型看到的就是「已建审批单 #13，5 分钟内带 approval_id 重试」。
- 自检：`npm run selftest`（stdio，原三条断言）+ `npm run selftest:http`（`StreamableHTTPClientTransport` 拉起 `dist/http.js`，断言 tools≥10、含 query_stock/submit_job、三个 prompt 名、resources/list 不报错 → `SELFTEST HTTP OK`）。验收 M.22 在 `dist/http.js` + `selftest:http` 脚本存在时自动跑，否则跳过（与 L.14 同策略）。
- 启动方式只有 `npm run start:http` / `node dist/http.js`（**没有** `npm start -- http` 这种 argv 分派，避免动 stdio 入口的无参行为）。

**MCP SDK 1.32.2 的坑（踩过的，别再踩）**

- `transport.onclose/onerror` 必须在 `server.connect(transport)` **之前**赋值：`Protocol.connect` 会链式包裹旧 handler，事后赋值会把 SDK 自己的钩子覆盖掉。
- `transport.close()` 只触发 `onclose`，**不触发** `onsessionclosed`（后者只在 DELETE 路径里调）—— 空闲 sweeper 和 SIGTERM 清理必须挂 `onclose`，否则会话表静默泄漏。
- `client.close()` 不发 DELETE；显式结束会话要用 `transport.terminateSession()`，且必须在 `close()` **之前**调用（它复用 `_abortController.signal`，close 后 signal 已 abort，DELETE 发不出去）。
- `transport.sessionId` 构造后是 undefined，只有走到 initialize 分支才赋值；会话表靠 `onsessioninitialized`（写响应头之前同步回调）登记。同一对 Server+Transport **不能复用**：对已初始化会话再 initialize 返回 400 "Server already initialized"。
- 每会话只允许一条 GET SSE 流，第二条 → **409**；SDK 客户端 `connect()` 已经占住它，所以手工 GET 探针必然 409，断言要写 200|409。
- POST 的校验顺序是 Accept(须同时含 json 与 event-stream → 406) → Content-Type(→415) → 读 body(→400 -32700) → schema(→400) → `_closed`(→404) → **才**判 initialize / 校会话。「畸形 JSON + 错误会话号」是 400 不是 404。每次 GET/DELETE/POST 都校 `MCP-Protocol-Version`，裸 curl 探针要显式带 `MCP-Protocol-Version: 2025-03-26`。
- 预解析 body 必须**读到流结束**再 `handleRequest(req,res,parsedBody)`（内部按转换后的 Web Request 用 WeakMap 关联），body 半态会挂。
- `inspector --cli` 0.14.2 的 `createTransport` 只认 `stdio|sse`，URL 一律按旧版 SSE 处理，**连不上 `/mcp`**；HTTP 要么用 GUI 选 Streamable HTTP，要么跑 `selftest:http`。
- 接口层坑：后端把 `need_approval / approval_id / idempotent_replay` 放在 **`ToolResult.data` 那一层**（controller 判 202 也是 `result.data.need_approval`），外层信封只有 `{code,message,data:ToolResult}`。只查 `env.data.need_approval` → 提示永远不触发。`readResource` 的 `contents[]` 是 `{text}|{blob}` 联合，TS 不收窄。

**这层的三个取舍（要改前先读）**

- `ListResources` 每次现调 `templates.search` + `inventory.query_stock`（各 20 条）**且无缓存** → 计入后端计量/审计/限流；已按会话 scope 做门禁（本会话没有该工具就不调，避免注定 403 的调用）。嫌贵可改 TTL 缓存或只回资源模板。
- 会话与 token 的绑定强度：initialize 之后的请求**允许不带** `Authorization`（会话号即凭据），带了才比对、不一致 401。改成「每请求必带」更严，但部分客户端只在 initialize 发 auth。
- 默认值是拍的：`SESSION_IDLE_MS=1800000`（30min 空闲回收）、`MAX_BODY_BYTES=1048576`。HTTP 模式**不使用** `AGENT_TOKEN` env（每会话自带 token），只共用 `AGENT_API_BASE`，多后端要另开口子。

### 10.21.8 P5 明确没做（别当成已完成）

- ~~**审批的前端页面**：后端 `/agents/approvals` 三件套已就绪，`apps/console` 还没有「Agent 待确认」列表/确认按钮~~
  → **2026-11-05 P5.5 已闭合**，见 §10.23.6（菜单目录 + `Agents.vue` / `AgentApprovals.vue` / `ArgsPreview.vue`）。
- **未注册的工具**：§11.7.4 提到的 `print.estimate` / `print.wait_for_job` / `print.cancel_job`、`ai.*`、`alerts.*` **目录里根本没有条目**（调用 → 404「未知工具」，不是 400 占位）—— alert 域无数据表、ai 域要图片入参与计费联动，都留给后续阶段。dispatch 第 3 步的 `implemented` 分支目前不会命中，是留给以后「先注册后实现」的护栏。
- 审批过期靠**读时判定**，没有定时任务批量回写 `expired`；`tool_idempotency` 没有 TTL 清理任务（长跑会一直攒行）。
- 限流只有 **Agent 维度**（tenant+client+分钟），无 per-tool / per-token 细分，也没有下发 `X-RateLimit-*` 响应头（detail 里有 `retry_after`）。
- 幂等只保证「同 key 同参数最多一次副作用」，**不保证跨进程崩溃窗口的 exactly-once**（占坑行残留需同键重试或人工清理）；
  护栏 7 的**字段脱敏仍未做**；RLS 数据域 → P6.1 兜底已就位（§10.22），但**主链路还没切到 `labelflow_app` 角色**，切换条件见 §10.22.4。
- D10 `external_mcp_servers`（调第三方 MCP）继续不实现。

### 10.21.9 验证（全部实跑 2026-11-05）

- `npx tsc --noEmit` / `npx tsc -p tsconfig.json` **0 error**；`npm run lint` **0 error / 11 warning**（warning 全是 P0~P3 存量，新增文件 0 条）。
- `npm test` **180/0**（原 160 → P5 +20：`approval.calc.test.ts` 14 条 = 指纹剔除 approval_id、五种状态判定、hash 篡改、5 分钟窗口与脏日期、consumed 优先于到期、isStale、compactPreview 折叠、isDryRun 严格布尔；`rate.calc.test.ts` 6 条 = key 分桶与租户/client 隔离、TTL 余量、resolveRpm 脏值与上下限、放行/拦截边界、批量 500 与自定义上限）。
- `T_CODE=p5xi T2_CODE=p5xj bash backend/scripts/p0-acceptance.sh` → **通过 146 / 失败 0**（原 115 → M 段 +31），M 段实测：
  缺幂等键 400（库存 60 未动）→ dry_run 预演 200 零副作用 → 无 approval **202** + 单 pending + 库存 60 未动 → 未确认重试 403/4034 → 租户 pending 列表 + viewer 403/4032 → 确认 approved（5 分钟窗口）→ 重试真实出库 **60→50** + 单置 consumed → 复用旧单 403/4034 → 批准后偷改 delta=-999 **403/4034**（库存仍 50）→ 驳回 + 重试被拒 → 模板清洗（未知元素丢弃、落库 1 元素）→ 同键重放（模板仍 1 张）→ 同键换参 409/4036 → 脏 content 400 → update 到 v2 → 调拨总量守恒 320 / 目标仓批次 2 → D7 关闭 403/4035、开启 + 审批出任务（2 张、`created_by`=Agent 归属人）→ `print.get_status` success 2/2 → rpm=1 首呼 200 后 5 呼全 429/4037（`retry_after=33s`、Redis key `lf:agent:rl:<租户>:<client>:<桶>` 实存）→ 计量 26→27→27（放行才计）→ 解除阈值后恢复放行 → `actor_type='agent'` 审计 42 条 / **14 种状态** / `on_behalf_of` 全非空 → Agent 自查 5 张审批单。
- 库里最终留痕（租户 114）：`agent_approvals` = consumed 3 / approved 1 / rejected 1，`tool_idempotency` 6 行，`agent_calls` 本月 28，M-BOX-GIFT 上海仓 50。
- ⚠️ 重跑注意：M 段每次都要**新租户码**（A.1 唯一约束）；限流项刻意新建独立 client（桶键含 clientId）才拿得到干净的一分钟窗口；`agent.print.submit` / `agent.rate_limit` 两个 flag 在 M 段结尾被复原（D7 回 false、rollout 清空）。

## 10.22 P6.1 RLS 兜底（2026-11-05 落地）

### 10.22.1 先说边界：这条防线今天还**没**套在主链路上

多租户隔离目前是**应用层**的：`where tenant_id = ?` + 订阅门禁（`ModuleGuard`）+ 权限点（`PermissionGuard`）。
RLS 是**第二道防线**——防的是「某人写 SQL 忘了加 where」。它今天只对 `labelflow_app` 角色生效，原因：

- PostgreSQL 里 **owner 与 superuser 默认绕过 RLS**（除非 `ALTER TABLE ... FORCE ROW LEVEL SECURITY`），
  而 dev/主链路用的 `DB_USER=labelflow` 既是库 owner 又是超级用户 → 给它建策略等于没建。
- 所以 §10.22.2 的策略一律 `TO labelflow_app`（精确绑角色），`p6-rls-smoke.sh` 也**必须用该角色的 DSN 连库**才有意义。
- 结论与承诺：**不要在文档或 PR 里写「已启用 RLS 隔离」**。写的是「RLS 兜底已就位，切换条件是 X」（X 见 §10.22.4）。

### 10.22.2 DDL：`backend/scripts/saas_p6_rls.sql`（可重复执行，已应用到沙盒库）

- **两个角色**：`labelflow_app`（`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`，租户业务连接）、
  `labelflow_platform`（`BYPASSRLS`，平台跨租户运维/统计连接）。口令与角色同名，仅 dev 用。
- **授权**：所有带 `tenant_id` 的表 **+ `bom_items`**（家生子，见下）给两角色 CRUD；
  元数据 `tenants / modules / plans / plan_modules / permissions / role_permissions` 两角色**只有 SELECT**；
  `platform_users / platform_audit_logs` **只给** `labelflow_platform`（`labelflow_app` 连表都读不到，冒烟 N.19 实测）。
  授权循环用 `to_regclass()` 判存，**不要**用 `::regclass`——表不存在时后者直接抛错。
- **策略**：`AS PERMISSIVE FOR ALL TO labelflow_app` +
  `USING / WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)`。
  `nullif(...,'')` 是 **fail-closed** 的写法：没设 GUC → `current_setting` 返回空串 → `::bigint` 得 NULL → 等式恒假 → **0 行**，
  而不是「条件被跳过、退回全表」。
- **`bom_items` 没有 `tenant_id`**，靠父表钉范围：`EXISTS (SELECT 1 FROM boms b WHERE b.id = bom_items.bom_id AND b.tenant_id = <GUC>)`。
  子表策略会递归校验父表策略，所以 join 也拿不到别家的行（冒烟 N.12）。
- **覆盖度自检写进 DDL**：脚本末尾 DO 块扫「有 `tenant_id` 却没 `tenant_isolation` 策略」的表，命中就 `RAISE EXCEPTION`。
  以后加新表忘了配策略，**建库阶段就炸**，而不是留一个静默的越权口子。当前 39 = 38 张带 `tenant_id` 的表 + `bom_items`。

### 10.22.3 冒烟：`backend/scripts/p6-rls-smoke.sh`（22 项）

用 `labelflow_app` / `labelflow_platform` 的 DSN 直连（不是 owner），断言：覆盖度与 `relrowsecurity`、角色属性、
不带 GUC 读不到任何行、带 GUC 行数=owner 视角、漏写 `tenant_id` 条件仍只见本家、JOIN 不跨家、
`bom_items` 父表策略、`WITH CHECK` 拒插别家 `tenant_id`、拒插 NULL `tenant_id`、合法插入→自查→自删、
`platform_users` 无授权、`tenants` 只读、无 DDL 权限、平台角色跨租户可见全量。
**2026-11-05 实跑：22 通过 / 0 失败 / 0 跳过。**

- 唯一写入是一条 `materials` 探针行（`code = RLS-SMOKE-<时间戳>`），跑完即删，不污染别的验收。
- 靶租户挑选：优先「既有模板、又有库存批次」的租户，否则 N.10（本租户批次可见性）会因数据稀疏 SKIP
  ——默认租户 1 有 28 张模板但 0 个批次，就会踩到这个 SKIP。
- helper 命名口径：`own()` owner 视角、`appq()` 带 GUC 只读、`appw()` 带 GUC **保留错误原文**（断言「被拒绝」类必须用它，
  用不带 GUC 的连接测「插入被 WITH CHECK 拒绝」是假命题——它会被 fail-closed 先拦掉，报的是另一个错）。

### 10.22.4 代码接入点与「什么时候真的切」

`backend/src/common/tenant-data-source.manager.ts`：

- `withTenantScope(tenantId, fn)` → `{ result, rlsActive }`。**固定 QueryRunner + `startTransaction`**，
  事务里 `select set_config('app.tenant_id', $1, true)`——第三参必须 `true`（**事务级** GUC）；
  连接池场景下 session 级 `set_local=false` 会把 GUC 留给下一个借到同一物理连接的请求，等于串租户。
- RLS DataSource **懒建**（`entities: []`，只跑原生 query，池 `DB_RLS_POOL` 默认 5）。`tenantId` 为 0/空直接抛，不给「GUC 没设上但代码以为设上了」的机会。
- 连不上 RLS 角色 → **warn 一次**并降级为主库事务，`rlsActive=false` 一路带到响应体和验收断言里；
  宁可明说「这次只有应用层隔离」，也不假装已隔离。`get rlsEnabled()` 的判据就是 `!!process.env.DB_RLS_USER`。
- `registerDedicated(key, options)` / `unregisterDedicated` / `dedicatedKeys()`（D2 独立库租户的注册表已就位，
  `get ctx.data` 未注册时抛 `ServiceUnavailableException`，不会静默回落到共享库）——**P6.2 尚未产品化**，见 §10.23.7。

**真正切主链路需要同时满足**（缺一别切）：① 请求级 ALS/中间件里为每个租户作用域打事务级 GUC（40+ 处原生 `query()` 要逐个核）；
② DDL/迁移走独立 owner 通道（`synchronize` 与 `saas_p0*.sql` 不能用 `labelflow_app`）；
③ 跨租户运营查询全部改走 `labelflow_platform`。当前只做了「谁需要强隔离谁先用」：租户导出与硬删（§10.23）。

**带 RLS 角色的启动命令**（少 `DB_RLS_USER` 就是降级路径，`rlsActive` 会返回 false）：

```bash
cd backend && setsid env PORT=3200 DB_HOST=127.0.0.1 DB_PORT=5433 \
  DB_USER=labelflow DB_PASS=labelflow DB_NAME=labelflow \
  DB_RLS_USER=labelflow_app DB_RLS_PASSWORD=labelflow_app \
  REDIS_PORT=6380 JWT_SECRET=devsecret-devsecret-devsecret-devsecret-devsecret \
  SQL_SECRET_KEY=<60hex> node -r reflect-metadata dist/src/main.js </dev/null >/tmp/api.log 2>&1 &
```

## 10.23 P6.3 租户数据导出与硬删（D12）+ P5.5 审批前端入口（2026-11-05 落地）

### 10.23.1 五条平台路由（`@Controller('platform')` + `PlatformJwtGuard`，scope=platform）

| 路由 | 作用 |
| --- | --- |
| `GET platform/tenants/retention` | D12 保留期看板：已退订租户 `daysLeft` / `due` / `hardDeleteAt` / `warn`（进入 7 天内提醒） |
| `POST platform/tenants/:id/export` | 全量导出 → gzip JSON 落 `tenant_backups(kind='export')`，返回 `{backupId,sizeBytes,tableCount,rowCount,truncated,rlsActive}` |
| `GET platform/tenants/:id/exports` | 该租户的导出件 + 租户自己手工/定时备份的清单 |
| `GET platform/tenants/:id/exports/:exportId/download` | 下载 gzip 原文件（**必须 `@Res()` 不带 passthrough**，见 §10.23.4） |
| `POST platform/tenants/:id/purge` | 硬删该租户全部业务数据（不可逆），闸门见 §10.23.5 |

实现：`tenant-data.service.ts`（IO）+ `tenant-data.calc.ts`（纯函数，单测覆盖）。
新增前置 DDL：**必须先跑 `backend/scripts/saas_p6_tenant_data.sql`**，否则导出直接 500（`tenant_backups_kind_check` 23514）——
`kind` 白名单从 `manual/scheduled` 放宽为 `manual/scheduled/export/purge-pre`，并补 `ix_tenant_backups_tid_kind`。

### 10.23.2 表清单**不再手写**，而且**不能用 `information_schema`**（本轮最贵的一条）

`plan()` 取的是结构元数据，进程内缓存一次，口径：
① 所有带 `tenant_id` 的 public 表；② 没有 `tenant_id`、但有**单列外键**指向「带 `tenant_id` 的表」的子表（家生子），
靠 `join parent on parent.id = child.fk where parent.tenant_id = $1` 钉范围。当前库里家生子只有 `bom_items`，
真实清单 = **38 张带 `tenant_id` + 1 张家生子（+ `tenants` 本身）= 导出包 40 张表**。

两个已被实测打过的点：

- **`information_schema` 系列视图按「当前角色的权限」过滤**。`withTenantScope` 用 `labelflow_app` 连库时，
  `information_schema.table_constraints / key_column_usage / constraint_column_usage` 对 `bom_items` 的外键**返回 0 行**
  （owner 连接返回 2 行）→ 家生子被**静默漏掉**：导出少一张表、硬删留下孤儿行且不报错。
  第一版就是这么写的，是验收 N.8b 加了「导出包必须含 `bom_items` 那条真实行」的断言才暴露出来
  （靶租户原来没有 BOM 数据，所以此前一路绿灯）。改成 `pg_catalog`（`pg_class`/`pg_attribute`/`pg_constraint`）后，
  只要对该表有任意权限就完整可见。结构元数据本就该走平台侧主连接，不该带 `app.tenant_id` GUC，也已一并改掉。
- **`BackupService` 那份手写 16 张表**的清单，SaaS/P3/P4/P5 的新表一个都没进去——老备份件其实一直在漏数据，
  只是没人核对过。新代码不再走这条路，加表不用改代码。

副作用（是想要的）：如果某张表忘了授权给运行角色，数据读取会**直接 permission denied 炸出来**，而不是被静默跳过。
复合外键（多列 FK）的家生子目前**跳过并 warn**，只支持单列 FK——以后出现孙表（A→B→`tenant_id`）需要扩 `plan()`。

### 10.23.3 导出

- 逐表 `select * ... limit EXPORT_ROW_CAP + 1`（`EXPORT_ROW_CAP = 50_000`），超了截断并把表名记进 `truncated[]`，**不静默截断**。
- 落库前 `zlib.gzipSync`，`tenant_backups.data` 存 gzip `bytea`；审计 `platform.tenant.export`（带 `rlsActive`、行数、大小）。
- `exportTenantInternal()` 给硬删复用（同一份取数逻辑，保证「快照」和「导出件」内容口径一致）。

### 10.23.4 踩过的坑：下载路由把**进程**打挂了

`ResponseInterceptor` 会把返回值包成信封**再发一次**。二进制下载若用 `@Res({ passthrough: true })` 自己 `res.send(buffer)`，
Nest 随后仍会写 JSON → `ERR_HTTP_HEADERS_SENT: Cannot set headers after they are sent`，
而且它不是 500，是**未捕获异常直接崩进程**。正确写法：`@Res() res: Response`（**不带** passthrough），
Nest 就不接管响应了——代价是这条路不再走拦截器，`Content-Type` / `Content-Disposition` 要自己设。
`Buffer` 传参还有 TS2769 重载坑，按 `Buffer.isBuffer` / `instanceof Uint8Array` / base64 三分支窄化。

### 10.23.5 硬删的三道闸门（`assertPurgeAllowed`）

1. **`confirm` 必须逐字等于租户 `code`**（不是 id，防止对着列表页手滑点错行）。
2. **D12 保留期**：`hardDeleteAt = canceled_at + RETENTION_DAYS(90)`，未到 `due` 一律 400，除非 `force=true`。
3. **未退订租户必须显式 `force=true`**（`canceled_at is null` 时 `due` 永假）——给运营留逃生口，但必须是「明知未退订还强删」。

删的动作本身：

- **同一个事务里**先落 `purge-pre` 快照（复用 §10.23.2 的取数），再逐表删；事务保证「快照」与「删」不半途中断。
- `deleteOrder()` 拓扑方向 = **子表先删**（Kahn，入度记「还有多少张表必须先于它删」）。
  ⚠️ 这里最初写反成父表先删，直接撞外键；单测 `先删子表再删父表，顺序确定` 就是为了钉住方向。
  有环时保留原序并把表名单列进 `cyclic[]` 回报，不静默丢表。
- `NEVER_TOUCHED`：`tenants / modules / plans / plan_modules / permissions / role_permissions / platform_*` 永远不碰；
  `KEEP_ON_PURGE = ['tenant_backups']` —— **快照表本身不被删**，删完还留着证据（验收 N.18 断言靶租户恰好 2 条：export + purge-pre）。
- 每张表删完**复查 `remaining`**，非空就整体回滚（`ON DELETE CASCADE` 帮不上家生子那种没有 FK 到 tenants 的情况）。
- 审计 `platform.tenant.purge`（逐表明细 + `rlsActive`）。

### 10.23.6 P5.5：把 Agent 审批接进产品（上一版 §10.21.8 的第一条已闭合）

- `backend/src/saas/menu.catalog.ts` 新增「Agent 接入」分组两条：`/agents`（`sys:agent:manage`）、`/agent-approvals`（`sys:agent:approve`）。
  **菜单目录是后端下发的**，光加前端路由不算「可达」——这条以前漏过两次。
- `apps/console` 新增 `views/Agents.vue`（客户端 + token 签发/吊销）、`views/AgentApprovals.vue`（待确认列表 + 确认/驳回）、
  `components/ArgsPreview.vue`（递归渲染 `compactPreview` 的三种折叠形态：`__array`/`sample`、`__json`/`keys`、`…（共 N 字符）`，深度封顶 8）。
  `src/api/index.ts` 补 Agent/Token/Approval 封装与类型，`src/router/index.ts` 补两条路由（`meta.permission` 对齐后端权限点）。
  `npm run build` exit 0、`npm run lint` 0 error（复核过）。
- `backend/src/agent/approval.service.ts` 的 `listForTenant` 批量补 `agentClientName`（一条 `in (...)` 拿名字，不 N+1）。
  以前这列恒空，前端「谁要做什么」等于瞎判。验收 N.22 断言「列表里每条都带非空 agentClientName」。
- 已知限制（**没改**，记在这）：`meta.permission` 只支持单个权限串，不支持数组 OR。
  当前角色组合不会误锁（`tenant_admin` 同时有 `sys:agent:manage` 与 `sys:agent:approve`），
  但若以后给「只批不看」的角色配路由，需要先把守卫改成支持多权限任一命中。

### 10.23.7 验证（全部实跑 2026-11-05）

- `npm test` **189/0**（180 → +9：`tenant-data.calc.test.ts`，含保留期边界、三道闸门顺序、`deleteOrder` 方向与环、截断、表名白名单）。
- `npx tsc --noEmit` / `npx tsc -p tsconfig.json` **0 error**；`npm run lint` **0 error / 11 warning**（全是 P0~P3 存量）。
- `bash backend/scripts/p6-rls-smoke.sh` → **22 / 0 / 0**。
- `DB_RLS_USER=labelflow_app T_CODE=p6s1..p6s2 bash backend/scripts/p0-acceptance.sh` → **通过 174 / 失败 0**，连跑 2 轮（原 146 → N 段 +28）。
  N 段实测：RLS 覆盖 39 张表 → kind CHECK 已放宽 → 建靶租户写模板 + **造家生子数据（boms/bom_items）** →
  导出 `rlsActive=true` / **40 张表 / 27 行** → 落 `kind=export` → 下载解包后 **包内只有靶租户、含刚写的模板、含那条 `bom_items`、0 行别家** →
  平台审计 → 确认串不对 400 → 未退订无 force 400 → 刚退订仍在保留期 400 → `canceled_at` 推 91 天后看板 `due=true` →
  confirm 即硬删（明细 38 张表 / 27 行、`remaining=[]`、靶租户 `templates+users` 清零、
  **按 id 复查那条 `bom_items` 已不存在**、`boms+materials` 清零）→
  **旁证租户（M 段 PRO 租户）模板数删前删后一致** → 自动落 `purge-pre` 且快照表不被删（靶租户恰好 2 条：export + purge-pre）→
  平台审计 → 未退订 + force 放行 → 菜单两条 → 审批 5 条全带 `agentClientName`。靶租户与快照在段尾自清理。
- **降级路径单独实测**：另起一个**不带** `DB_RLS_USER` 的实例（:3210）跑导出 → `rlsActive=false` + 一次性 WARN，
  导出仍成功。也就是说「没配 RLS 角色」时功能可用、但不假装隔离。
  ⚠️ 这条实测还顺手暴露了 §10.23.2 的 bug：owner 连接下 `tableCount=40`、RLS 连接下只有 39，差的正是家生子。
- ⚠️ 重跑注意：N 段的 `ps "insert into materials(...)"` 用的是 owner 连接（`$PSQL`，`labelflow`），
  不依赖 `labelflow_app` 的写权限；靶租户 code 固定是 `${T_CODE}p6` / `${T_CODE}p7`，换 `T_CODE` 就自动不撞唯一约束。

### 10.23.8 P6 明确没做（别当成已完成）

- ~~**P6.4 白标（D6）**~~ → **2026-11-05 已落地**，见 §10.24（`saas_p6_branding.sql` + `backend/src/saas/branding/` + `apps/console` 品牌页）。
- ~~**P6.2 独立库租户（D2）**~~ → **2026-11-06 阶段 A 已落地**，见 §10.25：`tenants.data_source_key` DDL、数据源注册/诊断/注销、平台侧导出/硬删按库路由、provision 对 dedicated 明确 400；
  **仍缺**：开通编排（建库 → 跑 DDL → 迁移数据 → 切换 data_source_key）、业务读写接管（仓库仍绑默认 DataSource）、退订后库回收。
- ~~**P6.5 Prompts 库产品化**~~ → **2026-11-06 已落地**，见 §10.26：系统默认在代码 + 租户覆盖表、`/agent-prompts` CRUD/预览、MCP `prompts/list|get` 改由后端动态下发（60s TTL + 静态兜底）、Console「Prompt 库」页。
- ~~**platform 前端**：保留期看板、导出按钮、下载链接、purge 二次确认~~ → **2026-11-05 已落地**，见 §10.24.7（`apps/platform/src/views/TenantData.vue`）。
- 家生子目前只处理「单层 FK 指向带 `tenant_id` 的表」；若以后出现孙表（A→B→`tenant_id`）需要扩 `plan()` 的递归。

## 10.24 P6.4 白标（D6）+ P6.3 平台前端（2026-11-05 落地）

一句话：**白标改的是「登录页对外的长相 + 用哪个域名进哪个租户」，不碰任何鉴权与数据范围。**
把它当成主题注入 + 域名路由两件事来做，就不会写歪。

### 10.24.1 三条闸门（这是全部安全性的来源，改代码前先读）

| # | 闸门 | 落点 | 不这样做会怎样 |
|---|------|------|----------------|
| ① | **只有 `verified` 的域名参与 Host→租户解析** | `branding.calc.resolveTenantByHost()` 里 `r.verified &&` 那半句 | `tenant_domains.domain` 是**唯一约束**，登记即抢注：任何人 POST 一个 `label.客户.com` 就能把客户域名指到自己租户 |
| ② | **Host 推出的租户与显式 `tenantCode` 不一致 → 401** | `auth.service.login()` 第二道判断 | 客户域名下摆一个能登别家账号的登录框 = 现成钓鱼页 |
| ③ | **域名被别家占用时报「已被占用」，不带归属方任何信息** | `branding.service.addDomain()` 的 dup 分支 | 探测接口可以逐个域名问出「这家是谁 / 存不存在」 |

②的关键前提：解析结果**只**用于「显示什么品牌」和「允许省略 tenantCode」。
伪造 Host 头能得到的最多是别人的 logo 和租户名，拿不到一行数据。写文档时不许出现「域名即身份认证」这种表述。

`X-Forwarded-Host` 默认**不信任**，只有 `BRANDING_TRUST_FORWARDED_HOST=1` 才认（反代后面不设它，白标不生效——
不生效比认错租户安全）。

### 10.24.2 DDL：`backend/scripts/saas_p6_branding.sql`（幂等，已应用到沙盒库）

- 给 P0 预留的 `tenant_domains` 补 4 列：`verify_token / verified_at / is_primary / created_by`；
- CHECK `tenant_domains_domain_format`（非空 + 无空格，长度对齐 `VARCHAR(200)`）；`ix_tenant_domains_tid`；
- 新权限点 `sys:branding:manage`（挂 module `users`），只授 `admin` / `tenant_admin`；
- 两处 `RAISE EXCEPTION` 自检（补列没生效 / 权限点没落地就别让它悄悄过）+ NOTICE 汇总。
- ⚠️ 域名单租户上限 `MAX_DOMAINS_PER_TENANT=10` 写在代码里（`branding.calc.ts`），不在 DDL 里——改上限改常量，别找约束。

### 10.24.3 品牌值的清洗口径：白名单键 + 两类失败要分开

`sanitizeBranding()`（纯函数，单测 `branding.calc.test.ts` 13 条覆盖）：

- **只有 7 个键能进 `tenants.branding`**：`appName / logoUrl / faviconUrl / primaryColor / backgroundColor / loginNotice / customCssVars`。
- 白名单**外的键 → `dropped[]`**，请求照样 200。前端必须把 `dropped` 显示出来（`Branding.vue` 顶部黄条），静默吞会让用户以为改了。
- 白名单**内但值不合法 → 400 整笔退回**：颜色必须 `#RGB/#RRGGBB`（落库转小写）；`logoUrl/faviconUrl` 必须 `https://` 绝对地址（`data:`、`javascript:`、base64 一律拒）；
  `customCssVars` 只接受 `--小写变量名: 值`，值里出现 `}` `"` `\` `url(` 直接 400。**没有「清洗后收下」这条路。**
- `appName / loginNotice` 走纯文本：去控制字符和 `<>`、限长 200，前端**只用文本节点渲染**（`{{ }}`，不许 `v-html`）。
- 整包序列化后 >8 KiB 报错——防住「把 logo 塞成 base64」把 `tenants` 表撑爆。

前端主题注入在 `apps/console/src/composables/branding.ts`：覆盖 `--el-color-primary` 时必须连 EP 的派生色
（`light-3/5/7/8/9`、`dark-2`）一起按比例算，否则 hover/禁用态还是老颜色，看着像换色失败；
外壳自己的色走 `--lf-brand` / `--lf-page-bg` / `--lf-sidebar-bg`（`styles/main.css` 里出厂值写在 fallback 上）。
`clearBranding()` 负责「解析失败 / 没命中域名 → 回到出厂外观」，别留半套颜色。

### 10.24.4 域名生命周期与 dev 逃生口

```
addDomain → verified=false + verify_token（唯一约束先占名）
   ↓ 客户在 DNS 放 TXT：_labelflow-verify.<domain> = labelflow-verify=<token>
verifyDomain → 查 TXT 比对 → verified=true + verify_token 置 null
   ↓
参与解析 / 可设 is_primary / 公开解析接口带出品牌
   ↓
removeDomain → 删行 + 立刻 invalidateHostCache(domain)
```

- TXT 比对 `matchVerifyToken()` 要同时比**每个 char-string 片段**与**拼起来的整串**（RFC 1035 允许一条 TXT 分段，
  只比一种会误判失败）；也接受只填 token 本身或 `record=token` 两种偷懒写法。
- 已校验的域名**不再回显 token**（`listDomains` 里 `verified ? null : verifyToken`）。
- `BRANDING_DEV_VERIFY=1` 一键 verified 的逃生口**必须同时满足 `NODE_ENV !== 'production'`**，否则生产上谁都能把别人域名点成已校验。
  这条判断写在 service 里而不是控制器，别挪。
- 解析有 30s TTL 缓存（`BRANDING_CACHE_MS`），**增删改域名都要显式失效**，否则验收会出现「删了还能解析出来」这种假通过。
- ⚠️ **登记入参不吃 `normalizeHost` 的便利**：`normalizeHost` 是给请求头用的，会剥端口和路径；
  直接拿来洗用户输入会把 `acme.com:3200/path` 静默变成 `acme.com`。`addDomain()` 现在先拦 `/ @ 空白` 再规范化。
- ⚠️ `Repository.remove()` 之后**实体主键会变成 undefined**：`removeDomain` 返回 `Number(row.id)` 得 NaN，
  审计 `target_id` 是 bigint → PG 直接 `invalid input syntax for type bigint: "NaN"`（**实测 HTTP 500，数据倒是删干净了**）。
  删之前先把 `id`/`domain` 取成局部变量。O.41 就是钉这条的。

### 10.24.5 登录侧集成（改动面很小，但顺序要紧）

- `auth.controller.login`：`hostFromHeaders(req.headers, TRUST_FORWARDED)` → `branding.publicBrandingByHost(host)?.tenantCode` → 传给 service。
- `auth.service.login(username, password, tenantCode?, hostTenantCode?)`：`code = tenantCode ?? hostTenantCode ?? 'default'`。
  老行为一条没变——**没配自定义域名的租户，登录路径与 P6.4 之前完全一致**。
- ⚠️ 空字符串陷阱：前端如果传 `tenantCode: ''`，`?? ` 不会兜住（`''` 不是 nullish）→ 报「租户 "" 不存在」。
  `Login.vue` 的做法是命中域名时把租户码**预填成解析结果并禁用输入框**，既不留空串，也让用户看得见自己进的是哪家。
- `GET /branding` 是 `@Public()`，**不 404**：没命中回 `{matched:false}`，前端 `apiPublicBranding()` 用**裸 axios**（不走 `http` 实例）
  调用并 `catch → null`。理由：它可能在老后端（没这条路由）上被登录页调用，弹 toast 或阻塞首屏都是事故。

### 10.24.6 平台工单通道（`platform-admin.controller.ts`）

| 路由 | 说明 |
|------|------|
| `GET platform/tenants/:id/domains` | 运营看这家登记了什么、哪些还没校验 |
| `POST platform/tenants/:id/domains/:domainId/verify` | **绕过 DNS 的强校验**，必须平台 token，且写 `platform.tenant.domain.verify` 审计 |

`forceVerifyByPlatform(tenantId, domainId)` 一定要**先按 domainId 取行、再核 `row.tenantId === tenantId`**：
只吃 `domainId` 的版本（上一版就是这么写的）拿别家的 id 也能点通，路径里的 `:id` 就成了摆设。O.36 专测这条。

### 10.24.7 前端入口与页面

- 菜单目录 `menu.catalog.ts` 在 `backups` 后加 `branding` 叶子：`path /branding`、`module users`、`permission sys:branding:manage`；
  `apps/console/src/router/index.ts` 必须同步加 `path: 'branding'`，否则 `menu.catalog.test.ts` 的反向断言直接红（**上一版就是这样挂的**）。
  `meta.module` 用 `users` 而不是新模块：品牌配置存在 `tenants.branding`、域名是 SaaS 侧的表，单开模块会让 BASIC 客户「有权限却没订阅」而跳 `/blocked`。
- `apps/console/src/views/Branding.vue`：左品牌表单（保存即 `previewFromMyBranding` 回显，不用刷新）+ 右域名表（登记→展示 TXT 记录名与值→校验→设主→删除）+ 解析自测输入框（吃 `?domain=`）。
- `apps/platform/src/views/TenantData.vue`（P6.3 的前端闭合）：保留期看板（`due` 整行标红、「已到保留期 · 可硬删」；`warn` 标黄「剩 N 天」）、
  导出摘要 + 导出件抽屉 + 下载、purge 二次确认（内联展示三道闸门、`trim` 后逐字校验 code、`!due || !canceledAt` 才出现 force 勾选）、
  `rlsActive` **三态徽标**（true 绿 / false 黄「降级：未走 RLS 角色」/ 未回灰，没有写死的绿色）、`truncated` 非空 → 黄警「导出件不完整」。
  ⚠️ 契约差异：`GET /tenants/:id/exports` 的 `sizeBytes`/`createdBy` 是 **BIGINT 字符串**（`"985"`），而 `POST /export` 摘要里是数字，前端类型放宽成 `number | string` 再 `Number()` 展示。
- ⚠️ **vue-tsc（Volar）在本仓库版本下会被模板里的 `//` 咬到**：`placeholder="https://x/y.png"` 这种**静态属性值里带 `//`**，
  会让生成的虚拟 TS 少一段，报的是跟真因毫无关系的 `TS2339: Property 'value' does not exist on type '{...}'`（而且会牵连同文件里别的 `v-model` 行）。
  规避：占位文案别写 `://`（本页已改成 `cdn.example.com/logo.png`），或挪到 `<script>` 里再绑定。改完 `npm run build` 立刻验。
- ⚠️ `<el-alert>` 里的品牌文案一律插值，别学 `v-html`；`el-popconfirm` 用 `v-if` 而不是 `v-permission.hide`（见 §10.23.6）。

### 10.24.8 验证（全部实跑 2026-11-05）

- `npm test` **202/0**（+13：`branding.calc.test.ts`，含「未校验域名不许解析出租户」「自由 CSS 是红线」「TXT 多段 char-string 要认」）。
- `bash backend/scripts/p0-acceptance.sh` → **通过 219 / 失败 0**（174 → O 段 +45），换 `T_CODE` 连跑 2 轮一致。
  O 段实测：出厂 Host 不命中 → 租户读写 → viewer 403/4032 → 脏值（白名单外键进 `dropped`、`<script>` 去尖括号、颜色转小写、审计）→
  自由 CSS / `data:` / `red` 三条 400 且不落库 → 登记（大小写混写规范化）→ **未校验不参与解析、不许设主** → dev 逃生口 verified →
  校验后解析命中（含 `cssVars` 形状）→ **只给 Host 头就能登进对应租户（解 JWT 核 tenantId）**、A 家域名登 B 家 401 →
  7 种非法域名全 400 → 抢注被拒不泄露归属 → 补登到 10 条上限、第 11 条 400 → 设主唯一 → 平台列域名 / 越权 400 / 强校验 + 平台审计 + 解析生效 →
  删除后**同秒解析即失配**、增删审计 → 菜单两条（tenant_admin 有 / viewer 无）。域名在段尾自清理。
- `bash backend/scripts/p6-rls-smoke.sh` **22/0/0**；`npx tsc -p tsconfig.json` 0 error；
  `apps/console` 与 `apps/platform` 各自 `npm run build`（含 `vue-tsc -b`）+ `npm run lint` **均 0 error / 0 warning**。
- ⚠️ 白标**没有**跑真实 DNS：沙盒里 `resolveTxt` 查不到东西，TXT 那条路径只有单测 + 平台强校验通道在验。
  上线前必须拿一个真域名手工走一遍「登记 → 放 TXT → verify → 解析命中」，并把 `BRANDING_DEV_VERIFY` 明确关掉。

### 10.24.9 P6.4 没做 / 边界（别当成已完成）

- **真实 DNS 校验端到端没验过**（见上一条）。反代部署要设 `BRANDING_TRUST_FORWARDED_HOST=1`，否则解析到的是内部 Host。
- ⚠️ **主链路切到 `labelflow_app` 时，公开解析这条查询会当场静默失效**：它现在走默认（owner）连接，
  而 `tenant_domains` / `tenants` 的策略是 fail-closed。切换清单（§10.22.4）里必须把「公开解析改走 `labelflow_platform` 连接」列为一条硬性检查。
- 域名**只做解析，不做签发/回调**：没接 ACME 自动证书、没做「域名指向了但平台侧 404」的接入向导、没在 CNAME 未生效时给检测提示。
- 主题只覆盖颜色/标题/favicon/logo：**没有租户级自定义字体、自定义 CSS 文件、登录页版式模板**。要做得先扩白名单键，别再开自由 CSS 的口子。
- `logoUrl/faviconUrl` 是第三方 https 地址，页面没配 CSP——真上线白标建议同时给 `img-src` 白名单（目前只有 URL 格式校验这一层）。
- 白标**不影响订阅**：`sys:branding:manage` 是权限点，没做「按套餐收费才给白标」的 gating；要做就照 §11.10 的模块/配额口径加，而不是在 controller 里写 if。
- 一个租户多个已校验域名都会解析到同一套品牌（`is_primary` 目前只作展示与将来回调用）；主域名切换不改变解析结果。

## 10.25 P6.2 独立库租户（D2）阶段 A（2026-11-06 落地）

一句话：**这一阶段只回答「这个租户的数据在哪个库」，并把平台侧的导出/硬删/保留期切过去；
业务读写仍然只打共享库**——所以 provision 明确拒绝 `type='dedicated'`，避免做出「以为隔离了其实没隔离」的假象。

### 10.25.1 范围与边界（先读，避免按「已完成」理解）

| 能力 | 状态 | 说明 |
|------|------|------|
| `tenants.data_source_key` 标识 + 形状/唯一约束 | ✅ | `backend/scripts/saas_p6_dedicated.sql`（幂等） |
| 独立库注册 / 诊断 / 注销（平台 API） | ✅ | `POST/GET/DELETE /platform/datasources`，平台审计 `platform.datasource.*` |
| 平台侧导出 / 下载 / 硬删 / 保留期按库路由 | ✅ | `TenantDataService` 先读目录库拿 key，再钉到该库事务 |
| 未注册 key 的租户请求 | ✅ 503 | `TenantDataSourceManager.get()` 不回退共享库 |
| 开通独立库租户（建库 / 跑 DDL / 迁移 / 切换） | ❌ | provision 对 `type='dedicated'` / 带 `dataSourceKey` 一律 400（带下一步指引） |
| 业务读写接管（Repository / 事务路由） | ❌ | 仍是默认 `DataSource`；见 §10.25.8 的必做清单 |
| 退订后库回收 / 连接池配额 / DSN 轮换 | ❌ | 运维手工 |

### 10.25.2 DDL：`backend/scripts/saas_p6_dedicated.sql`

- `tenants.data_source_key VARCHAR(64)`（**只存标识，不存 DSN**）。
- `tenants_data_source_key_shape`：`shared → 空或 'default'`；`dedicated → 非空且 ≠ 'default'`。
  ⚠️ 改 routing 时必须**同时**改 `type` 和 `data_source_key`，只改一个会被 CHECK 拦下（P 段实跑踩过）。
- `tenants_data_source_key_format`：`^[a-z][a-z0-9-]{1,63}$`（与 `validateKey` 同口径）。
- `CREATE UNIQUE INDEX ux_tenants_data_source_key ... WHERE data_source_key IS NOT NULL`：
  **一个 key 只服务一个租户**。两个租户共用 key 意味着「硬删 A 会顺手删 B」，必须在库里拦死。
- 自检 DO 块：列 1 / 约束 2 / 唯一索引 1，缺一直接 `RAISE`。

### 10.25.3 注册流程：先连、再自检、最后才落注册表

`TenantDataSourceManager.registerFromUrl()` 的顺序是刻意的（`env` 启动与平台接口共用）：

1. `validateKey` + `isPostgresUrl` + `dsnTarget`（**拆不出库名就拒**）；
2. `buildDedicated()` 建池并 `initialize()`（`connectTimeoutMS=5000`，失败抛 `ServiceUnavailableException` → 503）；
3. `inspectSchema()`：用 **`pg_catalog`** 数 `public` 下的表（`information_schema` 会按角色权限静默漏表，见 §10.23.2），
   必查 `tenants/users/templates/tenant_backups/tenant_modules/audit_logs`；
4. 只有 2、3 都过了才 `dedicated.set(key, ds)`；半初始化的库会 `destroy()` 后抛错。

env 入口：`DB_DEDICATED_DSNS='{"acme":"postgres://..."}'`，单条失败只记日志（对应租户 503），不阻断进程启动。
错误会通过 `GET /platform/datasources` 的 `envErrors` 原样透出，别让运维去翻日志。

### 10.25.4 路由：目录库决定去哪个库，数据只在那个库读写

- `TenantDataService.routingKey(tenantId)` **只查共享目录库**的 `tenants.data_source_key`（空 = default）。
- 表清单缓存从「进程内一份」改成 **按 key 一份**（`planCache: Map<string, TablePlan>`）：
  独立库可能停在不同迁移版本，混用清单会导出/删除错表。
- `withTenantScope(tenantId, fn, { dataSource })` 新增「钉库」模式：
  - 返回 `mode: 'rls' | 'dedicated' | 'app-only'`；独立库**如实报 `rlsActive=false`**（隔离来自库边界，不冒充 RLS）；
  - 事务里仍然 `set_config('app.tenant_id', …, true)`，同一套 DDL 复制过去后 RLS 照样生效（纵深防御）。
- 导出摘要与快照头新增 `dataSourceKey` / `isolation`，审计明细同步带 `dataSourceKey`：
  「这包数据从哪个库导的」必须可追溯，否则合规审计说不清。
- 保留期看板的 `users/templates` 计数按租户所属库分开取；独立库连不上时标 `countsAvailable=false`，不让整块看板 500。

### 10.25.5 安全：DSN 永不落库

- 落库的只有 `data_source_key`；DSN 只在进程内存（env 或平台接口传入）。
- 接口返回值、平台审计、日志统一 `maskDsn()` → `postgres://user:***@host:port/db`。
- 注销前检查引用：仍有租户使用该 key → **400**（先迁走再注销，避免线上 503）。
- `GET /platform/datasources` 额外列 `missing`：**租户表里写着、但本进程没有连接池的 key**——
  这是「后台看不出为什么 503」的最常见现场，必须显式暴露。

### 10.25.6 两个实现细节（容易写反）

1. **独立库连接池不要挂实体**：`entities: []`、只跑带参原生 SQL。挂了实体就会随默认库一起加载元数据，
   两边迁移进度不一致时先炸的是进程启动，而不是那条本该 503 的业务请求。
2. **不要用 URL 解析后再拼连接串**：密码里带 `@` / `:` 会被转义错。`dsnTarget()` 只用于诊断展示，
   真正连接始终用原始 DSN（`new DataSource({ url })`）。

### 10.25.7 验证（全部实跑 2026-11-06）

- `npm test` **209/0**（+7：`src/saas/__tests__/dedicated.calc.test.ts`）。
- `D2_DSN=… bash backend/scripts/p0-acceptance.sh` → **通过 249 / 失败 0**（A–P 段；219 → P 段 +30）。
  P 段实测：DDL 就位 → 非平台身份 403 → key/协议/缺参 400 → **连不上 503 且不入注册表** →
  provision dedicated / 共享带 key 均 400 → 未注册 key 导出 503 → 注册（脱敏 + 审计 + 面板）→
  两库各写一条靶模板 → 导出摘要 `dataSourceKey/isolation=dedicated-db/rlsActive=false` →
  下载解包**只含独立库标记、0 条共享库标记** → 导出件落独立库（共享库 0 条）→ 清单读独立库 →
  在用中注销 400 → 面板 `tenantsUsing=1` → 唯一索引/CHECK 双拦截 → 迁走后注销 200 + 审计 + 面板消失。
- `D2_DSN` 未提供时 P.13+ 打印 `[SKIP]`，控制面校验（P.1–P.12）照常执行。
- `bash backend/scripts/p6-rls-smoke.sh` **22/0/0**；`npx tsc -p tsconfig.json` 0 error。
- 沙盒里用 `CREATE DATABASE labelflow_d2` + `pg_dump --schema-only` 克隆 schema 造的靶库；
  **绝不能把 `D2_DSN` 指向共享库本身**，否则「路由到独立库」等于没路由。

### 10.25.8 阶段 B 必做清单（不要按当前状态对外承诺「独立库已交付」）

> **2026-11-13 状态**：1–4 项代码已落地（详见 §10.27），第 5 项仍未做；1–4 项**缺真连库验收**，口径仍是「已实现、待验收」。

1. **业务读写接管** ✅ 代码已落地：Repository 代理 / 事务路由到 `tdsm.get(ctx)`（`common/tenant-routing.*`），16 个模块统一接入；拦截器读真实 key。**待验收**：独立库租户建模板 / 打库存时共享库 0 行。
2. **开通编排** ✅ 代码已落地：建库 → DDL → 搬数据 → 行数校验 → 切 `data_source_key` → 逆序回滚（状态机保证校验不过不切 key）。**待验收**：一条命令开通 + 失败可回滚。
3. **退订回收** ✅ 代码已落地：`reclaimable` 巡检 + `reclaim` 端点；物理库保留不自动删。**待验收**：硬删后巡检能列出孤儿 key。
4. **运维面** ✅ 代码已落地：per-key 池上限 / 超时 / SSL / 健康检查（DSN 轮换沿用 `register` 覆盖）。**仍缺**：独立库物理备份/PITR。
5. **备份** ❌ 仍未做：独立库的物理备份/恢复不在 `tenant_backups` 里；当前导出是逻辑 JSON gzip，不是 PITR。

## 10.26 P6.5 Prompt 库（D8）（2026-11-06 落地）

一句话：**系统提示词的权威副本在代码里，数据库只存「租户改过的 / 自己加的」；同名行 = 覆盖，删除 = 回落。**
这不是「给每个租户 seed 三行文案」——那样产品每次改提示词都会留下 N 份互不一致的存量数据。

### 10.26.1 范围与边界

| 做了 | 没做（别按「已完成」理解） |
| --- | --- |
| 3 条开箱即用系统提示词（库存巡检 / 齐套日报 / 按描述打印） | 提示词版本历史与回滚（当前覆盖只有一行，改前请自行留档） |
| 租户覆盖同名系统提示词、新增自定义、停用、删除回落 | 按角色/用户分提示词（当前是租户级一份） |
| `{{arg}}` 占位符校验 + 默认值 + 必填 + 服务端预览 | 条件分支/循环/表达式（刻意不做，见 10.26.5） |
| Console 管理页 + MCP `prompts/list|get` 动态下发 | 提示词效果统计（调用量/采纳率） |

### 10.26.2 数据模型：代码默认 + 覆盖行

- `backend/src/agent/prompt.defaults.ts`：`SYSTEM_PROMPTS`（name/title/description/arguments/content/sortOrder）。
  改文案走代码评审，所有未覆盖的租户**自动吃到最新版本**。
- `agent_prompts`：只存租户行。`UNIQUE(tenant_id, name)`，同一提示词一个租户最多一行。
- 合并视图 `mergePromptList(SYSTEM_PROMPTS, tenantRows)`：
  - 同名行覆盖系统行，**保留系统排序位**，`source=custom` + `overridden=true`；
  - 租户独有行按 `sortOrder` 追加；
  - `enabled=false` 仍出现在管理列表（否则用户没法再打开），但 Agent 侧过滤。
- 删除租户行：系统同名 → `revertedToSystem=true`；自定义 → 彻底消失。系统行本身没有删除接口。

### 10.26.3 DDL：`backend/scripts/saas_p6_prompts.sql`

- `agent_prompts`：`tenant_id / name / title / description / content / arguments(jsonb) / enabled / sort_order / created_by / updated_by / created_at / updated_at`；
- CHECK：name 形态（`^[a-z][a-z0-9_.-]{2,63}$`）、title ≥2、content 10–20000、`arguments` 必须是数组且 ≤12 项；
- `ux_agentprompt_tenant_name` 唯一索引 + `ix_agentprompt_tenant`；
- `ENABLE ROW LEVEL SECURITY` + `tenant_isolation`（`tenant_id = nullif(current_setting('app.tenant_id',true),'')::bigint`），
  同时授 `labelflow_app` / `labelflow_platform`（本文件单独跑也成立，不依赖随后再跑 `saas_p6_rls.sql`）；
- 权限点 `sys:prompt:manage`（module_code=`users`，与 `sys:*` 系列一致），只授 `admin` / `tenant_admin`
  —— 改的是 Agent 对全公司说话的模板，属于租户级运营配置，不下放 manager/viewer。

### 10.26.4 接口（`/agent-prompts`，`@RequireModule('agent')` + `@RequirePermission('sys:prompt:manage')`）

| 路由 | 说明 |
| --- | --- |
| `GET /agent-prompts` | 合并视图（含被停用的覆盖行），数组而非分页（3–20 条量级） |
| `GET /agent-prompts/:name` | 单条（编辑器回填） |
| `PUT /agent-prompts/:name` | 新建自定义 / 覆盖同名系统；`name` 走 URL |
| `DELETE /agent-prompts/:name` | 删除租户行；无行 → **404**（系统行不可删） |
| `POST /agent-prompts/:name/preview` | 用参数渲染正文，缺必填 → 400；返回 `{name,title,source,text,length}` |
| `GET /agent/v1/prompts` | Agent Token；只含 enabled，正文已合并租户覆盖（MCP 的唯一数据源） |

审计：写操作 `agent.prompt.save` / `agent.prompt.delete`（detail 带 name/enabled/overridden/参数名，不落正文，
避免把可能含业务话术的长文本复制进审计表）。

### 10.26.5 校验与渲染口径（`prompt.calc.ts`，MCP 侧 `renderRemotePrompt` 必须一致）

1. 正文里的 `{{name}}` 必须先在 `arguments` 里声明，否则 400 并点出参数名（拼错不能静默留空）。
2. 声明了但正文没用：只提示 `unusedArgs`，不拦（改正文时忘删参数很常见）。
3. 渲染优先级：**模型传值 > 参数 default > 空串**；`required` 且两者都没有 → 可读错误。
4. **只做文本替换，不做表达式/条件分支**：提示词一旦能执行逻辑，就会变成第二个模板引擎，
   还会把「参数没传」这类问题藏进分支里。条件语义用「默认值」表达。
5. 参数名 `^[a-zA-Z_][a-zA-Z0-9_]{0,31}$`，最多 12 个；正文上限 20000 字符。
6. ⚠️ 名字校验**不要先截断再套正则**：截断会把超长名字静默改成另一个合法名字，必须原样校验。

### 10.26.6 MCP 侧变化（`apps/mcp-server`）

- `client/agent-api.ts` 新增 `listPrompts()`（GET `/agent/v1/prompts`）。
- `server.ts` 的 `ListPrompts/GetPrompt` 改为「先拿服务端清单，失败回落内置 `prompts.ts`」：
  - 清单缓存 **60s TTL**：租户后台改完，正在跑的 MCP 会话最迟一分钟生效，不必重启客户端；
  - 拉取失败时返回上次成功的缓存（没有就静态副本），后端抖一下不会让模型失去全部提示词；
  - `prompts/get` 的渲染口径与后端 `prompt.calc.ts` 一致（默认值/必填/占位符替换）。
- `prompts.ts` 的静态 `PROMPTS` 保留为**离线兜底副本**，正常运行时以服务端为准，两处文案不一致时以服务端为准。
- `selftest.ts` / `selftest-http.ts` 增加：三名字仍在、`days=45` 渲染进正文、正文长度 ≥200。

### 10.26.7 Console

- 路由 `/prompts`（meta：module=`agent`、permission=`sys:prompt:manage`、icon=`ChatDotRound`），
  菜单目录 `menu.catalog.ts` 的 agent 分组新增同名条目（两边必须一起改，守卫按 `/auth/me.menus` 放行）。
- `views/PromptLibrary.vue`：列表（系统/自定义/覆盖系统标签）、启用开关、参数表编辑、正文编辑、
  预览弹窗（按参数默认值预填，调 `POST .../preview`）。
- 覆盖行操作叫「恢复默认」，自定义行叫「删除」；两者都走同一个 `DELETE`，文案不同但语义由后端判断。

### 10.26.8 验证（全部实跑 2026-11-06）

- `npm test` **217/0**（+8：`src/agent/__tests__/prompt.calc.test.ts`）。
- `D2_DSN=… bash backend/scripts/p0-acceptance.sh` → **通过 267 / 失败 0**（A–Q 段；Q 段 +18）。
  Q 段实测：菜单入口 → viewer 4032 → 系统 3 条 → 新建自定义 → 非法名/未声明占位符/超长/缺 title 四类 400 →
  预览渲染（WH-SH / 45）→ 覆盖系统（overridden=true）→ 停用后管理列表仍可见、Agent 清单消失 →
  重新启用即恢复 → 删除覆盖回落默认 → 二次删除 404 → 审计 save/delete → 删除自定义彻底消失。
- `bash backend/scripts/p6-rls-smoke.sh` **22/0/0**；`npx tsc` 0 error；backend lint **0 error**；
  `apps/console` `vue-tsc && vite build` 通过；MCP `npm run build` + `selftest` / `selftest:http` 通过
  （`prompts/get(inventory.health_check, days=45)` 正文含 45）。
- ⚠️ 新增实体必须**同时**加到 `src/entities/index.ts`（`app.module` 的 `ENTITIES` 只从那里批量注册）：
  漏了会报 `EntityMetadataNotFoundError: No metadata for "AgentPrompt"`，接口表现是 500 而不是 400。

---

## 10.27 隐性重点补齐（2026-11-13 落地）

一句话：把 §10.1.5 B 清单里「上线前必须处理 / 挡住对外承诺」的隐性重点按工程标准逐项收口，
**纯逻辑全部抽成可单测函数，IO 层只做编排**；同时诚实标出哪些只是「代码已实现」而非「已验收」。

### 10.27.1 本轮做了什么（按工作包）

| WP | 对应缺口 | 交付 | 主要落点 |
| --- | --- | --- | --- |
| WP1 | 码制能力单一真源 + P7 剩余 | 能力表驱动 ZPL/TSPL/EPL、Console 属性面板同步 | `backend/core/symbology.capabilities.ts`、`epl-generator.ts`、`apps/console/src/views/designer/` |
| WP2 | B2.2 / B2.6 / B3 | 配置 fail-fast、出域脱敏、三维限流 + 响应头 | `common/config.guard.ts`、`agent/redaction.calc.ts`、`agent/rate.calc.ts` |
| WP3 | B2.4 / B2.5 | 三个 repeatable 定时任务、站内信与通道扩展点 | `jobs/`、`notify/`、`scripts/saas_p7_notifications.sql` |
| WP4 | B1（P6.2 阶段 B） | 业务读写路由、开通编排、退库巡检、运维面 | `common/tenant-routing.*`、`saas/platform-admin/dedicated.*` |
| WP5 | 回归与交接 | 全量单测 / typecheck / 编译 / DI 探针 / 文档 | 本节 |

### 10.27.2 几个关键设计决策（改之前先读）

1. **配置守卫放在 `NestFactory.create()` 之前**，不是做成 Nest Provider：Provider 初始化时连接池可能已经用弱口令连上了，
   必须在任何外部连接建立之前拒绝启动。dev/test 只 warn 不抛，不打断本地开发与单测；错误消息只报「哪项不合规」，不回显密钥。
   `BRANDING_DEV_VERIFY` 的 dev 逃生口只在严格模式判 block（旧写法恒为 block，已修）。
2. **脱敏只在出域做**：幂等记录与审计保留原始结果（重放一致性 / 合规追溯需要原值），
   `ToolsService.egress()` 统一裁剪返回给 LLM 的 `data`。本轮补齐了此前漏掉的**幂等重放分支**，四个返回点全覆盖。
   掩码保留「有值 + 类型 + 长度量级」，命中时把字段清单写进 `warnings`，模型知道数据被裁剪过。
3. **限流新维度默认关闭**：`tool_rpm` / `token_rpm` / `per_tool` 不配就不检查，避免无预警收紧存量租户；
   agent 维度 key 保持 `lf:agent:rl:<tenant>:<client>:<桶>` 不变（验收 M 段直接查这个键）。
   成功响应头通过 `rate.context.ts`（AsyncLocalStorage）传，429 通过异常自带 headers 由 `AllExceptionsFilter` 下发——
   不把传输层元数据混进 `ToolResult` 业务信封。
4. **定时任务用 BullMQ repeatable 而不是 `@Cron`**：复用打印队列同一套 Redis，repeatable 按 name+cron 去重，
   API 进程与 worker 进程同时注册也不会重复触发；判定（第 7 天边界、审批过期、TTL 边界）全在 `jobs/schedule.calc.ts` 纯函数。
5. **站内信通道分层**：`InAppChannel` 是必须成功且带 `dedupe_key` 幂等的落库通道；
   `NotificationChannel` 是外部通道扩展点，投递失败只记日志，绝不阻断主流程或回滚已落库的站内信。
6. **业务读写接管用注入层代理，不改业务代码**：`tenant-typeorm.module.ts` 导出同名 `TypeOrmModule`，
   16 个模块只需把那一行 import 指向它，`@InjectRepository` 注入的 Repository 就是动态 Proxy ——
   每次方法调用按 `TenantCtx.dataSourceKey` 解析 `tdsm.get(ctx)`。无 ALS 上下文（定时任务 / 平台任务 / seed）回落共享库，
   独立库 key 未注册则抛 503，**绝不静默回落**。事务通过 `TENANT_DATASOURCE` 代理在目标库起事务并打 `app.tenant_id`。
   ⚠️ 关键闭环：`TenantContextInterceptor` 原来把 `dataSourceKey` 硬编码成 `'default'`，本轮改为从**目录库** `tenants.data_source_key` 读取；
   不改这里，代理永远走共享库。
7. **开通编排的两道闸门**：状态机 `canSwitchKey()` 要求「前置步骤全完成 + `verify_counts` 通过 + 处于 verifying/switching 态」，
   编排器在真正 `UPDATE tenants` 前再调一次。任何失败进逆序回滚，**建库是唯一不可逆步骤，只标 manual 不自动 DROP DATABASE**；
   新建场景即使编排失败，租户仍留在共享库且 key 未切，业务不中断（天然回滚）。DSN 只活在进程内存，审计只记 `maskDsn`。

### 10.27.3 实跑验证（2026-11-13）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `cd backend && npm run typecheck` | **0 error** |
| 全量单测 | `cd backend && npm test` | **297 条全绿**（290 pass / 7 skip / 0 fail），较 217 基线 +80 |
| 全量编译 | `./node_modules/.bin/tsc -p tsconfig.json` | 通过（含装饰器元数据） |
| lint | `cd backend && npm run lint` | **0 error / 11 warning**，与基线完全一致（本轮新增文件 0 warning） |
| DI 图 | 编译产物上 `NestFactory.createApplicationContext(AppModule)` | **依赖解析全部通过**，走到 TypeOrmModule 连接阶段才因沙盒无 PG 停止（非 DI 错误） |
| 前端构建 | `cd apps/console && pnpm build` | **未复跑**：沙盒无前端 `node_modules`、仓库根也没有 `pnpm-lock.yaml`（`vue-tsc: not found`）；本轮前端零改动，历史构建记录见 §10.8 / §10.26.8 |

本轮新增单测文件：`config.guard.test.ts`、`redaction.calc.test.ts`、`rate.calc.test.ts`（B3 追加）、
`schedule.calc.test.ts`、`tenant-routing.test.ts`、`tenant-context.interceptor.test.ts`、
`dedicated.orchestration.test.ts`、`dedicated.ops.test.ts`。

### 10.27.4 诚实边界：待验收 / 仍未做

> **不要按本节把系统写成「独立库已交付」或「定时任务已上线」。**

| 类别 | 具体内容 | 为什么没验 / 还缺什么 |
| --- | --- | --- |
| 🔴 待真连库验收 | 独立库租户建模板/打库存后共享库 0 行；开通编排一条命令跑通且失败可回滚；跨库 `INSERT` 与 `session_replication_role` | 沙盒只有一套 PostgreSQL（且本轮环境连 PG/Redis 都没装），没有第二套实例与 superuser admin DSN |
| 🔴 待真连库验收 | BullMQ repeatable 三个任务真实触发、站内信真实落库、429 响应头在真实 HTTP 上出现 | 沙盒无 Redis / 无运行中的 API 进程 |
| 🟡 上线前仍缺 | 主链路切到 `labelflow_app`（B2.1）、白标真实 DNS 验证（B2.3） | 需运维配合，见 §10.22.4 / §10.24 |
| 🟡 上线前仍缺 | 独立库物理备份 / PITR（B1.5） | 目前只有逻辑 JSON gzip 导出，需在合同或运维文档里明确「只保证逻辑导出」 |
| ⚪ 未做 | 邮件 / 飞书 / 短信通知通道 | 只有 `NotificationChannel` 接口与 `ChannelRegistry`，V1 仅站内信 |
| ⚪ 未做 | 广播站内信的逐用户已读位图 | V1 `read_at` 单值 → 一人标记即全租户已读；需要时加 `notification_reads` 表 |
| ⚪ 未做 | Agent 工具路径的独立库路由 | `inAgentTenant()` 显式设 `dataSourceKey:'default'`（P5 语义保持），Agent 写工具仍落共享库 |

### 10.27.5 部署 / 运维增量清单

**新 SQL 脚本**（幂等，接在 `saas_p6_prompts.sql` 之后）：
`backend/scripts/saas_p7_notifications.sql` —— 建 `notifications` 表、dedupe 唯一索引、RLS 兜底策略
（角色 `labelflow_app` 不存在时自动跳过，不影响建表）。新表带 `tenant_id`，会自动纳入 P6.3 导出/硬删表清单。

**新增环境变量**（都有默认，不配不影响启动）：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `LABELFLOW_STRICT_CONFIG` | 未设 | `=1` 时在非 production 也启用配置 fail-fast（灰度验收用） |
| `MAINTENANCE_SCHEDULER_ENABLED` | `1` | `=0` 关闭维护任务调度注册（只想让 worker 进程跑时） |
| `DB_DEDICATED_POOL_<KEY>` / `DB_DEDICATED_POOLS` | 回落 `DB_DEDICATED_POOL=4` | per-key 连接池上限（夹到 1–50） |
| `DB_DEDICATED_SSL` / `DB_DEDICATED_SSL_REJECT` | 关 / 严格 | 独立库 SSL 开关与自签证书容忍 |
| `DB_DEDICATED_IDLE_MS` / `DB_DEDICATED_CONNECT_MS` | 30000 / 5000 | 空闲回收与连接超时 |
| `DEDICATED_DDL_FILES` | 内置 12 份脚本 | 覆盖新库 DDL 清单（逗号分隔）；默认**跳过** `saas_p6_rls.sql`（库边界即隔离）与 `seed.sql`（会插默认租户） |

**新增端点**：

| 端点 | 说明 |
| --- | --- |
| `GET/POST /api/v1/notifications…` | 站内信列表 / 未读数 / 标已读 / 全部已读（租户 JWT） |
| `GET /platform/datasources/health` | 所有独立库健康快照 |
| `POST /platform/datasources/:key/reclaim` | 回收无租户引用的孤儿连接池（不删物理库） |
| `GET /platform/datasources` | 新增 `reclaimable` / `unregisteredRefs` 巡检字段 |
| `POST /platform/tenants/dedicated` | 一条命令开通独立库租户（需 `dataSourceKey` + `dedicatedDsn`，DSN 不落库） |
| `POST /platform/tenants/:id/dedicated/plan` | 编排计划预览 |
| `POST /platform/tenants/:id/dedicated/provision` | 迁移已有租户到独立库（失败自动回滚） |

> ⚠️ `ProvisionService.provision` 仍**拒绝** `type='dedicated'` 与 `dataSourceKey` 入参（防止绕过编排造成假隔离），
> 文案已改为指向上述专用端点。
