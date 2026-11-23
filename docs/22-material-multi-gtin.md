# U5.2 多 GTIN（单品 / 中包 / 托盘）

> 目标：一个物料可能同时有单品码、中包码、托盘码，扫码比对时按**整组**匹配，而不是只认一个 GTIN。
> 相关：`docs/21-material-gtin-and-scan-match.md`（U5.1 单码与拦截）。

---

## 1. 数据模型

新表 `material_gtins`（迁移 `backend/scripts/wms_u5_material_gtins.sql`，幂等）：

| 列 | 类型 | 说明 |
|---|---|---|
| `tenant_id` / `material_id` | bigint | 租户 + 物料 |
| `gtin` | varchar(14) | GTIN14（含校验位） |
| `pack_level` | varchar(8) | `UNIT` / `CARTON` / `PALLET`（CHECK 约束） |
| `is_primary` | boolean | 主码（优先 UNIT 级，用于打标签/展示） |

- 唯一索引 `(tenant_id, gtin)`：同一租户一个码只属于一个物料。
- 物料索引 `(tenant_id, material_id)`。
- **回填**：脚本把 `materials.gtin` 里已有的单码写入表（`UNIT` + 主码），`ON CONFLICT DO NOTHING`。
- `materials.gtin` 保留为"主码镜像"，兼容旧接口/旧数据；真正比对读 `material_gtins` 整组。

---

## 2. 接口与行为

**物料维护**（`POST/PUT /api/v1/masterdata/materials`）：

```json
{ "code": "M-001", "name": "球囊扩张导管", "udiRequired": true,
  "gtins": [
    { "gtin": "06901234567892", "packLevel": "UNIT" },
    { "gtin": "06901234567908", "packLevel": "CARTON" }
  ] }
```

- `gtins` 最多 10 条；级别只允许 UNIT/CARTON/PALLET，非法直接 400。
- 也兼容单个 `gtin` 字段（视为 UNIT），老前端不用改。
- 同物料内去重、跨物料查重（`GTIN ... 已被物料 X 占用`）。
- 更新时按"整组覆盖"（先删后插），前端提交什么就是什么。
- 列表接口返回 `gtins: [{gtin, packLevel, isPrimary}]`，供页面展示。

**扫码比对**（`udi.match.calc`）：

- `matchMaterialGtins(list, scannedGtin)`：列表中任意一个命中即通过；列表为空 → 跳过；全为脏数据 → 拒绝并说明。
- `judgeScanGtin({materialGtins, materialGtin, ...})`：有整组就按整组比，没整组退回单码。
- 级别**不影响放行**：扫到 CARTON 码同样通过（本轮不做"中包码应拆几件"的数量换算）。

---

## 3. 代码位置

| 文件 | 变更 |
|---|---|
| `backend/scripts/wms_u5_material_gtins.sql` | 新表 + 唯一索引 + 回填 |
| `backend/src/inventory/inventory.entity.ts` | `MaterialGtin` 实体 |
| `backend/src/inventory/inventory.module.ts` / `src/entities/index.ts` | 注册与导出 |
| `backend/src/inventory/inventory.service.ts` | `prepareGtins`（校验/查重/主码）、`syncGtins`（整组覆盖）、列表回 `gtins` |
| `backend/src/inventory/dto/masterdata.dto.ts` | `gtins?: {gtin, packLevel}[]` |
| `backend/src/wms/gateways/inventory.gateway.ts` | `resolveMaterial` 回 `gtins[]`；新增 `resolveMaterialGtins()` |
| `backend/src/wms/inbound/services/inbound.service.ts` | 收货按整组比对 |
| `backend/src/wms/issuing/services/issuing.service.ts` | 发料扫码/过账按整组比对 |
| `apps/console/src/views/Masterdata.vue` | GTIN 改为多行文本（`码|CARTON` 写法） |

---

## 4. 测试

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `udi.match.test.ts` | +5（共 15） | 中包码命中、全不匹配报错、空列表跳过、全脏数据拒绝、13/14 混存、整组优先 |
| `issuing.service.test.ts` | +1（共 18） | 扫到中包 GTIN（不在 `materials.gtin` 主码上）仍然放行并记 ISSUE |

全量：**856 例 / 849 通过 / 0 失败 / 7 跳过**；`typecheck` 零错误；console 构建通过。

---

## 5. 诚实边界

1. **级别只做标签，不做数量换算**：扫中包码不会自动按"1 箱 = 10 支"入账，数量仍由 `qty` 字段决定。真要做拆箱逻辑，需要 `pack_qty` 字段和库存单位换算，属下一阶段。
2. **不支持 SSCC 箱码**：`(00)` 开头的 18 位 SSCC 目前不参与比对（UDI 单品链路只解析 GTIN/批号/序列号/有效期）。
3. **收货分支仍无服务级单测**：与 U5.1 同一缺口，`InboundService` 没有夹具；整组比对的实际路径需真库联调。
4. **整组覆盖是硬覆盖**：接口没带 `gtins` 就不动；带了就按提交内容全量替换，不做增量合并（前端需回填现状再改）。
5. **真库未验证**：新表唯一索引、CHECK 约束、RLS 策略均未在 PostgreSQL 实测。
