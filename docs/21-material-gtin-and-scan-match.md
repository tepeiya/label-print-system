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

1. **收货拦截无服务级单测**：`InboundService` 依赖 6 个 Repository，项目里没有它的测试夹具。收货分支已在本机 PG14 真库逐条联调（见 §6.2 实测表），但**没有自动化测试**，回归仍需人工跑。
2. **一个物料只能挂一个 GTIN**：同一 SKU 的多规格/多包装（中包、箱码）暂不支持；如需多码，下一步加 `material_gtins` 子表。
3. **不校验 SSCC/包装码**：只比对单品码（GTIN14 + 批号/序列号）；扫箱码（SSCC）当单品处理会失败。
4. **GTIN 未回填旧数据**：存量物料 `gtin` 为空，不比对；需要客户按物料维护，或从 BOM/供应商资料导入（未做导入）。
5. **发料扫码是"校验"不是"门禁"**：`issue-scan` 不改库存，真正的拦截发生在 `issue-post`（必须带 `udiCodes` 才校验）；只扫不传码的客户端仍能过账（除非物料 `udi_required`）。

---

## 6. W5：扫 UDI 即收货（2026-11-25）

### 6.1 改了什么

| 位置 | 变更 |
|---|---|
| `InventoryGateway.resolveMaterialByGtin` | 新增：GTIN → 物料反查（先 `materials.gtin` 精确匹配，再 `material_gtins` 中包/托盘码）；只放行 `active=true`；命中 0 → 带原因；命中多物料 → 返回 `candidates` 要求显式 SKU |
| `InboundService.receiveScan` | 无 `sku`、无 `lineId/lineNo`、只给 `udiCode` 时，解析码取 GTIN → 反查物料补出 SKU → 照原逻辑按 SKU 找单内行；审计 `wms.receive.udi.resolve_sku` |
| 同上（重复扫码守卫） | UDI 事件**先记**再累加：同一单元在本单已记 RECEIVE（`idempotent=true`）→ 返回 `duplicate:true` + 「数量未重复累加」，审计 `wms.receive.udi.duplicate_scan` |
| `apps/pda` `ReceiveScan.vue` | 识别 GS1（HRI `(01)…` 或元素串 `01…`）→ 只填 `udiCode`、SKU 留空；新增 UDI 输入框与「清空」；成功提示带箱码折算 / UDI 建档 / GTIN 匹配结果 |
| `apps/pda` `apiReceiveScan` | 入参补 `udiCode / strictUdi / forceUdi`；返回补 `pack / udi / udiWarning / udiResolved` |

扫码内容判定：`gs1Gtin()` 只认两种——HRI 括号含 `(01)` + 12~14 位，或元素串以 `01` 开头 + 14 位（先剔 FNC1 `\u001d/\u001e`）。认不出就按旧逻辑当 `SKU|数量|批次` 处理。

### 6.2 真库实测（本机 PG14 + 后端 :3202，收货仓 WH-JX=2）

| # | 操作 | 结果 |
|---|---|---|
| 1 | 物料 `M-PEAR-001` 登记 `gtin=06901234567892`，建单 `GRN-UDI-01`（`warehouseId=2`，应收 10） | 201 |
| 2 | `receive-scan` 只传 `{"qty":5,"udiCode":"(01)06901234567892(10)LOT2611(17)271231(21)SN0001"}` | 200；`udiResolved.materialCode=M-PEAR-001`；行 `qtyReceived=5`；`udi.status=RECEIVED`、`created=true` |
| 3 | 同码再扫一次 | `duplicate:true`，`qtyReceived` 仍 5；审计 `wms.receive.udi.duplicate_scan` |
| 4 | 换序列号 `SN0002`（同 GTIN/批次） | 行累计 10 |
| 5 | 合法但未登记 GTIN `16901234567899` | 400「GTIN 16901234567899 未匹配到物料（请先在物料主数据登记该 GTIN）」 |
| 6 | 校验位错误的码 `(01)06901234567893` | 400「AI(01) 模 10 校验位错误：应为 2，实际 3」 |
| 7 | `POST /wms/receipts/1/post` | 200；`movementId=WMS_RECEIPT:GRN-UDI-01:M-PEAR-001:LOT2611`，库位 `JX-A01`（兜底「最空库位」） |
| 8 | 查 `stock_batches` | `WH-JX / LOT2611 / 11 / RELEASED / location=4` |
| 9 | 物料改 `qc_required=true` 后建 `GRN-QC-02` 收 2kg | 批次 `LOT-QC1 / WH-JX / PENDING`（收货即待检） |

### 6.3 边界（仍然存在）

1. **收货仓不由扫码决定**：来自建单 `warehouseId`；扫码只累加行数量，过账才入库。
2. **过账要求目标仓有可用库位**：无库位直接 400「仓库无可用库位，无法过账（禁止无库位库存）」——新仓上线前必须先建库位。
3. **SSCC 箱码不能反查**：`(00)` 里没有 GTIN，扫 SSCC 仍需选行或输 SKU。
4. **GTIN 唯一索引在 `materials`**（`ux_materials_tenant_gtin`），中包/托盘码在 `material_gtins` 无唯一约束；同码挂多物料时要求显式 SKU（防串料），不自动挑。
5. **打印标签是旁路**：`WMS_SERVICE_TOKEN` 未配置时过账仍成功，只在 `results[].print` 记 `failed`。
6. **PDA 摄像头需 HTTPS 或 localhost**；离线/弱网无补偿。

---

## 7. 收货标签"自动打印"的真实链路（2026-11-25 补测）

### 7.1 触发方式

`POST /wms/receipts/:id/post` **过账时逐行自动触发**，不需要人点：

```
每行 → PrintGateway.createJob({
         templateCode: 'RECEIPT_LABEL_V1',
         printerRoute: 'receipt-station',   // 阶段一仅作审计字段，不解析物理打印机
         idempotencyKey: `GRN:{收货单号}:{行号}`,
         copies: 1, source: 'wms.inbound.receipt'
       })
     → POST /api/v1/internal/print-jobs (Bearer WMS_SERVICE_TOKEN, 需 print:job:write)
     → 按 (tenant_id, code) 取模板 → 幂等 claim → print.createJob
     → print_jobs(status=queued) + Bull 队列 → worker 渲染/下发 → print_logs
```

- **每行一次、每次 1 份**（不是整单一张）。
- 幂等键 `GRN:单号:行号`：重复过账/重试不会重复出纸（同 key 同参回放 `idempotent:true`，同 key 不同参 409）。
- 超时 3 秒，超时视为未知结果**不重试**（防重复出纸）。
- 失败**不阻塞**过账：结果里 `results[].print` 记状态，审计写 `wms.print.call`。
- 补打走独立入口 `POST /wms/receipts/lines/:lineId/reprint-label`，新键 `GRN:单号:行号:reprint:{n}`，只允许已过账行。

### 7.2 要真出纸，三个前置缺一不可

| 前置 | 缺失时的表现 |
|---|---|
| `WMS_SERVICE_TOKEN`（Agent token，scope `print:job:write`） | `print.status=failed`，`WMS_SERVICE_TOKEN 未配置，无法调用打印服务` |
| 租户里存在 `code=RECEIPT_LABEL_V1` 的模板 | 404 `PRINT_TEMPLATE_NOT_FOUND`（**已由种子脚本补齐**，见 §7.4 #1；老库跑一次 `wms_receipt_label_template.sql` 即可） |
| `printers` 绑定打印机 + 打印代理在线 | WMS 内部调用（`requirePrinter=true`）标 `skipped_no_printer` 且 `printer_id` 为空；前端手打仍是旧语义（见 §7.4 边界 2） |

### 7.3 本轮修掉的 bug

`Template` 实体漏映射 `code` 列，`/internal/print-jobs` 每次必 500：

```
EntityPropertyNotFoundError: Property "code" was not found in "Template"
```

即"token 和模板都配好了也打不出来"。已在 `backend/src/entities/template.entity.ts` 补 `code` 映射（对齐 DDL 的 `ux_templates_tenant_code`）。修复后实测：过账返回 `print={jobId:1,status:"queued"}`，`print_jobs` 1 张 `success`、`print_logs` 1 条 `success`。

### 7.4 三件待办已全部落地（2026-11-25 第二轮）

| # | 待办 | 落地方案 | 真库实测 |
|---|---|---|---|
| 1 | 种子没有收货标签模板 | `backend/scripts/wms_receipt_label_template.sql`：按租户 upsert `code=RECEIPT_LABEL_V1`（50×30mm、7 元素、变量 `skuCode/skuName/batchNo/qty/unit/receiptNo/lineNo`）；存量只覆盖"仍是种子描述"的行，客户改过的不动 | 建库后 `templates` 自动有 1 行，`jsonb_array_length(elements)=7` |
| 2 | 无打印机静默 success | `PrintService.createJob` 新增 `requirePrinter`；取不到 printerId 就**不入队**，直接落 `print_jobs.status='skipped_no_printer'`（`params.skipReason=no_printer`）+ 审计 `print.job.skipped_no_printer`，返回带 `message`/`warnings`；`InternalPrintService` 传 `requirePrinter:true`；`wms_p9_print_route_and_skip.sql` 扩 status CHECK | 过账返回 `print.data.status=skipped_no_printer`，`print_jobs.printer_id` 为空，主链路照常 RECEIVED |
| 3 | printerRoute 没有物理映射 | 新表 `print_printer_routes(tenant_id,route_code,printer_id,enabled,priority,remark)` + 实体 `PrintPrinterRoute` + `GET/POST/DELETE /print/printer-routes`（`print:job:read` / `print:job:write` + admin/operator）；解析规则：同租户同 routeCode、`enabled=true`，取 `priority` 最小的一台 | 建路由后过账 `status=queued` → 异步 `success`；priority=0 的新路由抢过 priority=1；`enabled=false` 时回落 `skipped_no_printer` |

**顺手查出的第二个真 bug**：模板首版条码框宽 30mm，而 `M-PEAR-001`（10 字符 CODE128）实测需 41.3mm，被 `barcode-guard` 拦下，任务直接 `failed`（错误：`条码自检未通过…会溢出被切`）。改成条码横贯 46mm + 自带明文后，同一单据 `success`。

修前后对照（同一台 `image` 打印机、同一 SKU）：

| 单据 | 模板版式 | 结果 |
|---|---|---|
| GRN-R10 | 无打印机/无路由 | `skipped_no_printer`（job 1） |
| GRN-R11 | 条码框 30mm | `failed`（条码溢出 41.3 > 30mm） |
| GRN-R13 | 条码框 46mm | `success`（done=1） |
| GRN-R14 | 两台打印机、priority 0/1 | 命中 priority=0 那台，`success` |
| GRN-R15 | 路由 `enabled=false` | 回落 `skipped_no_printer` |

**仍然没做的边界**（别当成已具备）：

1. 路由表没有按"标签尺寸/模板"匹配，也不支持多台同时出纸（一台标签只落一台机）。
2. `requirePrinter` 只对 WMS 内部调用生效；前端手打的 `POST /print/jobs` 不传该参数，仍走旧的"无打印机也可入队"语义。
3. 路由变更无审计事件（只有 upsert/delete 的普通接口日志）。
4. `db-expected-tables.txt` 已补 `print_printer_routes`（88 条）。
