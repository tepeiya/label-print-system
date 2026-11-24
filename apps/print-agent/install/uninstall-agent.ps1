<#
.SYNOPSIS
    卸载 LabelFlow 本地打印代理（Windows，需管理员 PowerShell）。

.DESCRIPTION
    停任务、删任务、删程序目录。默认**保留** C:\ProgramData\LabelFlow（日志/账本/secret），
    因为排查和重装都要用；要彻底清掉加 -PurgeData。
#>
param(
    [string]$TaskName = 'LabelFlowPrintAgent',
    [string]$InstallDir = 'C:\Program Files\LabelFlowPrintAgent',
    [string]$DataDir = 'C:\ProgramData\LabelFlow',
    [switch]$PurgeData
)

$ErrorActionPreference = 'Continue'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "停止并删除计划任务 $TaskName" -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
} else {
    Write-Host "没有找到计划任务 $TaskName（跳过）" -ForegroundColor Yellow
}

Get-Process -Name 'LabelFlow.PrintAgent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if (Test-Path $InstallDir) {
    Write-Host "删除程序目录 $InstallDir" -ForegroundColor Cyan
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
}

if ($PurgeData) {
    if (Test-Path $DataDir) {
        Write-Host "删除数据目录 $DataDir（日志/账本/secret 一并清掉）" -ForegroundColor Cyan
        Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "保留数据目录 $DataDir（日志与幂等账本）；彻底清理加 -PurgeData" -ForegroundColor Yellow
}

Write-Host "卸载完成。服务端那条代理记录还在，可在 /hardware 页面删除或不管它（90s 无心跳即判离线）。" -ForegroundColor Green
