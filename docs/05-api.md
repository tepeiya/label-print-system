# 5. 后端 API 清单

> 统一约定：
> - **Base**：`/api/v1`
> - **统一响应体**：`{ code: 0, message: 'ok', data: T, traceId: string }`；`code≠0` 为业务/异常。`page` 接口 `data: { list: T[], total, page, pageSize }`。
> - **鉴权**：除登录/刷新外，均需 `Authorization: Bearer <accessToken>`。
> - **租户隔离**：所有接口由网关注入 `tenant_id`，**URL/Body 不接收租户参数**；Controller 仅用 JWT 中的 tenantId。
> - **权限**：标注所需角色/资源权限（见 RBAC + ACL）。
> - **分页**：`?page=1&pageSize=20&sort=updatedAt,desc`。

## 5.1 鉴权与用户

> **v2（2026-11-04）对齐代码实际实现**。权限名以 `backend/src/common/roles.guard.ts` 为准：`admin / operator / sql / viewer`。

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | `{username, password, tenantCode?}` | `{accessToken, refreshToken, expiresIn}` | 公开 |
| POST | `/auth/refresh` | `{refreshToken}` | `{accessToken, refreshToken}` | 公开 |
| POST | `/auth/logout` | `{refreshToken}` | `{ok:true}` | 登录用户 |
| GET | `/auth/me` | — | `User`（含 roles 数组、tenant 信息） | 登录 |
| GET | `/users` | — | `User[]`（每个用户带 `roles: string[]`） | admin |
| POST | `/users` | `{username, password, displayName?, email?, status?}` | `User` | admin |
| PATCH | `/users/:id` | `{displayName?, email?, status?}` | `{ok:true}` | admin |
| DELETE | `/users/:id` | — | `{ok:true}` | admin（不能删自己的账号） |
| POST | `/users/:id/reset-password` | `{newPassword: string}` | `{ok:true}` | admin（重置后该用户所有 refresh token 强制下线） |
| POST | `/users/:id/roles` | `{role: 'admin'\|'operator'\|'sql'\|'viewer'}` | `{ok:true, already?:boolean}` | admin |
| DELETE | `/users/:id/roles/:role` | — | `{ok:true}` | admin（**最后一位 admin 不能撤销自己的 admin 角色**） |

> **安全保护（后端双重校验 + 审计）**：
> - 不能删除 / 停用自己的账号
> - 不能撤销当前租户最后一位 admin 的 admin 角色
> - 重置密码 → 该用户全部 refresh_tokens 清空（所有会话强制下线）
> - 所有写操作自动写 `audit_logs`：`user.create / user.update / user.delete / user.reset_password / user.grant_role / user.revoke_role`

## 5.2 模板

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| GET | `/templates` | `?category&tag&keyword&favorite` | `Page<TemplateMeta>` | view |
| POST | `/templates` | `{name, category?, tags?, content}` | `Template` | template_designer |
| GET | `/templates/:id` | — | `Template`（含 content） | view（ACL） |
| PUT | `/templates/:id` | `{name?, content?}` | `Template`（新版本+1） | edit（ACL） |
| DELETE | `/templates/:id` | — | `{ok}` | super_admin/edit |
| POST | `/templates/:id/copy` | `{name?}` | `Template` | template_designer |
| POST | `/templates/:id/favorite` | — | `{favorite}` | 任意 |
| GET | `/templates/:id/versions` | 分页 | `Page<VersionMeta>` | view |
| GET | `/templates/:id/versions/:v` | — | `Version`（content 快照） | view |
| POST | `/templates/:id/versions/:v/rollback` | — | `Template` | edit |
| GET | `/templates/:id/versions/diff?a=&b=` | — | `Diff[]` | view |
| GET | `/templates/:id/thumbnail` | — | `image/png` | view |
| POST | `/templates/:id/share` | `{userId, perms[]}` | `Share` | share（ACL） |

## 5.3 导入导出 / 备份

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/templates/export` | `{ids:[]}` 或 `*`(整租户) | `.ziptpl` 文件流 | export |
| POST | `/templates/import` | `multipart .ziptpl` + `?conflict=overwrite\|skip\|copy` | `{imported[], skipped[]}` | template_designer |
| GET | `/tenant/backup` | `?kind=manual` | `.zip`（全量，脱敏） | super_admin |
| POST | `/tenant/backup/restore` | `multipart .zip` + `?conflict=` | `{report}` | super_admin |
| GET | `/tenant/backups` | 分页 | `Page<Backup>` | super_admin |

## 5.4 变量 / 公式（校验，不落库）

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/formula/eval` | `{expr, vars:{}}` | `{value, error?}` | 任意登录 |
| POST | `/formula/validate` | `{expr}` | `{ok, error?, deps:[]}` | 任意登录 |

## 5.5 流水号

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| GET | `/serial-sequences` | 分页 | `Page<SerialSeq>` | 任意登录 |
| POST | `/serial-sequences` | `{name,scope,start,step,digits,prefix,suffix,radix,resetCycle,consumeMode,rollbackPolicy}` | `SerialSeq` | template_designer |
| PUT | `/serial-sequences/:id` | 部分字段 | `SerialSeq` | template_designer |
| POST | `/serial-sequences/:id/reset` | `{to?}` | `{currentValue}` | template_designer |
| GET | `/serial-sequences/:id/usage` | 分页 | `Page<UsageLog>` | 任意登录 |
| GET | `/serial-sequences/:id/segment-preview?n=100` | — | `{from,to,preview:[]}` | 任意登录 |

> **批量打印时号段分配在后端内部调用 `SerialNumberService.allocate(tenantId, ref, n)`**，不暴露为公开 REST（避免被绕过并发控制）。

## 5.6 条码 / 二维码预览

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/barcode/preview` | `{sym, content, opts}` | `image/png` | 任意登录 |
| POST | `/barcode/validate` | `{sym, content}` | `{ok, error?}` | 任意登录 |
| POST | `/qrcode/preview` | `{sym, content, ecc, size}` | `image/png` | 任意登录 |

## 5.7 打印机

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| GET | `/printers` | 分页 | `Page<Printer>` | print_operator |
| POST | `/printers` | `{name,type,connection,dpi,w,h,offset,density,speed}` | `Printer` | super_admin |
| PUT | `/printers/:id` | 部分字段 | `Printer` | super_admin |
| DELETE | `/printers/:id` | — | `{ok}` | super_admin |
| POST | `/printers/:id/calibrate` | `{offsetXMm,offsetYMm}` | `{ok}` | print_operator |
| POST | `/printers/:id/test` | — | `{ok, roundtripMs}` | print_operator |

## 5.8 数据源 / 批量打印

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/data-sources/upload` | `multipart csv/xlsx` + `fieldMap` | `{sourceId, rows, columns[]}` | template_designer |
| POST | `/data-sources/preview` | `{sourceId, templateId, limit=10}` | `{rows:[]}`（变量映射后） | 任意登录 |
| POST | `/print/jobs` | `{templateId, printerId, dataSource?, rows?, copies, params}` | `{jobId, status}` | print_operator |
| GET | `/print/jobs/:id` | — | `PrintJob`（含进度） | print_operator |
| POST | `/print/jobs/:id/cancel` | — | `{ok}` | print_operator |
| POST | `/print/logs/:id/reprint` | `{copies?}` | `{jobId}` | print_operator |
| GET | `/print/logs` | 分页/筛选 | `Page<PrintLog>` | print_operator |

## 5.9 审计

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| GET | `/audit/logs` | 分页/action 筛选 | `Page<AuditLog>` | super_admin |
| GET | `/audit/print-logs` | 分页 | `Page<PrintLog>`（导出） | super_admin |

## 5.9b AI 模板生成

> 完整设计（算法/提示词/成本/局限性）见 `09-ai-template-generation.md`。

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/ai-template/generate` | `multipart`：`image`（≤10MB，jpg/png/webp）+ `targetWidthMm` + `targetHeightMm` + `dpi` + 可选 `tagMode` / `variableHintKeywords` / `serialHint` | `200` → `AiTemplateGenerateResponse`（template + meta）；`202` → `{jobId, status, estimatedMs}` | admin / operator |
| GET | `/ai-template/status/:jobId` | — | `{jobId, status, result?, errorMsg?}` | admin / operator |
| POST | `/ai-template/save` | `{template, meta?}`（用户校验后提交） | `Template` | admin / operator |
| POST | `/ai-template/regenerate-element` | **multipart/form-data**：`file`（原图）+ `elementId`（string）+ `currentElement`（JSON 字符串）+ `widthMm` / `heightMm` / `dpi` + 可选 `lang` / `variableHintKeywords` / `useLlm` | `{element, confidence, warnings[], model, llmUsed, llmError?, elapsedMs}` | admin / operator |
| GET | `/ai-template/models` | — | `AiModelConfig[]`（API Key 脱敏） | admin |
| POST | `/ai-template/models` | `{name, provider, apiEndpoint, apiKey, modelId, isDefault}` | `AiModelConfig` | admin |
| DELETE | `/ai-template/models/:id` | — | `{ok}` | admin |

**AI 生成错误码（追加）**

| code | 含义 |
| --- | --- |
| 4001 | 图片格式不支持（仅 jpg/png/webp/tiff） |
| 4002 | 缺少 `targetWidthMm` / `targetHeightMm` / `dpi` |
| 4003 | 图片超过 10MB |
| 4004 | 图片解码失败（文件损坏或非图片） |
| 5021 | Vision LLM 服务不可用 / 超时 |
| 5022 | OCR 服务不可用 |
| 5023 | LLM 返回结构不符合 LabelTemplate 契约（自动降级为启发式结果） |
| 4291 | 超出每日 AI 生成配额（默认 50 次/租户） |

## 5.10 错误码（节选）

| code | 含义 |
| --- | --- |
| 0 | 成功 |
| 1001 | 未认证 / token 失效 |
| 1003 | 租户越权（tenant_id 不匹配） |
| 1004 | 资源权限不足（ACL） |
| 2001 | 模板 schema 校验失败 |
| 2002 | 公式循环依赖 |
| 2003 | 公式语法错误 |
| 3001 | 流水号分配冲突（重试） |
| 4001 | 条码内容非法/字符集不支持 |
| 5000 | 打印机连接失败 |

## 5.11 控制器示例（NestJS，展示租户隔离注入）

```ts
@Controller('templates')
@UseGuards(JwtAuthGuard, TenantGuard)   // TenantGuard 将 tenantId 写入 req.tenantId
export class TemplateController {
  constructor(private svc: TemplateService) {}

  @Get()
  // 注意：方法签名不含 tenantId 参数，tenantId 由 req 提供，前端无法越权
  list(@Req() req, @Query() q: ListQuery) {
    // 服务端强制用 req.tenantId 查询，审计/隔离在此落地
    return this.svc.list(req.tenantId, q);
  }

  @Get(':id')
  async get(@Req() req, @Param('id') id: string) {
    // 内部 WHERE id=? AND tenant_id=? ，不存在即 404（不暴露存在性）
    return this.svc.getOwned(req.tenantId, +id);
  }
}
```

## 5.12 实现补充（当前代码已落地、设计稿未列出的接口）

> **注意**：用户管理相关接口（`GET/POST/PATCH/DELETE /users`、`reset-password`、`roles`）已在 §5.1 v2 完整列出，本节不再重复。
> 本表聚焦"不属于 5.1–5.11 主干章节但实际已实现"的接口。

| 方法 | 路径 | 入参 | 出参 | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/print/preview` | `{templateContent, rows, copies}` | HTML 字符串 | 服务端按 mm/pt 渲染打印 HTML（与前端共用元素语义） |
| POST | `/print/commands` | `{templateContent, rows, copies, protocol, dpi, widthMm, heightMm, gapMm, offsetXMm, offsetYMm, density, speed, serialMap}` | `{protocol, text, labelCount, bytes, dpi, warnings[]}` | 导出 ZPL / TSPL；`warnings` 提示码制降级与中文字库依赖 |
| GET | `/print/jobs` | `?status&page&pageSize` | `[rows, total]` | 打印队列分页 |
| GET | `/print/jobs/logs` | `?jobId&status&pageSize` | `PrintLog[]` | 逐张打印日志（追溯/回读） |
| GET | `/print/jobs/:id/logs` | `?page&pageSize` | `[rows, total]` | 单任务逐张日志 |
| POST | `/print/jobs/:id/retry` | `{seqNos?: number[]}` | `{jobId, status, reprintOf}` | 整单补打 / 指定序号补打（复用原流水号） |
| POST | `/print/jobs/:id/reprint` | 同上 | 同上 | 与 retry 等价（语义化别名） |
| POST | `/data-sources/rows` | `{name, type: csv/excel/tsv/json, headers, rows, fieldMap, config}` | `{sourceId, rows, columns, headers}` | 前端解析 Excel/CSV/TSV/JSON 后统一入库（源类型存 `config.sourceType`） |
| GET | `/data-sources` | — | `DataSource[]` | 数据源列表（含字段映射） |
| GET | `/data-sources/:id/rows` | `?limit&offset` | `DataRow[]` | 读取数据行（批量打印/预览） |
| DELETE | `/data-sources/:id` | — | `{ok}` | 删除数据源及其数据行 |
| GET | `/templates/:id/export` | — | `{template, schemaVersion}` | 单模板导出（前端再打包为 `.ziptpl`） |
| POST | `/printers/:id/test-commands` | `{protocol}` | `{protocol, text, bytes}` | 打印机自检指令（不落纸） |

### ZPL / TSPL 码制覆盖

| 能力 | ZPL | TSPL |
| --- | --- | --- |
| 文本（UTF-8） | `^CI28` + `^A0N,h,w` + `^FH` 转义 | `TEXT ... "FONT001"`（中文依赖打印机字库） |
| 一维码 | Code128 `^BC`、Code39 `^B3`、Code93 `^BA`、EAN13 `^BE`、EAN8 `^B8`、UPC-A `^BU`、UPC-E `^B9`、ITF `^BI`、Codabar `^BK`、MSI `^BM` | `BARCODE ... "128/39/93/EAN13/EAN8/UPCA/UPCE/ITF14/ITF/CODABAR/MSI"` |
| 二维码 | QR `^BQ`、DataMatrix `^BX`、PDF417 `^B2`、Aztec `^BO` | 仅 `QRCODE`；其它码制降级为 QR 并返回 `warnings` |
| 图形 | 矩形 `^GB`、椭圆 `^GE`、线（细长矩形） | `BOX` / `ELLIPSE` / `BAR` |
| 页面 | `^LH` 偏移、`^PQ` 份数、`~SD` 浓度、`^PR` 速度 | `SIZE` / `GAP` / `DIRECTION` / `DENSITY` / `SPEED` / `PRINT` |

## 5.13 命令行工具（`tools/labelctl.mjs`）

```bash
# 登录（token 缓存在 ~/.labelflow-token.json，过期自动重登）
node tools/labelctl.mjs login

node tools/labelctl.mjs templates --limit 20
node tools/labelctl.mjs printers
node tools/labelctl.mjs print --template 7 --rows data.csv --copies 2
node tools/labelctl.mjs commands --template 7 --protocol zpl -o label.zpl
node tools/labelctl.mjs jobs --status success --limit 10
node tools/labelctl.mjs retry 4 --seq 1,3
node tools/labelctl.mjs audit --limit 10
```

环境变量：`LABELFLOW_API`（默认 `http://localhost:3200/api/v1`）、`LABELFLOW_USER` / `LABELFLOW_PASS`、`LABELFLOW_TOKEN`。

---

## 5.14 P8 新增端点（2026-11-13）

### 5.14.1 自动化触发器（P8.1，租户 JWT）

| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| GET | `/triggers` | — | 本租户触发器列表（`config` 已剔除 `secret`/`secretEnc`） |
| GET | `/triggers/:id` | — | 单条详情 |
| GET | `/triggers/:id/deliveries?limit=50` | — | 投递历史（去重/成功/失败可追溯） |
| POST | `/triggers` | `{name,source,action,conditionExpr?,config,enabled?}` | 新建；写操作限 admin/operator |
| PATCH | `/triggers/:id` | 同上（可只传部分字段） | 更新；未重填 `secret` 时保留旧密文 |
| DELETE | `/triggers/:id` | — | 删除规则（保留 delivery 历史供审计） |
| POST | `/triggers/:id/test` | `{payload?}` | **dryRun**：只返回命中计划，不打印、不发 Webhook |

- `source`：`print.job.completed` / `print.job.failed` / `template.updated` / `hotfolder.file` / `subscription.expiring`。
- `action`：`webhook` / `notification` / `print`。条件表达式用公式引擎语法，变量写 `{{name}}`（与模板 `printIf` 同源）。
- `config` 按动作不同：
  - `webhook`：`{url, secret?}`（**仅 https**；`http://localhost` 需 `allowHttpLoopback:true` 且仅调试用；内网/回环/云元数据地址一律拒绝）。请求带 `X-LabelFlow-Timestamp` + `X-LabelFlow-Signature: sha256=<hmac>`，5s 超时。
  - `notification`：`{title, body, category?}` → 站内信。
  - `print`：`{templateId, printerId?, copies?}` → 文件到达即打印。
  - `hotfolder.file` 额外支持：`{directory, onSuccess?: archive|delete|keep}`。
- 后台事件统一走 BullMQ `trigger` 队列（进程内 EventEmitter 跨 worker 不生效）；`dedupe_key` 部分唯一索引兜并发，命中重复不重复打印。
- V1 **未接订阅模块 gating**（`menu.catalog` 无 `automation` 模块码，误挂会让所有租户 4031），权限只用角色，P8.3 统一补 permission 码。

### 5.14.2 印刷级导出（P8.2，与 `/print/commands` 同口径：自带模板 JSON，不读业务库）

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| POST | `/print/export/svg` | `{templateContent, rows?, copies?, serialMap?}` | `{format:'svg', sheets[], sheetWidthMm, sheetHeightMm, labelCount, perSheet, cols, rows, warnings[]}` |
| POST | `/print/export/pdf` | 同上 + `dpi?`（72–1200，默认 600） | `application/pdf` 二进制；响应头 `X-LabelFlow-Pages` / `X-LabelFlow-Warning-Count` / `X-LabelFlow-Warnings`（URI 编码） |

- SVG 是**整标签真矢量**：文本 `<text>`、图形 `<rect>/<ellipse>/<line>`、码制内联 bwip-js 的 `<path>`；矩阵拼版（`columns`/`rows`/`gapXMm`/`gapYMm`/`marginMm`）与浏览器打印口径一致。
- PDF 由 SVG 按 600dpi 栅格化嵌入 pdf-lib，页面尺寸按 `mm→pt`（1mm = 72/25.4pt）精确换算；**PDF 内部不是矢量**、无 CMYK/专色/出血，`warnings` 会显式声明。
- 总标签数上限 5000、PDF 页数上限 200，超限报错不静默截断。中文文本依赖渲染端系统字体，缺字时 `warnings` 提示。

---

## 5.15 P8.3 / P8.4 / P8.5 新增端点（代码已落地，验收边界见 `docs/10 §10.29–§10.30`）

> 所有端点沿用统一响应体 + 租户 JWT + `tenant_id` 行级隔离。新增业务表均带 `tenant_id` + RLS 兜底，
> 部署需按序执行 `saas_p8_triggers.sql` → `saas_p8_governance.sql` → `saas_p8_hardware.sql`。

### 5.15.1 企业治理（P8.3，`/governance`）

| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| GET | `/governance/policy` | — | 本租户治理策略（经 `normalizePolicy` 归一化） |
| PUT | `/governance/policy` | `{templateApproval?, dedupePrint?, printQuota?, watermark?}` | 保存策略；默认全宽松，未配置租户行为不变 |
| GET | `/governance/templates/:id` | — | 模板治理状态（无记录 = 未纳管，所有前置校验放行） |
| GET | `/governance/templates/:id/reviews` | — | 审批历史 |
| POST | `/governance/templates/:id/review` | `{action, comment?, publishedVersion?}` | `submit / approve / reject / request_change / archive / publish`；非法迁移 400 |
| GET | `/governance/dedupe?limit=50` | — | 防重打印记录 |
| DELETE | `/governance/dedupe?beforeDays=` | — | 清理过期防重记录 |

- 生产打印由 `PrintService.createJob()` **强制注入**治理前置校验（不通过写 `print.job.blocked_by_governance` 审计并 403），前端无法绕过。
- `POST /print/preview` 新增可选 `watermark`，`/print/export/svg` 与 `/print/export/pdf` 新增可选 `watermark`：**水印只叠加在 SVG / HTML / PDF 通道，ZPL/TSPL/EPL 指令通道不叠加**，响应里通过 `watermarkApplied` / `watermarkChannelNote` 明示。
- 防重键 `printFingerprint()` = `tenantId + templateId/scope + rows` 稳定哈希；`print_dedupe` 唯一索引 + `ON CONFLICT` 兜并发（真库并发未实跑）。

### 5.15.2 数据源与 GS1（P8.4）

| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| GET | `/data-sources/drivers` | — | 支持的驱动清单：postgres（内置）/ mysql（需 `npm i mysql2`）/ mssql（需 `npm i mssql`） |
| POST | `/data-sources/:id/lookup` | `{filters, limit?}` | 按字段查找：SQL 源执行查询、CSV/Excel 源读已导入行，再内存过滤；列名过 `SAFE_IDENT` 校验 |
| POST | `/data-sources/:id/refresh` | — | 手动刷新：真执行 SQL → 写 `data_rows` → 写审计与 `lastRefreshAt` |
| GET | `/data-sources/:id/refresh-plan` | — | 归一化刷新计划 + 上次刷新时间/行数/错误 |
| PUT | `/data-sources/:id/refresh-config` | `{refresh:{enabled,intervalSec?,cron?,replaceRows?}}` | 配置自动刷新并**同步 BullMQ repeatable 调度** |
| GET | `/data-sources/refresh-schedule?limit=100` | — | 运维：当前队列已登记的刷新任务（只返回 name 与周期，无 DSN） |
| POST | `/data-sources/refresh-bootstrap` | — | 运维：手动触发启动期调度对齐（Redis 恢复后无需重启） |
| GET | `/gs1/ai-catalog` | — | GS1 AI 字典目录（约 60 个精确 AI + 5 类模式族，声明非全量规范） |
| GET | `/gs1/ai/:ai/help` | — | 单个 AI 的字段帮助与示例 |
| POST | `/gs1/validate` | `{content}` | 整串 `(01)...(10)...(17)...` 合规校验、FNC1 分隔、errors/warnings/humanReadable |

- `SaveSqlDto` 新增 `driver?` / `refresh?`；`SqlExecDto` 新增 `offset?`（SQL 级分页）。
- 自动刷新走独立队列 `datasource_refresh`：`DATASOURCE_REFRESH_SCHEDULER_ENABLED=0` 可关；改配置时按 `reconcileRepeat()` 先撤销旧 key 再注册新 key，参数相同不重复注册；Worker 用目录库构造 `TenantCtx` 后复用 `refresh()`。
- MySQL / SQL Server 驱动懒加载，**未安装时明确报错**，不静默假装成功；沙盒无第二套数据库实例，真连库未实跑。
- MaxiCode / HIBC 系列 / PZN 走 `protocol=image` 位图通道，前端标「预览仅·需图像通道」，无 ZPL/TSPL/EPL 原生指令。

### 5.15.3 硬件层（P8.5，`/hardware`）

| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| POST | `/hardware/agents/register` | `{agentId,name?,capabilities[],driverNames?,metadata?}` | 注册/重新注册（**重新注册会轮换密钥**）；明文 `secret` 仅此一次返回 |
| GET | `/hardware/agents` | — | 代理列表 + 在线状态（不返回 `secret_enc`） |
| POST | `/hardware/agents/:agentId/heartbeat` | `{load?,capabilities?,draining?,version?}` | 心跳；返回 `serverTime` + 待办数 |
| POST | `/hardware/agents/:agentId/jobs/pull` | `{limit?}` | 拉取待办（能力匹配 + 在线校验 + 单次上限 10），返回脱敏 `envelope` 并标记 `claimed` |
| POST | `/hardware/agents/:agentId/receipts` | `{jobKey,tenantId,status,printedCount?,error?}` | 回执；jobKey/agentId/tenant_id 三重匹配 + 状态机，终态不可改写 |
| POST | `/hardware/agents/sweep` | — | 回收认领超时任务（300s）或标记 `expired` |
| POST | `/hardware/rfid/encode` | `{gtin,companyPrefixLen,serial,filter?}` | SGTIN-96 编码 → `epcHex` / `tagUri` / `decoded` |
| POST | `/hardware/rfid/write-job` | `{epc,jobId?}` | 生成 RFID 写操作信封（**不宣称已写入设备**） |
| POST | `/hardware/rfid/verify-read` | `{epc,readBack,jobId?}` | 写后读回比对；`verified=false` 落 `hardware_rfid_logs` |
| GET | `/hardware/inkjet/capabilities` | — | 行数/字符/触发模式上限与厂商中立声明 |
| POST | `/hardware/inkjet/job` | `{rows,config,jobId?,includePayload?}` | 生成喷码作业；`includePayload:true` 附厂商中立文本载荷 |

- `windows_spooler` Provider 已注册：打印任务不再抛「未注册的打印 Provider」，而是入队等待本地代理拉取。`provider.ok=false` 现在会让该张标签记 `failed`（此前被误记 `success`）。
- 代理主鉴权用租户 JWT；HMAC 签名默认关闭，`HARDWARE_AGENT_SIGNATURE_REQUIRED=1` 开启后需带 `X-LabelFlow-Timestamp` / `X-LabelFlow-Signature: sha256=<hmac>`（签名串为 `JSON.stringify(payload)`，算法与 §5.14.1 Webhook 同源）。
- **信封脱敏硬约束**：`connection` 只允许 `driverName` 出域，host/port/user/password/dsn/token 一律剔除并记入 `redactedFields`。冒烟已验证 `NO_SECRETS:true`。
- **真机未验收**：本地代理客户端、Windows 驱动打印、USB/串口、RFID 读写器指令、喷码机品牌协议均未实现。逐项验收清单见 `docs/10 §10.30.3`，未全绿前不得对外承诺可用。
