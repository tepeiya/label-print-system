# UDI × WMS 联动（U5）实施记录

> 目标：把 UDI 追溯链接到 WMS 实务流上——**收货扫 UDI 自动建档并记 `RECEIVE`，发料记 `ISSUE`**，让"码"和"库存动作"在同一条时间线上。
> 前置：`backend/scripts/udi_p1_trace.sql` 已执行（`udi_units/udi_packages/udi_events` 三表存在），且已重跑 `saas_p6_rls.sql`。

---

## 1. 做了什么

| 能力 | 入口 | 行为 |
|---|---|---|
| 收货联动 | `POST /wms/receipts/:id/receive-scan` 带 `udiCode` | 解析码 → 建档（幂等）→ 记 `RECEIVE` 事件（`refType=wms_receipt`、`refNo=收货单号`）→ 返回单元状态 |
| 发料扫码联动 | `POST /wms/work-orders/:id/issue-scan` 带 `udiCode` | 校验单元必须已收货 → 记 `ISSUE` 事件（`refType=wms_work_order`、`refNo=工单号`） |
| 发料过账联动 | `POST /wms/work-orders/:id/issue-post` 带 `udiCodes` | 按 `{code,lineNo|lineId}` 逐条记 `ISSUE`，逐条容错并返回汇总 |
| 状态守卫 | 纯函数 `checkUnitForReceive/checkUnitForIssue` | 一码不可多收、未收货不可发、已发料不可重发（同单同工单幂等回放） |
| 幂等键 | `receiveIdemKey` / `issueIdemKey` | `RECEIVE:{receiptNo}:{udiKey}`、`ISSUE:{woNo}:{lineNo}:{udiKey}`，超长截 128 与 `idem_key` 列宽对齐 |

**键口径**：`udiKey = GTIN14|批号|序列号|GS1六位有效期`，与 U2 追溯键一字不差（如 `06901234567892|LOT202611|SN0001|271231`）。

---

## 2. 代码位置

| 文件 | 说明 |
|---|---|
| `backend/src/udi/udi.link.calc.ts` | 新增纯函数：追溯键解析、幂等键、收货/发料状态守卫、事件 detail、批量汇总 |
| `backend/src/udi/udi.trace.service.ts` | 新增 `receiveByScan` / `issueByScan`（建档 + 事件 + 审计 `udi.link.receive` / `udi.link.issue`） |
| `backend/src/wms/inbound/dto/wms.dto.ts` | `ReceiveScanDto` 增 `udiCode`、`strictUdi` |
| `backend/src/wms/inbound/services/inbound.service.ts` | 扫码成功后调用 `udiOnScan`；失败默认只告警（`udiWarning`）并记 `wms.receive.udi.failed` 审计 |
| `backend/src/wms/issuing/services/issuing.service.ts` | `issueScan` 支持 `udiCode`；`issuePost` 支持 `udiCodes`，逐条容错返回 `udi` 汇总 |
| `backend/src/wms/wms.module.ts` / `issuing.module.ts` | 引入 `UdiModule`（单向依赖：WMS → UDI，UDI 不依赖 WMS，无环） |

**取值口径**：发料联动里的 `materialCode` 由 `InventoryGateway.resolveMaterial(materialId)` 实取，不用行字段猜测。

---

## 3. 串起来的业务链

```
供应商打印 UDI 标签 →（PDA 收货扫）→ 单元建档 REGISTERED → RECEIVE → RECEIVED
                                        ↓
                          （PDA 发料扫）→ ISSUE → ISSUED →（后续 SHIP 在阶段三接出库）
```

一条码从"打印"到"发出去"全程同一条 `udi_events` 事件流，`trace(code)` 可直接看到：建档 → 收货（收货单号/行）→ 发料（工单号/行）。

---

## 4. 测试

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `backend/src/udi/__tests__/udi.link.test.ts` | 10 | 追溯键口径、脏码、两个幂等键、128 截断、收货/发料状态守卫全状态表、detail、汇总 |
| `backend/src/udi/__tests__/udi.trace.service.test.ts` | +8（共 21） | 收货自动建档+RECEIVE、同单幂等、换单重复收货 409、未收货发料拒绝、收货后发料+重复幂等、换工单重发 409、未建档 404、已发料不可再收货 |
| `backend/src/wms/__tests__/issuing.service.test.ts` | +2（共 14） | 过账带 `udiCodes` 逐条记账且单条失败不阻塞过账；扫码带 `udiCode` 联动并回传 |

全量：**837 例 / 830 通过 / 0 失败 / 7 跳过**（净增 20 例），`pnpm typecheck` 零错误。

---

## 5. 诚实边界

1. **真库验证范围**：WMS 侧 G1–G7 与打印网关已在真 PG 实证（`docs/26`）；`udi_events` 唯一键 `(tenant_id, idem_key)` 与 UDI 专属 RLS 仍只有单测 + DDL 证据。
2. **UDI 联动是旁路**：收货/发料主流程不因 UDI 失败而回滚，默认只给 `udiWarning` + 审计；需要强校验时传 `strictUdi: true`。这样做的理由是"库存动作已经发生，不能为一条码回滚整单"。
3. **不做 GTIN ↔ 物料校验**：没有维护 `material.gtin` 映射，目前不校验"扫到的 GTIN 是否就是该行 SKU"，只校验单元状态与幂等。这是明确的缺口，售前不能宣称"错料自动拦截"。
4. **不做数量联动**：UDI 只到"单品/单元"粒度，未校验"扫了 N 个码 = 发料 N 件"，数量仍由 WMS 的 `qty` 字段决定。
5. **未做 SHIP**：成品出库写 `SHIP` 属阶段三 `wms.outbound`。
6. **未做退货联动**：退料只回补 WMS 库存；UDI 侧暂不记 `RETURN`（避免"退回的码还能不能再发"的口径歧义，留待与客户确认）。

---

## 6. 下一步（建议顺序）

1. 补 `material.gtin`/`udi_required` 字段 → 实现"扫错料拦截"（医疗客户最有感知的一条）。
2. 真 PG 跑 U5 三门：同单幂等、跨单重复收货 409、跨工单重发 409。
3. PDA 页面把 `udiCode` 接到现有收货/发料扫码框（当前仅后端 API 支持）。
4. U6：国家 UDI 数据库（DI 备案）导出格式。
