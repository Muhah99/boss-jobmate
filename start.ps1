$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$launchRoot=$PSScriptRoot
if($env:JOBMATE_POWERSHELL_ROOT -ne $launchRoot -or -not $env:JOBMATE_POWERSHELL -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine $env:JOBMATE_POWERSHELL){
 $launchNode=Join-Path $launchRoot 'runtime/node/node.exe'
 if(-not(Test-Path -LiteralPath $launchNode)){$launchNode=(Get-Command node.exe -ErrorAction Stop).Source}
 $launchArgs=@((Join-Path $launchRoot 'runtime/launch.mjs'),'start')
 
 & $launchNode @launchArgs
 if($LASTEXITCODE -ne 0){throw 'PowerShell 运行环境或启动操作失败，请检查上方具体原因。'}
 return
}

$projectRoot = $PSScriptRoot
$entryPath = Join-Path $projectRoot 'runtime\web.mjs'
$nodePath = Join-Path $projectRoot 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
. (Join-Path $projectRoot 'runtime\instance.ps1')
$runRoot = Join-Path $projectRoot 'data\run'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
# Serialize launcher processes, including their shared log redirection.
$startupLock = $null
for ($attempt=0; $attempt -lt 30; $attempt++) {
  try { $startupLock = [IO.File]::Open((Join-Path $runRoot 'start.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); break }
  catch [IO.IOException] { Start-Sleep -Milliseconds 500 }
}
if (-not $startupLock) { throw '本目录正在启动，请稍后再次双击图标。' }
try {
  $state = Get-JobmateInstance
  if ($state) { Write-Output ('boss-jobmate 已运行：http://127.0.0.1:' + $state.port + '/'); return }
  $entryArgument = '(?:^|\s)"?' + [regex]::Escape($entryPath) + '"?(?:\s|$)'
  $starting = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $nodePath -and $_.CommandLine -match $entryArgument }
  if (-not $starting) {
    $logRoot = Join-Path $projectRoot 'data\logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Start-Process -FilePath $nodePath -ArgumentList @(('"' + $entryPath + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot 'web-out.log') -RedirectStandardError (Join-Path $logRoot 'web-error.log') | Out-Null
  }
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    $state = Get-JobmateInstance
    if ($state) { Write-Output ('boss-jobmate 已启动：http://127.0.0.1:' + $state.port + '/'); return }
  }
  throw 'boss-jobmate 尚未就绪，请查看本目录 data/logs/web-error.log；不会重复启动已有后台。'
} finally { $startupLock.Dispose() }
