# UDI 里程碑 U2–U4 实施记录：追溯、真机适配、合规留痕

> 承接 `docs/18-udi-implementation.md`（U1：码构造/解析/扫码复核）。
> 本次把「按建议逐项落实」的四项做完：① PDA 扫码复核页 ② 真机适配矩阵 ③ UDI 追溯表与正反向查询 ④ 合规留痕报表 + CSV 导出。

## 1. 交付总览

| 项 | 交付物 | 状态 |
|---|---|---|
| ① PDA 扫码复核页 | `apps/pda/src/views/UdiVerify.vue` + 路由 `/udi/verify` + 首页入口 + `apiUdiScanVerify/apiUdiParse` | 完成，`vue-tsc + vite build` 通过 |
| ② 真机适配 | `backend/src/udi/udi.printer-profiles.ts` + `GET /udi/printer-profiles` + 8 步校准清单 | 代码完成；3 款机型 status=POC（**未出真机样张**） |
| ③ UDI 追溯 | `scripts/udi_p1_trace.sql`（3 表）、`entities/udi.entity.ts`、`udi.trace.calc.ts`、`udi.trace.service.ts`、`udi.trace.controller.ts` | 代码 + 单测完成；**未在真库跑过集成验证** |
| ④ 合规留痕 | `GET /udi/report/print-audit`、`GET /udi/export/print-audit.csv`、`GET /udi/export/units.csv`、console「UDI 合规留痕」页 | 完成（CSV 带 BOM + 防公式注入） |

测试：后端全量 **768 例 / 761 过 / 0 失败 / 7 跳过**（新增 36 例：追溯纯函数 23 + 追溯服务 13）；`pnpm typecheck` 零错误；PDA 与 console 均构建通过。

## 2. 数据模型（`scripts/udi_p1_trace.sql`）

| 表 | 用途 | 关键约束 |
|---|---|---|
| `udi_units` | 单品（一件一码） | `(tenant_id, udi_key)` 唯一；`udi_key = GTIN14|批号|序列号|有效期(YYMMDD)`；状态 CHECK 六值 |
| `udi_packages` | 包装 SSCC 层级 | `(tenant_id, sscc)` 唯一；`parent_sscc` 自关联（UNIT→CARTON→PALLET） |
| `udi_events` | 事件流（正反向追溯 + 留痕） | `(tenant_id, idem_key)` 唯一（幂等）；事件类型 CHECK 九值 |

- `udi_key` 里的有效期**保持 GS1 六位 YYMMDD**，与 U1 `UdiService.encode()` 产出的 `unitKey` 一字不差；`udi_units.expiry_date` 才是 ISO DATE（由 `gs1DateToIso()` 转换，`DD=00` 取当月最后一天，闰年已覆盖）。
- 迁移全部 `IF NOT EXISTS`/`DO $$` 守卫，可重复执行；**执行后必须重跑 `scripts/saas_p6_rls.sql`** 让三张表挂 `tenant_isolation` 策略。

## 3. 状态机与事件

```
REGISTERED ──PRINT──▶ PRINTED ──RECEIVE──▶ RECEIVED ──ISSUE──▶ ISSUED ──SHIP──▶ SHIPPED
     ▲                  │                     │                   │               │
     └──PRINT_FAIL──────┘                     └──────SHIP─────────┴───────────────┘
                                                                  SHIPPED ──RETURN──▶ RECEIVED
任意状态 ──VOID──▶ VOID（终态，之后任何流转一律 409）
```

- 未收货直接发料（`ISSUE`）会被拦成 409 —— 这是飞检里最常见的不合规动作，必须在系统层堵死。
- `PRINT_FAIL` 不改变主状态（回到 REGISTERED 以便重打），只在留痕报表里计失败次数。
- `REPACK` 只换包装归属，不动状态。
- 事件幂等：同一 `idemKey` 重复提交直接回放原事件（打印重试、PDA 重复点击都安全）。

## 4. API（前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/udi/trace/status` | 追溯能力自述与端点清单 |
| POST | `/udi/units/register` | 批量建档（≤5000 行、部分成功），打印派码后回填 |
| POST | `/udi/units/events` | 记录事件（收货/发料/出库/退料/作废/换包） |
| GET | `/udi/units` | 单元台账（状态/GTIN/批号/工单/时间过滤） |
| GET | `/udi/trace/:code` | **一码追溯**：UDI 码 / SSCC / 单品键均可，返回时间线+层级+反向引用 |
| POST | `/udi/packages` | 建/挂包装（SSCC 18 位校验位校验） |
| GET | `/udi/packages/:sscc` | 包装详情（子包装、包内单元、事件） |
| GET | `/udi/report/print-audit` | 留痕报表（按天/按模板，成功与失败分开计） |
| GET | `/udi/export/units.csv` | 台账 CSV（UTF-8 BOM，Excel 直开） |
| GET | `/udi/export/print-audit.csv` | 留痕报表 CSV（按天段 + 合计 + 按模板段） |
| GET | `/udi/printer-profiles` | 真机适配矩阵 + 8 步校准清单 + 能做/不承诺口径 |

## 5. 关键实现决策

1. **键口径统一**：追溯键用 `GTIN14|批号|序列号|YYMMDD`，与 U1 `unitKey` 完全一致；不统一就会出现"打印时建的档、扫码时查不到"。
2. **包装查询双向**：从单品进来能看它挂在哪个中包/托盘；从 SSCC 进来能看包里有哪些单品。`hierarchy.path` 为根→目标顺序（含目标），`children` 为全量后代包装。
3. **CSV 两个工程细节**：带 `\uFEFF` BOM（否则 Excel 打开中文乱码）；`csvCell()` 对 `= + - @` 开头加单引号（防 CSV 公式注入）。
4. **报表数据源用 `udi_events` 而非审计日志**：审计日志是"谁做了什么"，留痕报表要回答"哪一天、哪个模板、打了多少、失败多少"，必须按打印事件自己的口径统计；重打计次、涉及单元去重。
5. **菜单模块门暂挂 `print`**：`udi.compliance` 尚未种 `modules` 行，若在菜单声明会导致未开通租户整组消失。商业化时换 `module: 'udi.compliance'` 并补 seed 即可（后端 Controller 也仍未挂 `@RequireModule`，同理）。

## 6. 本轮**不能**证明的部分（诚实边界）

1. **无真库验证**：当前环境无 `docker`、无 `psql`，迁移与实体只做了类型/单测级验证，未连 PostgreSQL 跑过。上线前必须在有库环境执行以下 7 道门：
   - G1 `psql -f scripts/udi_p1_trace.sql` 可重复执行两次不报错
   - G2 重跑 `scripts/saas_p6_rls.sql` 后三张表有 `tenant_isolation` 策略
   - G3 `udi_key` 重复插入返回唯一冲突（幂等依赖）
   - G4 `idem_key` 重复插入后服务返回 `idempotent:true` 且事件数不增
   - G5 ISO 日期列对 `DD=00` 落成月末（1 月 31 日 / 2 月 28 或 29 日）
   - G6 18 位 SSCC 父子三级（托盘→中包→单品）能正反向查全
   - G7 报表按天/按模板数字与手工 SQL `count(*)` 一致
2. **无真机样张**：三款机型（Zebra ZD421、汉印 N41/SL42、GODEX RT700i/DT4x）全部 `status=POC`，参数来自厂商手册与同类机型经验，**没在实体打印机上出过合格样张**。交付必须现场按 8 步校准逐条签字，尤其是 30×20 试剂瓶标（0.25–0.3mm 模块下要求 10 次扫描 ≥9 次成功）。
3. **不承诺打印质量等级**：ISO/IEC 15415 需硬件验码仪，本系统只记录不判定。

## 7. 下一里程碑（U5/U6，未开工）

- U5 与 WMS 打通：收货时扫 UDI 自动建单元并记 `RECEIVE`、发料记 `ISSUE`（需 `docs/16` WMS 阶段二 D1–D8 签字后一起做）。
- U6 国家 UDI 数据库上报：先做 DI/PI 导出（当前台账 CSV 已含全部字段），接口按客户/代理确认后再对接。
- 售卖前补：`udi.compliance` 模块种子 + `@RequireModule` + 套餐定价（见 `docs/18 §5`）。
