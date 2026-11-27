# D4 验收记录 · 生产领料流程闭环（收货→上架→发料→退料）

> 日期 2026-11-24。对应 `docs/24-delivery-plan.md` §2.1 的 D4 三门。
> D3（真机打印）本轮未做：用户 2026-11-24 明确「当前没有打印机，先做 D4 和 D5」。

## 1. 三门结果

| 门 | 要求（docs/24 §2.1） | 结果 | 证据 |
|---|---|---|---|
| D4-1 | PDA 上完成 收货→上架→发料 全链，工单行状态 `ISSUING`→`ISSUED` | **pass** | `d4-flow.int.test.ts` D4-1 / D4-3（真 PG） |
| D4-2 | 发料扫包码：台账扣减为单品件数，与 U5.3 收货口径一致 | **pass** | D4-1（扫 2 箱×24 → `stock_moves` qty=-48、after=452，行 PARTIAL 48/200） |
| D4-3 | 退货 `RETURN` + 库存回补 + 批次可追溯 + 重复提交幂等 | **pass** | D4-2（同内容二次提交 `idempotent:true`，库存只回补一次）/ D4-2b / D4-3 |

真库 5 例全绿（`DB_PORT=5432 DB_NAME=labelflow_test`，租户 905 / 仓 805 / 库位 8051）：

```
D4-1  发料扫箱码：2 箱 × 24 = 48 件扣减（与收货折箱同口径）
D4-1b 扫未登记箱码：不拦截、按剩余量发，并给出 packWarning
D4-2  退货幂等：重复提交同内容走回放，库存不二次回补
D4-2b 退料必须带原因；超发量退料被拒
D4-3  全链状态：CREATED → RELEASED → ISSUING → ISSUED → CLOSED
```

这 5 条已接入 `scripts/acceptance-run.mjs` 的 `GATE_DEFS`（门号前缀 `D4-1…D4-3`），随 `docs/acceptance/latest.json` 一起出报告，不再是"单跑才看的测试"。

## 2. 改了什么

### 2.1 折算口径收敛到一处（防算法漂移）

`src/udi/udi.match.calc.ts` 新增：

```ts
resolvePackUnits(packRows, codeGtin, packCount)
  → 命中非 UNIT 包码时返回 { gtin, packLevel, packQty, packCount, units }，否则 null
```

收货（U5.3 `convertToUnits`）与发料（D4 `issuePost`）现在共用同一份"扫包码 → 单品件数"逻辑。之前两处各算一遍，箱规改一边另一边就静默错。

### 2.2 发料过账支持包码（`issuePost`）

DTO 增加可选 `packs: Array<{ lineId?, lineNo?, udiCode, packCount? }>`：

- 命中非 UNIT 包码 → `remaining = min(remaining, units)`，**只扣折算后的件数**，`posted` 回带 `pack:{gtin,packLevel,packQty,packCount,units}` 供 PDA 展示"扫了 2 箱=48 件"。
- 码解析失败或不在该物料包装表 → **不改行为**（按剩余量发）并给 `packWarning`，不硬拦。理由：现场箱码脏（贴错/旧码）时拦死会卡住产线，退回"人看着办"更符合车间实际操作；真要拦由 `udi_required` 在那之前起作用。

### 2.3 退货幂等（`createReturn`）

- 幂等键：显式 `idemKey`（PDA 重试时传随机 id）→ `WMS_RETURN:${clientKey}`；未传则内容键 `WMS_RETURN:${woNo}:${lineNo}:${batchNo}:${qty}`。
- 重复命中 → 返回 `{ idempotent:true, returnId, idemKey, note }` + 原记录明细，**不再抛 409、不再回补库存**。

踩到的坑（写在这里省下一次重犯）：状态机 `canTransit(wo.status,'RETURN')` 原来放在函数开头，第二次提交时工单已因第一次退料回到 `ISSUING`，重试会被拦成"状态 ISSUING 不允许执行 RETURN"——**幂等形同失效**。现在状态机校验移到 `dup` 回放检查之后：先认"这是同一个请求"，再校验状态。

### 2.4 PDA 发料页（新增两个页面）

`apps/pda`：

- `src/api/index.ts`：+10 个发料接口（工单列表/详情/齐套/放行/开始/扫码/过账/完成/缺料/退料）与 `WorkOrderItem`、`WoLine`、`WorkOrderDetail`、`IssueScanVerdict` 类型、`woStatusLabel`。
- `views/IssuingList.vue`：状态 tab（待处理 / 发料中 / 已发完 / 全部）+ 工单号关键字。
- `views/IssuingDetail.vue`：工单头 + 六步按钮（①齐套 ②放行 ③开始发料 ④扫码 ⑤过账 ⑥完成）+ 行明细（可选中）+ 扫码区（选行、扫码枪回车、包数、比对结果、加入待过账）+ 退料表单 + 发料记录。
- `router/index.ts` 挂 `/issuing`、`/issuing/:id`；`Home.vue` 加"发料作业"磁贴。

`npm run build`（`vue-tsc -b && vite build`）通过，产物 `index-*.js` 约 247 kB。

## 3. 诚实边界（没做到的）

1. **PDA 页面没有在浏览器/真机点过**，只做了类型检查与构建。后端链路由 D4 真库 5 例覆盖，但"按钮点了会不会报错、扫码枪在前端回车事件上是否稳定"没有实测证据。
2. **没有走 HTTP 端到端**（登录 → 工单列表 → 扫码 → 过账）：本地起服务后只验证了登录与导出，未逐接口点一遍。
3. 退货只支持"整行按数量退"，没有做按单个 UDI 码退（现场需要时会提，属新功能，不在计划内）。
4. D3（真机打印 / PDF 兜底）整段未动。

## 4. 复跑

```bash
cd backend
DB_PORT=5432 DB_NAME=labelflow_test npx jest --config jest.integration.config.js --runInBand test/integration/d4-flow.int.test.ts
# 或带全套
DB_PORT=5432 DB_NAME=labelflow_test DB_RLS_PASSWORD=app_pw_123 node scripts/acceptance-run.mjs
```
