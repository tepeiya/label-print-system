# 库存调整单（① 手工出入库口径改造）

> 2026-11-25 交付。前情：核查「库存管理是否与 WMS 冲突」时确认两者不冲突（账 + 作业分层，WMS 只能经 `InventoryGateway` 改库存），但发现两个真实问题——②（PC 端看不到 WMS 单据）已于同日交付（见 `docs/16 §13`）；本文是 ①：console 里那对「+ 入库 / − 出库」按钮。

## 1. 改造前的问题（不是"能不能写库"，是"这笔账事后说不出话"）

原实现在 `apps/console/src/views/Inventory.vue`：两个按钮直接 `POST /inventory/inbound|outbound` → `InventoryService.adjustStock`，表单只有「事由」一个自由文本框。后果：

- **同一本账两种凭证**：PDA 收货/上架/发料有单据号，手工出入库没有；月底对账只能翻台账的自由文本。
- **盘盈盘亏无处落脚**：系统没有盘点单/损益单，把按钮藏掉等于断了盘盈盘亏的后路——所以不能简单隐藏，必须给出替代口径。
- **类型与方向可以自相矛盾**：想加库存也能写"盘亏"，想减库存也能写"采购到货"，事后无法区分是笔误还是造假。

## 2. 改造方案

手工出入库入口**下线**，换成「库存调整单」：类型 + 原因 + 明细行 + 过账。过账仍逐行调 `InventoryService.adjustStock`，FIFO / 行锁 / 事务台账 / 入库自动建批次全部照旧——**没有第二条写库存的路**，因此不存在第二套账。

| 维度 | 改造前 | 改造后 |
|---|---|---|
| 凭证 | 无 | `SA-YYYYMMDD-NNNN`，租户内唯一 |
| 分类 | 无 | 盘盈 / 盘亏 / 报废 / 退货入库 / 其他调整 |
| 原因 | 自由文本（2–200 字） | 必填 2–200 字，且**类型约束方向** |
| 明细 | 单物料单行 | 最多 50 行，可混合物料/批次/库位 |
| 生效时机 | 提交即改库存 | 保存只建草稿；点「过账」才动库存 |
| 追溯 | 台账 reason 文本 | 台账 reason 前缀 `[SA-…]`，可反查单据与行 before→after |
| 部分失败 | 无此概念 | 停在失败行，单据落 `PARTIAL`，成功行不回滚、失败行可重试 |
| 作废 | 无 | 未过账可作废（带原因）；已过账只能另开反方向单冲回 |

**类型-方向硬约束**（`assertDirection`）：

- 盘盈 / 退货入库 → 只能为正；盘亏 / 报废 → 只能为负；其他调整 → 正负皆可，但原因要写清业务背景。

这条不是体验优化，是口径护栏：把「盘亏当成加库存的理由」在入口就拦掉。

## 3. 数据模型

`backend/scripts/inventory_stock_adjustments.sql`（已登记 `db-manifest.txt`，排在 `saas_p6_rls.sql` **之前**，让 RLS 动态遍历时自动覆盖新表）：

- `stock_adjustments`：`adjust_no` 唯一、`adjust_type` / `status` 带 CHECK、`created_by/posted_by/cancelled_by` 与三个时间戳
- `stock_adjustment_lines`：`sku_code`（过账直接喂 adjustStock，不必反查）、`qty_delta`（带符号，CHECK 非零）、`qty_before/qty_after` 回填、`error` 存失败原因、`line_no` 单据内唯一

`stock_batches` / `stock_moves` **结构未改**：单据号写进 `stock_moves.reason` 前缀，台账查询照旧可用（`docs/10 §9` 的台账口径不变）。

## 4. 接口（前缀 `/api/v1`，模块门 `inventory`，权限复用 `inventory:stock:read` / `inventory:stock:adjust`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/inventory/adjustments` | 列表（status / adjustType / keyword / 分页），带每单行数与已过账行数 |
| GET | `/inventory/adjustments/:id` | 详情（头 + 行 + `netDelta`） |
| POST | `/inventory/adjustments` | 建草稿（`adjustType` / `warehouseId|warehouseCode` / `reason` / `lines[]`） |
| POST | `/inventory/adjustments/:id/post` | 过账（逐行，返回每行结果与 `allDone`） |
| POST | `/inventory/adjustments/:id/cancel` | 作废（未过账可作废；已过账 400 并提示另开反方向单） |

**没有新增权限项**，复用已有的 `inventory:stock:adjust`——避免存量租户还要补 `role_permissions`。`GET /inventory/inbound|outbound` 两个老端点**保留**（PDA / Agent 工具仍在用），只是 console 不再暴露手工入口。

## 5. 前端

- 新页 `apps/console/src/views/InventoryAdjustments.vue`（路由 `/inventory-adjustments`，菜单「库存管理 → 库存调整」，需 `inventory:stock:adjust`）
  - 列表：单号 / 类型 / 仓库 / 原因 / 行数（已过账/总）/ 状态 / 操作（详情、过账、作废）
  - 新建：类型（带方向说明条）、仓库、原因、备注 + 动态明细行（物料筛选、批次、库位按仓过滤、方向 +/−、数量），方向随类型自动锁定
  - 详情抽屉：头信息、净变动、每行增减与「变动前→后」、行状态与失败原因；`PARTIAL` 时提示可继续过账
  - 过账前二次确认，明确"过账后不能作废，要冲回得另开反方向单"
- 库存页 `Inventory.vue`：删掉「+ 入库 / − 出库」与对应对话框（约 120 行），换成「库存调整（开单）」跳转；跨仓调拨保持原样（调拨是作业，不是调整）

## 6. 验收记录（2026-11-25，真实 PG + 真实 API）

| 场景 | 结果 |
|---|---|
| 盘亏单建单 | `SA-20261125-0001` DRAFT，单号格式与类型中文名正确 |
| 盘亏却填正数 | 400「『盘亏』只能减少库存，请检查方向」 |
| 原因只有 1 个字 | 400 参数校验失败 |
| 无库存仓库过账 | 行 FAILED「演示中心仓（长沙）没有『有机苹果』的可出库批次」，单据 `PARTIAL` |
| 正确仓库过账 | 120 → 115，`POSTED`，`netDelta -5` |
| 台账反查 | `OUT-20261125005641-52KB -5 | [SA-20261125-0002] 盘亏：…` |
| 重复过账 | 400「已过账，不能重复过账」 |
| 作废已过账单 | 400「已过账的单不能作废…」 |
| 作废草稿 | `CANCELLED`，提示"未产生库存变动" |
| 两行部分失败 | 第 1 行 115 → 113 成功、第 2 行超量失败，单据 `PARTIAL`，`netDelta -2` |
| 盘盈过账（纯函数重构后回归） | 0 → 2，`POSTED` |
| 单测 | `src/inventory/__tests__/stock-adjustment.test.ts` 8 例（方向约束 / 中文名齐全 / 单号补零 / 状态收敛） |
| 类型检查 / 构建 | 后端 `tsc --noEmit` 0 错；console `vue-tsc -b --noEmit` 0 错、`vite build` 通过 |

## 7. 遗留与边界（不粉饰）

1. **作废不回滚已过账行**：库里确实动过，反方向单才是可审计做法；作废只关闭剩余行，返回的 `note` 明确说清已有多少行过账。
2. **单号按当日张数 +1 重试**：并发极高时可能重试 6 次后失败；量级上够用（一个人一天开不了 6 次冲突的单）。
3. **没有审批流**：创建人即过账人。若以后要"主管复核"，在 `stock_adjustments` 加 `approved_by/approved_at` 并在 `post` 前拦一道即可，不动表结构以外的东西。
4. **调拨仍未单据化**：跨仓调拨保留原交互（同样有台账留痕 + reason）。它不属于"账实调整"，这次没顺手改。
5. **`stock_moves` 按 reason 关联单据**：没有加 `adjust_no` 列（避免动台账表），靠前缀约定；若将来要做"按单据筛台账"，再补列更直白。
