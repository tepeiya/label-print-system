<#
.SYNOPSIS
    LabelFlow 本地打印代理安装脚本（Windows，需管理员 PowerShell）。

.DESCRIPTION
    做四件事：复制程序 → 生成 agent.json → 建开机自启的计划任务（SYSTEM 身份）→ 提示设密码。
    不创建 Windows 服务（SCM 需要 ServiceBase，本程序是控制台形态；计划任务更省依赖，
    而且能带着"失败重启"策略跑）。

.EXAMPLE
    .\install-agent.ps1 -ServerBaseUrl https://labelflow.example.com -TenantId 3 `
        -Username print-agent -AgentId pack-line-1 -DriverName "ZDesigner ZD421-203dpi ZPL"
#>
param(
    [Parameter(Mandatory = $true)][string]$ServerBaseUrl,
    [Parameter(Mandatory = $true)][int]$TenantId,
    [Parameter(Mandatory = $true)][string]$Username,
    [Parameter(Mandatory = $true)][string]$AgentId,
    [Parameter(Mandatory = $true)][string]$DriverName,
    [string]$SourceDir = (Join-Path $PSScriptRoot '..\publish'),
    [string]$InstallDir = 'C:\Program Files\LabelFlowPrintAgent',
    [string]$TaskName = 'LabelFlowPrintAgent',
    [switch]$SignatureEnabled
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '请用「管理员身份」运行 PowerShell 再执行本脚本。'
    }
}
Assert-Admin

# 1) 程序就位
$exeSrc = Join-Path $SourceDir 'LabelFlow.PrintAgent.exe'
if (-not (Test-Path $exeSrc)) {
    throw "找不到 $exeSrc。先在仓库里执行：dotnet publish apps/print-agent -c Release -r win-x64 --self-contained -o apps/print-agent/publish"
}
Write-Host "[1/4] 复制程序到 $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse
$exe = Join-Path $InstallDir 'LabelFlow.PrintAgent.exe'

# 2) 配置
$dataDir = 'C:\ProgramData\LabelFlow'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$cfgPath = Join-Path $dataDir 'agent.json'
if (Test-Path $cfgPath) {
    Write-Host "[2/4] 已存在 $cfgPath，保留原配置（如需重建先删掉它）" -ForegroundColor Yellow
} else {
    Write-Host "[2/4] 生成配置 $cfgPath" -ForegroundColor Cyan
    $cfg = [ordered]@{
        ServerBaseUrl       = $ServerBaseUrl
        TenantId            = $TenantId
        Username            = $Username
        Password            = ''
        AgentId             = $AgentId
        AgentName           = "$env:COMPUTERNAME 本地打印代理"
        DriverNames         = @($DriverName)
        PollIntervalMs      = 2000
        HeartbeatIntervalMs = 25000
        DataDir             = $dataDir
        PullLimit           = 1
        SignatureEnabled    = [bool]$SignatureEnabled
        DryRun              = $false
        LogEnvelope         = $true
    }
    ($cfg | ConvertTo-Json -Depth 5) | Set-Content -Path $cfgPath -Encoding UTF8
}
# 只有 SYSTEM 和管理员会读这个目录，收紧 ACL
icacls $dataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

# 3) 账号密码（DPAPI 机器范围，SYSTEM 身份也能解）
Write-Host "[3/4] 设置账号密码（存到 DPAPI，不写明文）" -ForegroundColor Cyan
& $exe --config $cfgPath --set-password
if ($LASTEXITCODE -ne 0) { throw '设置密码失败。' }

# 4) 计划任务：开机自启、SYSTEM 身份、失败重试
Write-Host "[4/4] 注册开机自启任务 $TaskName" -ForegroundColor Cyan
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

$action = New-ScheduledTaskAction -Execute $exe -Argument "--config `"$cfgPath`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User 'SYSTEM' -RunLevel Highest -Description 'LabelFlow 本地打印代理（轮询云端任务并经本机打印队列出纸）' | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "`n安装完成。" -ForegroundColor Green
Write-Host "  体检（不出纸）：  & `"$exe`" --config `"$cfgPath`" --doctor"
Write-Host "  看日志：          Get-Content `"$dataDir\agent.log`" -Tail 50 -Wait"
Write-Host "  演练一轮：        & `"$exe`" --config `"$cfgPath`" --once --dry-run"
Write-Host "  停止/卸载：       .\uninstall-agent.ps1"
