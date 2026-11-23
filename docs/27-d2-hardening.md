# D2 上线加固（健康探针 / 限流 / 结构化日志 / 优雅停机 / CI / RLS 主链路）

> 目标（`docs/24 §D2`）：让系统"**能被运维接管**"。D0 解决装得上、D1 解决验得出，
> D2 解决"上线后出事能被发现、被挡住、被追溯、能干净重启"。
> 全部实现均在本机真跑验证（真 PG 14 + Redis 6 + nginx，无 docker）。

## 1. 六项交付

| 项 | 实现 | 实测 |
|---|---|---|
| 健康探针 | `src/common/health.controller.ts` + `main.ts` 裸路径注册 | `/health/live` 200；`/health/ready` 200（db 1ms / redis 1ms）|
| 限流 | `src/common/rate-limit.middleware.ts`（Redis 固定窗口，fail-open） | 全局 5/分：第 6、7 次 429；登录严档 3/分：第 4 次 429 |
| 结构化日志 + traceId | `src/common/trace.middleware.ts`（ALS + 单行 JSON） | 响应头 `x-request-id` 复用上游值；每条日志带 traceId |
| 优雅停机 | `main.ts` shutdown handler（SIGTERM → app.close → 超时强杀） | SIGTERM 后 `shutdown_begin` → `shutdown_ok`，进程退出 |
| CI 三 job | `deploy/ci/github-actions-ci.yml`（static / unit / integration） | 本机等价验证（见 §3）；**尚未放入 `.github/workflows/`**，原因见 §4 |
| RLS 主链路 | `DB_RLS_ENFORCE=1` + `DB_RLS_USER`：Repository 代理走 RLS 角色短事务 | 端点实测 200；`rls-enforce.int.test.ts` 3 门全绿 |

## 2. 三项关键事实

### 2.1 探针必须分三层，不能合成一个

`/health/live` **不查库**：DB 抖动时如果 liveness 挂了，k8s/ compose 会重启进程，等于把一次 DB 抖动放大成全站重启风暴。
`/health/ready` 查 DB + Redis，任一不通返回 **503**（让 LB 摘流，而不是重启）。
`/health` 是给人看的简报（版本、端口、启动时间、运行时长、两个探针明细）。
`/api/v1/health/*` 是同一套逻辑走全局前缀的副本（前端/运维面板可用）。

限流**跳过** `/health*`：监控 2s 轮询一次就会被限流打断，LB 会误判服务下线。

### 2.2 限流 fail-open，不 fail-closed

Redis 挂掉时放行 + 一次性 warn（`rate_limit_unavailable_fail_open`）。理由：限流是防滥用的软闸，
不是业务正确性的一部分；它挂了把全部业务打停是最糟的降级方式。真正的撞库防护在登录接口自身的失败计数。
分档：登录/注册/刷新令牌走严档（默认 20/分），其余走通用档（默认 300/分）；按 IP 维度（信任 `X-Forwarded-For`）。

### 2.3 RLS 主链路：能切，但有明确边界（重点看）

`DB_RLS_ENFORCE=1` + `DB_RLS_USER` 后，`TenantRouting` 把 Repository 的**单次方法调用**包进
"RLS 角色连接 + 短事务 + `set_config('app.tenant_id')`"，于是 `saas_p6_rls.sql` 的策略真正生效：

- 走 RLS 的：`find / findOne / save / update / delete / count / exists / insert ...` 等**一次调用即完成**的方法；
- **不走 RLS 的**：`createQueryBuilder()`（后续链式 `.leftJoin()` 必须同步拿到 builder，包成 async 会变成 Promise 直接崩）。
  这类查询退回主连接（应用层 `tenant_id` 过滤仍生效，但**不受 RLS 兜底**），启动时打一条 warn 说明；
- 需要强隔离的复杂查询请改用 `TenantRouting.transaction()`（它已在 RLS 连接上跑）。
- 代价：每次 repo 调用多 2 个往返（BEGIN / set_config / COMMIT）。写多读少的接口无感，列表页会略慢。
- 同一 Service 方法内的多次 repo 调用**不在同一事务**（改造前也没有事务，此处不假装更强）。

真库验收（`test/integration/rls-enforce.int.test.ts`，3 门）：

| 门 | 断言 | 结果 |
|---|---|---|
| R1 | `labelflow_app` 直连、无 GUC → `stock_batches/stock_moves/wms_work_orders/udi_units/audit_logs` 全部 0 行 | ✅ |
| R2 | 带 GUC 只见本租户行（903 看不到 904 的行）；**WITH CHECK** 让 903 的 GUC 插 904 的行被拒 | ✅ |
| R3 | 平台表 `tenants` 不隔离（登录按 code 查租户必须可见） | ✅ |

端点级实测（`DB_RLS_ENFORCE=1` 起服务，admin 登录后逐个打）：
`/templates` 200、`/printers` 200、`/inventory/materials` 200、`/users` 200、`/audit/logs` 403（模块未订阅，符合预期）。

## 3. 本轮实测暴露并修掉的 4 个缺陷

1. **RLS 连接没挂实体元数据**：`TenantDataSourceManager` 的 RLS DataSource 配了 `entities: []`（原设计只跑原生 SQL），
   一旦要在上面 `em.getRepository()` 就 `EntityMetadataNotFound` → 改为复用主 DS 的实体数组。
2. **RLS 连接没带命名策略**：同一个坑的第二层。没有 `SnakeNamingStrategy` 时实体属性 `createdAt` 被当成列名，
   直接 `column "Template.createdAt" does not exist` → 一并从主 DS 复制 namingStrategy。
3. **Repository 代理把所有属性都当方法包**：`repo.metadata` 被包成函数，启动期 InstanceLoader 立刻崩
   （`repo[method] is not a function`）→ 改为先取真值、只对 `function` 且在白名单内的方法包装。
4. **`createQueryBuilder` 被包成 async**：`this.materials.createQueryBuilder(...).leftJoin is not a function`（库存列表 500）
   → 白名单外的方法同步直连，并把"该路径不受 RLS 兜底"记为 warn。
5.（附带）**优雅停机 app.close() 被调两次**：`enableShutdownHooks()` 自带一套 SIGTERM listener，我又注册一套，
   日志里出现 pg 的 `Called end on pool more than once` → 注册前 `removeAllListeners('SIGTERM'/'SIGINT')`，只留自研 handler。

## 4. 明确没做到的

- **workflow 文件没进 `.github/workflows/`**：当前推送凭据是 GitHub OAuth App 且**没有 `workflow` scope**，
  GitHub 直接拒绝 `refusing to allow an OAuth App to create or update workflow`。因此 CI 定义版本化在
  `deploy/ci/github-actions-ci.yml`，**放到 `.github/workflows/ci.yml` 即生效**（需要带 workflow scope 的凭据或网页端新建）。
- **CI 未在 GitHub Actions 真跑过**：本环境无 GitHub runner 权限。workflow 的三个 job 是按本机等价步骤写的
  （`typecheck` / `node --test` / `db-init.sh + jest`），语法与步骤已在本地逐条执行过；首次真跑由 push 后触发，待看结果。
- **lint 不阻断**：仓库有 23 处历史 lint error（`no-unused-vars` 等），CI 的 static job 显式关掉这批规则，
  只挡解析错误/未定义变量。清理这 23 处属独立技术债，不在 D2 范围。
- **RLS 覆盖不完整**：见 §2.3，`createQueryBuilder` 路径不受兜底；`TENANT_DATASOURCE` 的 `getRepository` 代理已走 RLS，
  但 `.createQueryBuilder()` 同样落在主连接。
- **限流维度只有 IP**：没有按 user/tenant 维度分桶（Agent 侧另有 `agent.rate_limit` 的租户维度限流，两套并存）。
- **日志没有集中采集**：只输出到 stdout/stderr 的单行 JSON，接 Loki/ELK 属运维侧。

## 5. 运维速查

```bash
# 存活 / 就绪（探针用，2s 一次也不限流）
curl -s localhost:3200/health/live
curl -s -o /dev/null -w '%{http_code}\n' localhost:3200/health/ready   # 503 = DB/Redis 不通

# 关键环境变量
PORT=3200
LOG_FORMAT=pretty|json          # json = 单行结构化（生产默认）
LOG_LEVEL=info|debug|warn|error
RATE_LIMIT_PER_MIN=300
RATE_LIMIT_LOGIN_PER_MIN=20
RATE_LIMIT_TRUST_PROXY=1        # 前面有 nginx 时必须开
SHUTDOWN_TIMEOUT_MS=20000
DB_RLS_USER=labelflow_app       # RLS 角色
DB_RLS_PASSWORD=<改掉默认弱口令>
DB_RLS_ENFORCE=1               # 打开主链路 RLS（两条件缺一即维持旧行为）
APP_VERSION=<发布号>            # /health 简报里显示

# 按 traceId 追一条请求
curl -s -D- localhost:3200/api/v1/templates -H 'x-request-id: my-trace' -H "Authorization: Bearer $T"
grep my-trace /var/log/labelflow/api.log
```

## 6. 下一步（D3）

真机打印（Zebra ZD421 / 汉印 N41·SL42 / GODEX RT700i）+ Windows 打印代理，验证 `deploy/` 的打印链路；
D4 的 PDA 发料页依赖真机扫码枪的输入节奏，所以 D3 先于 D4。
