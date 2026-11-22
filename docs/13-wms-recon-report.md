# WMS 模块集成 —— 代码勘察报告（第 4 章交付物）

> 性质：本文档是 WMS 开发任务**第 4 章前置勘察**的交付物，按"文件路径 + 关键代码摘录 + 结论"逐项输出。
> 勘察基线：本地 `main` = `origin/main` = `48e4ad6`，工作区干净。勘察时间 2026-11-22。
> 原则：**勘察发现与开发文档冲突时，以仓库现状为准，并在本报告标注冲突点（见第 11 节），不静默改设计。**
> 本报告确认前不写任何 WMS 业务代码。

---

## 勘察结论速览

| 项 | 勘察主题 | 结论 |
|---|---|---|
| 1 | tenant_modules / 订阅门 | ✅ 现成（DB 表驱动 + 全局 Guard + 装饰器），但**模块是数据行不是代码枚举** |
| 2 | RLS 策略 | ✅ 现成（动态扫描 `tenant_id` 列自动挂策略），WMS 新表自带 `tenant_id` 即自动覆盖 |
| 3 | 打印模块入口 | ✅ 现成但需适配：`createJob` 按 `templateId` 寻址且依赖 ALS 上下文；**模板表无 `code` 字段**；**无 internal 端点** |
| 4 | inventory 服务接口 | ✅ 现成统一 Service（`InventoryService`），`adjustStock`/`transferStock`/`queryStock`/`checkKit` 可直接包装为 Gateway；**无"暂存位"概念** |
| 5 | Agent Token / service token | ✅ 可完整复用（token 带 tenant_id + scope + HMAC + 请求体租户忽略范式全现成） |
| 6 | tool_idempotency | ✅ 现成（claim/finish/release + 唯一索引 + 30 天 TTL 清理任务） |
| 7 | API 组织规范 | ✅ 明确（全局前缀 `api/v1`、class-validator、4031 错误码）——**文档路径 `/api/wms` 需对齐为 `/api/v1/wms`** |
| 8 | 迁移工具 | ✅ 裸 SQL 脚本（`backend/scripts/*.sql`，无 TypeORM migration 运行器） |
| 9 | 测试框架 | ✅ node:test + tsx，测试按 `src/**/__tests__/*.test.ts` 组织 |
| 10 | 前端 / PDA | ⚠️ **不存在独立移动端与扫码硬件封装，需新建**（桌面端 Vue3 齐备） |

---

## 1. tenant_modules 表结构 / 模块枚举 / 订阅门拦截

**文件路径**
- `backend/scripts/saas_p0.sql`（`modules` / `tenant_modules` / `plan_modules` DDL + 种子）
- `backend/src/entities/saas.entity.ts`（`TenantModule` / `ModuleRecord` 实体）
- `backend/src/common/module.guard.ts`（订阅门 Guard + `@RequireModule` 装饰器）
- `backend/src/saas/modules.service.ts`（订阅查询 + 60s 缓存）
- `backend/src/common/business.errors.ts`（`ModuleNotSubscribedException` = 4031）

**关键代码摘录**

```sql
-- saas_p0.sql:49
CREATE TABLE tenant_modules (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  module_code VARCHAR(40) NOT NULL REFERENCES modules(code) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
         CHECK (status IN ('trial','active','expired','disabled')),
  source VARCHAR(20) NOT NULL DEFAULT 'plan'
         CHECK (source IN ('plan','purchase','trial','gift','manual')),
  UNIQUE (tenant_id, module_code)
);
-- saas_p0.sql:85 模块目录是「数据行」种子，不是代码枚举
INSERT INTO modules (code, name, description, icon, sort_order, is_core) VALUES
  ('print','标签打印',...,10,TRUE), ('templates',...), ('ai',...), ...;
```

```typescript
// module.guard.ts:26-44
const codes = this.reflector.getAllAndOverride<string[]>(MODULE_KEY, [ctx.getHandler(), ctx.getClass()]);
if (!codes?.length) return true;              // 无声明 → 放行
const tenantId = req.user?.tenantId ?? 0;
const enabled = await this.modulesSvc.listTenantActive(tenantId);  // 自己查 DB，不依赖 ALS
if (!codes.some(c => enabled.includes(c))) throw new ModuleNotSubscribedException(...);  // 4031
// module.guard.ts:17
export const RequireModule = (...codes: string[]) => SetMetadata(MODULE_KEY, codes);
```

**结论**
- 订阅门现成：在 WMS Controller/Handler 上加 `@RequireModule('wms.inbound')` 即可拦截，未开通返回 4031（action=upgrade）。Guard 已全局注册（见第 7 项）。
- `module_code` **不是代码里的 enum/联合类型**，而是 `modules` 表的 `code` 行（VARCHAR(40)）。全链路（plan_modules/tenant_modules/permissions）都以外键引用它。因此"在枚举定义处追加 5 个 WMS 模块"的实际动作是：**新建迁移脚本 INSERT 5 行到 `modules` 表**，无需改 TS 类型。
- ⚠️ **冲突点 C1**：开发文档 7.1 说"在 module_code 枚举定义处追加"——仓库无此枚举，改为 SQL 种子 INSERT。

---

## 2. RLS 策略定义方式 / 租户上下文设置

**文件路径**
- `backend/scripts/saas_p6_rls.sql`（RLS 主脚本）
- `backend/src/common/tenant-data-source.manager.ts`（`applyTenantScope` / `withTenantScope`）
- `backend/src/common/tenant.context.ts`（`TenantCtx` / AsyncLocalStorage）

**关键代码摘录**

```sql
-- saas_p6_rls.sql:81-102 动态扫描所有含 tenant_id 的表，逐表挂同名策略
FOR r IN SELECT c.table_name FROM information_schema.columns c ... WHERE c.column_name = 'tenant_id'
LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
  EXECUTE format($pol$ CREATE POLICY tenant_isolation ON public.%I
      AS PERMISSIVE FOR ALL TO labelflow_app
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint) $pol$, r.table_name);
END LOOP;
-- 2c 防御检查：任何含 tenant_id 却无策略的表 → RAISE EXCEPTION
```

```typescript
// tenant-data-source.manager.ts:222
async applyTenantScope(runner, tenantId) {
  await runner.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(tenantId)]); // 事务级 GUC
}
```

**结论**
- RLS 是"第二道防线"：仅对 `labelflow_app` 角色生效，主链路 owner 默认绕过。策略按会话变量 `app.tenant_id` 过滤，未设置时 fail-closed（一行看不到）。
- **WMS 所有新表只要带 `tenant_id` 列，重跑 `saas_p6_rls.sql` 即自动纳入 RLS 覆盖**（动态扫描 + 2c 防御检查保证不漏）。
- 应用层租户上下文：`TenantCtx`（AsyncLocalStorage）由 `TenantContextInterceptor` 填充；写事务用 `withTenantScope(tenantId, fn)` 打 GUC。WMS Service 全部以 `TenantContext` 为第一参数是正确方向。

---

## 3. 打印模块现有入口（模板解析 / 打印机路由 / 任务表 / 云打印调度）

**文件路径**
- `backend/src/print/print.service.ts`（`createJob` 核心）
- `backend/src/entities/template.entity.ts`（`Template` / `TemplateVersion`）
- `backend/src/entities/print.entity.ts`（`PrintJob` / `PrintLog` / `Printer`）
- `backend/src/print/print.controller.ts`（现有 REST 端点，`@Controller('print/jobs')`）
- `backend/src/print/print.processor.ts`（BullMQ 消费 / 云打印调度）

**关键代码摘录**

```typescript
// print.service.ts:113
async createJob(dto: { templateId?: number; printerId?: number; rows?: any[]; copies?: number; ... }) {
  const tenantId = useTenantId();                                  // ← 依赖 AsyncLocalStorage
  const tpl = await this.tpls.findOne({ where: { id: dto.templateId, tenantId } }); // ← 按 ID 寻址
  if (!tpl) throw new NotFoundException('模板不存在');
  ...
  const job = await this.jobs.save({ tenantId, templateId, ..., dataRef: { rows, serialMap, templateContent: tpl.content } });
  await this.queue.add('print', { jobId: job.id, ... }, { jobId: `print-${job.id}` }); // BullMQ 入队
  return { jobId: job.id, status: 'queued', ... };
}
```

```typescript
// template.entity.ts:7-19 —— 模板表字段：无 code
export class Template {
  id; tenantId; uuid; name; category; tags; description;
  schemaVersion; content; currentVersion; acl; ...
}
// print.entity.ts:29 PrintJob: templateId / printerId / status / dataRef / params
```

**结论**
- 打印能力完整：模板按 `currentVersion` 解析、打印机路由、BullMQ(`print` 队列) 调度、任务表 `print_jobs`、审计/计费/治理前置均在 `createJob` 内编排。
- ⚠️ **冲突点 C2**：模板寻址——契约要求 `templateCode`（(tenant_id, template_code) 解析当前生效版本），但 `Template` 表**没有 `code` 列**，且 `createJob` 按数字 `templateId` 寻址。需决策（见第 11 节 C2）。
- ⚠️ **冲突点 C3**：无 `/internal/print-jobs` 端点。且 `createJob` 内部用 `useTenantId()`（ALS），内部端点若走 service token，需在一个已注入 `TenantCtx` 的上下文里调用（用 `tenantStorage.run(...)` 包裹，或给 PrintService 增加接受显式 tenantId 的重载方法）。
- 云打印/指令下发在 `print.processor.ts`（BullMQ worker），WMS 无需关心。

---

## 4. inventory 模块服务接口（查询 / 变更 / BOM 展开）

**文件路径**
- `backend/src/inventory/inventory.service.ts`（统一 Service，1557 行）
- `backend/src/inventory/inventory.entity.ts`（`StockBatch` / `StockMove` / `WarehouseLocation`）
- `backend/src/inventory/inventory.module.ts`（`exports: [InventoryService, AlertService]`）
- `backend/src/inventory/kit.calc.ts`（BOM 齐套纯函数 `computeKit`）

**关键代码摘录**

```typescript
// inventory.service.ts —— 已存在统一库存变更入口
async adjustStock(tenantId, args: { sku; warehouse?; batch_no?; delta; reason; location_id? }, dryRun?, operator?): Promise<StockWriteOutcome>
async transferStock(tenantId, args: { sku; from_warehouse; to_warehouse; qty; batch_no?; ... }, dryRun?, operator?): Promise<StockWriteOutcome>
async queryStock(tenantId, args: QueryStockArgs): Promise<{ items; groupBy; total }>
async checkKit(tenantId, args: { product; demand; warehouse? }): Promise<{ product; bom; kit: KitOutcome }>
```

```typescript
// inventory.entity.ts:94 StockBatch —— 有 location_id 但无「暂存位」状态
export class StockBatch {
  materialId; warehouseId; batchNo;
  locationId: number | null;   // 库位维度存在
  qty: string; producedAt; expiresAt;
}
```

**结论**
- **库存变更已有统一 Service**（`InventoryService.adjustStock`/`transferStock`），事务、FIFO、批次、行锁防超卖、台账 `recordMoves` 全部现成。按文档 8.4，`InventoryGateway` **只做适配包装**，无需新建库存变更 Service。
- ⚠️ **冲突点 C4**：契约用 `skuId`/`warehouseId`/`locationId`（数字 ID），而 `adjustStock` 业务主键是 `sku`（编码，支持编码/名称模糊）+ `warehouse`（编码）；WMS 若手上只有 ID，需先查 `listMaterials`/`listWarehouses` 换编码，或 Gateway 内做 ID→编码解析。批量维度上 `transferStock` 是**跨仓**调拨（from≠to），US-5 的"暂存位→目标库位"是**同仓同批次移库位**，现有 `adjustStock(delta>0, location_id)` 只改入库落位——需确认简化口径（见 C5）。
- ⚠️ **冲突点 C5（US-5）**：库存模型**无"收货暂存位"概念**，只有普通 `location_id`。文档已预见此情形：按"直接入库到目标库位"简化。确认采用该简化。
- BOM 展开能力在 `inventory.service.ts` 的 `checkKit` + `kit.calc.ts::computeKit`，阶段二直接复用。
- `InventoryModule` 已 `exports: [InventoryService]`，供 WMS 模块注入。

---

## 5. Agent Token 签发与校验 / scope / 能否复用为 service token

**文件路径**
- `backend/src/agent/agent-token.guard.ts`（Bearer token → `req.agentCtx`）
- `backend/src/agent/agent.calc.ts`（token 形态 / scope 覆盖 / 默认只读）
- `backend/src/agent/agent.service.ts::createToken`（签发）
- `backend/src/agent/agent.entity.ts`（`agent_clients` / `agent_tokens` 表实体）
- `backend/src/agent/agent-v1.controller.ts::ingest`（入站事件：租户忽略 + scope 校验 + HMAC 范式）

**关键代码摘录**

```typescript
// agent-token.guard.ts:32-49
const rec = await this.agent.authenticate(plain);
req.agentCtx = { tenantId: Number(rec.token.tenantId), clientId, scopes: rec.token.scopes, ... };
// agent.calc.ts:12-16 scope 形态 module:resource:action
const SCOPE_RE = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)*$/;
// agent-v1.controller.ts:88 （print:job:write scope 已在用）
if (!this.agent.hasScope(ctx.scopes, 'print:job:write')) throw new PermissionDeniedException(['print:job:write']);
// ingest.calc.ts:88-91 请求体租户忽略范式（直接可复用）
if (body.tenantId !== undefined || body.tenant_id !== undefined)
  warnings.push('请求体中的 tenantId 已被忽略（租户身份只从 Agent Token 解析）');
```

**结论**
- **可完整复用为 service token**：token 绑定 `tenant_id` + `scopes`（`print:job:write` 已是合法且在用的写 scope），签发走 `createToken`，校验走 `AgentTokenGuard`。HMAC 验签口径 `HMAC-SHA256(secret, ts + "." + JSON.stringify(body))` 与文档第 5 章完全一致（见 `ingest.calc.ts`）。
- 文档要求内部端点 header 为 `X-Service-Token`，而现有 Guard 读 `Authorization: Bearer lfagent_xxx`。两者取舍见冲突点 C6。
- 部署：为 WMS 建专用 Agent Client → 签发带 `print:job:write` scope 的 token，即 service token（明文一次性返回）。

---

## 6. tool_idempotency 表字段与读写封装

**文件路径**
- `backend/scripts/saas_p5_agent_tools.sql:23`（DDL）
- `backend/src/agent/idempotency.service.ts`（claim/finish/release 封装）
- `backend/src/jobs/maintenance.service.ts:106`（30 天 TTL 清理）

**关键代码摘录**

```sql
-- saas_p5_agent_tools.sql:23
CREATE TABLE tool_idempotency (
  id BIGSERIAL PRIMARY KEY, tenant_id BIGINT NOT NULL, agent_client_id BIGINT NOT NULL,
  tool VARCHAR(60) NOT NULL, idem_key VARCHAR(80) NOT NULL, args_hash VARCHAR(64) NOT NULL,
  result JSONB, approval_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_tool_idem ON tool_idempotency (tenant_id, tool, idem_key);
```

```typescript
// idempotency.service.ts:36 claim() —— 占坑/重放/409 冲突处理
// maintenance.service.ts:106 tool_idempotency TTL 清理（分批删，30 天边界）
```

**结论**
- 幂等基础设施完整：唯一键 `(tenant_id, tool, idem_key)` + `args_hash` 冲突检测 + TTL 清理任务（`idempotency.ttl_cleanup`，30 天）。
- **文档 5.4 要求新建独立的 `print_idempotency` 表**（唯一键 `(tenant_id, idempotency_key)`，无 tool 维度）。两种落地方式见冲突点 C7：直接复用 `tool_idempotency`（把 tool 固定为 `print.createJob`）可零新建表；若坚持独立表，则 TTL 清理需扩展（`maintenance.service.ts` 现只清 `tool_idempotency`）。

---

## 7. 现有 API 组织方式（Controller / DTO / 错误码）

**文件路径**
- `backend/src/main.ts`（全局前缀 / ValidationPipe / 全局守卫 / 拦截器 / 过滤器）
- `backend/src/print/dto/print.dto.ts`、`backend/src/inventory/dto/*.ts`（DTO 范例）
- `backend/src/common/business.errors.ts`（错误码）

**关键代码摘录**

```typescript
// main.ts:92-103
app.setGlobalPrefix('api/v1');
app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false, forbidNonWhitelisted: false }));
app.useGlobalGuards(new JwtAuthGuard(...), new ModuleGuard(...), new PermissionGuard(...), new RolesGuard(...));
app.useGlobalInterceptors(new TenantContextInterceptor(...), new ResponseInterceptor());
app.useGlobalFilters(new AllExceptionsFilter());
// business.errors.ts:10 BizCode
MODULE_NOT_SUBSCRIBED: 4031, PERMISSION_DENIED: 4032, QUOTA_EXCEEDED: 4033,
APPROVAL_INVALID: 4034, FEATURE_DISABLED: 4035, IDEMPOTENCY_CONFLICT: 4036, RATE_LIMITED: 4037
```

**结论**
- Controller 路径规范：`@Controller('print/jobs')` 等（不带 `api` 前缀），全局前缀统一为 `api/v1` → 实际 URL `/api/v1/print/jobs`。
- DTO 用 `class-validator` + `class-transformer`，置于各模块 `dto/` 目录。
- 统一响应信封由 `ResponseInterceptor` 包装，异常由 `AllExceptionsFilter` 转成 `{ code, message, ... }`。
- ⚠️ **冲突点 C8**：文档 8.3 API 清单写 `/api/wms/...`，实际应为 **`/api/v1/wms/...`**（`@Controller('wms/receipts')` + 全局前缀）。需按现状对齐。
- 模块未开通错误复用 4031，无需新建错误码。

---

## 8. 数据库迁移工具与命名规范

**文件路径**
- `docs/03-database.sql`（主库 DDL，`package.json` 的 `migration` 脚本指向它）
- `backend/scripts/*.sql`（分阶段增量脚本：`saas_p*.sql` / `inventory_*.sql`）

**结论**
- **无 TypeORM migration 运行器、无 Prisma、无 knex**。`synchronize: false`。迁移 = 手写 SQL 脚本，用 psql 执行。
- 命名规范（据现有脚本）：表名蛇形复数（`wms_receipts`）、列 `tenant_id BIGINT NOT NULL`、`created_at/updated_at TIMESTAMPTZ DEFAULT now()`、索引 `ix_<表>_<用途>`、唯一索引 `uq_<...>`、主键 `BIGSERIAL`、金额/数量 `NUMERIC(precision, scale)`。
- 阶段一 WMS DDL 应新建一个 `backend/scripts/wms_p1_inbound.sql`，风格对齐 `inventory_*.sql`；并重跑 `saas_p6_rls.sql` 纳入 RLS（见第 2 项）。

---

## 9. 测试框架与测试组织

**文件路径**
- `backend/package.json`（`test` 脚本）
- `backend/src/**/__tests__/*.test.ts`、`backend/core/__tests__/*.test.ts`

**关键代码摘录**

```json
"test": "node --import tsx --test core/__tests__/*.test.ts src/**/__tests__/*.test.ts"
```

**结论**
- 框架：Node 内置 `node:test` + `tsx` 加载 TS（无 Jest/Vitest），纯函数用 `node:assert`。
- 组织：各模块 `__tests__/` 子目录，`*.test.ts` 结尾。当前全量 661 例（654 pass / 7 skip）。
- WMS 单测放 `backend/src/wms/**/__tests__/`，纳入 glob 自动收集。
- 集成测试：现有以纯函数/service 级测试为主，无 Supertest e2e 基础设施；文档 13.2 的集成测试需新建测试夹具（直接或按 Service 层编排模拟）。

---

## 10. 前端 / PDA 端现状

**文件路径**
- `apps/console/src/views/*.vue`（桌面管理端，Vue3 + Element Plus，23 个页面）
- `apps/platform/src/views/`（运营后台）
- `web/js/*.js`（原生 JS 版设计器/打印）
- `apps/console/src/api/index.ts`（API 封装；`apiAlertScan` 是告警触发，非硬件扫码）

**结论**
- ⚠️ **不存在独立移动端 / PDA 前端工程**（无 mobile/pda/h5/scan 目录）。
- ⚠️ **不存在扫码硬件能力封装**：`bwip-js` / `zxing` 仅用于**条码生成与识别算法**（`apps/console/src/views/designer/engine/barcode.ts`），未封装摄像头 `getUserMedia`/`BarcodeDetector` 的 PDA 扫码组件。
- 桌面端页面齐备（Inventory/Masterdata/BomKit/PrintJobs 等），可作为 WMS 管理端页面的风格参考。
- 阶段一 PDA 扫码收货的**前端需新建**（可用移动浏览器 + 轻量扫码库，或后续独立 PDA 工程）。此为文档已识别的范围，勘察确认"需新建"，不计入后端阶段一阻塞项，但需在部署说明中明确。

---

## 11. 冲突点与决策清单（交文档维护者确认）

| 编号 | 文档口径 | 仓库现状 | 建议处理 | 是否阻塞阶段一 |
|---|---|---|---|---|
| C1 | 在 module_code 枚举处追加 5 个模块 | 模块是 `modules` 表数据行，无代码枚举 | 迁移脚本 INSERT 5 行 + 挂套餐/权限 | 否 |
| C2 | WMS 传 `templateCode` 按 (tenant,code) 解析 | `Template` 表无 `code` 列，仅 id/uuid/name | ①模板表加 `code` 列+唯一索引（推荐）；或 ②约定用 `uuid`/`name` 作 code | **是**——需先定寻址方案 |
| C3 | 内部端点 `POST /internal/print-jobs` | 无该端点；`createJob` 依赖 ALS `useTenantId()` | 新建 internal Controller + 用 `tenantStorage.run()` 注入上下文或加显式 tenantId 重载 | **是** |
| C4 | Gateway 用 skuId/warehouseId/locationId 数值 | `adjustStock` 用 sku/warehouse 编码 | Gateway 内做 ID→编码解析，或 WMS 侧存编码 | 否 |
| C5 | 上架"暂存位→目标库位"转移 | 无暂存位概念，仅普通 location_id | 按文档预见采用"直接入库到目标库位"简化 | 否（已定简化） |
| C6 | header `X-Service-Token` | Guard 读 `Authorization: Bearer lfagent_` | 复用现有 Guard（Bearer）最省事；若要 X-Service-Token 需加专用 Guard | 否（建议复用 Bearer） |
| C7 | 新建独立 `print_idempotency` 表 | 已有 `tool_idempotency`（含 30 天清理） | 建议复用 `tool_idempotency`（tool 固定 print.createJob），零新建表；坚持独立表则需扩展清理任务 | 否（建议复用） |
| C8 | API 路径 `/api/wms/...` | 全局前缀 `api/v1` | 按 `/api/v1/wms/...` 落地（`@Controller('wms/...')`） | 否 |

---

## 12. 可复用能力清单（无需重建，符合"方向 A"边界）

| 能力 | 现成实现 | WMS 使用方式 |
|---|---|---|
| 多租户隔离 | `TenantCtx` + RLS + `withTenantScope` | Service 第一参数 TenantContext；新表带 tenant_id |
| 订阅门 | `@RequireModule` + `ModuleGuard` + 4031 | Controller 加 `@RequireModule('wms.inbound')` |
| 打印调度 | `PrintService.createJob` + BullMQ | 仅经 PrintGateway → internal 端点调用，**不 import print 内部** |
| 库存变更 | `InventoryService.adjustStock/transferStock` | 仅经 InventoryGateway 包装调用，**不直接写库存表** |
| 审计 | `AuditService.write(tenantId, action, detail, actorId, targetType, targetId, actorType)` | 所有写操作复用 |
| 幂等 | `IdempotencyService` + `tool_idempotency` | 打印/库存变更/过账带幂等键 |
| 入站鉴权 | `AgentTokenGuard` + scope + HMAC + 租户忽略范式 | service token 直接复用 |
| 计费/配额 | `UsageService.assertQuota` + `moduleCode` 归因 | 打印调用 source 字段用于归因 |

---

---

## 13. 决策确认记录（2026-11-22 已拍板）

| 项 | 决策 |
|---|---|
| C2 | **选 A**：模板表加 `code` 列 + `(tenant_id, code)` 唯一；阶段一不做多版本（版本用 code 后缀表达，租户手动切换）；存量回填用迁移脚本：name 转 slug，冲突加序号，兜底 `TMPL_{id}` |
| C3 | 新建 internal 控制器，复用 agent token 认证；在调用边界注入租户，不改 `createJob` 签名 |
| C6 | 复用 `Authorization: Bearer lfagent_`，不新造 token 体系 |
| C7 | 复用 `tool_idempotency`，不新建表（前提见 §14.1 核实结论） |
| C8 | 路径统一 `/api/v1/wms/...`，文档中的 `/api/wms` 作废 |
| C1 | 用 SQL 种子 INSERT 到 `modules` 表；WMS 模块对存量租户默认不开通，确保订阅门生效 |
| C4 | 打印 `variables` 由 WMS 过账服务组装，Gateway 只传输不解析（不过多查主数据） |
| C5 | 同意简化；**硬规则：过账时库存落点必须确定，禁止无库位库存**；基于现有库位模型二选一（结论见 §14.2） |

---

## 14. 动工前补充勘察（按确认指令要求）

### 14.1 tool_idempotency 实际结构 & C7 前提核实

**文件路径**：`backend/scripts/saas_p5_agent_tools.sql:23` + `backend/src/agent/agent.entity.ts:67`

```sql
CREATE TABLE tool_idempotency (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    agent_client_id BIGINT NOT NULL,
    tool VARCHAR(60) NOT NULL,
    idem_key VARCHAR(80) NOT NULL,        -- ← 实际 80，非文档期望的 128
    args_hash VARCHAR(64) NOT NULL,
    result JSONB, approval_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_tool_idem ON tool_idempotency (tenant_id, tool, idem_key);
```

**核实结论**：
- ✅ **key 长度够用**：打印幂等键样例 `GRN:20261122:0001:L1` = 20 字符，补打键 `GRN:{no}:{line}:reprint:{n}` 通常 < 60，均在 80 以内。为对齐契约并留余量，迁移脚本加一条 `ALTER ... TYPE VARCHAR(128)`（扩列，不新建表）。
- ✅ **"tool 强绑定"不是障碍，反而是解**：唯一键第三维 `tool` 恰好用来区分 PRINT/TOOL——打印调用固定传 `tool='print.createJob'`，Agent 工具调用传工具名，天然隔离，无需新增 `type` 字段。
- ✅ **无需新建 `print_idempotency` 表**，TTL 清理（`maintenance.service.ts::cleanupIdempotency`，30 天）直接覆盖。

### 14.2 C5 库存落点二选一结论

**依据**（`inventory.service.ts`）：
- `adjustStock(..., location_id)`：入库时若带 `location_id`，事务内更新批次 `locationId`（L1339 `if (delta > 0 && locationId != null) patch.locationId = locationId`）。
- `transferStock`：L1419 `if (from.id === to.id) throw '调拨的出入仓库不能相同'` —— **禁止同仓调拨**。
- `resolveStockLocation`：请求位 > 产品默认 > 分组默认 > 系统首个启用仓库位。

**结论：选"过账时算出推荐位直接入库"**。理由：现有模型无暂存位、`transferStock` 禁止同仓，"先入暂存位再 transfer"路径在本仓库不成立。落地为：`post` 时先按 `wms_putaway_rules` 算出 `suggestedLocationId`（无规则则取仓库首个启用库位），以该库位调用 `InventoryGateway.increaseStock(locationId=推荐位)` 一步入库，库存落点当场确定，杜绝"无库位库存"。上架确认时若操作员改库位，阶段一记录 `suggestedLocationId` 与 `actualLocationId` 差异并写审计，库位调整暂不做同仓移库（列入阶段二，因需扩展 inventory 同仓移库位能力）。已写入验收文档。

### 14.3 C3 租户注入隐藏陷阱（重要）

`withTenantScope(tenantId, fn)` 只在它自己新建的 queryRunner 上 `set_config('app.tenant_id',...,true)`，而 `PrintService.createJob` 用的是 `@InjectRepository` 注入的 Repository（另一条连接）+ `useTenantId()`（读 AsyncLocalStorage）。**只包 withTenantScope 会导致 createJob 里 `useTenantId()` 抛"未初始化租户上下文"**。

**正确做法（双层包裹）**：
```ts
const result = await tenantStorage.run(buildTenantCtx(ctx), () =>
  this.tenantDS.withTenantScope(ctx.tenantId, (scope) =>
    this.print.createJob(dto)   // createJob 读 ALS；GUC 由 withTenantScope 兜底
  )
);
```
已在实现中采用，写入验收文档。

### 14.4 PDA 端形态评估（应确认指令要求）

**结论：阶段一 PDA 端采用「移动浏览器 H5」**，理由与工作量评估见下。

| 维度 | 评估 |
|---|---|
| 现状 | 仓库无移动端工程、无扫码硬件封装（§10）。桌面 Vue3 齐备，`zxing-wasm` 可直接用于 H5 扫码 |
| H5 方案（推荐） | 在 `apps/console` 新增 wms 移动端路由/视图，复用现有 API 封装 + zxing-wasm 摄像头扫码；无需新建工程、无需应用商店 |
| 原生/小程序 | 需新建工程 + 摄像头原生插件 + 独立发布流程，验证闭环成本高，阶段一不建议 |
| 工作量 | 后端 6 项（迁移/internal/骨架/2 Gateway/8 API/测试）约为主体；PDA H5 最小闭环（扫码收货+上架确认+补打）单独评估约 2–3 人日 |

**范围界定**：你给出的阶段一交付清单为「迁移 + internal 端点 + WMS 骨架 + 两个 Gateway + 8 个 API + 测试」，**不含前端**。故本轮阶段一聚焦后端闭环并以 API 可测为验收口径；**PDA H5 列出为独立排期项**，待后端验收通过后启动。如你希望本轮一并把 H5 做进来，请告知，我会追加。

---

> **下一步**：按 §13 决策 + §14 补充勘察进入阶段一实现（迁移 + internal 端点 + WMS 骨架 + 两个 Gateway + 8 个 API + 测试）。阶段一完成后暂停验收，再进入阶段二。PDA H5 为独立排期项。

