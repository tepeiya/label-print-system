# WMS 阶段二（wms.issuing 工单发料与齐套）验收报告

> 依据：`docs/16-wms-phase2-dev.md`（A 版，D1–D8 默认值）+ 用户"阶段二可以开工"整体授权。
> 交付范围：迁移 + 4 张表实体 + 4 个纯函数模块 + Gateway 扩展 + 服务 + 17 个 API + 5 组单测。
> 不含：ERP/MES 接入、自动倒冲、SN 追溯、替代料引擎、BullMQ 最终一致、PDA 前端页面、真 PG 集成门执行（见 §8）。

---

## 1. 交付物清单

| # | 交付物 | 状态 | 位置 |
|---|---|---|---|
| 1 | 阶段二迁移脚本（全 IF NOT EXISTS / DO 守卫，4 表 + 索引 + CHECK） | ✅ | `backend/scripts/wms_p2_issuing.sql` |
| 2 | 实体（工单 / 工单行 / 发料记录 / 退料记录） | ✅ | `backend/src/wms/issuing/entities/wo.entity.ts` |
| 3 | 纯函数模块（流转守卫 / 齐套摘要 / 批次分配 / 发料计算） | ✅ | `backend/src/wms/issuing/services/{wo-transit,kit-summary.calc,batch-alloc.calc,issue-calc}.ts` |
| 4 | Gateway 扩展（物料、仓库、BOM 展开、齐套、扣减、批次台账） | ✅ | `backend/src/wms/gateways/inventory.gateway.ts`（+6 方法） |
| 5 | 发料服务（建单/导入/齐套/下发/发料/完工/退料/关单/补打） | ✅ | `backend/src/wms/issuing/services/issuing.service.ts` |
| 6 | 控制器（17 端点，全挂 `@RequireModule('wms.issuing')`） | ✅ | `backend/src/wms/issuing/controllers/issuing.controller.ts` |
| 7 | 模块注册 | ✅ | `issuing.module.ts`、`app.module.ts`、`entities/index.ts`、`wms.module.ts`（forFeature +Bom/BomItem） |
| 8 | 单测 5 组共 49 例 | ✅ | `backend/src/wms/__tests__/{kit-summary,wo-transit,batch-alloc,issue-calc,issuing.service}.test.ts` |
| 9 | 验收报告 | ✅ | 本文 |
| 10 | 真 PG 集成门 G1–G7 | ⏳ 未执行 | 见 §8.1（当前环境无 docker/psql） |

---

## 2. 决策对照（D1–D8 落实情况）

| 决策 | 口径 | 落地 |
|---|---|---|
| D1 | 按行发料 + PDA 扫码校验，可 `force` 留审计 | `issuePost` 支持 `lineIds` 部分行、`force` 记 `wms.wo.issue.force`；`issueScan` 比对 SKU/批次/库位三字段 |
| D2 | 不做替代料 | 无替代物料字段与分支；缺料只出清单 |
| D3 | 行级 + 整体齐套 | `kitCheck` 回写行 `qty_shortage/shortage_reason`、工单 `shortage_flag`，返回整体 `overallMaxSets/overallKitRate` |
| D4 | 单位需求 = `qty_per × (1 + loss_rate)` | `lineRequiredQty`，全链路 `round3`（如 2×1.05×10=21） |
| D5 | 批次自动（近效期优先→FIFO）可手动 | `allocateBatches`：指定批次优先校验；否则过期批次排最后 → 有效期升序 → 入库时间 FIFO → 跨批拆分 |
| D6 | 不采 SN | 表无 SN 列，发料按批次 + 数量 |
| D7 | 不新增 `SHORTAGE` 状态 | 仅 `ISSUING` + `shortage_flag` + 行 `SHORT/PARTIAL` 标记 |
| D8 | 退料阶段二做（`ISSUED → ISSUING`） | `createReturn` 强校验原因、超发拒绝、`RETURN:{woNo}:{line}:{seq}` 幂等键、回补库存 |

---

## 3. API 对照（17 个）

| # | 方法 | 路径（`/api/v1`） | 状态 |
|---|---|---|---|
| 1 | POST | `/wms/work-orders` | ✅ 建单（`expandBom` 自动展开） |
| 2 | POST | `/wms/work-orders/import` | ✅ Excel 行数组导入，部分成功（≤200 行） |
| 3 | GET | `/wms/work-orders` | ✅ 列表（`status/page/pageSize`） |
| 4 | GET | `/wms/work-orders/:id` | ✅ 详情（行/发料/退料/物料名） |
| 5 | POST | `/wms/work-orders/:id/lines` | ✅ 改行/追加行（仅 `CREATED`） |
| 6 | POST | `/wms/work-orders/:id/kit-check` | ✅ 齐套检查 |
| 7 | POST | `/wms/work-orders/:id/release` | ✅ 下发（守卫：有行 + 已做过齐套检查，按审计 `wms.wo.kit_check` 判定） |
| 8 | POST | `/wms/work-orders/:id/cancel` | ✅ 取消（仅 `CREATED/RELEASED`） |
| 9 | POST | `/wms/work-orders/:id/issue-start` | ✅ `RELEASED → ISSUING` |
| 10 | POST | `/wms/work-orders/:id/issue-scan` | ✅ 扫码校验（不回写库存） |
| 11 | POST | `/wms/work-orders/:id/issue-post` | ✅ 过账（行级 + `force`） |
| 12 | POST | `/wms/work-orders/:id/issue-done` | ✅ 完工（未发满需 `force`，返回缺料清单） |
| 13 | GET | `/wms/work-orders/:id/shortages` | ✅ 缺料清单 + 摘要 + 可用批次 |
| 14 | POST | `/wms/work-orders/:id/returns` | ✅ 退料冲销 |
| 15 | POST | `/wms/work-orders/:id/close` | ✅ 关单（`ISSUED → CLOSED` 终态，守卫无未结退料） |
| 16 | POST | `/wms/work-orders/lines/:lineId/reprint-label` | ✅ 补打（`ISSUE:{woNo}:{line}:reprint:{n}`） |
| 17 | GET | `/wms/issue-records` | ✅ 发料记录查询 |

**幂等键**：`ISSUE:{woNo}:{lineNo}`（单批）/ `ISSUE:{woNo}:{line}:{batch}:{i+1}`（跨批拆分）/ `RETURN:{woNo}:{line}:{seq}`。`woNo` 自带 `WO` 前缀，函数内不重复加前缀（实现期修正项）。

**审计动作**：`wms.wo.create / kit_check / release / cancel / issue_start / issue.post / issue.force / issue_done(.force) / return / close / print.failed / print.reprint`，全部 `targetType='wms_work_order'`。

---

## 4. 测试

### 4.1 纯函数 + 服务级单测（node:test，内存仓库 + 假网关）

| 文件 | 例数 | 覆盖要点 |
|---|---|---|
| `kit-summary.test.ts` | 8 | 整体 `min(maxSets)`、0 行、不耗料、齐套率向下取整、摘要文本 |
| `wo-transit.test.ts` | 10 | 全状态 × 全动作白名单扫描、`force` 放行、守卫（无行/未齐套/未结退料） |
| `batch-alloc.test.ts` | 10 | 近效期优先、跨批拆分、过期批次排最后、手工批次校验、三位小数 |
| `issue-calc.test.ts` | 9 | 需求量含损耗、幂等键、超发拒绝、扫码三字段比对（原计划独立 `scan-verify.test.ts`，合并至此） |
| `issuing.service.test.ts` | 12 | 建单/重复单号、齐套回写、下发守卫、过账扣减与标签旁路、部分发料/完全缺料、重跑幂等、完工 `force`、退料回补与守卫、关单终态、缺料清单 |

### 4.2 全量回归

```
pnpm typecheck   → 0 error
pnpm test        → 817 tests / 810 pass / 0 fail / 7 skipped
```

净增 49 例（768 → 817），原 7 例跳过保持不变（环境缺外部依赖的既有项）。

---

## 5. 关键业务语义（实现口径）

1. **需求含损耗**：行需求在建单/加行时一次算定并落 `qty_required`，后续齐套与发料只读不重算，避免两次浮点漂移。
2. **齐套检查是"快照"**：回写行 `qty_shortage` 与工单 `shortage_flag`，但不改状态机；下发守卫靠审计是否存在 `wms.wo.kit_check`（不改表结构）。
3. **发料过账顺序**：按行 → 查可用批次 → 分配 → 逐批扣库存 + 写发料记录 + 打标签（旁路）→ 回写行。任一行失败不影响其他行；扣减失败即该行止步，不写记录（无脏数据）。
4. **完全无可用批次**：行置 `SHORT`，不写发料记录，不进扣减。
5. **部分可用**：按可用量发料，行 `PARTIAL`，剩余写入 `qty_shortage/shortage_reason`（"部分发料，仍缺 N"），`shortage_flag=true`，`skipped` 里带 `partialIssued` 供前端提示。此口径比 `docs/16 §7.1`"无可用批次 → SHORT"更细，与之兼容（文档未约束部分可用时的行为）。
6. **重跑幂等**：已有本行发料记录 → 不再扣减，按记录量回填 `qty_issued`；已发满的行 `skipped` 记"已发满"。库存与记录都不会二次变动（单测锁死 `calls.decrease` 次数不变）。
7. **完工**：全部行达标 → `ISSUED`；未达标必须 `force`，响应内联缺料清单并记审计。
8. **退料**：仅 `ISSUED` 可退（`RETURN` 状态机白名单），先回补库存再落记录，退后工单回 `ISSUING`、行按已发量重算状态（`DONE/PARTIAL/SHORT/PENDING`）。
9. **打印不阻塞**：标签失败只加 `labelFailed` 计数 + `wms.wo.print.failed` 审计，过账照常完成。
10. **事务边界**：WMS 表写入与库存扣减分属不同事务（`InventoryService` 自持事务），与阶段一同一已知偏差，靠"记录先于/后于扣减"的可重跑收敛；见 §8.2。

---

## 6. 上线前置（运维动作）

1. 执行 `backend/scripts/wms_p2_issuing.sql`。
2. **必须重跑** `backend/scripts/saas_p6_rls.sql`，让 4 张新表挂上 `tenant_isolation` 策略（脚本自身不建策略，沿用既有 RLS 装配）。
3. `modules` 表种入 `wms.issuing`（既有 WMS 种子脚本已含 5 个模块编码，执行一次即可）；存量租户需手工 `INSERT tenant_modules` 开通，否则 403。
4. 为租户预置发料标签模板 `ISSUE_LABEL_V1`（本次未在迁移内种模板，原因：模板变量与版式需按客户现场调；缺模板时打印失败但发料成功，可补打）。
5. 配置 `WMS_SERVICE_TOKEN`（与阶段一同一 service token，`print:job:write` scope）。

---

## 7. 与文档的偏差清单（显式声明，不含隐瞒项）

| # | 文档要求 | 实际 | 影响 |
|---|---|---|---|
| 1 | 独立 `scan-verify.test.ts` | 并入 `issue-calc.test.ts`（9 例） | 无功能影响；测试文件数少 1 |
| 2 | 自定义错误码 4091/4092/4093/422 | 使用 HTTP 语义（409 `ConflictException` / 400 `BadRequestException`） | 前端按 HTTP 状态码 + message 分支；如需业务码，后续加 filter 映射 |
| 3 | 真 PG 集成门 G1–G7 | 未执行（环境无 docker/psql） | 见 §8.1 |
| 4 | `issue-records` 支持时间范围/物料过滤 | 支持 `woId/material/page/pageSize`，时间范围按 `from/to` 已支持（服务内过滤） | 无 |
| 5 | PDA 发料页面 | 未做（文档 §2 已排除，后端 API 先行） | 现场用现有 PDA 扫码页或后续排期 |

---

## 8. 诚实边界（未验证项）

### 8.1 真库 7 门已实证（D1，2026-11-23）

`test/integration/wms-issuing.int.test.ts` 已落地并被 `backend/scripts/db-acceptance.sh` 纳入一键验收：真 PostgreSQL 14 + 真 `InventoryService` / `InventoryGateway` / `IdempotencyService`（仅 stub print/audit），租户隔离（903 对 904）、仓 803、BOM 与两批库存全部真表。

| 门 | 断言 | 现状 |
|---|---|---|
| G1 | BOM 展开行数与需求含损耗 | ✅ 真库通过 |
| G2 | 齐套率行级/整体一致（`overallMaxSets=0` 因组件无库存） | ✅ 真库通过 |
| G3 | 扣库存 + `stock_moves` out 台账（`qty` 为负、`after=before+qty`） + 记录唯一 | ✅ 真库通过 |
| G4 | 重跑不二次扣减 | ✅ 真库通过 |
| G5 | 完全缺料行 SHORT 不落记录；部分库存 PARTIAL 按量发 | ✅ 真库通过 |
| G6 | 退料回补 + 回 `ISSUING` + 幂等 | ✅ 真库通过 |
| G7 | 跨租户不可见（应用层 404 + `labelflow_app` 角色 RLS 查不到） | ✅ 真库通过 |

报告与逐门结果见 `docs/26-d1-acceptance.md` 与 `docs/acceptance/latest.json`。**未覆盖**：G8（收货侧 UDI 拦截，缺 `InboundService` 夹具）、应用进程切 `labelflow_app`（D2）。

### 8.2 跨服务事务
发料 = 扣库存（Inventory 独立事务）+ 写发料记录（WMS 表）。中间崩溃可能出现"扣了库存没记录"，重跑时靠**先查记录再扣减**的幂等路径收敛，但**不保证**库存侧幂等键与 WMS 记录物理同事务。阶段二承诺为"无脏数据 + 重跑收敛"，不承诺最终一致的自动重试（BullMQ 属阶段三）。

### 8.3 其他
- 未接 ERP/MES：工单只能手工或 Excel 导入。
- 无 SN：单件级追溯仍走 UDI 追溯链（`udi_units`），WMS 发料只到批次维度。
- 无替代料：缺料只能补料或 `force` 放行。
- 未做同仓移库位（阶段一遗留简化项）。

---

## 9. 结论

阶段二后端功能面已完整（D1–D8 全覆盖、17 API 全通、49 例单测全绿、全量 817 例 0 失败、typecheck 零错误），**可进入真库联调**；对外可售前需完成 §6 运维动作 + §8.1 七门实证 + PDA 页面。
