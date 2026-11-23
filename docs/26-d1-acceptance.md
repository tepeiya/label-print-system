# D1 真库验收（可重跑验收门）

> 目标（`docs/24 §D1`）：**一条命令跑完所有验收门，输出机器可读报告**，把此前文档里"仅单测、未实证"的门逐条改判。
> 结论：29 条门中 **28 通过 / 0 失败 / 1 显式跳过（G8）**，产物 `docs/acceptance/latest.json`。

## 1. 怎么跑

```bash
# 前置：真 PostgreSQL + Redis（本机已装 PG14 / Redis6，无 docker 亦可）
sudo pg_ctlcluster 14 main start
redis-server --daemonize yes --port 6379

cd backend
DB_PORT=5432 DB_NAME=labelflow_test ./scripts/db-acceptance.sh
# 等价：DB_PORT=5432 DB_NAME=labelflow_test node scripts/acceptance-run.mjs
```

输出：`docs/acceptance/latest.json`（逐门 id / 状态 / 耗时 / 失败摘要）+ `latest.md`（人读表格）。
退出码：任一门失败 → `1`，可直接接 CI。

## 2. 报告覆盖什么

| 阶段 | 门 | 来源 | 结果 |
|---|---|---|---|
| 环境 | 数据库可连、Redis 可连 | psql / redis-cli | ✅ |
| 库结构 | 77 张表全命中 | `scripts/db-verify.sh` | ✅ |
| WMS 阶段二发料 | G1–G7 | `test/integration/wms-issuing.int.test.ts`（真 PG + 真 InventoryService/Gateway） | 7/7 ✅ |
| WMS 阶段一收货 | T1–T5 | `test/integration/wms-inbound.int.test.ts`（真 PG，夹具自带） | 5/5 ✅ |
| 打印网关 | P1–P4 + entity 探针 | `print-gateway-http` / `metadata-probe`（真 HTTP + 真库） | 5/5 ✅ |
| UDI / GTIN / 拆箱 | U1、U2、U5、U5.1、U5.2、U5.3 | `src/udi/__tests__/*.test.ts` 定向 114 例 | 6/6 ✅（该组有 fail 才转红） |
| 全量回归 | UNIT-ALL | `npm test`（node --test） | ✅ |
| 收货侧 UDI 拦截 | **G8** | — | ⏭️ skip（见 §4） |

## 3. 本轮实际修掉的缺陷（都是"跑起来才暴露"的）

1. **测试依赖外部 bootstrap**：`wms-inbound.int.test.ts` 原来靠 `scripts/wms-test-db-bootstrap.sh` 用 `docker exec` 灌夹具，无 docker 环境直接全红 → 夹具搬进测试自身 `seedFixtures()`（幂等 `INSERT ... ON CONFLICT`），测试自给自足。
2. **T1 断言写死 4 张表**：实际阶段二后 `wms_*` 已有 8 张 → 改为 `rows.length >= 4` 并逐行校验 `rls/policyname`，避免以后加表就假红。
3. **`stock_moves` 字段口径错**：台账没有 `ref_no` / `direction`，真实字段是 `kind(in/out)` / `reason` / `qty` / `before_qty` / `after_qty` / `move_no`。
4. **台账 `qty` 存带符号变动量**：出库记为 `-200`，守恒式是 `after_qty = before_qty + qty`（此前按 `before - qty` 断言必错）。
5. **`release()` 必须先齐套**：`canTransit` 用审计里的 `wms.wo.kit_check` 记录判断是否做过齐套检查 → 测试流程改为 `kitCheck → release`，审计 stub 补 `find()` 与完整 `write(tenantId, action, detail, userId?, targetType?, targetId?)` 签名。
6. **G2 语义**：`overallMaxSets` 是"最多能配套几台"，有 0 库存组件时必须是 0（原断言 `> 0` 反了），正确断言是 `overallMaxSets === 0 && overallKitRate < 100 && shortageLines >= 2`。
7. **G5 语义**：完全无可用批次的行走 SHORT 且**不落发料记录**；有部分库存的行按可用量发 `PARTIAL`。所以"期望 0 条记录"是错的，正确是"组件A 0 记录 + 组件B 1 条 PARTIAL"，跳过的行在 `issuePost` 返回的 `skipped` 里（不是 `shortages`）。

> 上述 3–7 全属**测试侧口径错误**，不是业务代码缺陷：实现与 `docs/16 §7.1` 设计一致。

## 4. 明确没做到的（诚实边界）

- **G8 收货侧 UDI 拦截**：`InboundService` 有 6 个 Repository 依赖、项目里没有它的测试夹具，本轮未写（`docs/21 §68` / `docs/22 §3` 早已记此缺口）。报告里以 `skip` 明示，不冒充通过。补齐点在 D4 真机联调。
- **docker 真 build / 真 up**：本环境无 docker daemon，D0 已用本地 PG/Redis/nginx 做等价实证并列 `BLOCKED`，D1 不重复。
- **RLS 主链路**：G7 只用 `labelflow_app` 角色在测试内直连验证策略生效；应用进程仍连超管 `labelflow`（`docs/10 §10.22.4` 的 H5 未修），切换属 D2。
- **UDI 追溯的真库链路**：U1/U2/U5 门由单测覆盖，未单独写真库用例；`udi_events` 的 `(tenant_id, idem_key)` 唯一键与 RLS 仍只有 DDL 级证据。
- **单元门通过 = 该组定向用例零 fail**，报告未逐例列 UDI 用例名（只给 `pass=114 fail=0`），所以 U1/U2/U5 等门状态是"组级判定"。

## 5. 对历史文档的改判

`docs/17 §8.1`、`docs/19 §「无真库验证」`、`docs/20 §63` 原写"仅单测 / 未实证"，现按本报告改判为**已实证**（范围见 §2），未覆盖部分保留在 §4。

## 6. 下一步（D2）

`/health` 探针、限流、traceId 结构化日志、优雅停机、CI 三 job、把主链路切到 `labelflow_app` 让 RLS 真生效。详见 `docs/24 §D2`。
