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
- **事务边界说明**：WMS 表变更逐行落库；库存变更经 Gateway 内部独立事务（既有 InventoryService 架构）；打印旁路。未做成"单一物理事务"，因现有 `InventoryService.adjustStock` 自开事务、不可嵌入外部事务——此为与文档"同一事务边界"的**已知实现偏差**，已在此明示。

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
- **单事务过账**：库存/打印跨服务独立事务，未做单一物理事务（见 US-4 说明）。
- **真库 / 真机 POC**：本轮为纯函数 + 决策单测（14 例）+ 全量回归（675 例），未连真实 PostgreSQL / 打印机端到端。
- **模板版本管理**：阶段一不做，版本用 `code` 后缀表达（如 `RECEIPT_LABEL_V2`）。

---

## 7. 验证结果

- `npx tsc -p tsconfig.json --noEmit`：0 error。
- `npm test`：**675 tests / 668 pass / 0 fail**（其余为既有 skip；新增 14 例 WMS 测试全绿）。
- `npm run build`：受 Node 22 + Nest CLI 的 ora ESM 循环依赖工具链问题阻断（与本次代码无关）；依赖注入图经审查无循环。
- 测试明细：上架推荐规则 5 例、PrintGateway 5 例、过账决策 4 例。
