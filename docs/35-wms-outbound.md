# 35 · 成品发运（wms.outbound）

> 补掉 `wms.outbound` 只剩模块目录、没有代码的空壳。上一版系统能"扣库存"，不能"发货"：
> 没有发货单、没有客户与运单、没有签收，UDI 的 `SHIPPED` 状态虽然定义在状态机里，
> 却没有任何入口能产生一条 SHIP 事件（`shippedCount` 永远是 0）。
> 本文记录这一轮的设计取舍、真库实测结果与仍然没做的事。

## 1. 问题定义

| 层 | 存量状态 | 这一轮补齐后 |
| --- | --- | --- |
| 库存动作 | 有：`POST /inventory/outbound`（单行 delta 扣减、FIFO、批次校验） | 保留（PDA / Agent 仍在用），但 console 不再直接暴露 |
| 业务单据 | **没有**：无发货单/拣货/客户/承运商/签收 | 有：`wms_shipments` + `wms_shipment_lines`，状态机 6 态 |
| UDI 联动 | **没有入口**：`SHIPPED` 只能靠手工调 `/udi/units/events` | 过账时按行自动置 SHIPPED（单品码逐个 / SSCC 整包递归） |
| 前端入口 | **没有**（`apiStockOutbound` 是死代码） | console「成品发运」页 + PDA「成品发运 / 拣货出库」两页 |

## 2. 数据模型

DDL 见 `backend/scripts/wms_p3_outbound.sql`（排在 `saas_p6_rls.sql` 之前，保证新表被 RLS 覆盖）。

`wms_shipments`（头）
- `shipment_no`：`SH-YYYYMMDD-NNNN`，租户内唯一（撞索引重试，最多 6 次）
- `ship_type`：`SALES / TRANSFER / SAMPLE / OTHER`
- 客户/地址/承运商/运单/要求发货日：文本字段（**不引入客户主数据表**，对接 ERP 时由 ERP 传编码）
- `status`：`CREATED / PICKING / PICKED / SHIPPED / SIGNED / CANCELLED`（有 CHECK 约束）

`wms_shipment_lines`（行）
- `qty_plan / qty_picked / qty_shipped`（`NUMERIC(14,3)`，出参 Number 化）
- `batch_no / location_id`：拣货时可改；留空则过账按 FIFO 跨批次扣
- `pack_sscc`：托盘/箱码（18 位，出库时按包层级递归）
- `udi_codes`：单品 UDI 码数组（`JSONB`）
- `status`：`PENDING / PICKED / SHIPPED / SHORT / FAILED`
- `udi_result`：本行 UDI 联动结果（含失败原因，**不阻塞库存**）

## 3. 状态机与口径

```
CREATED ──拣货──▶ PICKING ──全部拣完──▶ PICKED ──过账──▶ SHIPPED ──签收──▶ SIGNED
   └─────────────┴─────────────┴──作废──▶ CANCELLED
```

三条硬口径（都在 `shipment.calc.ts`，可单测）：

1. **拣货不动物理库存**。本项目没有同仓移库能力（`InventoryGateway.transferStock` 明确抛错），
   所以拣货只确认"发哪批、发多少"；真正扣减发生在出库过账。副作用是：已拣未发的单可以安全作废。
2. **过账数量 = 实拣量，差额记缺量**。拣了 400 / 计划 500，就扣 400、行落 `SHORT`，
   不假装发齐。**没拣的行按计划量直发**（PDA 现场常见"扫一箱就走"，两步合一）。
3. **库存一旦动过就不许作废**。`SHIPPED / SIGNED` 作废直接 400，提示走退货入库
   （`wms_wo_returns` / 库存调整单 `RETURN`）；已出库的行也不能"退货冲回"式地作废。

单行过账走 `InventoryGateway.decreaseStock`，幂等键 `ship:{shipmentNo}:{lineNo}`；
同一行重放返回原结果，不二次扣减。台账 `stock_moves.reason` 写成
`[SH-20261125-0001] 销售出库：某某医疗器械经销公司`，可按单号反查。

## 4. UDI 联动（SHIP → SHIPPED）

`UdiTraceService` 新增两个方法（`udi.trace.service.ts`）：

| 方法 | 入参 | 行为 |
| --- | --- | --- |
| `shipByScan` | `code`（GS1 扫码原文 **或** `gtin\|lot\|serial\|expiry` 键）、`shipmentNo` | 校验单元状态 → 记 `SHIP` 事件 → `SHIPPED`；事件幂等键 `SHIP:{单号}:{udiKey}` |
| `shipPackage` | `sscc`、`shipmentNo` | 解析包树（`descendantsOf` 递归子包），包内所有已建档单元逐个 `shipByScan`，返回汇总 |

过账时按行触发：`pack_sscc` 非空 → `shipPackage`；`udi_codes` 非空 → 逐个 `shipByScan`。

**失败不阻塞库存**：库存已经动了是事实，UDI 联动失败只落 `udi_result` 并在页面提示
（"码状态未置已出库，请到 UDI 追溯补记"）。这条取舍写在这里，避免以后被当成 bug 修成"回滚库存"。

状态机本身早就支持：`RECEIVED | ISSUED | SHIPPED → SHIP → SHIPPED`（`udi.trace.calc.ts`），
这一轮补的是**入口**，没有改状态机。

## 5. API（9 个端点，全部挂 `@RequireModule('wms.outbound')`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/wms/shipments` | 建单（1–100 行；`SALES` 必须填客户名） |
| GET | `/wms/shipments` | 列表（status / shipType / 关键字 单号·客户·运单） |
| GET | `/wms/shipments/:id` | 详情（含行、物料名、库位文本） |
| GET | `/wms/shipments/:id/recommend` | FIFO 批次建议（复用发料的 `allocateBatches`：效期优先、过期提醒、缺口） |
| POST | `/wms/shipments/:id/lines/:lineId/pick` | 拣货（qty ≤ 计划量；可改批次/库位/SSCC/码） |
| POST | `/wms/shipments/:id/post` | 出库过账（逐行扣减 + UDI 联动，前行失败即停） |
| POST | `/wms/shipments/:id/sign` | 签收（记录客户签收人） |
| POST | `/wms/shipments/:id/cancel` | 作废（仅未出库） |

## 6. 前端

- console `apps/console/src/views/WmsShipments.vue`（约 470 行）：列表 / 新建（客户·承运商·运单·明细，支持 SSCC 与 UDI 码）/ 详情抽屉（FIFO 推荐、行拣货、过账、签收、作废、UDI 失败提示）。
- PDA `ShipmentList.vue` + `ShipmentPick.vue`：按状态分 tab 选单 → 扫码定位行 → 行内输入数量拣货 / 按计划全拣 → 出库过账 → 客户签收。
- 路由：`/wms-shipments`（console，模块门 `wms.outbound`）、`/shipments`、`/shipments/:id`（PDA）。
- 菜单：库存管理分组下「成品发运」（`menu.catalog.ts`），与收货/发料并列。

## 7. 真库实测（2026-11-25，本地 PG14 + 演示数据）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 建单 | `SH-20261125-0001` | ✅ 两行：MD-SYR-05 500（批 LOT-2611A）/ MD-DRS-10 100 |
| FIFO 推荐 | 按效期给批次 | ✅ 行 1→LOT-2611A×500；行 2→LOT-2610G×100，缺口 0 |
| 拣货 400/500 | 单据 `PICKING`、行 `PICKED` | ✅ |
| 过账 | 扣 400 + 100，行 1 `SHORT` 缺 100，单据 `SHIPPED` | ✅ 合计 500，`allDone=true` |
| 库存 | MD-SYR-05 2400→2000；MD-DRS-10 900→800 | ✅ 台账按批次正确 |
| UDI 单品码 | 2 码 `RECEIVED → SHIPPED`，事件 ref=单号 | ✅ `ok:2 / failed:0`，`udi_events` 两条 SHIP |
| UDI 整包（SSCC） | 扫一个箱码，包内 2 单元全 `SHIPPED` | ✅ `units:2 / failed:0`（含 `descendantsOf` 递归） |
| 重复过账 | 400 拒绝 | ✅ "该发货单已出库，不能重复过账" |
| 已出库作废 | 400 拒绝 | ✅ "库存已变动，客户退回请走退货入库" |
| 签收 | `SIGNED` + 签收人 | ✅ 张仓管 |
| 列表 | 单据/状态/行数/计划量 | ✅ total=2，`SIGNED` / `SHIPPED` |
| 单测 | 新增 8 例全过 | ✅ `shipment-calc.test.ts` |

## 8. 已知未做 / 遗留

| 项 | 说明 |
| --- | --- |
| 客户主数据表 | 现在只存客户编码/名称文本；要做客户档案、信用额度、多收货地址，需要新建 `customers` 表 |
| 发货单打印 | 「打印发货单/装箱单」未做；`PrintGateway` 可复用，但需要模板与纸张口径 |
| 部分行失败后的重试入口 | 过账前行失败会停并按 `FAILED` 保留，PC 可再点「过账」继续，PDA 需重进页面（逻辑正确，交互偏简陋） |
| 退货入库联动 | 已出库单退货走库存调整单 `RETURN`，但未自动把 UDI 码置回 `RECEIVED`（`RETURN` 事件需要手工或后续补联动） |
| 多承运商/物流轨迹回传 | 只存运单号，不接快递 100 / 承运商 API |
| 拣货波次 / 批量拣货 | 一行一拣，没有波次、拣货单合并 |
| 出库与财务对账 | 不生成应收、不联动 billing；发货数量与账单无关 |

## 9. 代码位置

- DDL：`backend/scripts/wms_p3_outbound.sql`（清单 `db-manifest.txt` 第 33 步；期望表 `db-expected-tables.txt`）
- 实体：`backend/src/wms/outbound/entities/shipment.entity.ts`（已注册进 `src/entities/index.ts`）
- 纯函数：`backend/src/wms/outbound/services/shipment.calc.ts`
- 服务：`backend/src/wms/outbound/services/shipment.service.ts`
- 控制器：`backend/src/wms/outbound/controllers/shipment.controller.ts`
- DTO：`backend/src/wms/outbound/dto/shipment.dto.ts`
- UDI 联动：`udi.trace.service.ts`（`shipByScan` / `shipPackage`）、`udi.link.calc.ts`（`shipIdemKey` / `checkUnitForShip` / `shipDetail`）
- 前端：`apps/console/src/views/WmsShipments.vue`、`apps/console/src/api/wms-shipments.ts`、`apps/pda/src/views/ShipmentList.vue`、`ShipmentPick.vue`
- 单测：`backend/src/wms/__tests__/shipment-calc.test.ts`
