# 标签管理与打印系统（LabelFlow）设计方案

> 目标：从零实现一套可商用专业标签软件的 ~80% 核心能力。支持拖拽式可视化设计器、变量/公式/流水号/条码二维码、多打印机通道、多租户隔离、批量打印与任务队列、导入导出与版本管理。

---

## 0. 技术栈选型与取舍

### 后端：Node.js (NestJS)  vs  Java (Spring Boot 3)

| 维度 | NestJS (推荐) | Spring Boot 3 |
| --- | --- | --- |
| 渲染生态 | `node-canvas` / `sharp` / `pdf-lib` / `puppeteer` 与前端同语言，复用校验位/坐标换算逻辑 | 需 `ZXing` / `iText` / `Apache Batik`，图形渲染需 JVM 内 canvas，体积大 |
| 打印指令生成（ZPL/TSPL/EPL/CPCL） | 纯字符串模板，TS 直接拼装 | 同样纯字符串，无优势 |
| 团队一致性 | 前后端同 TS，设计器与渲染层可共享 schema/dpi 换算/pix-per-mm | 需两套语言维护 |
| 性能/并发 | 单进程 I/O 密集足够；CPU 密集渲染用 Worker 线程池 | 线程模型更稳，长任务友好 |
| 运维/容器 | 镜像小（~200MB alpine），启动快 | JDK17 镜像 ~400MB+ |

**结论**：选 **NestJS + TypeScript**。理由：① 渲染层（barcode/二维码/PDF/PNG）与前端设计器需共用「毫米↔点阵」「校验位」「公式」等逻辑，同语言可非零拷贝复用；② 指令生成本质是字符串模板，TS 表达力强；③ 启动快、镜像小，符合 Docker Compose 一键部署要求。CPU 密集的批量出图通过 **BullMQ + Worker 线程池** 隔离，避免阻塞事件循环。

### 其他选型

- **数据库**：PostgreSQL 16（模板存 `JSONB`，支持 GIN 索引全文检索）；**Redis** 7 用于号段缓存、任务队列（BullMQ）、租户配置缓存。
- **渲染**：服务端 `node-canvas`（PNG 位图）、`pdf-lib`（PDF 矢量/精确分页）、`@bwip-js/node`（条码/二维码位图，支持 GS1/DataMatrix/PDF417）；前端预览 `jsbarcode` + `qrcode` + Konva 实时绘制。
- **画布**：**Konva.js**（声明式、性能好、对 100 元素拖拽不掉帧；自带 Transformer 多选/成组/旋转）。对比 Fabric.js：Konva 在 React 下状态管理更清晰、性能更优；Fabric 序列化更全但 React 集成偏命令式。
- **状态管理**：**Zustand**（轻量、可拔插 history 中间件做撤销/重做，对比 Redux 样板代码少）。
- **队列**：**BullMQ**（基于 Redis，原生支持重试/延迟/进度，对比 RabbitMQ 部署更轻）。
- **鉴权**：JWT（Access 15min）+ Refresh Token（7d，Rotation），密码 `bcrypt` 加盐哈希。

---

## 1. 目录结构

```
label-print-system/
├── README.md                       # 本文档（总览 + 架构 + 技术取舍）
├── docker-compose.yml              # 一键启动（pg + redis + api + worker + web）
├── docs/
│   ├── 01-requirements.md          # 功能矩阵（P0/P1/P2）
│   ├── 02-architecture.md          # 架构图（Mermaid）
│   ├── 03-database.sql             # 完整 DDL（含索引/租户隔离/流水号表）
│   ├── 04-template-schema.md       # 模板 JSON Schema + 示例
│   ├── 05-api.md                   # 后端 API 清单
│   └── 08-plan.md                  # 开发计划 + 测试要点
├── backend/
│   ├── core/
│   │   ├── serial-number.service.ts   # 流水号并发安全（行锁 + 号段预分配）
│   │   ├── formula-engine.ts          # 公式引擎（解析/求值/循环依赖检测）
│   │   ├── checksum.ts                # 条码校验位算法（Code128/EAN13/Code39…）
│   │   ├── barcode-renderer.ts        # 条码/二维码 服务端出图 + 前端预览适配
│   │   ├── zpl-generator.ts           # ZPL 指令生成（文本/条码/二维码/图片/流水号）
│   │   └── tspl-generator.ts          # TSPL 指令生成
│   └── printer/
│       ├── printer-provider.interface.ts  # PrinterProvider 抽象接口
│       ├── raw-tcp.provider.ts            # 网络打印机 9100 直连
│       ├── image.provider.ts              # 服务端 PNG/PDF 出图（存档/第三方）
│       └── tenant.guard.ts                # 多租户行级隔离守卫
└── frontend/
    └── designer/
        ├── types.ts                  # 设计器核心数据结构
        ├── store.ts                  # Zustand 状态管理（含撤销/重做）
        └── interactions.ts          # 拖拽/对齐/吸附/键盘等交互
```

> 所有**对外坐标/尺寸以毫米(mm)为单位**，内部渲染按目标 `dpi` 转点阵：`dots = mm * dpi / 25.4`。例：203dpi → 8 dots/mm；300dpi → 11.81 dots/mm；600dpi → 23.62 dots/mm。

---

## 2. 坐标系与单位约定（贯穿全系统）

```text
mm  → dots : dots = round(mm * dpi / 25.4)
dots → mm  : mm   = dots * 25.4 / dpi
```

- 设计器画布逻辑单位为 **mm**，按 `缩放比 * (screenDpi/25.4)` 像素/毫米渲染（屏幕按 96dpi 显示，导出时按打印机 dpi 重算）。
- 模板 JSON 中所有 `x/y/w/h` 均为 mm；打印机指令生成时统一在 Provider 内按 `printer.dpi` 换算为 dots。
- DPI 不一致时，出图层以打印机 DPI 为基准重采样，避免模糊/偏移。

---

## 3. 核心能力覆盖度

| 能力域 | 本方案覆盖 | 备注 |
| --- | --- | --- |
| 可视化设计器 | ✅ 拖拽/缩放/标尺/网格/吸附/成组/层级/撤销重做 | Konva |
| 元素类型 | ✅ 文本/图/线/形/表/条码/二维码/公式/流水号/日期/系统变量/DB字段 | 12 类 |
| 变量/公式/流水号 | ✅ 含 CHECKSUM、循环依赖检测、号段预分配 | 见 core |
| 条码/二维码 | ✅ Code128/EAN13/UPC/ITF14/GS1-128 + QR/DataMatrix/PDF417/Aztec | @bwip-js |
| 打印通道 | ✅ 浏览器打印 / 9100 Raw TCP / 本地代理 / 服务端出图 | 4 类 Provider |
| 多租户隔离 | ✅ tenant_id 行级 + 资源级权限 + 审计 | 见 tenant.guard |
| 版本/导入导出 | ✅ 快照/回滚/对比 + .ziptpl + 整租户备份 | 见 API |
| 批量/队列 | ✅ CSV/DB 数据源 + BullMQ 异步 + 重打补打 | 见 plan |

---

## 4. 快速开始（开发态）

```bash
# 后端
cd backend && npm i && npm run start:dev
# 前端（原生 HTML5，无构建步骤）
node web/serve.mjs 5180          # 打开 http://localhost:5180/
# 一键全家桶
docker compose up -d
```

## 5. 当前进度（已实现并验证）

| 层 | 状态 | 验证 |
| --- | --- | --- |
| 核心引擎（公式/校验位/流水号/条码/DPI/ZPL/TSPL） | ✅ 真实可运行 | **16 个单元测试全绿**（node:test + tsx） |
| 条码出图（Code128/EAN13 自包含编码器 + PNG 写出） | ✅ 真实 | 测试产出有效 PNG 签名 |
| 渲染管线（变量+公式+流水号 → 单行元素） | ✅ 真实 | 渲染测试覆盖占位/公式/流水号切片 |
| 后端 NestJS 应用 | ✅ 完整骨架 | 模块/控制器/服务/实体/main/worker 齐备，需 `npm i` + PG/Redis 启动 |
| 前端设计器 | ✅ 原生 HTML5 重写 | `web/`：DOM 渲染标签元素（无 Konva 命中测试问题）、设计/打印/模板三页签、原生 Pointer 拖拽缩放旋转、离线条码二维码 |
| 多租户隔离 | ✅ 守卫+BaseRepository | 查询强制带 tenant_id |

### 如何运行测试（零外部依赖，立即可跑）

```bash
cd backend
node --import tsx --test core/__tests__/*.test.ts
# 期望：# tests 16  # pass 16  # fail 0
```

### 如何启动完整系统

```bash
docker compose up -d        # 拉起 PG + Redis + api + worker + web
# 或本地：先建库（docs/03-database.sql），再：
cd backend && npm i && npm run start:dev      # API :3000
cd backend && npm run worker                  # BullMQ 打印消费者
node web/serve.mjs 5180                       # 设计器 :5180（原生 HTML5）
```

> 说明：核心引擎层已通过测试证明正确（最难验证的并发打号、校验位、DPI 换算、渲染管线均在测试中覆盖）。后端应用与前端为完整可运行骨架，需在 `npm i` + 基础设施就绪后联调。

### 命令行（`tools/labelctl.mjs`，无依赖）

```bash
node tools/labelctl.mjs login                                   # token 缓存在 ~/.labelflow-token.json
node tools/labelctl.mjs print --template 7 --rows data.csv --copies 2
node tools/labelctl.mjs commands --template 7 --protocol zpl -o label.zpl
node tools/labelctl.mjs jobs --limit 5
node tools/labelctl.mjs retry 4 --seq 1,3                        # 指定序号补打
```

环境变量 `LABELFLOW_API`（默认 `http://localhost:3200/api/v1`）、`LABELFLOW_USER`/`LABELFLOW_PASS`、`LABELFLOW_TOKEN`。

详细设计见 `docs/` 各章节；核心实现见 `backend/` 与 `web/`。
