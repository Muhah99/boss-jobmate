param([string]$ReturnUrl='', [switch]$FocusReturn)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$launchRoot=$PSScriptRoot
if($env:JOBMATE_POWERSHELL_ROOT -ne $launchRoot -or -not $env:JOBMATE_POWERSHELL -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine $env:JOBMATE_POWERSHELL){
 $launchNode=Join-Path $launchRoot 'runtime/node/node.exe'
 if(-not(Test-Path -LiteralPath $launchNode)){$launchNode=(Get-Command node.exe -ErrorAction Stop).Source}
 $launchArgs=@((Join-Path $launchRoot 'runtime/launch.mjs'),'open')
 $launchArgs+=@('-ReturnUrl',$ReturnUrl);if($FocusReturn){$launchArgs+='-FocusReturn'}
 & $launchNode @launchArgs
 if($LASTEXITCODE -ne 0){throw 'PowerShell 运行环境或启动操作失败，请检查上方具体原因。'}
 return
}

& (Join-Path $PSScriptRoot 'start.ps1') | Out-Null
$projectRoot = $PSScriptRoot
$entryPath = Join-Path $projectRoot 'runtime\web.mjs'
$nodePath = Join-Path $projectRoot 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
. (Join-Path $projectRoot 'runtime\instance.ps1')
$state = Get-JobmateInstance
if (-not $state) { throw '未找到本目录已就绪的后台，请再次双击图标。' }
$address = 'http://127.0.0.1:' + $state.port + '/'
if ($ReturnUrl) {
 if ($ReturnUrl -notmatch ('^' + [regex]::Escape($address) + '[^\s]*$')) { throw '返回地址不属于当前安装。' }
 $address = $ReturnUrl
}
$browserArguments = @((Join-Path $projectRoot 'runtime\browser.mjs'), 'open', $address)
if ($FocusReturn) { $browserArguments += 'focus-return' }
$browserResult = & $nodePath @browserArguments
if ($LASTEXITCODE -ne 0) { throw '浏览器未能打开，请检查本目录权限及浏览器文件后重试。' }
$browserOpened = $browserResult | ConvertFrom-Json
if ($FocusReturn -and $browserOpened.opened -and -not $browserOpened.focused) { throw '任务网页已打开，但未能切到前台，请手动返回任务页。' }
if (-not $browserOpened.opened) { Start-Process -FilePath $address }
