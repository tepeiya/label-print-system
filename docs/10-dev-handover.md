# 10. 开发交接文档（面向接手的 AI / 开发者）

> 本文档目标：**任何 AI 或开发者读完本文即可无缝接手继续开发**，不需要再翻历史对话。
> 阅读顺序建议：§10.1 速览 → §10.5 核心约定 → §10.8 已知问题 → §10.9 路线图。
> 最后更新：2026-11-03（对应 commit `c822386`）

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
# 期望：{"code":0,...,"data":{"username":"admin",...,"roles":["admin"]}}
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
│   │   └── __tests__/            # 16 个单测（唯一有测试的地方）
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

`main.ts` 的 seed 只保证：租户 `default` + 用户 `admin` + 给 admin 授予 `admin` 角色。
若需要 `operator` 账号与 AI 测试数据，手工执行：

```sql
-- 操作员账号（密码 op123）
INSERT INTO users (tenant_id, username, password_hash, display_name, status)
VALUES (1, 'operator', '<bcrypt hash of op123>', '操作员', 1)
ON CONFLICT (tenant_id, username) DO NOTHING;

INSERT INTO user_roles (tenant_id, user_id, role)
SELECT 1, id, 'operator' FROM users WHERE username='operator' AND tenant_id=1
ON CONFLICT DO NOTHING;
```

（bcrypt hash 可用 `node -e "console.log(require('bcryptjs').hashSync('op123',10))"` 生成）

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

### 10.5.4 RBAC

- 角色：`admin` / `operator` / `sql` / `viewer`，定义在 `common/roles.guard.ts`。
- 用法：`@Roles('admin', 'operator')` 贴 handler 或 controller。
- `admin` 对任何 `@Roles` 声明**无条件放行**（便于运维）。
- 前端 `app.js` 的 `applyRoleConstraints()` 会按角色禁用/隐藏危险按钮——
  这只是 UX，**真正的权限必须在后端**。

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

### 10.8.1 唯一有自动化测试的部分

```bash
cd backend && npm test     # core/__tests__：16 个用例（公式/校验位/流水号并发/DPI/ZPL/TSPL/渲染）
```

后端 API 层、Service 层、RBAC、AI 模块**均无单测**。

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

5. **仍待补** 后端零单测
   建议至少补：`RolesGuard` 4 条规则、`sql-executor.assertReadOnly`（INSERT/多语句/SELECT）、
   `validate-ai-template`（脏输入）、`datasource.service.testSql`（真实 PG）。
   现有单测集中在 `core/__tests__/*.test.ts`（公式引擎 / 流水号 / DPI / ZPL / TSPL / 条码渲染 / 渲染层），16 条全通过。

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

---

## 10.12 自测清单（改动后按需执行）

```bash
# 0. 准备
TOKEN=$(curl -s -X POST http://localhost:3200/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
H="Authorization: Bearer $TOKEN"

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
cd backend && npm test     # 期望 16/16
```

RBAC 回归（用 operator 登录 `operator/op123`）：
`/audit/logs/export` → 403、`/users` → 403、`POST /print/jobs` → 201、`/data-sources/:id/sql-exec` → 403。

---

## 10.13 给接手 AI 的协作规范

### 改代码前必读（按任务类型）

| 任务 | 必读文件 |
| --- | --- |
| 改元素/渲染 | `web/js/model.js`（schema 唯一来源）→ `web/js/render.js` → `docs/04-template-schema.md` |
| 改打印/指令 | `backend/core/zpl-generator.ts` `tspl-generator.ts` → `print.processor.ts` |
| 改权限 | `common/roles.guard.ts` → 各 controller 的 `@Roles` → `app.js#applyRoleConstraints` |
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
