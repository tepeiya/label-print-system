# 10. 开发交接文档（面向接手的 AI / 开发者）

> 本文档目标：**任何 AI 或开发者读完本文即可无缝接手继续开发**，不需要再翻历史对话。
> 阅读顺序建议：§10.1 速览 → §10.5 核心约定 → §10.9 已知问题 → **§10.15 SaaS P0（做订阅/权限相关开发前必读）** → **§10.16 SaaS P1 前端动态化（做前端必读）** → §10.17 校验底座 → **§10.18 P2 平台运营后台（动 /platform 或 platform_users 前必读）**。
> 最后更新：2026-11-05（P0/P1 已落地；新增 **§10.17 入参校验底座** + **§10.18 P2 平台运营后台**；上一版对应 commit `c822386`）
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
| 前端 | Vue 3 后台 `http://localhost:5173`（`apps/console/` · pnpm dev）；设计器 iframe 嵌入 `http://localhost:5180`（`web/serve.mjs`） |
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

# 前端：两套并行（Vue 3 后台 + 原生 DOM 设计器 iframe）
# —— 开发态：Vite dev server 5173 自动代理 /api 到后端
cd apps/console && pnpm dev
# —— 同时起原生设计器（Vue 3 的 Designer 页用 iframe 嵌入这个）
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

## 10.2 技术栈与目录结构

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端（后台） | Vue 3 + TS + Vite + Element Plus + Pinia | `apps/console/`；pnpm build 出包后托管到 NestJS 静态目录；设计器用 iframe 嵌入旧版 |
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
│   │   └── __tests__/            # 16 个单测（引擎层；P0 后 src 下另有 99 个，见 §10.15.6）
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
├── web/
│   ├── index.html                # 7 个页签
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
    └── Designer.vue           iframe 嵌入 /designer.html（原生版）
```

> 设计器目前用 iframe 嵌入原生版本（见下），后续逐步 Vue 化：
> `render.js#renderElement` → `<DesignerElement>` 组件
> `interactions.js` → `useDrag()` 组合式
> `store.js` → Pinia store

### 10.7.2 原生 DOM 设计器（web/ —— 老版本，iframe 嵌入）

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
| 设计器（12 类元素、标尺/网格/参考线、撤销重做、快捷键、复制粘贴） | ✅ | 原生实现 |
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
cd backend && npm test     # 125 条全通过（core/__tests__ 16 + src/**/__tests__ 109，见 §10.15.6 分布）
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
   `cd backend && npm test` → **125 条全通过**（原 `core/__tests__` 16 条 + `html-renderer` 10 条仍在）。
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

## 10.10 未完成路线图

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
| `backend/scripts/p0-acceptance.sh` | §11.11.1 可重跑验收脚本（62 条断言） |

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
cd backend && npm test                       # 125 条（原 26 → P0 新增 89 → P1 新增 2 → 校验底座新增 8）
T_CODE=p0a1 T2_CODE=p0a2 bash backend/scripts/p0-acceptance.sh   # 62 项断言，期望「通过 62 / 失败 0」
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
> 本轮同时改两套前端：`apps/console`（Vue 3 + Element Plus，要构建）和 `web/`（零构建原生 DOM，
> 设计器 iframe 就走这套）。两套读的是同一个 `/auth/me`，只改一套会出现「console 里看不到的入口，
> 在设计器里照样能点」。

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

- 计费/账单/发票（P3）；`/platform/v1` 独立前缀（仍挂在 /api/v1 下）；
- 模拟登录 impersonate（§11.6.2 列了，风险高，单独排期）；
- platform_users 的 CRUD UI（后台只有种子账号，加人直接 SQL）；refresh token 机制。
