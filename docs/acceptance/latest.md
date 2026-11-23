# D1 真库验收报告

生成时间：2026-11-23T16:19:57.496Z
环境：Node v22.23.4 / labelflow_test@127.0.0.1:5432

**结果：31 通过 / 0 失败 / 1 跳过（共 32 条）**

| 门 | 说明 | 结果 | 耗时 | 备注 |
|---|---|---|---|---|
| ENV | 数据库可连（labelflow_test） | ✅ | 63ms | PostgreSQL 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3 |
| ENV2 | Redis 可连 | ✅ | -ms | PONG |
| DB | 建库表数量自检 | ✅ | 751ms | PASS: 期望 77 张表，实际 77 张，全部命中 |
| G8 | 收货侧 UDI 拦截（udi_required 物料必须带码） | ⏭️ | -ms | 无 InboundService 服务级夹具，docs/21 §68 / docs/22 §3 已记录，留待 D4 真机联调 |
| G1 | G1 BOM 展开：行数与需求量含损耗（100 件 × 2、×1.05、×1） | ✅ | 72ms |  |
| G2 | G2 齐套：行级与整体一致，缺料行被标出 | ✅ | 67ms |  |
| G3 | G3 过账真扣库存 + stock_moves 台账 + 发料记录唯一 | ✅ | 116ms |  |
| G4 | G4 重跑不二次扣减（幂等）：库存与台账不变，行报「已发满/无新扣减」 | ✅ | 126ms |  |
| G5 | G5 缺料：完全无可用批次的行走 SHORT 且不落记录；有部分库存的行按量发 PARTIAL | ✅ | 103ms |  |
| G6 | G6 退料回补 + 工单回 ISSUING + 退料记录可追溯 | ✅ | 144ms |  |
| G7 | G7 跨租户不可见：应用层 404 且 labelflow_app 角色 RLS 下查不到 | ✅ | 70ms |  |
| R1 | R1 无租户 GUC：业务表看不见任何行（策略默认拒绝） | ✅ | 5ms |  |
| R2 | R2 带 GUC：只见本租户行，另一租户行确实存在（对照） | ✅ | 50ms |  |
| R3 | R3 平台表不隔离：tenants 对 app 角色可读（登录链路依赖） | ✅ | 8ms |  |
| P1 | 真实 200 往返：返回 jobId/status，Bearer token 正确，请求体不含 tenantId | ✅ | 27ms |  |
| P2 | 真实 500 往返：返回 status=failed + errorCode，不抛异常（供过账记 failed） | ✅ | 5ms |  |
| P3 | 真实 409/幂等往返：映射 idempotent=true | ✅ | 2ms |  |
| P4 | 真实超时（>3s）：抛不可达、只发一次请求（不重试）——打印侧幂等兜底 | ✅ | 3015ms |  |
| T1 | T1 跨租户隔离 + RLS：A 建单 B 查不到；全部 wms_* 表均挂 tenant_isolation | ✅ | 44ms |  |
| T2 | T2 重复过账拒绝：同单过账两次，第 2 次拒、库存不翻倍 | ✅ | 26ms |  |
| T3 | T3 打印降级：打印抛 500/超时 → 过账成功、审计 failed、补打成功 | ✅ | 47ms |  |
| T4 | T4 过账中途失败：库存变更抛错 → 行状态/任务无脏数据（非单一事务的真实后果） | ✅ | 29ms |  |
| T5 | T5 订阅门：未开通 wms.inbound 的租户被 ModuleGuard 拦截（真实查库） | ✅ | 5ms |  |
| P5 | 真实 entity 能被 TypeORM 解析并连库初始化（不再报 Column type undefined） | ✅ | 130ms |  |
| UDI-UNIT | UDI/GTIN/拆箱 定向单测（7 文件） | ✅ | 52334ms | pass=114 fail=0 |
| U1 | UDI 构造/解析 + GS1 DataMatrix 回环 | ✅ | -ms | 口由 UDI-UNIT 汇总覆盖（pass=114 fail=0） |
| U2 | 追溯正反向 + 合规留痕 | ✅ | -ms | 口由 UDI-UNIT 汇总覆盖（pass=114 fail=0） |
| U5 | 扫码收货/发料旁路（receiveByScan/issueByScan） | ✅ | -ms | 口由 UDI-UNIT 汇总覆盖（pass=114 fail=0） |
| U5.1 | GTIN 校验：只收 13/14 位 | ✅ | -ms | 口由 UDI-UNIT 汇总覆盖（pass=114 fail=0） |
| U5.2 | 一物料多码整组匹配 | ✅ | -ms | 口由 UDI-UNIT 汇总覆盖（pass=114 fail=0） |
| U5.3 | 拆箱换算：包数×每包件数 | ✅ | -ms | 口由 UDI-UNIT 汇总覆盖（pass=114 fail=0） |
| UNIT-ALL | 全量单测回归（866 例） | ✅ | 263938ms | pass=859 fail=0 skip=7 |
