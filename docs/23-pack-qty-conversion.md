# U5.3 拆箱数量换算（B：中包/托盘 → 单品件数）

> 目标：物料挂的中包码/托盘码带"每包件数"；PDA 扫到包码时自动折回单品件数累加，库存台账始终记**单品数量**。
> 承接：`docs/22-material-multi-gtin.md`（U5.2 多 GTIN 整组匹配）。

---

## 1. 数据模型

`material_gtins` 增加列 `pack_qty numeric(14,3) NOT NULL DEFAULT 1`（迁移 `backend/scripts/wms_u5_material_gtins.sql` 末尾，幂等 `ADD COLUMN IF NOT EXISTS`）：

| 级别 | `pack_qty` 口径 |
|---|---|
| `UNIT` 单品码 | 恒为 1（服务端强制，录入不接受其他值） |
| `CARTON` 中包码 | 每包含的单品件数，必须为正数 |
| `PALLET` 托盘码 | 每托含的单品件数，必须为正数 |

- 小数保留三位（`round3`：四舍五入到 3 位小数）。
- 存量行 `pack_qty` 回填为 1。

## 2. 纯函数（`backend/src/udi/udi.match.calc.ts`）

- `PackRow { gtin, packLevel, packQty }`。
- `matchPack(rows, scannedGtin)`：从整组码里找出扫码命中的包装行；未命中返回 `null`。
- `convertToUnits(packCount, packQty, packLevel?)`：非 UNIT 级 `单品件数 = 包数 × 每包件数`；UNIT 级不折算，直接返回包数；结果 `round3`。

## 3. 服务与接口

**物料维护**（`POST/PUT /api/v1/masterdata/materials`）：

```json
{ "code": "M-001", "gtins": [
  { "gtin": "06901234567892", "packLevel": "UNIT" },
  { "gtin": "06901234567908", "packLevel": "CARTON", "packQty": 24 }
] }
```

- 中包/托盘缺 `packQty` 或非正数 → 400「每包件数必须为正数」。
- UNIT 级 `packQty` 被强制写回 1。
- 物料列表 / 详情的每个码行回带 `packQty`（数字）。

**网关**（`backend/src/wms/gateways/inventory.gateway.ts`）：

- `resolveMaterial` 返回体新增 `gtinRows: [{ gtin, packLevel, packQty }]`（`gtins` 字符串数组保留兼容）。
- 新增 `resolveMaterialGtinRows({ tenantId, materialId })`，收货折单直接取行对象。

## 4. 收货折箱（`inbound.service.receiveScan`）

1. 入参 `qty` 语义为**包数**（扫几包/几托）。
2. UDI 匹配到包装行后：
   - 命中 `CARTON/PALLET`：`单品件数 = 包数 × packQty`，台账 `qtyReceived` 累加单品件数。
   - 命中 `UNIT`：不折算，包数即件数。
3. 响应回带 `pack: { packCount, packQty, packLevel, units }`；UDI `RECEIVE` 事件 detail 保留 `packCount / packQty / packLevel` 与折算后单品 `qty`。
4. 扫错料（`WRONG_SKU`）盲收分支仍按包数记差异行，不做折算。

> 口径说明：发料侧数量仍由 WMS 工单行 `qty` 决定，本轮**不在发料做包码折算**；超收/短收差异比对按折算后的单品件数进行。

## 5. 前端

- 产品资料页 GTIN 多行输入第三段为每包件数：`6901234567892|CARTON|24`；省略第三段默认 1。
- 回显时中包/托盘行带第三段件数。

## 6. 验证

- 纯函数单测新增 4 例：包码命中带级别与件数、未命中/空列表安全、相乘与 UNIT 不折算、小数包数三位取整。
- 全量 `pnpm test` **860 例 / 853 通过 / 0 失败 / 7 跳过**；`pnpm typecheck` 零错误；console `vue-tsc + vite build` 通过。

## 7. 诚实边界

- 收货折箱分支无 `InboundService` 服务级单测（缺 Repository 夹具），需真库验证。
- 发料暂不支持包码折算；不支持 SSCC 箱码；托盘→中包→单品层级换算未做递归。
- `material_gtins`（含 `pack_qty`）未在真 PostgreSQL 跑集成门；上线前执行迁移并重跑 `saas_p6_rls.sql` 挂租户隔离。
