$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$launchRoot=$PSScriptRoot
if($env:JOBMATE_POWERSHELL_ROOT -ne $launchRoot -or -not $env:JOBMATE_POWERSHELL -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine $env:JOBMATE_POWERSHELL){
 $launchNode=Join-Path $launchRoot 'runtime/node/node.exe'
 if(-not(Test-Path -LiteralPath $launchNode)){$launchNode=(Get-Command node.exe -ErrorAction Stop).Source}
 $launchArgs=@((Join-Path $launchRoot 'runtime/launch.mjs'),'stop')
 
 & $launchNode @launchArgs
 if($LASTEXITCODE -ne 0){throw 'PowerShell 运行环境或启动操作失败，请检查上方具体原因。'}
 return
}

$projectRoot = $PSScriptRoot
$entryPath = Join-Path $projectRoot 'runtime\web.mjs'
$nodePath = Join-Path $projectRoot 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
. (Join-Path $projectRoot 'runtime\instance.ps1')
$state = Read-JobmateRecord
if (-not (Get-JobmateProcess $state)) { Write-Output '未找到属于本目录的后台，不会停止其他进程。'; return }
$progressPath = Join-Path $projectRoot 'data\progress\desktop.json'
if (Test-Path -LiteralPath $progressPath) { [IO.File]::WriteAllText($progressPath,'{"status":"closed"}',[Text.UTF8Encoding]::new($false)) }
Stop-Process -Id ([int]$state.pid) -ErrorAction Stop
Write-Output 'boss-jobmate 本目录后台已停止。未完成处理等待下次手动恢复。'
