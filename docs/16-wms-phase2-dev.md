# WMS 阶段二开发文档（wms.issuing 工单发料与齐套）

> **版本**：A 版（按 `docs/15-wms-phase2-design-confirm.md` 的「建议默认值」预填，**待签字**）
> **前置**：阶段一 `wms.inbound` 已闭环（收货/上架/内部打印端点/幂等/补偿语义实证）
> **依据**：`docs/13-wms-recon-report.md`、`docs/14-wms-phase1-acceptance.md`、现有代码勘察（`InventoryService.checkKit`/`computeKit`、`BomItem.lossRate`、`StockBatch`、`ToolIdempotency`、`InventoryGateway`/`PrintGateway`）
> **性质**：开发文档，不是签字单。签字单见 `docs/15`；本文件在签字后作为唯一实现口径，改决策则同步修订本文 §1。

---

## 1. 决策锁定（A 版取值）

| # | 决策项 | A 版取值 | 落地影响 |
|---|---|---|---|
| D1 | 发料模式 | **按工单行发料 + PDA 扫码校验**（扫错 SKU/库位/批次不许过账，可强制放行并留审计） | 需要 `issue-scan` 接口 + 校验纯函数 |
| D2 | 替代料 | **阶段二不做**，缺料即挂起 | 无替代关系表、无审批流、无齐套重算；少 3–4 周 |
| D3 | 齐套口径 | **按行 + 整体汇总**（行级复用 `computeKit`，整体 = `min(行 maxSets)`） | 齐套检查响应同时给 `lines[]` 与 `summary` |
| D4 | 损耗率 | **沿用 BOM `loss_rate` 计入需求**：`单位需求 = qty_per × (1 + loss_rate)` | 不新增"发料时另计损耗"逻辑 |
| D5 | 批次指定 | **两者可选，默认自动**（FIFO → 近效期；可手动指定批次覆盖） | Gateway 增加批次分配能力 |
| D6 | SN 采集 | **阶段二不采集**（仅批次），SN 留阶段三 `wms.trace` | 不碰 `SerialSequence`/`SerialUsageLog` |
| D7 | 缺料挂起 | **不新增独立 `SHORTAGE` 状态**，用 `ISSUING` + 缺料标记/缺料清单表达 | 状态机少一个状态，少一套流转守卫 |
| D8 | 退料 | **阶段二内做**（`ISSUED → ISSUING` 冲销，需审批放行） | 需要退料记录表 + 冲销幂等键 |

> 任一决策变更 → 先改本表，再动代码。

---

## 2. 范围边界

**做**
- 工单建单（手工 / Excel 导入，BOM 自动展开或手工填行）
- BOM 展开与齐套检查（行级 + 整体，损耗率计入需求）
- 发料任务：开始发料、PDA 扫码校验、发料过账（扣库存 + 批次标签）
- 缺料清单（按行缺料数量 + 友好摘要）
- 退料冲销、关单
- `wms.issuing` 模块订阅门、审计动作、内部打印复用

**不做（阶段三或独立排期）**
- 替代料规则引擎 / 手工替代（D2）
- ERP 接入、自动倒冲领料、线边库 JIT 叫料
- SN 正反向追溯（D6）
- 自动重试到最终一致（BullMQ 队列）——阶段二只承诺"无脏数据 + 重跑幂等收敛"
- PDA 前端页面（与阶段一同属独立排期，后端 API 先行）
- 同仓移库位（阶段一遗留简化项，仍不在阶段二范围）

---

## 3. 数据模型（迁移脚本 `backend/scripts/wms_p2_issuing.sql`）

约定沿用阶段一：全部含 `tenant_id BIGINT`、纳入 RLS、数量 `NUMERIC(14,3)`（对齐 `stock_batches.qty`）、DDL 全部 `IF NOT EXISTS` / `DO $$` 守卫、可重复执行。

### 3.1 `wms_work_orders`（工单头）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGSERIAL PK | |
| tenant_id | BIGINT NOT NULL | RLS |
| wo_no | VARCHAR(64) NOT NULL | `(tenant_id, wo_no)` 唯一 |
| product_material_id | BIGINT NOT NULL | 产出物料（决定 active BOM） |
| warehouse_id | BIGINT NOT NULL | 发料仓 |
| demand_qty | NUMERIC(14,3) NOT NULL | 计划产出数（齐套 demand） |
| source_type | VARCHAR(32) | `MANUAL` \| `EXCEL_IMPORT` |
| source_no | VARCHAR(64) NULL | 上游单据号 |
| priority | INT DEFAULT 100 | |
| planned_start_at / planned_end_at | TIMESTAMPTZ NULL | |
| status | VARCHAR(32) DEFAULT 'CREATED' | 见 §4 |
| shortage_flag | BOOLEAN DEFAULT FALSE | D7：缺料标记（不引入新状态） |
| remark / created_by / created_at / updated_at | | |

### 3.2 `wms_wo_lines`（工单明细行 = 应发料行）

| 列 | 类型 | 说明 |
|---|---|---|
| id / tenant_id / wo_id / line_no | | |
| material_id | BIGINT | 组件物料（BOM 展开来源） |
| qty_required | NUMERIC(14,3) | 需求量 = `round3(qty_per × (1+loss_rate) × demand)` |
| qty_issued | NUMERIC(14,3) DEFAULT 0 | 累计已发 |
| qty_shortage | NUMERIC(14,3) DEFAULT 0 | 最近一次齐套/过账后缺口 |
| batch_no | VARCHAR(60) NULL | 手工指定批次（D5 覆盖自动分配） |
| status | VARCHAR(32) DEFAULT 'PENDING' | `PENDING`\|`PARTIAL`\|`DONE`\|`SHORT` |
| shortage_reason | VARCHAR(300) NULL | 可解释缺料原因（如"可用 12 < 需求 30"） |

### 3.3 `wms_issue_records`（发料记录，幂等完成标志）

| 列 | 类型 | 说明 |
|---|---|---|
| id / tenant_id / wo_id / line_id / material_id | | |
| batch_no | VARCHAR(60) | 实际发出批次 |
| location_id | BIGINT NULL | 发出库位 |
| qty | NUMERIC(14,3) | 本次发出量 |
| idem_key | VARCHAR(128) NOT NULL | `ISSUE:WO{wo_no}:{line_no}`（唯一索引，幂等兜底） |
| ref_type | VARCHAR(32) | `WMS_ISSUE` |
| operator_id | BIGINT NULL | |
| print_job_id / print_status | VARCHAR(64) / VARCHAR(32) NULL | 标签旁路结果 |
| created_at | TIMESTAMPTZ | |

> **唯一约束** `(tenant_id, idem_key)`：既是幂等收敛标志，也防止并发重复过账。

### 3.4 `wms_wo_returns`（退料记录）

`id / tenant_id / wo_id / line_id / material_id / batch_no / location_id / qty / idem_key(唯一) / approved_by / approved_at / reason / created_at`，幂等键 `RETURN:WO{wo_no}:{line_no}:{seq}`。

### 3.5 索引

```
idx_wms_wo_status      (tenant_id, status)
idx_wms_wo_lines_wo    (tenant_id, wo_id)
ux_wms_issue_idem      (tenant_id, idem_key) UNIQUE
ux_wms_return_idem     (tenant_id, idem_key) UNIQUE
```

### 3.6 迁移后动作

1. 重跑 `scripts/saas_p6_rls.sql`，给 4 张新表挂 `tenant_isolation` 策略；
2. `modules` 种子已在阶段一写入 `wms.issuing`，本阶段**不重复插入**；
3. 测试租户开通：手工 `INSERT INTO tenant_modules`（与阶段一部署说明一致，不做自动开通）。

---

## 4. 状态机

```
                 ┌──────────── CANCEL（仅 CREATED / RELEASED）────────────┐
                 ▼                                                       │
CREATED ──RELEASE──▶ RELEASED ──ISSUE_START──▶ ISSUING ──ISSUE_DONE──▶ ISSUED ──CLOSE──▶ CLOSED
   │                    │                        │  ▲                     │
   └────EDIT(改行)───────┘                        │  └──RETURN(退料冲销)───┘
                                                  └── 部分发料/缺料：留在 ISSUING + shortage_flag
```

| 当前 | 允许下一状态 | 动作 | 守卫 |
|---|---|---|---|
| CREATED | RELEASED / CANCELLED | 下发 / 取消 | 明细行非空；下发前必须做过齐套检查（可缺料，但须记录缺料清单） |
| CREATED | CREATED | EDIT（改行） | 仅 CREATED 可改行 |
| RELEASED | ISSUING / CANCELLED | 开始发料 / 取消 | 已齐套检查（或缺料已标记） |
| ISSUING | ISSUED / ISSUING | 发料完成 / 部分发料 | 全部行 `qty_issued >= qty_required`，或 `force=true` 人工放行并留审计 |
| ISSUED | CLOSED / ISSUING | 关单 / 退料 | 关单须无未结退料；退料须审批 |
| CLOSED / CANCELLED | — | 终态 | 不可回退 |

纯函数 `woTransit.ts: canTransit(from, action)` 承载合法流转表，单测覆盖全部非法组合（不发 SQL 判断）。

---

## 5. 齐套口径（D3 / D4）

- **展开**：工单 `product_material_id` → active BOM（同一产品最多一个 active，沿用现有约束）；无 BOM / 无明细行 → 返回 0 行齐套 + 友好提示，**不报错**。
- **需求量**：`单位需求 = qty_per × (1 + loss_rate)`，`行需求 = round3(单位需求 × demand)`（复用 `kit.calc.ts: round3`）。
- **行级**：直接复用 `computeKit(lines, demand)`，不复制公式（`maxSets = floor(available / 单位需求)`、`shortage = max(0, round3(needed - available))`）。
- **整体汇总**（新增纯函数，放 `wms/issuing/services/kit-summary.calc.ts`）：
  - `overallMaxSets = min(行 maxSets)`（无行 → 0）
  - `overallKitRate = floor(min(overallMaxSets, demand) / demand × 10000) / 100`
  - `shortageLines = shortage > 0` 的行
  - `summaryText` 复用 `shortageSummaryText` 口径（产品名 + 前 3 项缺料 + 可配套数 + 齐套率）
- **一致性**：行级必须走 `InventoryService.checkKit`（经 `InventoryGateway` 适配），**禁止 WMS 自己拼 SQL 算可用库存**——保证与 BOM 模块、Agent 工具同一口径。

---

## 6. Gateway 扩展（边界不变）

阶段一边界：WMS 只通过 Gateway 改库存、打标签，禁止 import `src/print/**`、`src/inventory/**` 内部实现。阶段二在 `backend/src/wms/gateways/` 内扩展，**不新增越界 import**：

| 新增方法 | 用途 | 底层 |
|---|---|---|
| `InventoryGateway.checkKit({product, demand, warehouse})` | 齐套检查适配（ID → code 解析在 Gateway 做） | `InventoryService.checkKit` |
| `InventoryGateway.decreaseStock({...})` | 发料扣减（`delta` 取负） | `InventoryService.adjustStock`，幂等 tool `wms.stock.issue` |
| `InventoryGateway.allocateBatches({sku, warehouse, qty, batchNo?})` | D5 批次分配：手动指定优先校验余量；否则 FIFO→近效期 | 只读 `stock_batches`（按 `created_at` / `expires_at` 排序），**不改库存** |
| `InventoryGateway.queryBatches({sku, warehouse})` | 缺料解释用的批次余量明细 | 只读 |

`decreaseStock` 幂等键复刻 `increaseStock` 的 claim/finish 结构，`argsHash` 必须含 `batchNo/qty/refNo`，防同键不同参。

---

## 7. 发料过账事务与补偿（复用阶段一 T4 语义）

**顺序**（逐行）：

1. `allocateBatches` 定批次与库位（无可用批次 → 行置 `SHORT`，不进第二步）
2. `InventoryGateway.decreaseStock`（幂等键 `ISSUE:WO{wo_no}:{line_no}`，库存是第一步，**失败即止**）
3. `wms_issue_records` 落库（`(tenant_id, idem_key)` 唯一，作为"该行已发"完成标志）
4. `wms_wo_lines.qty_issued/qty_shortage/status` 更新
5. `PrintGateway.createJob` 发料标签（旁路，失败只记 `failed` 审计 + 补打入口）
6. 整单：全部行 DONE → `ISSUED`；否则留 `ISSUING` 且 `shortage_flag=true`

**失败语义**
- 库存扣减失败 → 后续步骤不落库，**无脏数据**；
- 若在 3/4 之间崩溃：库存已扣但无发料记录 → 重跑同单据时，先查 `idem_key` 是否存在发料记录，不存在则重走，`decreaseStock` 凭幂等键直接返回原结果（不二次扣减）；
- 对外口径：**"失败后单据无脏数据、重跑可幂等收敛"**，不是"自动重试到最终一致"。

**已知实现偏差（与阶段一相同，须明示）**：`InventoryService.adjustStock` 自开事务、无法嵌入 WMS 外部事务，因此不做单一物理事务；补偿依靠幂等键 + 完成标志。

**并发**：同一工单行并发过账由 `(tenant_id, idem_key)` 唯一索引兜底，冲突返回 409 `ISSUE_ALREADY_POSTED`。

---

## 8. API 清单（全局前缀 `/api/v1`，全部 `@RequireModule('wms.issuing')` + `TenantGuard`）

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | POST | `/wms/work-orders` | 手工建单；`expandBom=true` 时按 BOM 自动展开明细 |
| 2 | POST | `/wms/work-orders/import` | Excel 建单（部分成功：成功行进、失败行返回行级错误） |
| 3 | GET | `/wms/work-orders` | 列表（`status`/`page`/`pageSize`） |
| 4 | GET | `/wms/work-orders/:id` | 详情（含行、齐套摘要、发料记录、退料记录） |
| 5 | POST | `/wms/work-orders/:id/lines` | 改行/追加行（仅 `CREATED`） |
| 6 | POST | `/wms/work-orders/:id/kit-check` | 齐套检查：行级 `computeKit` + 整体汇总，回写 `qty_shortage/shortage_flag` |
| 7 | POST | `/wms/work-orders/:id/release` | 下发（`CREATED → RELEASED`，守卫：有行 + 已齐套检查） |
| 8 | POST | `/wms/work-orders/:id/cancel` | 取消（仅 `CREATED/RELEASED`） |
| 9 | POST | `/wms/work-orders/:id/issue-start` | 开始发料（`RELEASED → ISSUING`） |
| 10 | POST | `/wms/work-orders/:id/issue-scan` | PDA 扫码校验：SKU / 批次 / 库位三者比对，不回写库存 |
| 11 | POST | `/wms/work-orders/:id/issue-post` | 发料过账（可选 `lineIds` 部分过账；`force` 强制放行留审计） |
| 12 | POST | `/wms/work-orders/:id/issue-done` | 发料完成（全部达标或 `force=true`；缺料清单随响应返回） |
| 13 | GET | `/wms/work-orders/:id/shortages` | 缺料清单（行 + 摘要文本） |
| 14 | POST | `/wms/work-orders/:id/returns` | 退料冲销（`ISSUED → ISSUING`，需审批字段） |
| 15 | POST | `/wms/work-orders/:id/close` | 关单（守卫：无未结退料） |
| 16 | POST | `/wms/work-orders/lines/:lineId/reprint-label` | 发料标签补打（幂等键 `ISSUE:WO{no}:{line}:reprint:{n}`） |
| 17 | GET | `/wms/issue-records` | 发料记录查询（`woId`/`material`/时间范围） |

**错误码约定**：`4091` 单号重复、`4092` 重复过账、`4093` 状态不允许、`422` 扫码校验不符（SKU/批次/库位）、`4031` 模块未开通。

**发料标签**：模板 `ISSUE_LABEL_V1`，`source='wms.issuing.issue'`，`printerRoute='issue-station'`，变量由 WMS 组装（`woNo/lineNo/materialCode/materialName/batchNo/qty`），`PrintGateway` 仅透传（沿用阶段一 C4 口径）。

---

## 9. 测试与验收门

### 9.1 纯函数单测（`backend/src/wms/__tests__/`，node:test）

| 文件 | 覆盖 |
|---|---|
| `kit-summary.test.ts` | 整体 `min(maxSets)`、0 行、全不耗料、齐套率向下取整、摘要文本 |
| `wo-transit.test.ts` | 状态机合法/非法流转全组合（含 `force` 放行分支） |
| `batch-alloc.test.ts` | 手动批次校验、FIFO、近效期优先、跨批次拆分、余量不足 |
| `issue-calc.test.ts` | 幂等键构造、行需求 `round3`、部分发料累计、超发拒绝 |
| `scan-verify.test.ts` | SKU/批次/库位三比对 + 强制放行 |

目标新增 ≥ 25 例，总数从 661 → ≥ 686，全绿。

### 9.2 真 PG 集成门（`backend/test/integration/wms-issuing.int.test.ts`，沿阶段一 jest 门）

| 门 | 断言 |
|---|---|
| G1 | 建单 → BOM 展开行数与需求量正确（含损耗率） |
| G2 | 齐套检查：缺料行 `shortage>0`、整体齐套率与行级一致 |
| G3 | 发料过账：库存减少、`stock_moves` 落 `out` 台账、发料记录唯一 |
| G4 | 重跑过账：库存不二次扣减、返回 `idempotent` |
| G5 | 库存不足：过账失败且**无发料记录、无行状态变更**（无脏数据） |
| G6 | 退料冲销：库存回补、工单回到 `ISSUING`、退料幂等 |
| G7 | RLS：跨租户不可见/不可改 4 张新表 |

### 9.3 收尾门

- `pnpm typecheck` 零错误；`pnpm test` 全绿；`pnpm lint` 无新增 error
- `docs/17-wms-phase2-acceptance.md` 逐条对照本文与 `docs/15` 签字项

---

## 10. 里程碑与工作量

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M1 | 迁移脚本 + 实体 + `entities/index.ts` 导出 + Gateway 4 个方法 + 单测（batch-alloc/issue-calc） | 3–4 天 |
| M2 | 建单/导入/改行/详情 + BOM 展开 + 齐套检查（行+整体） + 单测 | 4–5 天 |
| M3 | 发料：issue-start / scan / post / 打印 / 补打 + 单测 | 5–6 天 |
| M4 | 缺料清单 / issue-done / 退料 / 关单 / 审计动作 | 3–4 天 |
| M5 | 真 PG 集成 7 门 + 验收报告 + README §9 更新 | 3–4 天 |

合计 **约 15–19 个工作日**（D2 不做替代料是压缩到该区间的关键前提）。

---

## 11. 风险与回滚

| 风险 | 处置 |
|---|---|
| 齐套口径与 BOM 模块漂移 | 只经 `InventoryGateway.checkKit` 取数，不复制 SQL；加一致性单测 |
| 库存扣减与发料记录不一致 | 幂等键 + `(tenant_id, idem_key)` 唯一 + 完成标志；G4/G5 故障注入验证 |
| 批次分配与实际现场不符 | D5 默认自动但允许手动覆盖；`issue-scan` 校验 + `force` 留审计 |
| 迁移影响存量 | 全部 `IF NOT EXISTS`；新表不写 `plan_modules`，未开通租户 4031，零影响 |
| 回滚 | 停用 `wms.issuing` 模块订阅即可（代码保留、接口 403）；表可保留不删 |

---

## 12. 签字后开工顺序

1. 本文 §1 与 `docs/15` 决策勾选一致 → 打标签 `wms-p2-go`
2. 按 M1→M5 顺序提交，每个里程碑一个 commit（中文 commit message，沿用现状）
3. 每里程碑结束跑 `pnpm typecheck && pnpm test`，红了不进下一里程碑
