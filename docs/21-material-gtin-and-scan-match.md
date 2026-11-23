# U5.1 物料 GTIN 与扫错料拦截

> 目标：让系统知道"这个物料应该是什么码"，收货/发料扫码时能挡住扫错料——医疗客户最在意的一条。
> 前置：`backend/scripts/wms_u5_material_gtin.sql`；与 `udi_p1_trace.sql`、`wms_p2_issuing.sql` 同一库。

---

## 1. 数据模型

`materials` 新增两列（迁移脚本 `backend/scripts/wms_u5_material_gtin.sql`，幂等）：

| 列 | 类型 | 含义 |
|---|---|---|
| `gtin` | `varchar(14)` | GS1 GTIN14（含校验位）；空 = 不做比对 |
| `udi_required` | `boolean default false` | true 时收货/发料必须扫 UDI 码 |

- 唯一索引 `ux_materials_tenant_gtin (tenant_id, gtin) WHERE gtin IS NOT NULL`：同一租户一个 GTIN 只挂一个物料。
- **只收 13/14 位**：8/12 位的校验位计算口径与 GTIN14 补位不一致（实测 12 位会"录得进、比对不上"），所以录入阶段就拒绝，避免埋雷。13 位按 GS1 规则校验后左补零成 14 位。
- 物料侧写入走 `InventoryService.createMaterial/updateMaterial`，统一由 `materialGtinFor()` 校验（补位 + 校验位 + 查重），非法值 400。

---

## 2. 拦截点

| 场景 | 判定顺序 | 结果 |
|---|---|---|
| 收货扫码（带 `udiCode`） | 解析码 → 必扫校验 → GTIN 比对 | 不符：**拒绝本次扫码**（不累加数量），审计 `wms.receive.udi.gtin_block` |
| 收货扫码（物料 `udi_required` 但没带码） | 必扫校验 | 拒绝，提示"该物料要求扫 UDI 码" |
| 收货扫码（物料未登记 GTIN） | 比对跳过 | 放行 + 审计 `wms.receive.udi.gtin_skipped`（不误拦未赋码物料） |
| 发料扫码校验（`issue-scan`） | GTIN 比对 / 必扫 | `verdict.ok=false` + `mismatches[].field='gtin'`，`canForce=true`（可强制但有审计 `wms.wo.issue.udi.mismatch`） |
| 发料过账（`issue-post` + `udiCodes`） | 逐条解析 → 比对 | 单条不符：该码记失败，不影响其他行；`udi_required` 行未提供码：**该行不扣库存**，记 `skipped` |
| 发料过账（`force=true`） | 跳过必扫拦截 | 照常发料并留审计（D1 口径不变） |

**总入口**：`judgeScanGtin({materialGtin, udiRequired, codeGtin, hasCode, force})`——先判"没码"，再判"码不对"，`force` 一律放行（审计由调用方写）。纯函数、可穷举。

---

## 3. 代码位置

| 文件 | 说明 |
|---|---|
| `backend/src/udi/udi.match.calc.ts` | `normalizeMaterialGtin` / `matchMaterialGtin` / `checkUdiRequired` / `judgeScanGtin` |
| `backend/src/inventory/inventory.entity.ts` | `Material.gtin`、`Material.udiRequired` |
| `backend/src/inventory/inventory.service.ts` | 物料新增/编辑校验 GTIN（查重）、列表返回两字段 |
| `backend/src/inventory/dto/masterdata.dto.ts` | DTO 增 `gtin`、`udiRequired` |
| `backend/src/wms/gateways/inventory.gateway.ts` | `resolveMaterial` 返回 `gtin/udiRequired`（WMS 不碰 inventory 实体） |
| `backend/src/wms/inbound/services/inbound.service.ts` | 扫码收货前置拦截 + `forceUdi` 旁路 |
| `backend/src/wms/inbound/dto/wms.dto.ts` | `ReceiveScanDto` 增 `udiCode`、`strictUdi`；配置 `forceUdi` |
| `backend/src/wms/issuing/services/issuing.service.ts` | `issueScan` 合并 GTIN 判定；`issuePost` 逐码比对 + `udi_required` 行拦截 |
| `apps/console/src/views/Masterdata.vue` | 产品资料表单增「GTIN」「必须扫 UDI」，列表增两列 |
| `backend/scripts/wms_u5_material_gtin.sql` | 迁移 |

---

## 4. 测试

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `backend/src/udi/__tests__/udi.match.test.ts` | 10 | 13 位补零、12 位拒绝、校验位错拒绝、空值跳过、一致/不一致、缺 GTIN、必扫、总入口优先级、force |
| `backend/src/wms/__tests__/issuing.service.test.ts` | +3（共 17） | 扫错 GTIN → `verdict.ok=false` + `canForce`；`udi_required` 未扫码 → 判定失败；过账时缺码行不扣库存（批次数量实证） |

全量：**850 例 / 843 通过 / 0 失败 / 7 跳过**；`pnpm typecheck` 零错误；`apps/console` 构建通过。

---

## 5. 诚实边界

1. **收货拦截无服务级单测**：`InboundService` 依赖 6 个 Repository，项目里没有它的测试夹具；本轮只做了纯函数穷举 + 发料侧服务测试。收货分支的实际行为需在真库联调时逐条验证（建议列为真库门 G8）。
2. **一个物料只能挂一个 GTIN**：同一 SKU 的多规格/多包装（中包、箱码）暂不支持；如需多码，下一步加 `material_gtins` 子表。
3. **不校验 SSCC/包装码**：只比对单品码（GTIN14 + 批号/序列号）；扫箱码（SSCC）当单品处理会失败。
4. **GTIN 未回填旧数据**：存量物料 `gtin` 为空，不比对；需要客户按物料维护，或从 BOM/供应商资料导入（未做导入）。
5. **发料扫码是"校验"不是"门禁"**：`issue-scan` 不改库存，真正的拦截发生在 `issue-post`（必须带 `udiCodes` 才校验）；只扫不传码的客户端仍能过账（除非物料 `udi_required`）。
