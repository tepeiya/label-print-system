# 32 · 租户端 AI 助手

> 一句话：租户在 console 里点右下角悬浮球就能问"这东西怎么用"，答案只来自**产品使用类知识库**，
> 平台运营内容（套餐、用量、审计、租户管理）一个字都不会出现在这里。

## 为什么不是把平台知识库直接开放

平台知识库 16 篇里有「租户生命周期」「套餐与计费」「数据保留策略」这类内容，
对租户是内部信息、对运营是商业信息，直接放开等于把后台手册发给客户。
所以两边共用一张表、用 `scope` 分层，**不是同一份内容换个入口**。

## 数据模型

`kb_articles` 增加一列：

| 列 | 值 | 谁能读 |
|---|---|---|
| `scope` | `platform`（默认，存量行不变） | 平台身份（`PlatformJwtGuard`） |
| `scope` | `tenant` | 租户身份（`TenantGuard`） |

- 存量 16 篇不需要改数据，ALTER 后默认落 `platform`。
- 租户层 13 篇见 `backend/scripts/kb_tenant_scope.sql`，按 slug UPSERT，可重复执行。
- 索引 `ix_kb_articles_scope (scope, category, sort)`，列表/分类查询不再全表扫。

## 接口

`backend/src/kb/tenant-assistant.controller.ts`，类上 `@UseGuards(TenantGuard)`：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/assistant/ask` | `{question, limit?}`，租户 id 从 token 取，前端不传 |
| GET | `/api/v1/assistant/suggestions` | 快捷提问（取租户层文章标题，最多 8 条） |
| GET | `/api/v1/assistant/articles/:slug` | 只看 `scope=tenant` 的文章；跨层统一报"不存在"，不泄露另一层 |
| GET | `/api/v1/assistant/status` | 当前生效的 AI 来源（不回显 key） |

平台端 `/api/v1/kb/*` 完全不动：`KbService` 增加 `scope` 参数，缺省 `platform`，旧调用行为不变。

## 模型配置：沿用四级回退

`租户自己的默认配置 → 平台级（tenant_id=0）→ 环境变量 → 无`。

- 没有模型时**不是不能用**，降级为"知识库原文整理"，照样回答，只是不润色、不总结。
- 前端状态条直接显示"已接入模型 / 未接入模型，回答为知识库原文整理"，不假装。

## 内容口径（13 篇）

只写"产品怎么用"，不写价格、套餐、内部运营流程：

| 分类 | 篇目 |
|---|---|
| 入门 | 快速开始 |
| 模板设计 | 设计器基础、变量与公式、模板复用 |
| 条码 | 码制与密度、扫不出排查、UDI 赋码 |
| 打印 | 三种通道、本地代理安装、失败与补打、批量导入 |
| 数据与集成 | 数据源与表格 |
| 账号与权限 | 角色与权限 |

条码三篇直接对应系统真实行为（密度下限 0.19/0.30mm、条高 6mm、装框拦截、静区按码制），
报错文案与打印自检输出**逐字一致**，用户照文章和报错对照就能处理。

## 前端

`apps/console/src/components/AiAssistant.vue`，挂在 `MainLayout` 根节点：

- 右下角悬浮球，点开是面板；展开状态与最近 20 条对话存 localStorage，刷新不丢。
- 回答用极简 markdown 渲染（标题符、加粗、行内代码、换行，以及「报错 | 原因 | 处理」这类表格转真表格），不引入完整解析器。
- 回答里的「依据」行不出现 K1/K3 内部编号（租户看不懂），统一收敛为「依据：知识库 N 篇（见下方参考文章）」；LLM 提示词同步改成同样的口径。
- 参考文章可点开看全文（`el-dialog` 内渲染），不用跳页。
- 没有"选哪个租户"的下拉：租户身份由登录态决定，避免前端传参被篡改。

## 明确不做的

1. **不代操作**：不会替用户点按钮、改配置、删模板，只答"怎么用"。
2. **不查业务数据**："我昨天打了多少张"这类问题不回答（走报表页）。
3. **PDA 未接**：PDA 面向一线扫码，屏幕小、场景单一，本轮没加入口。
4. **不做向量检索**：仍是关键词打分（复用 `kb.calc.ts`）；13 篇规模下够用，量大了再说。

## 验收

`docs/24-delivery-plan.md` D6.1 行。真实库（`labelflow_test`）实测：

| 项 | 结果 |
|---|---|
| 租户登录 → `/assistant/suggestions` | 6 条 chip，全部来自 tenant 层 |
| `/assistant/ask`「条码扫不出怎么办」 | `answeredBy=kb`、`confident=true`，命中 `t-barcode-troubleshoot` + 3 篇延伸 |
| 未配 AI 时的降级 | `aiSource=none`，明确标注"知识库原文整理，不是模型生成" |
| 租户读 platform 文章 `quick-start` | 404（跨层统一 NotFound，不泄露存在性） |
| 租户调平台 `/kb/articles` | 403 |
| 平台调 `/assistant/ask` | 403（TenantGuard） |
| 平台 `/kb/articles` | 16 篇，无一条 `t-` 前缀 |
| 前端 | 悬浮球/面板/chips/参考文章弹窗/表格渲染，实际登录态截图核对 |
