# 36 · 质量三闸门：检验单 / 成品放行 / 批记录（2026-11-25）

> 背景：上一轮把「医疗器械业务流程 × 系统闭环」画成图，结论是 **物理流闭合、合规流不闭合** —— 三个 GMP 硬闸门在系统里根本不存在：
> ① 收货进来没有任何检验动作，库存一入库就能领用；② 成品没有 QA 放行，检验合格也不区分"可销售"；③ 没有批记录，飞检第一个要的材料交不出来。
> 本文记录这三件事真做进系统的位置、口径、证据，以及明确没做的部分。

## 1. 结论先给

| 闸门 | 落地状态 | 一句话证据 |
|---|---|---|
| P0-1 检验单 + 库存质量状态（待检/合格/不合格/冻结） | **已落地，真库验收** | 待检批次发货过账被 400 拒绝「批次 QC-A-083620 质量状态为「待检」，不允许出库」，库存零变动；判合格后同一张发货单过账 201 成功 |
| P0-2 成品放行（QA 电子签，未放行禁出库） | **已落地，真库验收** | 成品检验判 PASS 后批次仍是 `PENDING`（检验≠放行）；错密码签批 401「签批密码错误（电子签必须验证本人）」；正确密码签批后批次才 `RELEASED`，发货才通 |
| P0-3 批记录最小版（工单工序 + 参数 + 结果） | **已落地，真库验收** | `BR-20261125-0002` 绑 `WO-DEMO-002`，3 道工序（配料/注塑/初包装，含设备、操作人、时间、参数）→ 提交 → 质量批准 |

- 后端单测：新增 21 例（`backend/src/quality/__tests__/quality-gates.test.ts`），全过。
- 真库端到端：`/tmp/verify_quality.py` 46 个请求、**0 断言失败**。
- 编译：`npx tsc -p tsconfig.json` 通过；前端 `npx vue-tsc -b --noEmit` + `npx vite build` 通过。

## 2. 数据层（`backend/scripts/quality_p1_gates.sql`）

插在 `db-manifest.txt` 里 `saas_p6_rls.sql` 之前（RLS 要覆盖新表），期望表清单 `db-expected-tables.txt` 已加 6 项。

### 2.1 两个列（挂在既有表上，不新建一套库存）

| 表.列 | 类型 | 作用 |
|---|---|---|
| `materials.qc_required` | BOOLEAN DEFAULT FALSE | 该物料收货后是否必须检验。演示种子把 `udi_required=TRUE` 的 13 个医用耗材一并置 TRUE |
| `stock_batches.quality_status` | VARCHAR(12) DEFAULT `'RELEASED'` | 批次的可用性：`PENDING` 待检 / `RELEASED` 合格 / `REJECTED` 不合格 / `FROZEN` 冻结。CHECK 约束 + 索引 `ix_stock_batches_quality` |

**为什么默认 `RELEASED`**：存量批次上线瞬间不能集体变「待检」，否则所有老库存突然领不出来、把业务打断。新流程从「收货时按 `qc_required` 置 PENDING」开始生效，老数据保持可用 —— 这是兼容性取舍，写在迁移注释里。

### 2.2 六张新表

| 表 | 关键字段 | 说明 |
|---|---|---|
| `qc_inspections` | `inspection_no` `QC-YYYYMMDD-NNNN`、`insp_type` IQC/IPQC/FQC/OQC、`source` RECEIPT/MANUAL/WORKORDER、`status` DRAFT/PASS/FAIL/CANCELLED、`batch_no` `qty` `sample_qty` | 检验单主表 |
| `qc_inspection_items` | `seq` `item_name` `standard` `measured` `verdict` PASS/FAIL/NA | 检验项目；判定规则全靠它 |
| `qa_releases` | `release_no` `RL-YYYYMMDD-NNNN`、`status` PENDING/RELEASED/REJECTED/CANCELLED、`inspection_id` | 成品放行单，挂检验单 |
| `batch_records` | `record_no` `BR-YYYYMMDD-NNNN`、`status` OPEN/SUBMITTED/APPROVED/REJECTED、唯一 `(tenant_id, material_id, batch_no)` | 一批一条，防重复 |
| `batch_record_steps` | `seq` `step_name` `equipment` `operator` `started_at` `ended_at` `params` JSONB、`result` PASS/FAIL/NA、`attachment_url` | 工序记录 |
| `qc_status_log` | `from_status` `to_status` `reason` `ref_type` `ref_no` `operator` | 质量状态每次变更留痕（谁、为什么、依据哪张单） |

模块开通：`modules` 加 `quality.qms`（`质量管理`，sort 35，非核心），`tenant_modules` 给演示租户 `status='active', source='manual'`。
**坑**：`source` 只能是 `manual`，填 `addon` 直接违反 CHECK 约束；`modules` 表没有 `kind`/`path` 列。

## 3. 闸门是怎么"卡住"的（代码位置）

### 3.1 P0-1 检验 + 质量状态

- 收货过账（`wms/inbound/services/inbound.service.ts`）：`increaseStock` 时 `qcStatus = 物料.qcRequired ? 'PENDING' : undefined`。
- 库存层（`inventory/inventory.service.ts`）：
  - `fifoQb(...qualityStatuses = ['RELEASED'])` —— 所有 FIFO 分配默认只看合格批次；
  - `adjustStock` 新增 `qc_status`（入库新建批次的初始状态）与 `allow_qc`（出库允许的状态集，默认 `['RELEASED']`）；
  - `planFifo` 在"没货"之外单列一类错误：`另有 N 件处于待检/不合格/冻结状态，未通过质量闸门` —— 让仓管知道不是没货，而是货被质量挡住；
  - `queryStock` 按 SKU 汇总时拆成 `availableQty`（合格可用）与 `lockedQty`（非合格锁定量）。
- 报废是例外通道：库存调整单 `adjustType='DAMAGE'` 传 `allow_qc: ['RELEASED','REJECTED']` —— 不合格品唯一合法去处就是报废。

### 3.2 P0-2 成品放行

判定与放行是两件事，这是最容易做错的一处：

```
judge(检验单)  result=FAIL                → 批次 REJECTED
               result=PASS & FQC/OQC      → 批次 PENDING   ← 检验合格 ≠ 可销售
               result=PASS & IQC/IPQC     → 批次 RELEASED  ← 来料/过程合格即可用
sign(放行单)   APPROVE → 批次 RELEASED；REJECT → 批次 REJECTED（隔离）
```

- 电子签：`POST /quality/releases/:id/sign` 必须带 `password`，服务端 `auth.verifyPassword(userId, tenantId, password)` 用 bcrypt 复核本人密码，失败 401「签批密码错误（电子签必须验证本人）」。签批人取 `users.displayName || username || user-{id}`，落 `qa_releases.reviewer`。
- 签批前置（`release.calc.ts` 的 `checkBeforeRelease`，纯函数可单测）：放行单必须 `PENDING`、批次不能已 `RELEASED`、不能 `FROZEN`、物料要求检验则必须挂一张 `PASS` 的检验单；前端拿到 `canSign / signBlockReason` 直接展示原因，不做二次判断。
- 未关联检验单时，`submit` 会自动找该批次最近一张 PASS 检验单，并校验批次一致性。

### 3.3 P0-3 批记录

- `create` 可传 `workOrderId`，自动带出产品、名称、需求量、`woNo`；`(tenant, material, batch)` 唯一，同批重复开单会被拒。
- 工序：追加/修改/删除（仅 `OPEN` 可改），`seq` 自增、重号拒绝、结束时间早于开始时间拒绝。
- 提交前置（`batch-record.calc.ts`）：至少 1 道工序、工序名与操作人齐全、时间不倒挂、`result=FAIL` 必须写备注。不满足给中文原因，不是干巴巴 400。
- 详情自带 `evidence` 只读聚合：该批次 UDI 码数量 / 已打印数、关联检验单张数与单号 —— 让批记录能指回"这批货打了多少码、检了几次"。
- 状态机 `OPEN → SUBMITTED → APPROVED / REJECTED`，退回必须写原因。

## 4. 接口（全部 `@RequireModule('quality.qms')`，`/api/v1/quality`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/summary` | 三段概览：`inspections`（待判定/今日已判定/累计不合格/待检批次）、`releases`（待签批/已放行/已驳回/超 3 天未签）、`records`（记录中/待批准/已批准） |
| GET | `/pending-batches` | 库存里 `PENDING` 且无待判定单的批次，带 `hasDraft` |
| GET | `/inspections` `/inspections/:id` | 列表（状态/类型/关键字过滤）、详情（含批次当前质量状态） |
| POST | `/inspections` `/inspections/auto-open` | 手工开单；一键扫描待检批次补开（单次上限 50） |
| PUT | `/inspections/:id/items` | 覆盖检验项 |
| POST | `/inspections/:id/judge` `/inspections/:id/cancel` | 判定 `{result, reviewer, opinion}`；作废需原因 |
| GET/POST | `/releases` `/releases/:id` | 放行单列表/详情（含 `canSign`） |
| POST | `/releases/:id/sign` `/releases/:id/cancel` | 签批 `{decision, password, opinion}`；作废 |
| GET/POST | `/batch-records` `/batch-records/:id` | 批记录列表/详情 |
| POST/PUT/DELETE | `/batch-records/:id/steps`、`/steps/:stepId` | 工序增改删 |
| POST | `/batch-records/:id/submit` `/approve` | 提交（回 `warnings`）；批准 `{decision, opinion}` |

## 5. 顺手修掉的两个"假成功"

1. `shipment.service.ts`：原来发货过账全部行 `FAILED` 也返回 201，前端会以为发货成功、实际没扣库存。现在 `!anyShipped && results.some(FAILED)` 抛 400 `发货失败：<首行原因>` —— 质量闸门拦截必须显性。
2. `stock-adjustment.service.ts`：原来"一行都没过成"返回 201 + 行 FAILED，现在直接 400 `过账失败：<原因>`。

## 6. 真库验收证据（`/tmp/verify_quality.py`，46 请求 0 失败）

| 场景 | 结果 |
|---|---|
| 收货 `MD-SYR-05` / `WH-DEMO` / 30 | `/pending-batches` 命中，批次 `qualityStatus=PENDING` |
| 待检批次发货过账 | **400**「发货失败：批次 QC-A-083620 质量状态为「待检」，不允许出库（需先检验/放行）」，库存零变动 |
| 一键补开 + 录 3 项（外观/尺寸/密封性 PASS）+ 判 PASS | 生成 `QC-20261125-0004` → 批次 `RELEASED` → 同一发货单 201 成功 |
| 成品批次 `QC-B-083620`：FQC 检验 2 项 PASS → 判 PASS | 批次**仍 PENDING**（检验≠放行） |
| 提交放行 `RL-20261125-0002` → 错密码签批 | **401**「签批密码错误（电子签必须验证本人）」 |
| 正确密码签批 | 批次 `RELEASED`，签批人 `Admin` → 发货 201 |
| 批记录 `BR-20261125-0002`（3 道工序）→ 提交 → 批准 | 成功 |
| 判 FAIL | 批次 `REJECTED` |
| `DAMAGE` 调整单 -3 | 过账成功（10→7） |
| `LOSS` 调整单 -2 取不合格批次 | **400**「过账失败：批次 QC-C-083620 质量状态为「不合格」，不允许出库」，库存未动 |

复跑：后端跑在 `:3202`、租户 `admin/admin123`、仓库用 `WH-DEMO`（id=3，**`WH-SH` 无库位，收货过账必报「仓库无可用库位」**）、物料 `MD-SYR-05`（`udi_required` → 收货扫码要 `forceUdi: true` 绕过）。

## 7. 前端

| 页面 | 路径 | 内容 |
|---|---|---|
| 检验单 | `/quality/inspections` | 四张概览卡 + 检验单列表 + 「待检批次」tab（一键补开、单条开单）+ 详情抽屉（检验项编辑、判定合格/不合格、作废） |
| 成品放行 | `/quality/releases` | 待签批/已放行/已驳回 + 超期未签提醒 + 详情抽屉签批（密码框 + `canSign` 阻断原因） |
| 批记录 | `/quality/batch-records` | 状态卡 + 列表 + 详情抽屉（证据聚合、工序表格、工序录入、提交、批准/退回） |

菜单：`menu.catalog.ts` 新增「质量管理」分组（`quality` / `CircleCheck` / 模块门 `quality.qms`），三个叶子与 `router/index.ts` 一一对应。API 封装在 `apps/console/src/api/quality.ts`。

## 8. 明确没做的（别当成先斩后奏的缺口）

1. **PDA 端没有检验页**。检验判定放在 PC —— QC 记录要在受控终端留痕，车间扫码枪不适合录检验项。收货 PDA 只负责"收货即入待检"，判定仍在 console。
2. **不合格品处置单**（评审、返工、让步接收、销毁审批）没做。当前只有"判不合格 → 批次隔离 → 只能报废"这条最短路径。
3. **放行与批记录的强制绑定**没做：放行只校验"有 PASS 检验单"，不强制"批记录已 APPROVED"。真实 GMP 里两条都要，这是 P1。
4. **电子签只有密码复核**，没有 CA 证书 / 时间戳 / 签名图片。签批记录落 `reviewer + reviewed_at + opinion` 三要素，审计日志另有 `quality.release.sign` 事件。
5. **冻结（FROZEN）没有入口页**：`setBatchQualityStatus` 支持冻结、出库默认拦冻结批次，但 console 没有"批量冻结（如召回、偏差调查）"的操作界面 —— 只能走 API。
6. 客户主数据、销售订单、装箱单打印、冷链温度、召回执行：与上一轮结论一致，仍未做。

## 9. 一处需要现场确认的口径

`materials.qc_required` 目前按"`udi_required` 的物料默认要检"种子化（13 个医用耗材）。真实客户可能只有部分物料做 IQC、部分免检。上线前要跟质量部确认这张"免检清单"——这是唯一一个"跑起来之后可能被质疑"的默认值。
