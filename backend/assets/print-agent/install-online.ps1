<#
LabelFlow 本地打印代理 —— 一行命令安装
（这个文件由服务端在 GET /api/v1/agent/setup.ps1 输出，__BASE_URL__ 会被替换成实际地址）

用法（客户机上以「管理员身份」打开 PowerShell，粘贴执行）：
    irm http://你的域名/api/v1/agent/setup.ps1 | iex

它会：登录校验 → 下载发行包 → 解压 → 自动列出本机打印队列让你选 → 写配置 →
把密码存进 DPAPI → 注册开机自启 → 跑一次体检。租户不需要懂 exe / json / 计划任务。
#>
param(
    [string]$Tenant = '',
    [string]$Username = ''
)

$ErrorActionPreference = 'Stop'
try { chcp 65001 > $null } catch {}
$Base = '__BASE_URL__'

function Fail([string]$msg) {
    Write-Host "`n[失败] $msg" -ForegroundColor Red
    exit 1
}
function Step([string]$msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

Write-Host @"
LabelFlow 本地打印代理 · 一键安装
服务器：$Base
"@ -ForegroundColor Green

# --- 0. 管理员检查（装程序、写 ProgramData、注册计划任务都需要） -------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "请用「管理员身份」打开 PowerShell 再运行这条命令。"
}

# --- 1. 账号 ------------------------------------------------------------------
Step '1/7 登录信息'
if (-not $Tenant) { $Tenant = Read-Host '租户代码（不知道就直接回车，默认 default）' }
if (-not $Tenant) { $Tenant = 'default' }
if (-not $Username) { $Username = Read-Host '账号（建议用专门给代理的 operator 账号）' }
$secure = Read-Host '密码' -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $secure).Password

$loginBody = @{ username = $Username; password = $password; tenantCode = $Tenant } | ConvertTo-Json
try {
    $login = Invoke-RestMethod -Method Post -Uri "$Base/api/v1/auth/login" -ContentType 'application/json' -Body $loginBody
} catch {
    Fail "登录失败（账号/密码/租户代码不对？）：$($_.Exception.Message)"
}
$token = $login.data.accessToken
if (-not $token) { Fail '登录返回里没有 accessToken。' }
$H = @{ Authorization = "Bearer $token" }
Write-Host "  已登录：$Username（租户 $Tenant）"

$me = Invoke-RestMethod -Method Get -Uri "$Base/api/v1/auth/me" -Headers $H
$tenantId = [int]$me.data.tenantId

# --- 2. 发行包 -----------------------------------------------------------------
Step '2/7 下载发行包'
try {
    $meta = (Invoke-RestMethod -Method Get -Uri "$Base/api/v1/hardware/agents/release" -Headers $H).data
} catch {
    Fail "取发行包清单失败：$($_.Exception.Message)"
}
if (-not $meta.available) { Fail "发行包不可用：$($meta.reason)" }

$tmp = Join-Path $env:TEMP ("labelflow-agent-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp $meta.fileName
try {
    Invoke-WebRequest -Uri "$Base/api/v1/hardware/agents/release/download" -Headers $H -OutFile $zip -UseBasicParsing
} catch {
    Fail "下载失败：$($_.Exception.Message)"
}
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $meta.sha256) { Fail "下载包校验不一致（可能网络中断，请重跑一次）。`n  期望 $($meta.sha256)`n  实际 $sha" }
Write-Host ("  已下载 v{0}，{1:N0} MB，SHA-256 校验通过" -f $meta.version, ((Get-Item $zip).Length / 1MB))

# --- 3. 解压 -------------------------------------------------------------------
Step '3/7 解压安装'
$installDir = 'C:\Program Files\LabelFlowPrintAgent'
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$inner = Get-ChildItem -Path $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'LabelFlow.PrintAgent.exe') } | Select-Object -First 1
if (-not $inner) { Fail '压缩包里没找到 LabelFlow.PrintAgent.exe。' }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $installDir -Recurse -Force
$exe = Join-Path $installDir 'LabelFlow.PrintAgent.exe'
Write-Host "  已安装到 $installDir"

# --- 4. 选打印队列 -------------------------------------------------------------
Step '4/7 本机打印队列'
# Get-Printer 要 PrintManagement 模块（Win8 / Server2012 起才有）；老系统退回 WMI
$printers = @()
if (Get-Command Get-Printer -ErrorAction SilentlyContinue) {
    $printers = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
}
if ($printers.Count -eq 0) {
    $printers = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue |
        Where-Object { -not $_.Virtual -and -not $_.WorkOffline } |
        Select-Object -ExpandProperty Name)
}
if ($printers.Count -eq 0) {
    Fail '本机没有装任何打印队列。先把打印机驱动装好（能打测试页），再重跑这条命令。'
}
$chosen = @()
if ($printers.Count -eq 1) {
    $chosen = @($printers[0])
    Write-Host "  本机只有一台：$($chosen[0])，直接使用。"
} else {
    Write-Host '  本机有这些打印队列：'
    for ($i = 0; $i -lt $printers.Count; $i++) { Write-Host ("   [{0}] {1}" -f ($i + 1), $printers[$i]) }
    $answer = Read-Host '  要交给代理的是哪几台？输入编号，多台用逗号分隔（直接回车 = 全部）'
    if (-not $answer) { $chosen = $printers }
    else {
        foreach ($part in ($answer -split ',')) {
            $idx = 0
            if ([int]::TryParse($part.Trim(), [ref]$idx) -and $idx -ge 1 -and $idx -le $printers.Count) {
                $chosen += $printers[$idx - 1]
            }
        }
        if ($chosen.Count -eq 0) { Fail '没解析出有效编号。' }
    }
}
$chosen = @($chosen | Select-Object -Unique)
Write-Host ("  将使用：{0}" -f ($chosen -join ' / '))

# --- 5. 写配置 + 存密码 --------------------------------------------------------
Step '5/7 生成配置'
$dataDir = 'C:\ProgramData\LabelFlow'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$cfgPath = Join-Path $dataDir 'agent.json'

$agentId = ($env:COMPUTERNAME -replace '[^a-zA-Z0-9._:-]', '').ToLower()
if (-not $agentId -or $agentId -notmatch '^[a-zA-Z0-9]') { $agentId = 'agent-' + $agentId }
if ($agentId.Length -gt 64) { $agentId = $agentId.Substring(0, 64) }

$cfg = [ordered]@{
    ServerBaseUrl       = $Base
    TenantId            = $tenantId
    Username            = $Username
    Password            = ''
    AgentId             = $agentId
    AgentName           = "$env:COMPUTERNAME 本地打印代理"
    DriverNames         = @($chosen)
    PollIntervalMs      = 2000
    HeartbeatIntervalMs = 25000
    DataDir             = $dataDir
    PullLimit           = 1
    SignatureEnabled    = $false
    DryRun              = $false
    LogEnvelope         = $true
}
($cfg | ConvertTo-Json -Depth 5) | Set-Content -Path $cfgPath -Encoding UTF8
icacls $dataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
Write-Host "  配置已写入 $cfgPath（AgentId=$agentId，租户=$tenantId，队列=$($chosen.Count) 台）"

# 密码不进 json，管道喂给 exe 存进 DPAPI（机器范围，SYSTEM 身份能解）
$password | & $exe --config $cfgPath --set-password-stdin | Out-Null
if ($LASTEXITCODE -ne 0) { Fail '保存密码失败。' }

# --- 6. 开机自启 ---------------------------------------------------------------
Step '6/7 注册开机自启'
$taskName = 'LabelFlowPrintAgent'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute $exe -Argument "--config `"$cfgPath`"" -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -User 'SYSTEM' -RunLevel Highest `
    -Description 'LabelFlow 本地打印代理（轮询云端任务并经本机打印队列出纸）' | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host '  已注册计划任务并启动'

# --- 7. 体检 -------------------------------------------------------------------
Step '7/7 体检'
Start-Sleep -Seconds 2
& $exe --config $cfgPath --doctor

Write-Host @"

==================== 安装完成 ====================
代理已以 SYSTEM 身份常驻，开机自启。接下来不用再配任何东西：
  · 云端「打印机」页会自动出现这几台（本地代理通道，驱动名已填好）
  · 设计器里选它们，点打印，5 秒内出纸

日志：Get-Content "$dataDir\agent.log" -Tail 30 -Wait
改密码：& "$exe" --config "$cfgPath" --set-password
卸载：  & "$installDir\install\uninstall-agent.ps1"（或删计划任务 LabelFlowPrintAgent）
==================================================
"@ -ForegroundColor Green
