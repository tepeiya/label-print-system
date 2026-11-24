# 31 · Windows 本地打印代理（Print Agent）

> 承接 D3「打印通道」遗留缺口：`raw_tcp` 能直连网络打印机，但 **USB / 本机共享打印机在云端无路可走**。
> 本文记录代理的定位、协议对齐、实现取舍、装机与验收，以及这一轮同时补掉的两个服务端运行时缺口。

## 1. 问题定义

服务端已有的打印通道：

| 通道 | 可打场景 | 状态 |
| --- | --- | --- |
| `raw_tcp` | 打印机自带网口（9100），同网段或端口映射可达 | 已通（真连通性探测 + 直发） |
| `browser` | 浏览器本地打印预览 | 已通，依赖用户手动确认 |
| `windows_spooler` | USB / 本机共享 / 厂商驱动 | **只有协议，没有客户端** |

`windows_spooler` 的 `test` / `testPrint` 在服务端一律返回"该通道由本地代理完成"。也就是说：**协议主干（注册 / 心跳 / 拉任务 / 回执 / 租约）在 D3 就已写好，缺的是跑在客户机上的执行者**。这就是 `apps/print-agent`。

为什么必须是本机程序：USB 是物理总线，云端拿不到句柄；Windows 打印队列（spooler）也没有远程"提交 RAW 字节"的标准接口（IPP 只覆盖部分机型，且厂商 ZPL/TSPL 不对 IPP 友好）。唯一稳的做法是**本机进程调 winspool.drv**。

## 2. 架构：只出站，不监听

```
┌──────────── 云端 ────────────┐        ┌──────── 客户机（Windows）────────┐
│ hardware_agent_jobs 表        │        │ LabelFlow.PrintAgent            │
│  pending → claimed(租约300s)  │◀──pull─┤  ├ ApiClient（5 个 POST）        │
│  printing → succeeded/failed  │◀─receipt┤  ├ JobLedger（防重打）           │
│  定时 sweep 回收过期租约      │        │  └ SpoolerPrinter（winspool RAW）│
└──────────────────────────────┘        └──────────────┬───────────────────┘
                                                        │ RAW bytes
                                                   ┌────▼─────┐
                                                   │ spooler  │ → USB 打印机
                                                   └──────────┘
```

三条设计红线：

1. **纯出站**：代理只发 HTTPS 请求，不监听端口、不需要公网 IP、不需要端口映射。这是"能装进客户内网"的前提。
2. **认证复用租户 JWT**：`/hardware/*` 全部在 `TenantGuard` 下且 `@Roles('admin','operator')`，代理用 operator 账号登录，token 2h、无 refresh → 客户端自己做"剩余 < 5 分钟主动重登"。
3. **服务端不信任代理的任何自述**：`driverName` 由服务端下发、`connection` 的 host/端口/密码在信封里被白名单脱敏，代理只能打到"本机已装的队列"。

## 3. 协议对齐（写代码时的真源）

| 项 | 值 |
| --- | --- |
| 协议版本 | `1.0` |
| 注册 | `POST /hardware/agents/register`，body `{agentId,name,capabilities,driverNames,metadata}` → 返回 `{agentId, protocolVersion, secret, secretHint, warnings}`；**secret 明文只出现一次，重复注册会轮换并使旧 secret 立即失效** |
| 心跳 | `POST /hardware/agents/{id}/heartbeat`，body `{version,load,capabilities,draining}` → `{ok,serverTime,pending}`；90s 无心跳判离线 |
| 拉取 | `POST /hardware/agents/{id}/jobs/pull`，body `{limit}` → `{ok,serverTime,jobs:[{jobKey,status:'claimed',envelope}]}`；代理离线时服务端返回 `ok:false` |
| 回执 | `POST /hardware/agents/{id}/receipts`，body `{jobKey,status,printedCount?,error?,at?}` |
| 状态机 | `pending→claimed\|expired`；`claimed→printing\|succeeded\|failed\|expired\|pending`；`printing→succeeded\|failed\|expired\|pending`；`succeeded→[]`（终态）；`failed/expired→pending` |
| 重试 | `AGENT_JOB_MAX_ATTEMPTS=3`，超限置 `expired` |
| 签名（可选） | 头 `x-labelflow-timestamp`（秒）+ `x-labelflow-signature`；`HMAC-SHA256(secret, "{ts}.{bodyRaw}")`，容差 300s；仅当 `HARDWARE_AGENT_SIGNATURE_REQUIRED=1` 时服务端校验 |
| 信封 | `{version,jobKey,tenantId,jobId,printerId,templateId,capability,driverName,labels[{format,data,copies}],settings{dpi,widthMm,heightMm,offsetXMm,offsetYMm,orientation,gapMm,density?,speed?},createdAt,redactedFields}` |
| 帧格式 | `zpl` / `tspl` / `epl` / `png-base64` / `pdf-base64` |

## 4. 实现取舍

### 4.1 为什么用 C# 而不是 Python / Node

厂商驱动与 spooler 的 RAW 提交在 Windows 上只有三条路：P/Invoke（C/C#）、WMI/COM（慢且不稳）、第三方工具（不可控）。C# 单文件 exe 自包含发布，客户机不用装任何运行时，是运维成本最低的形态。

### 4.2 为什么 `net8.0` 而不是 `net8.0-windows`

`winspool.drv` 的 P/Invoke 与 `System.Drawing.Printing` 在普通 `net8.0` 目标下也能编译引用（运行时才需要 Windows）。这样 CI / Linux 开发机可以 `dotnet build` 做语法与类型校验，不必为了编译起一个 Windows。代价是平台告警（`CA1416`）被显式 `NoWarn`，用 `OperatingSystem.IsWindows()` 做运行时守卫。

### 4.3 RAW 直发是硬要求

```csharp
pDataType = "RAW";              // ← 写成 TEXT/让驱动接手 = GS1 的 FNC1 被吃掉
OpenPrinter → StartDocPrinter → StartPagePrinter → WritePrinter → EndDocPrinter
```

这是整套方案里最容易"看起来成功、实际扫不出"的地方：驱动重排后纸上仍然是人眼可读的标签，只是 DataMatrix 里少了 FNC1 分隔符，UDI 扫描直接失败。

### 4.4 本地幂等账本

认领租约 300s，代理若在回执前崩溃，任务会被 `sweep` 回收重派。**没有本地账本，同一张 UDI 标签就会打第二遍**（医疗场景里这是要写偏差报告的）。账本 `ledger.json` 保留最近 5000 条 jobKey，命中即回 `succeeded` 且不出纸。

### 4.5 逐帧串行、整单原子

`PullLimit=1`，一单内多帧串行打；任何一帧失败 → 整单回 `failed`（并带已打份数），不做"部分成功"。理由：标签是包装单元的证据，打一半的半成品比全失败更难处置。

### 4.6 secret 存 DPAPI 机器范围

代理以 SYSTEM（计划任务）身份常驻，而 `--set-password` 是管理员手工执行 —— `CurrentUser` 范围两边对不上。用 `LocalMachine`，配合 `C:\ProgramData\LabelFlow` 的 ACL 收紧（仅 SYSTEM + Administrators）。

### 4.7 安装形态：计划任务而不是 Windows 服务

`sc create` 注册的服务必须是实现了 `ServiceBase` 的程序，否则 SCM 启动直接 1053。为一个打印代理引入 ServiceBase 包装不值当；计划任务（`-AtStartup`、SYSTEM、`RestartCount 3`）能达到同样的开机自启 + 崩溃重启，且无第三方依赖（不引 NSSM）。

## 5. 本轮同时补的服务端缺口

写代理的过程中暴露了两个"协议写了但运行时没兜住"的问题，一并修掉：

### 5.1 租约 TTL / 拉取上限可配置

`agent-protocol.calc.ts` 新增 `claimTtlSec()`（默认 300，夹取 60–3600，env `AGENT_CLAIM_TTL_SEC`）与 `maxPullLimit()`（默认 10，夹取 1–50，env `AGENT_MAX_PULL`）。原先 `claimExpired()` 只用常量、`pull()` 只用常量，现场调参必须改代码重发版。

### 5.2 定时回收过期租约（原先缺失）

`claimExpired()` 之前只在"有人访问相关接口"时被动触发。如果某条 `claimed` 任务的代理永久失联、且没有新任务进来，那条行会一直挂在 `claimed`，永远不会回到 `pending` —— 作业看起来"卡在打印中"。

`hardware.service.ts` 补上：

- `OnModuleInit` 起一个 `setInterval`（`HARDWARE_AGENT_SWEEP_MS`，默认 60000，`<=0` 关闭，夹取 10000–600000，`unref()` 不挡退出）；
- `sweepAllTenants()`：先 `SELECT DISTINCT tenant_id FROM hardware_agent_jobs WHERE status IN ('claimed','printing') LIMIT 200`（用 `manager.query` 绕过租户 Repository 的 where 注入），再对每个租户用 `tenantStorage.run(systemTenantCtx(id), () => this.sweepExpired())` 复用既有逻辑（RLS 与审计字段都走同一条路径，不另开旁路）；
- `OnModuleDestroy` 清定时器。

单测新增 2 例（env 覆盖与脏值夹取、放宽租约后不回收），`agent-protocol.calc.test.ts` 13 例全绿。

## 6. 装机与验收

装机三步：`dotnet publish` → `install-agent.ps1`（四件事：复制程序、生成配置、设密码存 DPAPI、注册计划任务）→ `--doctor` 体检。

验收五步（客户现场）：

1. `--doctor` 四项全 ✓（登录 / 注册 / 本机队列 / 拉取通道）；
2. `--once --dry-run` 拉到任务并回执成功、不出纸；
3. 云端 `/hardware` 页代理变"在线"，`pending` 数正确；
4. 云端下发真实作业，5 秒内出纸，回执 `succeeded` 且 `printedCount` 正确；
5. 拔网线 90s → 代理显示离线、任务不再派发；插回 → 恢复在线并补打。

## 7. 已知未做 / 遗留

| 项 | 说明 |
| --- | --- |
| PDF 帧 | 需 PDF 渲染依赖（PDFium 等），当前回 `failed` 并写明原因 |
| 托盘 UI | 现在只有日志，无驻留图标显示在线/积压 |
| 多打印机并行 | 建议一台机一个实例（不同 `AgentId` / `DriverName`） |
| 真机矩阵 | ZDesigner / TSC / Godex 三类 profile 仍为 `POC`，需现场逐台过扫码 |
| ISO 15415 分级 | 不评估条码质量等级，只保证"能扫出来" |
| 真库实跑 sweep | 本轮沙箱内 PG 不可用，定时回收只过了 `tsc` 与单测，未做真库定时器实跑 |

## 8. 代码位置

- 代理：`apps/print-agent/`（`src/` 七个类 + `install/` 两个 PowerShell 脚本 + `agent.example.json`）
- 服务端加固：`backend/src/hardware/agent-protocol.calc.ts`、`backend/src/hardware/hardware.service.ts`
- 单测：`backend/src/hardware/__tests__/agent-protocol.calc.test.ts`
