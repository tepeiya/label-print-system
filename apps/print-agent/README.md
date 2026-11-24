# LabelFlow 本地打印代理（Windows）

> **最短路径：一行命令。** 客户机管理员 PowerShell 里执行
> `irm https://你的域名/api/v1/agent/setup.ps1 | iex` —— 下载、装程序、选队列、存密码、开机自启、体检全自动，装完云端打印机也自动出现。
> 模板见 `backend/assets/print-agent/install-online.ps1`。

> **本目录不含 exe / zip（构建产物不进源码库）。**
> 要拿到可运行的 `LabelFlow.PrintAgent.exe`，走这三条任一条：
> 1. 租户控制台「打印机」页右上「下载本地代理」（整包 zip，含 exe + install 脚本）；
> 2. 仓库 `backend/assets/print-agent/labelflow-print-agent-win64-<ver>.zip`（服务端就是发这个包）；
> 3. 自己构建：`dotnet publish apps/print-agent -c Release -r win-x64 --self-contained -o publish`。
> 直接在本目录 `src/` 找 exe 是找不到的 —— 这里只有 C# 源码和 PowerShell 安装脚本。

云端没有 USB 口，也没有本机打印队列。**凡是"贴着机器的那台打印机"，都必须由本机的一个小程序去调 Windows spooler**。这个目录就是那个小程序。

## 它解决什么

服务端的打印协议早就通了（注册 / 心跳 / 拉任务 / 回执 / 租约回收），缺的一直是客户端。装了这个代理之后：

- USB 打印机、共享打印机、厂商驱动（ZDesigner、TSC、Godex…）都能打；
- 云端的"打印"从"下发 ZPL 让你自己拷到 U 盘"变成"点一下，5 秒内出纸"；
- 全程主动出站（只往外发 HTTPS 请求），**不需要公网 IP、不需要在路由器上开端口**。

## 一次打印的完整链路

```
云端作业           代理（本机）                       打印机
--------           --------------------------------   --------
pending ──pull──▶  claimed（服务端打租约 300s）
                   ├─ 本地账本查重：已打过 → 直接 succeeded（不出纸）
                   ├─ 解析 driverName → 本机队列名
                   ├─ 回执 printing
                   ├─ OpenPrinter → StartDocPrinter(datatype=RAW) → WritePrinter
                   └─ 回执 succeeded / failed        ──▶ 纸出来
```

五个动作，全部是 POST，全部带租户 JWT：

| 动作 | 端点 |
| --- | --- |
| 登录 | `POST /api/v1/auth/login` |
| 注册（拿 secret，只显示一次） | `POST /api/v1/hardware/agents/register` |
| 心跳 | `POST /api/v1/hardware/agents/{id}/heartbeat` |
| 拉任务 | `POST /api/v1/hardware/agents/{id}/jobs/pull` |
| 回执 | `POST /api/v1/hardware/agents/{id}/receipts` |

## 装机（客户现场）

前置：Windows 10/11 或 Server 2016+，打印机已在本机装好驱动、能正常打测试页；准备好一个**租户 operator 账号**（不要用 admin）。

```powershell
# 0) 在仓库根目录打包（自包含，客户机不需要装 .NET）
dotnet publish apps/print-agent -c Release -r win-x64 --self-contained -o apps/print-agent/publish

# 1) 把 publish/ 和 install/ 一起拷到客户机，管理员 PowerShell 里跑
.\install\install-agent.ps1 `
  -ServerBaseUrl https://labelflow.example.com `
  -TenantId 3 `
  -Username print-agent `
  -AgentId pack-line-1 `
  -DriverName "ZDesigner ZD421-203dpi ZPL"
```

脚本会做四件事：复制程序到 `C:\Program Files\LabelFlowPrintAgent` → 生成 `C:\ProgramData\LabelFlow\agent.json` → 交互输入密码并存进 DPAPI（**不落明文**）→ 注册开机自启的计划任务（SYSTEM 身份、失败 3 次重试）。

装完必做三步验收：

```powershell
# 体检：登录 / 注册 / 本机队列 / 拉取通道（不出纸）
& "C:\Program Files\LabelFlowPrintAgent\LabelFlow.PrintAgent.exe" --doctor

# 演练：拉一轮、走完回执但不出纸
& "...\LabelFlow.PrintAgent.exe" --once --dry-run

# 真打：云端建一个作业并下发，观察日志与实物
Get-Content C:\ProgramData\LabelFlow\agent.log -Tail 30 -Wait
```

验收通过的标志：`--doctor` 全 ✓；云端 `/hardware` 页该代理状态变"在线"；下发作业 5 秒内出纸，回执在作业详情里可见。

## 五个必须知道的坑

1. **必须 RAW 直发。** `StartDocPrinter` 的 `pDataType="RAW"` 一旦写成 `"TEXT"` 或让驱动接手，厂商驱动会把内容当作文档重排，GS1 DataMatrix 的 FNC1 语义直接丢失 —— 扫不出 UDI 码，但纸上看着"差不多"。
2. **`driverName` 必须逐字符一致。** 服务端信封里只下发 `driverName`（`connection` 的 host/端口/密码已被服务端白名单脱敏），代理拿它当本机队列名。名字差一个空格就是"打不开打印队列"。代理**不会**自动替换成别的队列 —— 打错介质比失败更糟。
3. **DPAPI 用机器范围（LocalMachine）。** 代理跑在 SYSTEM 下、`--set-password` 是管理员手工跑的，`CurrentUser` 范围两边对不上、服务解不开 secret。代价是本机管理员可解密（文件另有 ACL 保护）。
4. **本地账本是防重打的唯一保险。** 认领租约 300s，代理若在回执前崩溃，任务会被服务端回收重派。账本（`ledger.json`，保留最近 5000 条）记着"已打成功"的 jobKey，重派时直接回 succeeded、不出纸。删掉它就是允许重复出纸。
5. **PDF 帧暂不支持。** `pdf-base64` 需要 PDF 渲染库，代理遇到会回 `failed` 并写明原因。服务端要么改出 PNG 帧，要么给代理加依赖（见下"未做"）。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 云端显示代理离线 | 心跳断了（90s 阈值）/ 任务计划未跑 | `Get-ScheduledTaskInfo LabelFlowPrintAgent`，看 `LastRunTime` 与 `LastTaskResult` |
| 日志刷 `401` | token 2h 到期（后端无 refresh） | 代理会自己重登；持续 401 说明账号密码错，重跑 `--set-password` |
| 日志 `打不开打印队列` | `driverName` 与本机不符 | `--doctor` 会列出本机已装队列名，逐字符对齐 |
| 作业一直 `claimed` 不打印 | 代理拉的 `capability` 不匹配（本代理只声明 `windows_spooler`） | 云端打印机通道要选"Windows 本地代理" |
| 纸出来但扫码失败 | 走了驱动重排（非 RAW），或条码密度/尺寸不对 | 确认 `pDataType=RAW`；把标签尺寸与 DPI 与服务端设置对齐 |
| 同一张标签打了两遍 | 账本被清 / 服务端重派且账本没写成功 | 检查 `ledger.json` 是否可写（ACL） |

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/AgentConfig.cs` | 配置模型、`--config/--tenant/--agent-id/--dry-run` 覆盖、启动前校验 |
| `src/ApiClient.cs` | 5 个接口 + JWT 自动续登 + HMAC 签名头 + `{code,message,data}` 信封拆解 |
| `src/Signer.cs` | `HMAC-SHA256(secret, "{ts}.{bodyRaw}")`，与服务端同口径 |
| `src/SecretStore.cs` | 密码与 agentSecret 的 DPAPI（LocalMachine）仓库 |
| `src/JobLedger.cs` | 本地幂等账本（防重复出纸） |
| `src/SpoolerPrinter.cs` | winspool RAW 直发 + PNG 走 GDI 打印 |
| `src/Program.cs` | 主循环、任务处理、`--doctor/--once/--register/--set-password` |
| `install/*.ps1` | 安装 / 卸载（计划任务形态） |

## 已知未做

- **托盘 UI**：现在是"计划任务 + 日志"，没有驻留托盘图标显示在线状态与积压数。
- **PDF 帧**：需引入渲染依赖（如 PDFium / PdfiumViewer），未做。
- **多打印机并行**：当前串行、`PullLimit=1`。一台机器挂多台打印机时，建议每台起一个代理实例（不同 `AgentId`、不同 `DriverName`）。
- **真机矩阵**：ZDesigner / TSC / Godex 三类机型的服务端 profile 仍是 `POC` 状态，需要现场逐台过 UDI 扫码等级（ISO 15415 不做，只保"能扫出来"）。
