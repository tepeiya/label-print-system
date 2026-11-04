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
