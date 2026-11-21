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
| POST | `/print/commands` | `{templateContent, rows, copies, protocol, dpi, widthMm, heightMm, gapMm, offsetXMm, offsetYMm, density, speed, serialMap}` | `{protocol, text, textBase64, textExact, labelCount, bytes, dpi, warnings[]}` | 导出 ZPL / TSPL / **EPL**（`protocol ∈ zpl\|tspl\|epl`）。**含位图段（TSPL `BITMAP`、EPL `GW`、ZPL `^GFA`）时 `textExact=false`：`text` 只能看不能用，下发与存盘必须用 `textBase64` 的字节**；`bytes` 是真实字节数 |
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
| POST | `/printers/:id/test-commands` | `{protocol}` | `{protocol, text, bytes}` | 打印机自检指令（不落纸）；`protocol ∈ zpl\|tspl\|epl`，与 `/print/commands` 同一白名单 |

### ZPL / TSPL / EPL 码制覆盖

> **单一真源是 `backend/core/barcode-caps.ts` 的 `CAP_MATRIX`（`CAP_MATRIX_VERSION` 版本化）**，
> 生成器、Console 副本（`apps/console/src/views/designer/barcode-caps.ts`）、单测守卫、验收脚本都以它为准。
> 下表只是人读摘要，**与矩阵冲突时以矩阵为准**（历史上这张表写过 `ITF=^BI`、`PDF417=^B2`，两处都是错的，
> 打出来是另一种符号或直接不打印 —— 见 docs/10 §10.27）。
> 状态口径：`原生` = 协议有原生指令；`位图` = 无原生指令，服务端用 bwip-js 出点阵走图像通道（可扫，但不是打印机原生符号）；
> `仅预览` = 连位图通道都不给（一维符号栅格化会破坏条空比例），生成器直接跳过 + warning，绝不换码制。

| 码制 | ZPL | TSPL | EPL |
| --- | --- | --- | --- |
| CODE128 | 原生 `^BC` | 原生 `"128"` | 原生 类型码 `1` |
| GS1_128 | 原生 `^BC` + FNC1（`>;` 起始、变长 AI 间 `>8`） | 原生 `"EAN128"`（**不是** `"128"`） | 仅预览：类型码 `1E` 存在，但 FNC1/AI 分隔转义写法查不到 |
| CODE39 / CODE93 | 原生 `^B3` / `^BA` | 原生 `"39"` / `"93"` | 原生 `3`/`3C` / `9` |
| EAN13 / EAN8 / UPC-A / UPC-E | 原生 `^BE` / `^B8` / `^BU` / `^B9` | 原生 `"EAN13"` / `"EAN8"` / `"UPCA"` / `"UPCE"` | 原生 `E30` / `E80` / `UA0` / `UE0` |
| ITF / ITF14 | 原生 `^B2`（`^BI` 是 Industrial 2 of 5，`^B7` 是 PDF417） | 原生 `"ITF"` / `"ITF14"` | `2` / `2`（EPL 无 ITF-14 类型码，不含边框承载 → degraded） |
| CODABAR / MSI | 原生 `^BK` / `^BM` | 原生 `"CODABAR"` / `"MSI"`（校验位用 `MSIC`） | `K` / 仅预览（`M`=MSI-3、`L`=Plessey，校验算法被固件写死） |
| PHARMACODE / CODE16K | 仅预览（手册无 `^B`；`^BB` 是 Codablock 不是 Code16K） | 仅预览 | 仅预览 |
| QRCODE | 原生 `^BQ`（model 2） | 原生 `QRCODE` | 位图 `GW`（`b` 2D 指令语法查不到） |
| MICROQR | 位图 `^GFA` | 位图 `BITMAP` | 位图 `GW` |
| DATAMATRIX / DATAMATRIX_RECT | 原生 `^BX` / 位图（矩形尺寸越出 `columns,rows` 9–49） | 位图 `BITMAP` | 位图 `GW` |
| PDF417 / AZTEC | 原生 `^B7` / 原生 `^B0` | 位图 `BITMAP` | 位图 `GW` |
| 含 GS1 `(AI)` 的二维符号 | **一律位图**：`^BX/^B7/^B0/^BQ` 的 FNC1 转义写法无可引用依据，硬编会静默丢 AI 结构 | 同左 | 同左 |
| 文本 | `^CI28` + `^A0N,h,w` + `^FH` 转义（UTF-8） | `TEXT ... "FONT001"`（中文依赖打印机字库） | `A` 指令拉丁字体 1–5；CJK 需亚洲机型字库且 DATA 要是 GBK 字节 |
| 图形 | `^GB` / `^GE` / 细矩形 | `BOX` / `ELLIPSE` / `BAR` | 仅预览：手册有 `X`、`LO/LS/LW/LE` 但参数几何含义说法不一致，不猜 |
| 页面 | `^LH` 偏移、`^PQ` 份数、`~SD` 浓度、`^PR` 速度 | `SIZE`/`GAP`/`DIRECTION`/`DENSITY`/`SPEED`/`OFFSET`/`PRINT` | `N`/`q`/`Q`/`D`/`S`/`Z`/`P`；无 OFFSET 指令（偏移等价折算成坐标平移） |

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

## 5.16 第三层 · 码制专业性端点（2026-11-20，验收边界见 `docs/10 §10.32`）

> 与 `/print/export` 同口径：自带数据、纯内存计算、不读业务库、无 DB 副作用，不挂 TenantGuard。

| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| POST | `/print/verify/image` | `{imageBase64, expected, sym, formats?}` | 解码上传的条码图（PNG/JPEG，可带 data: 前缀）并与期望文本比对；返回 `{verdict:{match,grade,score,reason,...},candidates[]}`。grade=exact/normalized/none |
| POST | `/print/verify/roundtrip` | `{expected, sym, dpi?}` | 三方一致性自检：服务端 bwip 渲染→zxing 解码→判定；返回 `verdict` + `candidates` + `pngBase64`（留档）+ `zxingFormats` + `boundary` 声明 |
| POST | `/print/maxicode/zpl` | `{text?, structured?, mode?, n?, t?}` | 构造 UPS MaxiCode 原生 ZPL `^BD` 片段。text 用于 Mode 4/5/6 自由数据；structured 用于 Mode 2/3（`{mode,serviceClass,countryCode,postalCode,postalExtension?,lowPriority?}`）。返回 `{zpl,escapedData,warnings,boundary}`；参数非法返回 400 |

- GS1 AI 字典扩到官方 541 项：`lookupAi` 优先级 = 中文精调 65 项 → 模式族 → 官方全量 → null；`gs1Catalog().totalFull` 反映合并总数。既有 GS1 校验端点/公式 `encodeGs1` 行为不变（精调层优先）。
- `checksum()` 公式新增两方案：`CHECKSUM('HIBC', data)` → Mod43 校验字符；`CHECKSUM('PZN', base7)` → Mod11 校验位（余数 10 抛错）。
- **解码性能**：zxing-wasm 首次初始化约 20s（进程内一次），之后单次解码 5–15ms。验证端点在生产常驻进程无此开销；单测用同一进程预热，全量测试约 +22s。
- **诚实边界**：解码闭环只覆盖 bwip 位图通道；指令通道与真机/扫描枪未验。MaxiCode 默认仍走位图「预览仅」，`^BD` 为显式 opt-in；Mode 2/3 结构化数据错误会被 UPS 拒收。详见 `docs/10 §10.32`。

## 5.17 第四层 · 设计器交互精度（2026-11-21，**无新增 HTTP 端点**）

> 本层为纯设计态数据模型 + 渲染通道改动，不改变现有 API 契约与 golden 快照。模板 JSON 中元素新增以下可选字段，旧模板无需迁移（缺省走原逻辑）。详见 `docs/10 §10.33`。

**模板元素新增字段**（`schemaVersion:1` 的 `elements[]` 内）：

| 字段 | 元素 type | 结构 | 说明 |
| --- | --- | --- | --- |
| `runs` | `richtext` | `RichTextRun[]` = `{text, bold?, italic?, underline?, color?, size?, script?:'sub'｜'super'}[]` | 富文本逐段样式；run 覆盖优先于元素级 `font`。HTML 通道完整还原；指令/SVG/PDF 降级纯文本 + warning |
| `dbField` | `dbField` | `{field, datasetId?, format?, fallback?}` | 字段绑定：`field` 可为字面字段名或 `{{var}}` 占位，从数据行同名取值；`format` 支持 `upper`/`num:N`/`date:图案`；空值取 `fallback`。`datasetId` 预留（当前未联查） |
| `mergedCells` | `table` | `{row, col, rowSpan, colSpan}[]` | 合并单元格（行列 0 基，P8 AI 表格识别既有契约）；越界/重叠自动钳制去冲突。HTML 按 span 跳格、矢量按主格画框 |

- 渲染服务 `render.service.ts`：`richtext` 逐 run 插值保样式，`dbField` 按数据行取值 + 格式 + 空值 fallback；`toZplElements`/`toTsplElements`/`toEplElements` 对富文本取纯文本拼接。
- 前端设计器 `types.ts`/`model.ts`/`engine/` 与后端 `core/{rich-text,table-layout}.ts` 为 parity 副本，保证设计态预览与出图语义一致。
- **诚实边界**：富文本样式跨指令/矢量通道不保留；表格仅矩形合并、`datasetId` 跨数据集联查未实现、非 locale 完备格式。均在渲染结果 `warnings` 中标注。

## 5.18 第五层 · 数据绑定/工具（2026-11-21，**无新增 HTTP 端点**）

> 本层为公式函数扩展，不改变现有 API 契约。模板变量 / 公式字段新增两个白名单函数，详见 `docs/10 §10.34`。

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `LOOKUP` | `LOOKUP(key, table, default?)` | 从表按 key 取首列值；未找到 / 空值取 `default`（缺省空串）。常用于变价表 `LOOKUP({{sku}}, {{prices}})` |
| `VLOOKUP` | `VLOOKUP(key, table, col?, default?)` | 从表按 key 取第 col 个数据列（1-based，默认 1）；越界 / 未找到取 `default`。常用于物料映射 `VLOOKUP({{sku}}, {{mat}}, 2)` |

**表数据格式**（`table` 参数为字符串，支持三种）：
- JSON 对象：`'{"A100":12.5,"B200":9.9}'` → key → 单列值
- JSON 行数组：`'[["A100","MAT1","E"],["B200","MAT2","W"]]'` → 首列 key，其余为数据列
- 紧凑 KV 文本：`'A100=7.5;B200=9.9'`（分号/换行分行，`=`/`:` 分隔键值，值可用 `,`/`|` 分多列）

- 表数据通过 `{{var}}` 从数据行 / 变量注入，或在公式内直接写 KV 文本字面量。
- 后端 `core/lookup-table.ts` 与前端 `engine/lookup-table.ts` 为 parity 副本，`lookup-table.parity.test.ts` + `formula-parity.test.ts` 锁定两端一致。
- **诚实边界**：表数据须为字符串；后端 tokenize 不支持字符串内转义，故公式内内联 JSON（含双引号）不可用，JSON 必须走 `{{var}}` 注入；key 精确匹配，无模糊/区间匹配；`ai.*` 工具属有意推迟的产品决策，非缺口。

## 5.19 MCP 工具补齐（2026-11-21，工具目录 22 → 29）

> `GET /agent/v1/tools` 是当前 token 可见工具清单（MCP server 启动据此注册）；`POST /agent/v1/tools/:tool` 统一调用。本轮新增 7 个工具 + 3 类 Resource + Prompt 版本参数，详见 `docs/10 §10.37`。

| 工具 | 风险 | 入参要点 | 说明 |
| --- | --- | --- | --- |
| `print.list_jobs` | read | `status?`、`limit?`、`cursor?`（页码）、`template?` | 返回 `{items, total, page, pageSize, nextCursor}` |
| `print.retry_job` | write | `job_id`、`seq?`（序号数组）、`idempotency_key` | 复用原数据+流水号补打，避免重号 |
| `print.preview` | read | `template`、`rows?`、`copies?` | 返回完整 HTML + 张数，不落库不打印 |
| `print.commands` | read | `template`、`rows?`、`copies?`、`protocol?`、`dpi?` | 返回 ZPL/TSPL/EPL 指令文本 |
| `printers.list` | read | 无 | 打印机清单，供选机 |
| `printers.status` | read | `id` | 连通性探测，只读 |
| `datasource.refresh` | write | `id`、`idempotency_key` | 仅 SQL 数据源，真执行落 `data_rows` |

**Resource（MCP `resources/read`）**：新增 `labelflow://jobs/{id}`、`labelflow://alerts/open`、`labelflow://printers`。

**Prompt 版本（MCP `prompts/get`）**：`arguments.version=N` 取历史版本正文；后端对应 `GET /agent/v1/prompts/:name?version=N`（不传则返回当前版本）。版本回滚与调用计数为 P6.5 既有管理端能力（`POST /agent-prompts/:name/rollback`、`GET /agent-prompts/:name/versions`）。

- 写工具（risk≠read）强制 `idempotency_key`；高危（risk=high）需 `approval_id` 或 `dry_run`；全部经 `ToolsService.call()` 统一护栏链与统一信封 `{summary, data, warnings, next_actions}`。
- **诚实边界**：真库/真机 IO 未端到端验收（沙盒无 PG/Redis）；`print.preview` 返回 HTML 非图片；`ai.*` 与反向 MCP 维持刻意不注册。
