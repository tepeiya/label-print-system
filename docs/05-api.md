# 5. 后端 API 清单

> 统一约定：
> - **Base**：`/api/v1`
> - **统一响应体**：`{ code: 0, message: 'ok', data: T, traceId: string }`；`code≠0` 为业务/异常。`page` 接口 `data: { list: T[], total, page, pageSize }`。
> - **鉴权**：除登录/刷新外，均需 `Authorization: Bearer <accessToken>`。
> - **租户隔离**：所有接口由网关注入 `tenant_id`，**URL/Body 不接收租户参数**；Controller 仅用 JWT 中的 tenantId。
> - **权限**：标注所需角色/资源权限（见 RBAC + ACL）。
> - **分页**：`?page=1&pageSize=20&sort=updatedAt,desc`。

## 5.1 鉴权与用户

| 方法 | 路径 | 入参 | 出参 | 权限 |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | `{username, password}` | `{accessToken, refreshToken, expiresIn}` | 公开 |
| POST | `/auth/refresh` | `{refreshToken}` | `{accessToken, refreshToken}` | 公开 |
| POST | `/auth/logout` | `{refreshToken}` | `{ok:true}` | 登录用户 |
| GET | `/users/me` | — | `User` | 登录 |
| GET | `/users` | 分页/搜索 | `Page<User>` | super_admin |
| POST | `/users` | `{username,email,password,roles[]}` | `User` | super_admin |
| PUT | `/users/:id/roles` | `{roles[]}` | `User` | super_admin |

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
