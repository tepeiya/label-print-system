# 标签管理与打印系统（LabelFlow）

> 一套可商用的专业标签设计 / 打印 SaaS。覆盖拖拽式可视化设计器、变量 / 公式 / 流水号 / 条码二维码、多打印机通道、多租户隔离、批量打印与任务队列、SaaS 订阅计费、Agent / MCP 接入、AI 模板生成，以及库存 / 主数据 / 齐套 / 呆滞预警等企业治理能力。

> **接手开发请先读 [`docs/10-dev-handover.md`](docs/10-dev-handover.md)** ——
> 面向 AI / 开发者的权威交接文档：运行环境与端口、模块地图、核心 schema 约定、
> 已完成清单、已知技术债、路线图、踩坑记录、自测清单。本文档只做总览与快速上手。

> **前端现状（重要）**
> - ✅ 主前端：`apps/console`（Vue 3 + TypeScript + Vite + Element Plus + Pinia）租户后台 `:5173`
> - ✅ 平台运营后台：`apps/platform` `:5181`；Agent/MCP Server：`apps/mcp-server` `:3300`
> - ✅ WMS 收货作业 PDA（移动端 H5）：`apps/pda` `:5185`（zxing-wasm 摄像头扫码 + 盲收/按单收 + 上架确认，需租户订阅 `wms.inbound`）
> - ✅ Windows 本地打印代理：`apps/print-agent`（C# net8.0 控制台，自包含单文件 exe；winspool RAW 直发，装成计划任务开机自启）——补上 USB / 本机共享打印机无法从云端直接打印的缺口；租户在「打印机」页复制一行命令即装好，装完打印机自动出现，见 `docs/31-windows-print-agent.md`
> - ⚠️ `web/`（原生 HTML5）**已弃用（DEPRECATED）**，仅作行为对照，不再新增功能，待新前端完善后删除。

---

## 0. 技术栈选型与取舍

### 后端：Node.js (NestJS) vs Java (Spring Boot 3)

| 维度 | NestJS (选用) | Spring Boot 3 |
| --- | --- | --- |
| 渲染生态 | `sharp` / `pdf-lib` / `@bwip-js/node` 与前端同语言，复用校验位 / 坐标换算逻辑 | 需 `ZXing` / `iText` / `Batik`，图形渲染需 JVM 内 canvas，体积大 |
| 打印指令生成（ZPL/TSPL/EPL） | 纯字符串模板，TS 直接拼装 | 同样纯字符串，无优势 |
| 团队一致性 | 前后端同 TS，设计器与渲染层可共享 schema / dpi 换算 | 需两套语言维护 |
| 性能 / 并发 | 单进程 I/O 密集足够；CPU 密集渲染用 BullMQ Worker 隔离 | 线程模型更稳，长任务友好 |
| 运维 / 容器 | 镜像小、启动快 | JDK17 镜像 ~400MB+ |

**结论**：选 **NestJS + TypeScript**。① 渲染层（条码 / 二维码 / PDF / PNG）与前端设计器共用「毫米↔点阵」「校验位」「公式」逻辑，同语言零成本复用；② 指令生成本质是字符串模板，TS 表达力强；③ 启动快、镜像小，符合 Docker Compose 一键部署。CPU 密集的批量出图通过 **BullMQ + Worker** 隔离，避免阻塞事件循环。

### 其他选型（以实际代码为准）

- **包管理**：统一用 **pnpm**。后端 `backend/`、前端 `apps/console`、`apps/platform` 均用 pnpm（`pnpm-lock.yaml`）；`apps/mcp-server` 仍保留 npm（`package-lock.json`，历史遗留，后续可择机迁移）。
  - 后端已于 2026-11-22 移除历史 `backend/package-lock.json`（与 `pnpm-lock.yaml` 并存会导致 CI/新同事装依赖时依赖集不一致——后者含 jest 集成测试依赖、前者不含）。后端装依赖一律 `cd backend && pnpm install`，校验用 `pnpm install --frozen-lockfile`。
- **数据库**：PostgreSQL 16（`pgvector/pgvector:pg16`，模板 / 业务扩展存 `JSONB` + GIN 索引）；**Redis 7** 用于号段缓存、BullMQ 队列、租户配置缓存。
- **ORM**：TypeORM（`synchronize: false`，全部建表 / 改列走 `backend/scripts/*.sql` 手工执行）。
- **渲染 / 识别**：服务端 `sharp`（位图）、`pdf-lib`（矢量 PDF / 精确分页）、`@bwip-js/node`（条码二维码，含 GS1 / DataMatrix / PDF417 / Aztec）、`zxing-wasm` + `@zxing/library`（解码校验）、`tesseract.js`（OCR）、`xlsx`（数据导入）。
- **设计器**：`apps/console/src/views/designer/` 下 **Vue 3 原生实现**（12 类元素、手势 / 标尺 / 吸附 / 撤销重做 / 检查器），非 iframe、非 Konva。前端预览用 `bwip-js` 出码。
- **状态管理**：前端 **Pinia**（`apps/console/src/store/`）。
- **鉴权**：JWT（Access + Refresh Rotation）、bcrypt 加盐哈希；多租户 `tenant_id` 隔离 + RBAC 权限点 + 模块订阅门。

---

## 1. 目录结构

```
label-print-system/
├── README.md                       # 本文档（总览 + 架构 + 快速上手）
├── docker-compose.yml              # 一键启动（pg + redis + api + worker + 老 web）
├── docs/
│   ├── 01-requirements.md          # 功能矩阵（P0/P1/P2）
│   ├── 02-architecture.md          # 架构图（Mermaid）
│   ├── 03-database.sql             # 基础 DDL
│   ├── 04-template-schema.md       # 模板 JSON Schema + 示例
│   ├── 05-api.md                   # 后端 API 清单
│   ├── 08-plan.md                  # 开发计划 + 测试要点
│   ├── 09-ai-template-generation.md # AI 标签图片 → 模板自动生成
│   ├── 10-dev-handover.md          # ★ 开发交接文档（权威，接手必读）
│   ├── 11-saas-and-agent-architecture.md # SaaS 订阅/RBAC + Agent/MCP 架构
│   └── 12-formula-guide.md         # 公式引擎使用指南
├── backend/
│   ├── core/                       # 纯计算内核（无 Nest 依赖，可单测）
│   │   ├── serial-number.service.ts   # 流水号并发安全（行锁 + 号段预分配）
│   │   ├── formula-engine.ts          # 公式引擎（解析/求值/循环依赖检测）
│   │   ├── checksum.ts                # 条码校验位算法
│   │   ├── barcode-renderer.ts        # 服务端出图 + 前端预览适配
│   │   ├── symbology.capabilities.ts  # 码制单一真源（预览/指令能力矩阵）
│   │   ├── zpl-generator.ts / tspl-generator.ts / epl-generator.ts
│   │   ├── vector-renderer.ts / pdf-export.ts  # 整标签矢量 SVG + PDF
│   │   └── __tests__/golden/          # ZPL/TSPL/EPL golden 快照
│   ├── src/                        # NestJS 应用模块
│   │   ├── agent/                  # Agent/MCP 工具目录、Prompt 库、审批、限流
│   │   ├── ai-template/            # AI 模板生成（OCR/透视矫正/LLM）
│   │   ├── audit/ backup/ billing/ # 审计 / 备份 / 计费
│   │   ├── barcode/ formula/ serial/ datasource/ printer/
│   │   ├── inventory/              # 主数据 / 库存 / BOM 齐套 / 呆滞预警
│   │   ├── jobs/                   # BullMQ 任务与定时维护（Webhook、HotFolder）
│   │   ├── notify/                 # 站内信 + 飞书/邮件/短信外部通道
│   │   ├── print/ saas/ governance/ hardware/ template/ user/ auth/
│   │   └── app.module.ts / main.ts
│   └── scripts/*.sql               # ★ 全部 DDL / 权限种子（需手工执行，见 §5）
├── apps/
│   ├── console/                    # 租户后台（Vue 3 + Vite + Element Plus + Pinia），:5173
│   │   └── src/views/designer/     # 原生 Vue 设计器（元素/引擎/检查器）
│   ├── platform/                   # 平台运营后台，:5181
│   ├── pda/                        # WMS 收货作业 PDA H5，:5185（zxing-wasm 扫码）
│   └── mcp-server/                 # Agent/MCP Server，:3300
├── web/                            # ⚠️ 已弃用：老版原生 HTML5 前端，仅作对照
└── tools/labelctl.mjs              # CLI：login/templates/printers/print/commands/jobs
```

> 所有**对外坐标 / 尺寸以毫米(mm)为单位**，内部渲染按目标 `dpi` 转点阵。

---

## 2. 坐标系与单位约定（贯穿全系统）

```text
mm  → dots : dots = round(mm * dpi / 25.4)
dots → mm  : mm   = dots * 25.4 / dpi
```

- 设计器画布逻辑单位为 **mm**，按 `缩放比 * (screenDpi/25.4)` 像素/毫米渲染（屏幕按 96dpi 显示，导出时按打印机 dpi 重算）。
- 模板 JSON 中所有 `x/y/w/h` 均为 mm；打印指令生成时统一在 Provider 内按 `printer.dpi` 换算为 dots。
- DPI 不一致时，出图层以打印机 DPI 为基准重采样，避免模糊 / 偏移。例：203dpi→8 dots/mm；300dpi→11.81；600dpi→23.62。

---

## 3. 核心能力覆盖度

| 能力域 | 覆盖 | 备注 |
| --- | --- | --- |
| 可视化设计器 | ✅ 拖拽 / 缩放 / 标尺 / 网格 / 吸附 / 成组 / 层级 / 撤销重做 | Vue 3 原生实现 |
| 元素类型 | ✅ 文本 / 图 / 线 / 形 / 表 / 条码 / 二维码 / 公式 / 流水号 / 日期 / 系统变量 / DB 字段 | 12 类 |
| 变量 / 公式 / 流水号 | ✅ 含 CHECKSUM、循环依赖检测、号段预分配并发安全 | 见 `core/` |
| 码制 | ✅ 主流一维 / 二维；GS1 FNC1、MaxiCode / HIBC / PZN 等专业码制 | `symbology.capabilities.ts` 单一真源 |
| 码制专业性（第三层） | ✅ GS1 AI 官方全量字典（541 项）、打印后解码验证闭环（bwip→zxing）、HIBC Mod43 / PZN Mod11 校验、MaxiCode 原生 `^BD` 构造器（opt-in） | `core/{gs1-ai.full,industrial-checksum,maxicode}.ts`、`src/print/verify.*`；指令/真机通道仍待硬件验收，见下方边界 |
| 设计器交互精度（第四层） | ✅ 富文本 runs（逐段样式/上下标）、表格合并单元格（rowSpan/colSpan 单一真源）、DB 字段元素（字段绑定/格式/空值占位） | `core/{rich-text,table-layout}.ts` + 前端 parity、`src/print/render.service.ts` 与各渲染器；指令/矢量通道富文本降级为纯文本，见下方边界 |
| 数据绑定/工具（第五层） | ✅ 公式 LOOKUP/VLOOKUP 查表函数（变价表/物料映射，JSON 对象/行数组/KV 文本）、前后端 parity | `core/lookup-table.ts` + 前端 parity、`formula-engine.ts` 白名单注册；`ai.*` 工具为有意推迟的产品决策（需图片入参+计费联动），非缺口 |
| 打印通道 | ✅ 浏览器打印 / 9100 Raw TCP / 本地代理（一行命令安装，自动建打印机） / 服务端出图 | 4 类 Provider |
| 输出 | ✅ ZPL / TSPL / EPL 指令 + 位图 PNG + 整标签矢量 SVG / PDF | golden 快照测试 |
| 设计/打印止血（第一层） | ✅ 旋转条码/二维码打印（printRotateStyle 统一口径 + 外层盒承载旋转）、右对齐/底对齐、双面打印 duplex（正反面交替页，多联拼版按 sheet 交替） | `engine/print.ts`、`store.ts`、`PropsPanel.vue`、`html-renderer.ts`；双面依赖打印机短边翻转，真机套准未验，见交接文档 §10.35 |
| 印刷级输出（第二层） | ✅ 真矢量 PDF（条码/图形/拉丁文本）、出血/裁切线/套准线/CMYK 色标、collate 交叉/堆叠、PDF 拆分、弧形文字/条码、缩略图 DPI 自适应 | `src/print/{vector-pdf,print-marks,impose}.ts`；二维码与中文文本块为高-DPI 位图，专色为 CMYK 近似（非真分色），见下方边界 |
| 批量 / 队列 | ✅ CSV / DB 数据源 + BullMQ 异步 + 重打补打 + 防重代码 | 见 `src/jobs`、`src/print` |
| 多租户 / RBAC | ✅ tenant_id 隔离 + 资源级权限点 + 模块订阅门 + 审计 | 见 `src/saas` / `src/auth` |
| SaaS 化 | ✅ 订阅计费（V1）、平台运营后台、白标、独立库路由、RLS 代码 | 见 `src/billing` / `src/saas` |
| Agent / MCP | ✅ 读写工具 + 审批流 + 限流 + 脱敏；Prompt 库版本历史 / 角色分发 | 见 `src/agent` |
| AI 模板生成 | ✅ 透视矫正 / 单元素重算 / 文本生模板 / 多联切分 | 见 `src/ai-template` |
| 自动化触发 | ✅ HotFolder + 事件 + Webhook | 见 `src/jobs` |
| 企业数据 | ✅ 基础资料（含自定义字段）/ 库存 / BOM 齐套率 / 呆滞效期预警 | 见 `src/inventory` |
| 通知 | ✅ 站内信 + 飞书 / 邮件 / 短信外部通道（配置驱动） | 见 `src/notify` |

> ⚠️ 标注「代码已落地」不等于「已完成真机 / 真库 / DNS 验收」。RLS 角色切换、独立库真连库、白标 DNS、硬件代理（RFID / 喷码机）等仍需真实环境验收，**不得按已交付对外表述**。详见 `docs/10-dev-handover.md`。

**印刷级输出的诚实边界**（`POST /print/export/pdf?vector=true`、SVG 端点、`pdf/split`）：

| 能力 | 实现 | 边界 |
|---|---|---|
| 一维条码 / 图形 / 拉丁文本 | pdf-lib 原生路径，**真矢量** | 可无限放大 |
| 二维码 / 矩阵码 | bwip SVG 高-DPI（默认 600）栅格化嵌入 | 非矢量，但可扫码；因 pdf-lib 多子路径填充坐标 bug |
| 中文文本 | 高-DPI 位图块嵌入（hybrid） | 非矢量；纯矢量中文需印前嵌入 CJK 字体子集 |
| 专色（Spot/Pantone） | 名称 + CMYK 近似色标 | **非真 Separation 分色**，需印前软件 |
| 弧形文字 / 条码 | SVG `<textPath>` / 旋转线段近似 | 指令通道（ZPL/TSPL/EPL）退化为直线；弧形条码解码需真机验证 |
| 印前标记 | 出血 / 裁切线 / 套准线 / CMYK 色标 | 底部标记区自动扩展；颜色为 CMYK 近似 |

**码制专业性的诚实边界**（`POST /print/verify/{image,roundtrip}`、`POST /print/maxicode/zpl`）：

| 能力 | 实现 | 边界 |
|---|---|---|
| GS1 AI 字典 | 官方 JSON-LD 派生 541 项全量索引，精调 65 项（中文/示例）优先 | 长尾仅英文标题；复合格式取首段；行业专用码以官方手册复核 |
| 打印后解码验证 | bwip 渲染→zxing 解码→文本比对，覆盖 CODE128/QR/DataMatrix/EAN13/GS1-128 | 只闭环**位图通道**；ZPL/TSPL/EPL 指令通道与真机/扫描枪实测未验 |
| HIBC / PZN 校验 | Mod43 / Mod11 纯函数，对照官方样例 | 未接真机扫描与医药监管系统验收 |
| MaxiCode `^BD` | 显式 opt-in 原生指令 + Mode 2/3 结构化构造器 | 默认仍走位图「预览仅」；Mode 2/3 格式错误会被 UPS 拒收；固定尺寸、无旋转、`^BY` 无效；真机/承运商未验 |

**设计器交互精度的诚实边界**（第四层，无新增 HTTP 端点，纯设计态 + 渲染通道）：

| 能力 | 实现 | 边界 |
|---|---|---|
| 富文本 runs | RichTextRun[] 逐段字重/斜体/下划线/颜色/字号/上下标；HTML `<span>/<sub>/<sup>` 完整还原 | 指令通道（ZPL/TSPL/EPL）与 SVG/PDF 矢量降级为纯文本拼接 + warning，样式不保留 |
| 表格合并单元格 | mergedCells [{row,col,rowSpan,colSpan}] 单一真源，前后端 parity；HTML 按 span 跳格、矢量按主格画框 | 仅矩形合并、越界/重叠自动钳制去冲突；非矩形自由合并未支持 |
| DB 字段元素 | 字段绑定（支持 `{{var}}` 占位）+ upper/num/date 格式 + 空值 fallback | 数据集 `datasetId` 为预留字段，当前取数据行同名字段；跨数据集联查未实现 |

**数据绑定/工具的诚实边界**（第五层，无新增 HTTP 端点，纯公式函数扩展）：

| 能力 | 实现 | 边界 |
|---|---|---|
| 公式查表 | LOOKUP(key,table,default?) / VLOOKUP(key,table,col?,default?)，白名单纯函数；表支持 JSON 对象 / JSON 行数组 / 紧凑 KV 文本，前后端 parity 锁定 | 表数据须为字符串（`{{var}}` 注入或 KV 文本内联）；后端 tokenize 不支持字符串内转义，故**内联 JSON 不可用**，JSON 必须走 `{{var}}`；key 精确匹配无模糊/通配 |
| Agent 工具 | 打印三工具 + 模板/库存/BOM/预警工具均已 implemented | `ai.*` 工具（图片入参 + 计费联动）属有意推迟的产品决策，非缺口，未注册 |

---

## 4. 快速开始

### 4.1 一键启动（推荐，Docker）

```bash
docker compose up -d --build
```

启动顺序由 compose 编排保证：`postgres` 健康 → `db-init` 按固定清单建库并自检 → `api`/`worker` 起来 → 三个前端等 API 健康后启动。

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 租户后台 console | http://localhost:5173 | 日常使用入口 |
| 平台后台 platform | http://localhost:5181 | SaaS 运营（租户/套餐/账单） |
| 手持 PDA | http://localhost:5185 | 手机同网段访问 `http://<宿主IP>:5185` |
| 后端 API | http://localhost:3200/api/v1 | 直连调试用 |
| PostgreSQL | localhost:5433 | 宿主映射，容器内 `postgres:5432` |
| Redis | localhost:6380 | 宿主映射，容器内 `redis:6379` |

默认账号：`admin / admin123`（租户 `default`）；`operator / admin123`。

首次冷启动会有 **45–70 秒**的加载时间（Nest 模块多、依赖重），期间 `api` 未监听属正常；`start_period` 已给到 120 秒。

冒烟验证：

```bash
curl -s -X POST http://localhost:3200/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# 期望 201 + {"code":0,...,"accessToken":"eyJ..."}
```

> 老前端 `web/` 已弃用，仅在需要行为对照时启动：`docker compose --profile legacy up -d web`（5180）。

### 4.2 本地分进程（改代码时）

```bash
cd backend && pnpm i && pnpm start:dev     # API :3200（nest watch）
cd apps/console && pnpm i && pnpm dev      # :5173，vite 代理 /api → 3200
cd apps/platform && pnpm i && pnpm dev     # :5181
cd apps/pda && pnpm i && pnpm dev          # :5185
```

> 本机需自带 PostgreSQL 与 Redis，并按 §5 建库。

### 4.3 生产构建与上线前必改

```bash
cd backend && pnpm build          # tsc -p tsconfig.json → dist/src/main.js、dist/worker.js
pnpm start:prod                   # node dist/src/main.js
pnpm worker:prod                  # node dist/worker.js
```

必须改的三项，否则后端会**拒绝启动**（`src/common/config.guard.ts` 的 fail-fast）：

1. `NODE_ENV=production`
2. `JWT_SECRET` 换成强随机串（内置 `dev-secret` 会被拦）
3. `DB_PASS` 不能是 `labelflow` / `postgres` / `password` / `123456` / `admin` 这类弱口令

多租户隔离的数据库角色 `labelflow_app`（NOBYPASSRLS）由 `saas_p6_rls.sql` 创建，见 §5。

---

## 5. 数据库

`synchronize: false`，所有 DDL 由脚本执行。**唯一真源是 `backend/scripts/db-manifest.txt` 的顺序清单**，不要再照记忆或文件头注释手工排。

```bash
# 一键建库（幂等，可重复跑；默认连 PG* 环境变量或 DATABASE_URL）
bash backend/scripts/db-init.sh
bash backend/scripts/db-init.sh --seed-demo     # 额外注入演示数据
bash backend/scripts/db-init.sh --dry-run       # 只看执行顺序
bash backend/scripts/db-init.sh --verify-only   # 只做缺表自检
```

机制：

- 顺序清单 `db-manifest.txt` 共 32 步（31 个脚本 + RLS 跑两遍）。实测踩到的两个坑已固化：`saas_p6_prompt_versions.sql` 要 GRANT 到 `labelflow_app`，所以 RLS 必须先跑一遍建角色；`inventory_masterdata.sql` 给 `stock_moves` 加库位列，必须排在 `inventory_stock_moves.sql` 之后。
- `saas_p6_rls.sql` **跑两遍**：第一次建角色 + 给当时已存在的表挂策略，最后一次给后建的新表（WMS/UDI/多码）补挂。
- 基础 DDL `docs/03-database.sql` 不幂等（19 张表无 `IF NOT EXISTS`），所以只在全新库执行一次；脚本会检测 `public.tenants` 是否存在来自动跳过。
- 结束自动跑 `db-verify.sh`：对账 `db-expected-tables.txt`（77 张表），缺一张即失败。
- 新增迁移脚本必须同时登记到 `db-manifest.txt`，否则自检会报缺表。

> 加购模块（`inventory` 基础模块之上）：`masterdata` / `bom` / `alert` 等需给目标租户开通 `tenant_modules` 后，模块门才放行、菜单才出现：
> ```sql
> INSERT INTO tenant_modules (tenant_id, module_code, status, source)
> VALUES (<租户ID>, 'alert', 'active', 'manual')
> ON CONFLICT (tenant_id, module_code) DO NOTHING;
> ```

---

## 6. 当前进度与验证

| 层 | 状态 | 验证方式 |
| --- | --- | --- |
| 核心引擎（公式 / 校验位 / 流水号 / 条码 / DPI / ZPL / TSPL / EPL） | ✅ 真实可运行 | `core/__tests__` + golden 快照 |
| 渲染管线（变量 + 公式 + 流水号 → 元素 / 矢量 SVG / PDF） | ✅ 真实 | 单测 + 快照 |
| 后端 NestJS 全模块 | ✅ 完整实现 | `pnpm typecheck` + 全量单测 |
| 前端三应用（console / platform / mcp-server） | ✅ 完整实现 | `vue-tsc -b` 类型检查 |
| 多租户隔离 | ✅ 应用层 + RLS 兜底（可开关） | `DB_RLS_ENFORCE=1` 时 Repository 走 RLS 角色短事务（R1–R3 真库门全绿）；`createQueryBuilder` 路径仍走主连接（`docs/27 §2.3`）|
| **交付化（D0）** | ✅ 装得上 | Dockerfile×2 + compose 编排出建库链 + `db-init.sh`（32 步 / 77 表自检）；真库实跑通过（`docs/25`） |
| **交付化（D2）** | ✅ 运维接管 | `/health` 三层探针 + Redis 限流（登录严档）+ traceId 结构化日志 + 优雅停机 + CI 三 job + RLS 主链路开关（`DB_RLS_ENFORCE`）；真库 R1–R3 门全绿（`docs/27`） |
| **交付化（D1）** | ✅ 验得出 | `backend/scripts/db-acceptance.sh` 一条命令跑全套门（WMS G1–G7 / T1–T5 / 打印 P1–P5 / UDI-U5 组 / 全量 885 例），产物 `docs/acceptance/latest.json`：当前 39 门 39 通过 0 失败 0 跳过（含 G8 收货侧 UDI 拦截，见 `docs/26 §4.1`） |
| **交付化（D4）** | ✅ 流程闭合 | PDA 发料页（列表/详情 + 六步流程 + 扫码 + 退料）+ 发料侧包码折算（与收货同口径）+ 退料 RETURN 幂等；真库 D4-1…D4-3 五门全绿（`docs/28`）；D3 真机打印待打印机就位 |
| **交付化（D5）** | ✅ 能演示能报价 | `backend/scripts/demo-up.sh` 一条命令起演示环境（33 脚本建库 + 医疗样板：20 物料/2 工单/50 UDI）；U6 国家 UDI 导出 xlsx/xml + 14 项字段映射；《能力清单（可承诺/不承诺）》见 `docs/29` |
| **交付化（D6）** | ✅ 运营能自助答疑 | 平台端「知识库」16 篇（8 类目）+ 右下角 AI 助手悬浮球（可关、菜单可再调出）；回答只用知识库内容，模型配置按 租户→平台→环境变量→无 四级回退，无模型时降级原文整理；`/kb/*` 由平台身份守卫（租户 token 401）；真库 11 项验证 + `kb.calc` 13 例单测（`docs/30`） |

### 运行测试

```bash
cd backend
pnpm typecheck                 # tsc --noEmit
pnpm test                      # node:test + tsx，覆盖 core/**/__tests__ 与 src/**/__tests__
# 当前：885 例 / 878 通过 / 0 失败 / 7 跳过

cd apps/console && pnpm vue-tsc -b   # 前端类型检查
```

> 单测均为纯函数 / 接线级（不触网、不连库）；网关连通性、飞书业务码、版本表并发、真机打印需在真环境验收。

### CLI（`tools/labelctl.mjs`，无依赖）

```bash
node tools/labelctl.mjs login                                   # token 缓存在 ~/.labelflow-token.json
node tools/labelctl.mjs print --template 7 --rows data.csv --copies 2
node tools/labelctl.mjs commands --template 7 --protocol zpl -o label.zpl
node tools/labelctl.mjs jobs --limit 5
node tools/labelctl.mjs retry 4 --seq 1,3                        # 指定序号补打
```

环境变量 `LABELFLOW_API`（默认 `http://localhost:3200/api/v1`）、`LABELFLOW_USER` / `LABELFLOW_PASS` / `LABELFLOW_TOKEN`。

---

## 7. 已知短板（路线图摘要）

按 `docs/10-dev-handover.md`，下一阶段优先级：

1. **最高优先：条码设计 / 打印核心能力打磨**（产品命根子）——**五层全部完工**，逐层清单见 [`docs/10-dev-handover.md`](docs/10-dev-handover.md) §10.31–§10.35：

   | 层 | 主题 | 已完工交付 | 测试基线 |
   | --- | --- | --- | --- |
   | 第一层 | 设计/打印止血 | 旋转条码/二维码打印、右/底对齐、双面打印 duplex | 532 例 / 525 pass |
   | 第二层 | 印刷级输出 | 真矢量 PDF、出血/裁切线/套准线/CMYK 色标、collate 拆分、弧形文字/条码、缩略图 DPI | 568 例 / 561 pass |
   | 第三层 | 码制专业性 | GS1 官方全量 AI 字典（541）、打印后解码验证闭环、HIBC/PZN 校验、MaxiCode `^BD` 构造器 | 609 例 / 602 pass |
   | 第四层 | 设计器交互精度 | 富文本 runs、表格合并单元格、DB 字段元素 | 635 例 / 628 pass |
   | 第五层 | 数据绑定/工具 | 公式 LOOKUP/VLOOKUP 查表函数 + 前后端 parity | 648 例 / 641 pass |

   **仍待验收**（不计入「已完工」）：指令/真机解码验证、富文本指令/矢量通道样式还原、专色真分色、打印机偏移校准真机验收。
2. **上线前技术债**：RLS 切到 `labelflow_app`（无 BYPASSRLS）角色、独立库真连库验收、白标真实 DNS / 证书、通知通道（代码已就绪，待配网关）、独立库物理备份策略。
3. **按需功能缺口**：更多 MCP 工具、高级计费（发票 / 退款 / 多币种）、Prompt 调用统计深化、Nest 容器级 E2E、前端测试、硬件层真机验收（Windows 打印代理 / RFID / 喷码机）。（MySQL / SQL Server 数据源方言已在 P8.4 落地，见 §8 与 handover §10.29.2；驱动 `mysql2` / `mssql` 需按需安装。）

详细设计与逐项状态见 [`docs/10-dev-handover.md`](docs/10-dev-handover.md) 与 [`docs/11-saas-and-agent-architecture.md`](docs/11-saas-and-agent-architecture.md)。

---

## 8. 外部系统集成（对接 MES / ERP）

> 本节为对接能力与自动化现状的**盘点 + 选型结论**，基于代码事实核查（2026-11-21）。
> 系统**没有** SAP / 用友 / 金蝶等专用连接器，而是提供通用入站/出站通道，靠配置化对接。
> ⚠️ 标注「已实现」的是代码中确有的能力；标注「建议 / 未实施」的是分析结论，**尚未落地，不得当作已交付**。

### 8.1 对接通道总览

| 方向 | 通道 | 代码落点 | 对接方式 | 状态 |
| --- | --- | --- | --- | --- |
| 入站 | ① SQL 直连 | `datasource.service.ts`、`sql-driver.calc.ts` | 填 MES/ERP 只读库连接串 + 查询模板，直连拉取；postgres / mysql / mssql 三方言，连接串加密、强制只读、参数化，可配 cron/interval 自动刷新 | ✅ 已实现 |
| 入站 | ② 文件 / HotFolder | `hotfolder.service.ts`、`file-parse.ts` | MES/ERP 把 CSV/Excel/JSON/TSV 落到监听目录，文件稳定后自动解析入队打印（BarTender Hot Folder 等价） | ✅ 已实现 |
| 入站 | ③ REST API | `print.controller.ts` | `POST /print/jobs` 提交、`/preview` 预览、`/commands` 出指令；JWT 鉴权，返回 202 + 任务号异步执行 | ✅ 已实现 |
| 入站 | ④ Agent / MCP | `tool.catalog.ts`、`tools.service.ts` | `print.submit_job`、`templates.*`、`inventory.*`、`bom.*`、`alerts.*` 等工具；`GET /agent/v1/tools` 供 MCP 注册，带审批/限流/脱敏 | ✅ 已实现 |
| 出站 | ⑤ Webhook | `webhook.sender.ts` | 投递 `labelflow.trigger` 信封，HMAC-SHA256 签名 + 时间戳防重放、5s 超时，把结果/状态回写客户系统 | ✅ 已实现 |
| 出站 | SSE 实时进度 | `print-stream/events` | 推打印任务实时进度（handler 内手验 token） | ✅ 已实现 |

### 8.2 「MES 扫码入库即自动打印」选型

场景关键：**扫码即触发、无需人工点按钮**。四条候选通道里三条能真正做到全自动：

| 方式 | 链路 | 实时性 | MES 侧改造 |
| --- | --- | --- | --- |
| **① 事件入站 `POST /agent/v1/events/ingest`（推荐）** | MES 扫码后推语义化业务事件（`source=stock.in` + `payload.rows` + 可选 HMAC 签名）→ 归一化/验签 → 入 `trigger` 队列 → 命中 `action=print` 规则 → 自动打印 | 秒级 | 调一个 HTTP 接口 + Agent Token，打印模板/条件/份数全在规则里配（§8.5） |
| **② HotFolder + 触发器 print** | MES 写入库记录到共享目录 → `fs.watch` 检测稳定（500ms）→ 解析 → 入 `trigger` 队列 → 命中规则 → `action=print` 自动打印 | 秒级 | 只写文件，不改代码、不开库 |
| **③ REST API `POST /print/jobs`** | MES 扫码后直接提交任务，返回 202 + 任务号，异步进 BullMQ 打印 | 最快（实时 push） | 调一个 HTTP 接口，需 JWT 凭证；MES 需知道模板/printer 细节 |
| ④ SQL 直连 —— **做不到「扫码即打」** | 拉模式 + 定时刷新（最小间隔 60s），只是把数据同步进来，非事件驱动 | 分钟级 | —— |

**代码证据**：`trigger.service.ts` 的 `runAction` 在 `action === 'print'` 时取 `payload.rows` 直调 `print.createJob({templateId, printerId, rows, copies})`，中间无人工环节；`enqueue` 用事件指纹做 jobId、`claim` 用 dedupeKey 去重，同一扫码事件不重复打印。打印完成事件的生产者也已补齐（`print.processor.ts` 完成时投递 `print.job.completed/failed`）。

**外部事件入站**（§8.5 已实施）：触发器事件源从固定 5 类扩展到 9 类，新增 `stock.in`/`qc.passed`/`workorder.done`/`external.event` 四类外部业务事件；`POST /agent/v1/events/ingest` 让 MES 直接推签名事件触发规则判定，无需落文件、无需知道模板细节。探针验证：`stock.in` 签名事件 → 命中 `action=print` 规则 → 生成去重键 `trig:1:SCAN-1`，未被 `guardLoop` 拦截。

**选型建议**：MES 已是服务化架构、希望业务与打印解耦 → 选 ①，推 `stock.in` 事件 + 在后台配 `stock.in → print` 规则绑模板；MES 只能写文件、不想改接口 → 选 ②；要最直接的实时回执和任务号 → 选 ③。三条都支持多租户隔离 + JWT；HotFolder 为单进程 `fs.watch`，多实例部署要共享存储 + 队列去重。

### 8.3 自动化优化方向（P1/P2 已实施，P3/P4 仍为建议）

现状**「判定层扎实、生产者与事件源已补齐」**：触发器规则归一化、条件求值（fail-closed）、去重（fingerprint + HMAC）、循环防护（`MAX_TRIGGER_DEPTH=3`）都是纯函数 + 单测。按缺口排序的优化项进展：

| 优先级 | 方向 | 状态与说明 |
| --- | --- | --- |
| P1 补齐事件生产者 | 结构性缺口 | ✅ **已实施**：`print.processor.ts` 任务完成时投递 `print.job.completed/failed` 到触发队列（失败只记日志不影响打印结果）；`guardLoop` 禁止「打印事件→再打印」，这类只配 webhook/notification |
| P2 扩事件源 | 解锁新场景 | ✅ **本轮已实施**：新增 `POST /agent/v1/events/ingest` 接收扫码入库/质检合格/工单完工/通用外部事件（§8.5）；`inventory`、`datasource.refresh` 发布 `stock.in`/`datasource.refreshed` 仍属建议 |
| P3 扩动作与编排 | 增强表达力 | ⚠️ **未实施建议**：动作当前仅 `webhook`/`notification`/`print`，可加 `datasource.refresh`（刷新后再打）、延迟/定时触发；一条事件触发「打印+回传+通知」现靠多条规则，无顺序与失败补偿，可引入有序动作序列 + 每步重试 |
| P4 可靠性与运维 | 生产可用 | ⚠️ **未实施建议**：HotFolder 单进程 `fs.watch` 多副本会重复监听，改共享存储 + 队列去重；`trigger_deliveries` 已有 status/errorMsg/durationMs 但无失败率告警与前端投递历史页；补「重放某事件」管理端点 |

> **诚实边界**：8.1/8.2/8.5 基于已实现代码；8.3 中 P3/P4 为**未实施建议**。SQL 直连只读（不写回 MES/ERP），真实连库回归需第二套数据库实例，沙盒无 PostgreSQL/Redis 未实跑；MySQL/MSSQL 驱动未安装时明确报错（不静默假装成功）；无 ESB/MQ 直连（Kafka/RabbitMQ/SAP RFC/IDoc 需自行桥接到文件或 REST）；Webhook 仅出站，接收方需自行验签；所有通道经 `tenant_id` 行隔离 + JWT 鉴权。入站事件端点需 `print:job:write` scope，HMAC 验签可选（配 `INGEST_HMAC_SECRET` 后强制）。

### 8.4 MCP 工具补齐（2026-11-21，已实施）

> 与 8.3（触发器自动化建议，未实施）不同，本节为**已落地代码**。Agent/MCP 工具目录从 22 个增至 **29 个**（`tool.catalog.ts` 为唯一真源，MCP server 从 `GET /agent/v1/tools` 拉取自动注册）。逐项见交接文档 §10.37。

| 新增工具 | 风险 | 用途 | 复用落点 |
| --- | --- | --- | --- |
| `print.list_jobs` | read | 分页查历史任务（状态/模板过滤 + 下一页 cursor） | `PrintService.list` |
| `print.retry_job` | write | 补打/重打（指定序号，复用原流水号避免重号） | `PrintService.retry` |
| `print.preview` | read | 渲染 HTML 预览（不落库不打印） | `renderPrintHtml` |
| `print.commands` | read | 导出 ZPL/TSPL/EPL 指令供审核后再提交 | `RenderService` + 三生成器 |
| `printers.list` / `printers.status` | read | 选打印机 / 连通性探测 | `PrinterService.list/test` |
| `datasource.refresh` | write | 手动刷新 SQL 数据源（数据到位→打印） | `DataSourceService.refresh` |

- **Resource 扩展**：新增 `labelflow://jobs/{id}`、`labelflow://alerts/open`、`labelflow://printers` 三类只读资源（后端 `resource()` + 前端 `resources.ts` 同步）。
- **Prompt 版本**：MCP `prompts/get` 支持 `arguments.version` 取历史版本正文（后端 `GET /agent/v1/prompts/:name?version=N`）。Prompt 的调用计数 `usageCount` 与版本回滚 `rollback()` 为 P6.5 既有能力，本轮只补 MCP 侧版本透传。
- **护栏不变**：全部新工具走 `ToolsService.call()` 统一链（scope → 模块 → 限流 → 配额 → 幂等 → 审批 → 执行 → 脱敏 → 审计）；写工具强制 `idempotency_key`，高危需 `approval_id`；统一信封 `{summary, data, warnings, next_actions}`。
- **刻意不做**：`ai.*`（图片入参 + 计费联动未就绪）、反向 MCP（`external_mcp_servers` 表已有、实现未做，等明确客户需求）——维持既有产品决策，避免半残工具。

### 8.5 扫码即打 · 外部业务事件入站（2026-11-21，已实施）

> 补齐 §8.2 中「MES 不能推自定义扫码事件触发打印」的缺口。逐项见交接文档 §10.38。

**新增端点**：`POST /api/v1/agent/v1/events/ingest`（Agent Token 鉴权，需 `print:job:write` scope）

| 入参 | 说明 |
| --- | --- |
| `source` | 外部事件源：`stock.in` / `qc.passed` / `workorder.done` / `external.event`（内部 `print.*`/`template.*`/`hotfolder.*` 不接受外部伪造） |
| `eventId` | 业务流水号，作幂等键；不传则用内容指纹兜底 |
| `payload` | 业务数据；`payload.rows` 为打印行数组（≤5000 行，每项须为对象） |
| Header `X-LabelFlow-Timestamp` / `X-LabelFlow-Signature` | 可选 HMAC 签名（配 `INGEST_HMAC_SECRET` 后强制，签名口径 `JSON.stringify(body)`） |

**链路**：签名/归一化 → `trigger` 队列（事件指纹去重）→ 规则引擎判定 → 命中 `action=print` → `print.createJob` 自动打印 → 返回 202 + 入队结果。MES 只发「发生了什么」，模板/条件/份数全在后台 `source → print` 规则里配，业务与打印解耦。

- **纯函数判定层**：`jobs/ingest.calc.ts` 的 `normalizeIngest`（验签/事件源白名单/租户隔离/payload 边界/幂等键），零依赖可测；复用 `trigger.calc.ts` 的 HMAC 真源与指纹。
- **安全护栏**：租户只从 Agent Token 解析（请求体 `tenantId` 一律忽略并告警）；触发打印需 `print:job:write` scope；`guardLoop` 不拦外部事件源（避免误判为「打印事件→再打印」）；入站写审计 `agent.event.ingest`。
- **诚实边界**：HMAC 验签默认关闭（未配 `INGEST_HMAC_SECRET` 时仅 Agent Token 鉴权，响应 warnings 显式标注）；真实签名事件驱动真机打印的端到端验收需真库/真机，沙盒仅以纯函数探针验证到规则命中层。

---

## 9. WMS 模块（2026-11-22，阶段一 wms.inbound 已实施）

> 按「方向 A」集成：打印系统保持独立产品线，WMS 通过**内部 HTTP 契约**调用打印能力，以模块订阅（`wms.inbound` 等）售卖。勘察报告 `docs/13-wms-recon-report.md`，阶段一验收 `docs/14-wms-phase1-acceptance.md`。

**核心边界**：WMS 不 import `src/print/**` 或 `src/inventory/**` 内部实现——打印只经 `PrintGateway` → `POST /api/v1/internal/print-jobs`（Bearer service token + `print:job:write` scope），库存只经 `InventoryGateway` 包装 `InventoryService`。租户由 token 注入（请求体 `tenantId` 一律忽略并告警），模板按 `templateCode` 寻址，打印/库存变更均带幂等键（复用 `tool_idempotency`，30 天 TTL 清理）。

| 模块编码 | 名称 | 阶段 |
| --- | --- | --- |
| `wms.inbound` | 收货与上架 | **阶段一（本轮已实施）** |
| `wms.issuing` | 工单发料与齐套 | **阶段二（本轮已实施）** |
| `wms.trace` / `wms.outbound` | 追溯 / 成品发运 | 阶段三 |
| `wms.connector` | ERP/MES 连接器 | 阶段二起单独定价 |

**阶段一 API**（`/api/v1/wms/...`，全部挂 `@RequireModule('wms.inbound')` 订阅门）：建单 / Excel 导入 / 列表 / 详情 / 追加行 / PDA 扫码收货 / 收货过账 / 上架任务列表 / 推荐库位 / 确认上架 / 补打标签。过账编排：更行状态 → `InventoryGateway` 入库（落推荐库位，杜绝无库位库存）→ 生成上架任务 → `PrintGateway` 打印（失败不阻塞、记 failed 审计、可补打）。

- **新增文件**：`backend/src/wms/**`（模块骨架 + 两个 Gateway + inbound 服务/控制器/DTO/实体 + 上架推荐与过账决策纯函数）、`backend/src/agent/internal-print.*`（打印侧内部端点）、`backend/scripts/wms_p1_inbound.sql`（迁移）。
- **模板寻址**：`templates` 表新增 `code` 列（人可读，如 `RECEIPT_LABEL_V1`）+ `(tenant_id, code)` 唯一；阶段一不做多版本，版本用 code 后缀表达。
- **订阅门**：5 个 WMS 模块以 SQL 种子写入 `modules` 表，**存量租户默认不开通**（需手工 INSERT `tenant_modules` 验证）。
- **测试**：新增 14 例（上架推荐规则 5 / PrintGateway 5 / 过账决策 4），全量 `npm test` 675 例、0 失败。
- **诚实边界**：PDA 前端已落地独立 H5（`apps/pda` :5185，zxing-wasm 摄像头扫码 + 手动输入兜底，真机摄像头/扫码硬件仍待实机验收）；阶段一不做同仓移库位（过账已直接入库到推荐位）、不做策略引擎/波次；补打标签需 `WMS_SERVICE_TOKEN` 否则 503；过账为跨服务独立事务（非单一物理事务）。

### 阶段二补充：工单发料与齐套（`wms.issuing`，2026-11-23）

> 开发文档 `docs/16-wms-phase2-dev.md`（A 版 D1–D8）；验收报告 `docs/17-wms-phase2-acceptance.md`。

- **新增**：`backend/scripts/wms_p2_issuing.sql`（4 表：工单/工单行/发料记录/退料记录）、`backend/src/wms/issuing/**`（实体 + 4 个纯函数 + 服务 + 控制器 + 模块）、`InventoryGateway` 扩 6 方法（`resolveMaterial/resolveWarehouse/expandBom/checkKit/decreaseStock/queryBatches`）。
- **17 个端点**（`/api/v1/wms/work-orders...`，全挂 `@RequireModule('wms.issuing')`）：建单 / Excel 导入 / 列表 / 详情 / 加行 / 齐套检查 / 下发 / 取消 / 开始发料 / 扫码校验 / 发料过账 / 完工 / 缺料清单 / 退料 / 关单 / 补打 / 发料记录查询。
- **核心口径**：行需求含损耗（`qty_per×(1+loss)`，`round3`）；批次分配"过期最后 → 近效期 → FIFO"；发料按行、可部分行、可 `force` 留审计；完全无库存行置 `SHORT` 不落记录，部分可用按量发料并记 `PARTIAL`+缺口；重跑不二次扣减（`ISSUE:{woNo}:{line}` 幂等键）；打印旁路失败不阻塞；退料仅 `ISSUED` 可做、先回补再落记录。
- **测试**：新增 49 例（齐套 8 / 流转 10 / 批次分配 10 / 发料计算与扫码 9 / 服务编排 12），全量 `pnpm test` **817 例 / 810 通过 / 0 失败 / 7 跳过**，`pnpm typecheck` 零错误。
- **诚实边界**：真 PG 集成门 G1–G7 **未执行**（开发环境无 Docker/PostgreSQL），迁移后须重跑 `saas_p6_rls.sql` 挂租户隔离；跨服务发料非同事务（只承诺无脏数据 + 重跑收敛）；未种 `ISSUE_LABEL_V1` 模板（缺模板时打印失败但发料成功，可补打）；PDA 发料页面未做。

---

### U5 联动（2026-11-23）：UDI 贯穿收货与发料

> 实施记录 `docs/20-udi-wms-integration.md`。

- 收货扫码带 `udiCode`：自动建档 + 记 `RECEIVE`（`refType=wms_receipt`，幂等键 `RECEIVE:{收货单}:{udiKey}`）。
- 发料扫码/过账带 `udiCode`/`udiCodes`：记 `ISSUE`（`refType=wms_work_order`，幂等键 `ISSUE:{工单}:{行}:{udiKey}`）。
- 状态守卫：一码不可多收、未收货不可发、已发料不可重发（同单/同工单幂等回放）。
- 旁路原则：UDI 失败默认只给 `udiWarning` + 审计，不回滚库存动作；需强校验传 `strictUdi: true`。
- 测试：新增 20 例（纯函数 10 + 追溯服务 8 + 发料编排 2），全量 **837 例 / 830 通过 / 0 失败 / 7 跳过**。
- 诚实边界：未做 GTIN↔物料校验（扫错料不会拦）、未做"码数=数量"校验、未做 `SHIP`/退货联动、真库未验证。

### U5.1 物料 GTIN 与扫错料拦截

> 实施记录 `docs/21-material-gtin-and-scan-match.md`；迁移 `backend/scripts/wms_u5_material_gtin.sql`。

- `materials` 增 `gtin`（GTIN14，租户内唯一）与 `udi_required`；产品资料页可直接维护，列表可见。
- 只收 13/14 位（8/12 位校验位口径与 GTIN14 不一致，录入即拒绝）；物料新增/编辑统一校验并查重。
- 收货扫 UDI：GTIN 不符或 `udi_required` 未扫码 → 拒绝本次扫码（不累加数量），审计留痕；物料未登记 GTIN 则跳过比对不误拦。
- 发料扫码（`issue-scan`）：不符写入 `verdict.mismatches[field=gtin]` 且 `ok=false`，可 `force` 放行留审计。
- 发料过账（`issue-post`）：逐码比对，坏码/错码记失败不阻塞其他行；`udi_required` 行未提供码 → 该行不扣库存。
- 测试：新增 13 例（纯函数 10 + 发料编排 3），全量 **850 例 / 843 通过 / 0 失败 / 7 跳过**；console 构建通过。
- 诚实边界：收货拦截分支无服务级单测（缺 `InboundService` 夹具），需真库验证；一个物料只支持一个 GTIN（不含中包/箱码）；存量物料未回填 GTIN。

### U5.2 多 GTIN（单品/中包/托盘）

> 实施记录 `docs/22-material-multi-gtin.md`；迁移 `backend/scripts/wms_u5_material_gtins.sql`。

- 新表 `material_gtins`：一个物料可挂多个 GTIN，带 `pack_level`（UNIT/CARTON/PALLET）与主码标记；既有单码自动回填。
- 物料维护接口支持 `gtins: [{gtin, packLevel}]`（≤10 条，租户内唯一），仍兼容单个 `gtin` 字段。
- 扫码比对改为**整组匹配**：扫到任意一个码都放行；列表为空则跳过，不误拦。
- 产品资料页 GTIN 改为多行输入（`6901234567892|CARTON` 表达级别）。
- 测试：新增 6 例（纯函数 5 + 发料 1），全量 **856 例 / 849 通过 / 0 失败 / 7 跳过**。
- 边界：包装级别只做标签、不做拆箱数量换算；不支持 SSCC 箱码；真库未验证。

### U5.3 拆箱数量换算（中包/托盘 → 单品）

> 实施记录 `docs/23-pack-qty-conversion.md`；迁移 `backend/scripts/wms_u5_material_gtins.sql`（追加 `pack_qty` 列）。

- `material_gtins` 增 `pack_qty`（每包件数，三位小数）；UNIT 恒为 1，CARTON/PALLET 必须为正数。
- 纯函数 `matchPack` / `convertToUnits`：扫包码命中后 `单品件数 = 包数 × 每包件数`，UNIT 不折算。
- 收货扫码按折算后单品件数累加台账；响应带 `pack` 折算信息，UDI `RECEIVE` 事件 detail 保留包数/件数/级别。
- 产品资料页多行录入第三段件数：`码|CARTON|24`。
- 测试：新增 4 例纯函数，全量 **860 例 / 853 通过 / 0 失败 / 7 跳过**；console 构建通过。
- 边界：发料侧暂不做包码折算；收货折箱分支无服务级单测；不支持 SSCC 箱码与层级递归换算；真库未验证。

---

## 10. 医疗 UDI 合规赋码（2026-11-23，里程碑 U1–U5 已实施）

> 商业化方向见对话决策：医疗 UDI（NMPA 2026 年第 21 号公告，全部二类 2027-06-01 前赋码、全部一类 2029-06-01 前）。
> 实施记录与边界声明见 `docs/18-udi-implementation.md`（U1）与 `docs/19-udi-trace-and-compliance.md`（U2–U4）。

**做了什么**：UDI 数据构造器（GTIN 补位+校验位、GS1 日期、批号/序列号、DI/PI、HRI、元素串 FNC1）、双向解析
（HRI 与原始元素串）、GS1 DataMatrix 渲染通道（bwip 原生 `gs1datamatrix`，`gs1: true` 开关）、扫码复核（字段级比对 + strict 整单校验）、批量构造（Excel 部分成功）、3 个标准模板包。

**API**（`/api/v1/udi/...`）：`GET status` / `GET templates` / `GET templates/:code` / `POST encode` / `POST parse` / `POST scan-verify` / `POST batch`。

**验证**：新增 41 例（构造+解析 29、打印回环 2、服务与模板自洽 10）；全量 `pnpm test` 732 例 / 725 通过 / 0 失败 / 7 跳过。
**打印回环**已证：构造 → bwip 渲染 PNG → zxing 解码 → 反解出 DI/PI。

**U2–U4 追加（2026-11-23）**：
- **PDA 扫码复核页** `apps/pda` → `/udi/verify`（摄像头扫 GS1 DataMatrix，逐字段比对 GTIN/批号/序列号/有效期，通过/失败蜂鸣+震动，最近 10 条实录取样）。
- **UDI 追溯**：`udi_units` / `udi_packages` / `udi_events` 三表（`scripts/udi_p1_trace.sql`），一码追溯 `GET /udi/trace/:code`（正向生产/打印/收货 + 反向发料/出库/退料，含托盘→中包→单品层级）；状态机禁止"未收货先发料"。
- **合规留痕**：`GET /udi/report/print-audit`（按天/按模板统计成功与失败，重打计次、单元去重）+ `GET /udi/export/print-audit.csv`、`GET /udi/export/units.csv`（UTF-8 BOM、防 CSV 公式注入）。
- **真机适配**：`GET /udi/printer-profiles`（Zebra ZD421 / 汉印 N41·SL42 / GODEX RT700i·DT4x 参数矩阵 + 8 步现场校准清单 + 能做/不承诺口径），三款均 `status=POC` 待现场签字。
- **前端入口**：console 新增「UDI 追溯」「UDI 合规留痕」两页（菜单暂挂 `print` 模块门，商业化时换 `udi.compliance`）。

**验证（U1–U4 合计）**：后端全量 `pnpm test` **768 例 / 761 通过 / 0 失败 / 7 跳过**，`pnpm typecheck` 零错误；`apps/pda` 与 `apps/console` 均 `vue-tsc + vite build` 通过。

**诚实边界**：不做 ISO/IEC 15415 质量等级（需硬件验证仪）；不自动上报国家 UDI 数据库（先做导出）；ZPL/TSPL 指令通道的 FNC1 需逐机型真机验收；不含医院端临床扫码；**三张追溯表尚未在真 PostgreSQL 上跑过集成验证**（当前环境无 psql/docker），上线前须执行 `scripts/udi_p1_trace_verify.sql` 的 7 道门（见 `docs/19 §6`）。
**订阅门**：模块 code 预留 `udi.compliance`，正式售卖时在 `modules` / `tenant_modules` 开通并挂 `@RequireModule`。
