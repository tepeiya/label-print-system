# 标签管理与打印系统（LabelFlow）

> 一套可商用的专业标签设计 / 打印 SaaS。覆盖拖拽式可视化设计器、变量 / 公式 / 流水号 / 条码二维码、多打印机通道、多租户隔离、批量打印与任务队列、SaaS 订阅计费、Agent / MCP 接入、AI 模板生成，以及库存 / 主数据 / 齐套 / 呆滞预警等企业治理能力。

> **接手开发请先读 [`docs/10-dev-handover.md`](docs/10-dev-handover.md)** ——
> 面向 AI / 开发者的权威交接文档：运行环境与端口、模块地图、核心 schema 约定、
> 已完成清单、已知技术债、路线图、踩坑记录、自测清单。本文档只做总览与快速上手。

> **前端现状（重要）**
> - ✅ 主前端：`apps/console`（Vue 3 + TypeScript + Vite + Element Plus + Pinia）租户后台 `:5173`
> - ✅ 平台运营后台：`apps/platform` `:5181`；Agent/MCP Server：`apps/mcp-server` `:3300`
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

- **包管理**：后端 `npm`（`package-lock.json`，同时保留 `pnpm-lock.yaml`）；前端各 `apps/*` 用 **pnpm**（`pnpm-lock.yaml`）。
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
| 打印通道 | ✅ 浏览器打印 / 9100 Raw TCP / 本地代理 / 服务端出图 | 4 类 Provider |
| 输出 | ✅ ZPL / TSPL / EPL 指令 + 位图 PNG + 整标签矢量 SVG / PDF | golden 快照测试 |
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

---

## 4. 快速开始（开发态）

### 环境约定（与 `docs/10-dev-handover.md` 一致）

| 服务 | 宿主端口 | 容器 / 内部端口 | 说明 |
| --- | --- | --- | --- |
| 后端 API | **3200** | 3200 | `http://localhost:3200/api/v1` |
| PostgreSQL | **5433** | 5432 | 容器网内 `postgres:5432` |
| Redis | **6380** | 6379 | 容器网内 `redis:6379` |
| console 租户后台 | 5173 | — | Vite dev，代理 `/api` → 3200 |
| platform 平台后台 | 5181 | — | Vite dev |
| MCP Server | 3300 | — | Agent/MCP HTTP |
| 老 web（弃用） | 5180 | 80 | 仅对照 |

> 端口 `3000` 属其他项目，禁止占用。

### 启动

```bash
# 一键全家桶（PG + Redis + API + Worker + 老 web）
docker compose up -d

# 或本地分进程
cd backend && npm i && npm run start:dev          # API :3200
cd apps/console && pnpm i && pnpm dev             # 租户后台 :5173（推荐）
cd apps/platform && pnpm i && pnpm dev            # 平台后台 :5181
# 老版原生前端（⚠️ 已弃用，仅作对照）：node web/serve.mjs 5180
```

> 数据库脚本 `synchronize: false`，建表 / 权限种子需手工执行 —— 见 §5。

---

## 5. 数据库脚本（手工执行，幂等）

项目关闭了 TypeORM 的自动同步，所有 DDL 与权限种子都在 `backend/scripts/`。首次部署 / 升级按依赖顺序执行：

| 脚本 | 用途 |
| --- | --- |
| `docs/03-database.sql` | 基础表（模板 / 用户 / 打印任务等） |
| `saas_p0.sql` / `saas_p0_roles.sql` | 租户 / 模块 / RBAC 权限点种子 |
| `saas_p2_platform.sql` / `saas_p3_billing.sql` | 平台运营 / 计费 |
| `saas_p4_agent.sql` / `saas_p5_agent_tools.sql` | Agent / 工具权限 |
| `saas_p6_*.sql` | 白标 / 独立库 / RLS / Prompt 库 / Prompt 版本历史 / 租户数据 |
| `saas_p7_notifications.sql` | 通知 |
| `saas_p8_governance.sql` / `saas_p8_hardware.sql` / `saas_p8_triggers.sql` | 治理 / 硬件 / 自动化触发 |
| `inventory_*.sql` | 主数据 / 库存 / 库位 / 产品组 / 产品打印 / 自定义字段 / BOM / 呆滞预警 |
| `seed.sql` / `seed-inventory-demo.sql` | 演示数据 |

> **加购模块**（`inventory` 基础模块之上）：`masterdata` / `bom` / `alert` 等需给目标租户开通 `tenant_modules` 后，模块门才放行、菜单才出现。示例：
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
| 多租户隔离 | ✅ 守卫 + BaseRepository + RLS 代码 | 查询强制带 tenant_id |

### 运行测试

```bash
cd backend
pnpm typecheck                 # tsc --noEmit
pnpm test                      # node:test + tsx，覆盖 core/**/__tests__ 与 src/**/__tests__
# 当前：约 635 例，628 通过 / 0 失败 / 7 跳过

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

1. **最高优先：条码设计 / 打印核心能力打磨**（产品命根子）——已完成旋转/对齐/双面、拼版、真矢量 PDF、出血/裁切线/套准线/CMYK 近似色标、collate/拆分、弧形文字/条码、缩略图 DPI（第二层）；GS1 官方全量 AI 字典、打印后解码验证闭环、HIBC/PZN 校验、MaxiCode `^BD` 构造器（第三层）；富文本 runs、表格合并单元格、DB 字段元素（第四层）；仍待：指令/真机解码验证、富文本指令/矢量通道样式还原、打印机偏移校准真机验收。
2. **上线前技术债**：RLS 切到 `labelflow_app`（无 BYPASSRLS）角色、独立库真连库验收、白标真实 DNS / 证书、通知通道（代码已就绪，待配网关）、独立库物理备份策略。
3. **按需功能缺口**：MySQL / SQL Server 数据源方言、更多 MCP 工具、高级计费（发票 / 退款 / 多币种）、Prompt 调用统计深化、Nest 容器级 E2E、前端测试、硬件层真机验收（Windows 打印代理 / RFID / 喷码机）。

详细设计与逐项状态见 [`docs/10-dev-handover.md`](docs/10-dev-handover.md) 与 [`docs/11-saas-and-agent-architecture.md`](docs/11-saas-and-agent-architecture.md)。
