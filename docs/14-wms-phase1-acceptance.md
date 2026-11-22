# WMS 阶段一（wms.inbound 收货与上架）验收报告

> 依据：`docs/13-wms-recon-report.md` §13 决策 + WMS 开发文档第 8 章。
> 交付范围：迁移 + internal 打印端点 + WMS 骨架 + 两个 Gateway + 8+ API + 测试。
> 不含：PDA 前端（独立排期项，建议 H5）、阶段二/三模块、策略引擎、波次、同仓移库位。

---

## 1. 交付物清单对照

| # | 交付物 | 状态 | 位置 |
|---|---|---|---|
| 1 | 代码勘察报告 | ✅ | `docs/13-wms-recon-report.md` |
| 2 | 阶段一迁移脚本 | ✅ | `backend/scripts/wms_p1_inbound.sql` |
| 3 | 后端代码（WMS 模块 + 2 Gateway + internal 端点 + 幂等复用） | ✅ | `backend/src/wms/**`、`backend/src/agent/internal-print.*` |
| 4 | 打印契约 OpenAPI 片段 | ✅ | 本文 §4 |
| 5 | 单元测试 + 决策测试 | ✅ | `backend/src/wms/__tests__/*.test.ts`（14 例） |
| 6 | 阶段一验收报告（对照 8.2） | ✅ | 本文 §2 |
| 7 | 部署说明（service token / 测试租户开通） | ✅ | 本文 §5 |

---

## 2. 用户故事逐条勾选（对照文档 8.2）

### US-1 建收货单 ✅
- 手工建单（`POST /api/v1/wms/receipts`）+ 追加行（`.../:id/lines`），SKU 按编码录入。
- 创建后 `status=CREATED`；`qtyExpected` 可编辑（追加行）。
- 重复 `receipt_no` → `ConflictException`（409）。
- 代码：`InboundService.createReceipt/appendLines`。

### US-2 Excel 导入收货单 ✅
- `POST /api/v1/wms/receipts/import`，`sourceType=EXCEL_IMPORT`。
- **口径声明（文档允许二选一）：采用"部分成功"**——成功行入库、失败行返回行级错误，不阻塞成功行；响应 `{ receiptId, created, errors:[{row,sku,error}] }`。
- 代码：`InboundService.importReceipt`。

### US-3 PDA 扫码收货 ✅（后端 API）
- `POST /api/v1/wms/receipts/:id/receive-scan`。
- 按单收（`lineNo/lineId`）+ 盲收（仅 SKU）；盲收发单外 SKU → 新建 `WRONG_SKU` 差异行；按单收 SKU 不符 → 标记 `WRONG_SKU`。
- 超收/短收：`calcDiff(qtyExpected, 累计 qtyReceived)` 写 `diffType/diffQty`。
- 重复扫同批次**累加**（`before + qty`），非覆盖。
- 数量精度 `NUMERIC(14,3)`，与库存一致。
- 首扫将单据置 `RECEIVING`。
- ⚠️ 前端 PDA 页面属独立排期（见 §6）。

### US-4 收货过账 ✅
- `POST /api/v1/wms/receipts/:id/post`。编排顺序：
  1. 行状态 → `RECEIVED`（逐行）
  2. `InventoryGateway.increaseStock`（批次维度，落推荐库位）
  3. 生成 `wms_putaway_tasks`（status=`ASSIGNED`）
  4. `PrintGateway.createJob`（幂等键 `GRN:{no}:{line}`，source=`wms.inbound.receipt`）
  5. 打印调用记录写审计（`wms.print.call`，含 jobId/status/errorCode）
- 打印失败**不阻塞**过账：Gateway 抛错被 catch，写 `status=failed` 审计，过账继续完成。
- 重复过账被拒绝（status 守卫 → 409）。
- 整单置 `RECEIVED`。
- **事务边界说明**：WMS 表变更逐行落库；库存变更经 Gateway 内部独立事务（既有 InventoryService 架构）；打印旁路。未做成"单一物理事务"，因现有 `InventoryService.adjustStock` 自开事务、不可嵌入外部事务——此为与文档"同一事务边界"的**已知实现偏差**，已在此明示。补偿语义（失败后重试如何收敛）见 **§8.3**，已做故障注入实证并据此加固。

### US-5 上架任务与推荐 ✅（含简化）
- `GET /api/v1/wms/putaway-tasks`、`GET .../:id/recommend`、`POST .../:id/confirm`。
- 推荐规则：`wms_putaway_rules` 按 priority 排序，条件 `abc/zone/maxUtilization`，动作 `zoneCode/sortBy`；无规则兜底选最空库位；返回可解释 `reason`。
- **C5 硬约束**：过账时必须算出确定库位才入库（无暂存位、`transferStock` 禁同仓），杜绝无库位库存。
- 确认上架：写 `actualLocationId`、`status=DONE`、审计记录推荐位 vs 实际位差异。
- **简化**：阶段一不做同仓移库位（过账已直接入库到推荐位）；改库位仅记录差异，不触发库存迁移（列入阶段二）。

### US-6 补打标签 ✅
- `POST /api/v1/wms/receipts/lines/:lineId/reprint-label`。
- 仅已过账行可补打；新幂等键 `GRN:{no}:{line}:reprint:{n}`（序号递增）；source=`wms.inbound.receipt.reprint`。

---

## 3. 8 项决策落地确认

| 决策 | 落地情况 |
|---|---|
| C2 模板 code 列 | 迁移加 `templates.code VARCHAR(60)` + `(tenant_id, code)` 部分唯一索引 + PL/pgSQL 存量回填（slug→序号→TMPL_{id}）；阶段一不做版本 |
| C3 internal + 租户注入 | `InternalPrintController`（@Public + Bearer lfagent token）→ `InternalPrintService`，在 `tenantStorage.run` 里调 `createJob`，不改其签名 |
| C6 复用 lfagent_ token | 复用 `AgentService.authenticate` + `hasScope('print:job:write')` |
| C7 复用 tool_idempotency | 打印侧 `tool='print.createJob'`，库存侧 `tool='wms.stock.increase'`；`idem_key` 扩列至 128；30 天 TTL 清理复用 |
| C8 路径 | `@Controller('wms')` + 全局前缀 → `/api/v1/wms/...`；internal → `/api/v1/internal/print-jobs` |
| C1 SQL 种子 | `modules` 表 INSERT 5 行；不写 plan_modules/tenant_modules → 存量租户默认不开通 |
| C4 variables 组装 | `buildReceiptVariables` 纯函数由 WMS 过账服务组装，PrintGateway 仅透传 |
| C5 库存落点 | `assertStockLocation` 硬校验；过账即入库到推荐位 |

---

## 4. 打印契约 OpenAPI 片段（internal 端点）

```yaml
POST /api/v1/internal/print-jobs
  security: [ { bearerAuth: [] } ]   # Authorization: Bearer lfagent_xxx (scope: print:job:write)
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required: [templateCode, idempotencyKey, variables]
          properties:
            templateCode:   { type: string, example: RECEIPT_LABEL_V1 }
            printerRoute:   { type: string, example: receipt-station }
            idempotencyKey: { type: string, example: "GRN:20261122:0001:L1" }
            variables:      { type: object, additionalProperties: true }
            source:         { type: string, example: wms.inbound.receipt }
            copies:         { type: integer, minimum: 1, maximum: 500, default: 1 }
  responses:
    '200':
      description: 已入队；idempotent=true 表示幂等命中返回原任务
      content:
        application/json:
          schema:
            type: object
            properties:
              jobId:      { type: string }
              status:     { type: string, example: queued }
              idempotent: { type: boolean }
    '403':
      description: 模块未开通(4031) / scope 不足(4032)
    '404':
      description: PRINT_TEMPLATE_NOT_FOUND
    '409':
      description: 幂等键冲突（同 key 不同参数）
```

> 租户身份只从 token 解析；请求体携带 `tenantId` 一律忽略并在 `warnings` 中告警。

---

## 5. 部署说明

1. **跑迁移**（在现有库上）：
   ```bash
   psql "$DB_URL" -f backend/scripts/wms_p1_inbound.sql
   psql "$DB_URL" -f backend/scripts/saas_p6_rls.sql   # 必须重跑：为 4 张新表挂 tenant_isolation
   ```
   > 复核：`p6-rls-smoke.sh` 的 `rls_tables` 计数应增加 4。

2. **签发 service token**（以目标租户管理员身份）：
   - 该租户后台创建 Agent Client（active），用管理员签发带 `print:job:write` scope 的 token（明文一次性返回）。
   - 后端 `.env` 配置 `WMS_SERVICE_TOKEN=<明文>`；跨进程部署再配 `PRINT_INTERNAL_BASE_URL`。

3. **开通测试租户模块**（存量租户默认不开通）：
   ```sql
   INSERT INTO tenant_modules (tenant_id, module_code, status, source)
   VALUES (<测试租户id>, 'wms.inbound', 'active', 'manual')
   ON CONFLICT (tenant_id, module_code) DO NOTHING;
   ```
   > 需 invalidate 模块缓存（等 60s 或调 ModuleGuard 用的 ModulesService.invalidate）。

4. **基础数据**：确保目标租户已有仓库/库位/物料（SKU 编码），否则建单/过账会报"不存在"。

---

## 6. 未覆盖项与已知偏差（转阶段二 / 独立排期）

- **PDA 前端**：独立排期（建议 H5 + 现有 zxing-wasm 扫码），本轮只交付后端 API。
- **同仓移库位**：阶段二（需扩展 inventory 同仓移库能力；`transferStock` 当前禁止同仓）。
- **单事务过账**：库存/打印跨服务独立事务，未做单一物理事务（见 US-4 / §8.3 补偿语义）。
- **真机 POC**：已连真实 PostgreSQL 完成后端集成验证（§8.2）；**真实打印机 / PDA 扫码硬件**仍待 PDA 就绪后端到端验收。
- **全链路①**（建单→扫码→过账→打印→上架 端到端 UI 流程）：后端各环节已分别真实验证，完整 UI 链路留到 PDA H5 就绪后补。
- **模板版本管理**：阶段一不做，版本用 `code` 后缀表达（如 `RECEIPT_LABEL_V2`）。

---

## 7. 验证结果

- `npx tsc -p tsconfig.json --noEmit`：0 error。
- `npm test`：**675 tests / 668 pass / 0 fail**（其余为既有 skip；新增 14 例 WMS 测试全绿）。
- `npm run build`（Nest CLI）：受 Node 22 + 工具链 ora ESM 循环依赖问题阻断；改用 `npx tsc -p tsconfig.json` **完整编译成功**（见 §8.1）。
- 单测明细：上架推荐规则 5 例、PrintGateway 5 例、过账决策 4 例。
- **真库集成测试**：23 PASS / 0 FAIL（见 §8.2）；**故障注入补偿探针**：修复后自愈成功（见 §8.3）。

---

## 8. 验证加固报告（2026-11-22，验收前补充）

> 针对验收提出的三处差距（集成测试被降级为纯函数、运行时装配未验证、事务补偿未讲清）与三项底线项，逐条补齐。本节为**实证结果**，非静态推断。

### 8.1 启动证据（运行时 DI 装配验证）

- **方法**：`tsx` 不 emit `emitDecoratorMetadata`，直接跑源码会在首个 TypeORM 实体抛 `ColumnTypeUndefinedError`（与 WMS 无关）。改用 `npx tsc -p tsconfig.json` 完整编译（含 metadata）后用 `node dist/src/main.js` 启动。
- **发现并修复既有缺陷**：首次启动暴露 `Nest can't resolve dependencies of the NotifyModule (ChannelRegistry, ?)` —— `notify.module.ts` 构造函数注入的是 `NotifyConfig` **interface**（编译后为 `Object`），未加 `@Inject(NOTIFY_CONFIG)`；而 `notification.service.ts` 用对了。**此为既有 bug（commit `f0ef098`），非 WMS 引入**。已最小修复：`@Inject(NOTIFY_CONFIG) private cfg`。
- **结果**：连真实 PostgreSQL 启动成功，路由映射日志实证 **11 条 `/api/v1/wms/*` 路由 + `POST /api/v1/internal/print-jobs` 全部真实装配**（日志见 `dist` 启动输出）。彻底证伪上一轮"依赖注入图经审查无循环"的静态断言。

### 8.2 真实集成测试（4 场景，连真实 PostgreSQL 16）

- **方法**：`backend/scripts/wms-phase1-integration.ts` —— 真实 TypeORM DataSource 连真库 + 真实 `InboundService`（手动装配真实 Repository，mock 打印/库存 Gateway 使成功/失败可控），在 `tenantStorage.run` 内调用真实 service 方法。非纯函数测试。
- **前置**：按 `docs/10` 顺序灌入完整 schema（03-database → seed → saas_p0 → p0_roles → p2/p3/p4 → inventory_* → p5/p6/p7/p8 → wms_p1_inbound → saas_p6_rls），造两租户基础数据（A 开通 wms.inbound，B 不开通）。
- **结果：23 PASS / 0 FAIL**

| 场景（文档 13.2） | 覆盖 | 关键断言 |
|---|---|---|
| ②重复过账拒绝 | ✅ | 过账后 status=RECEIVED；二次过账 409 语义；库存未重复加 |
| ③打印不可用→过账成功+补打 | ✅ | 打印抛错时过账仍成功、行状态 RECEIVED、审计记 failed；补打用新 reprint 键、source 正确 |
| ④订阅门拦截 | ✅ | 真实 ModulesService 查库；ModuleGuard 拦未开通租户 B（4031）、放行租户 A |
| ⑤跨租户隔离 | ✅ | 租户 B 读 A 收货单 404、列表不可见 |
| 附加 US-3/US-5 | ✅ | 重复扫码累加(60+70=130)、超收差异 OVER/30；上架任务含推荐原因 |

- 全链路①（UI 端到端）按约定留 PDA H5 就绪后补；后端各环节已分别真实验证。
- **可复现命令**（需先按 §5 + 本文前置灌好测试库，两租户基础数据见脚本说明）：
  ```bash
  cd backend
  npx tsc -p scripts/tsconfig.integration.json       # 编译（scripts/tsconfig.integration.json 固化了 metadata 配置）
  export NODE_PATH="$(echo $(ls -d node_modules/.pnpm/*/node_modules | tr '\n' ':'))"  # pnpm 依赖解析
  DB_HOST=127.0.0.1 DB_PORT=5433 DB_NAME=labelflow DB_USER=labelflow DB_PASS=labelflow \
    node dist-it/scripts/wms-phase1-integration.js
  # 期望：23 PASS / 0 FAIL
  ```

### 8.3 过账失败补偿语义（实证 + 加固）

- **失败点顺序**：`increaseStock`(库存,有幂等键) → 行状态 RECEIVED → `tasks.save`(上架任务,原无幂等保护) → 打印(旁路,失败不阻塞) → 整单 RECEIVED。
- **故障注入实证**（`backend/scripts/wms-compensation-probe.ts`，注入 tasks.save 首次失败）：**修复前**——第一次失败后行=RECEIVED、库存已加、任务=0；重试报"没有待过账的收货行"，**任务永久丢失、整单卡死 RECEIVING**。
- **补偿语义（定稿）：「幂等重试兜底 + 以任务存在为完成标志」**
  1. 库存变更：Gateway 侧 `tool_idempotency`（key=`STOCK:GRN:{no}:{line}`）去重，重试不重复加库存。
  2. 打印：内部端点 `tool_idempotency`（key=`GRN:{no}:{line}`）去重；失败旁路记 failed，可补打（reprint 键）。
  3. 上架任务：重试时把「已 RECEIVED 但仍缺任务」的行纳入处理；**以该行是否已有上架任务作为过账完成标志**——有则跳过，无则重走（库存/打印靠各自幂等键防重复）。
- **已实施加固**：`InboundService.postReceipt` 查询条件由 `status=PENDING` 改为 `status IN (PENDING, RECEIVED)`，并预载该单已有任务，按 `receiptLineId` 幂等跳过已完成行。
- **修复后实证**：注入失败 → 重试补齐任务（任务 0→1）、整单收敛 RECEIVED、不重复加库存。**不回滚**（跨服务无分布式事务），靠重试向最终一致收敛。
- **仍存的边界（诚实标注）**：① 若某行在"库存已加、任务已建、打印前"崩溃，重试会跳过该行（已有任务），打印靠人工补打入口兜底——不会重复打印，但需人工触发补打；② 真机打印/PDA 未端到端。
- **可复现命令**：同 §8.2 编译后 `node dist-it/scripts/wms-compensation-probe.js`，修复前应见 `✗ 任务永久丢失`，修复后见 `✓ 重试补齐任务，库存幂等未重复`。

### 8.4 三项底线项核实（真库实证）

| 底线项 | 方法 | 结果 |
|---|---|---|
| RLS 覆盖 4 张 WMS 新表 | 迁移后重跑 `saas_p6_rls.sql`，查 `pg_policies` + `relrowsecurity` | ✅ 4 表全部 `rls_enabled=t` 且挂 `tenant_isolation`；脚本 §2c 防御检查通过 |
| 模块种子未误开存量租户 | 查 `modules` 与 `tenant_modules` | ✅ 5 个 wms.* 模块在目录表（`is_core=f`）；`tenant_modules WHERE module_code LIKE 'wms.%'` **0 行** |
| 模板 code 回填多租户安全 | 真库造中文名/重名/空名数据跑回填算法 | ✅ slug 化+冲突加序号(`v1`/`v1_1`)+非法名兜底(`TMPL_9004`)；跨租户同名互不冲突（唯一键含 tenant_id） |

- **回填可用性细节（如实记录）**：纯中文名 `收货 标签 V1` 经 `[a-z0-9]` slug 化后只剩尾部 ASCII 片段 `v1`，业务语义弱（但未违反唯一性、不报错）。这是 C2 既定 slug 算法的特性；若需中文名可读 code，属后续增强，阶段一不扩范围。
- **部署提醒（不可省）**：`wms_p1_inbound.sql` 建表后**必须重跑 `saas_p6_rls.sql`**，否则新表不挂策略。验收报告 §5 已列此步骤，本节用真库证实其必要性。
