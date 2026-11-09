param([Parameter(Mandatory=$true)][string]$InstallationRoot)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$resetRoot=[IO.Path]::GetFullPath($InstallationRoot).TrimEnd([char[]]'\/')
$scriptRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd([char[]]'\/')
if($resetRoot -ine $scriptRoot){throw '清理脚本必须属于当前安装'}
$resetProfile=[IO.Path]::GetFullPath((Join-Path $resetRoot 'data\chrome-profile'))
$uiProfile=[IO.Path]::GetFullPath((Join-Path $resetRoot 'data\app-browser-profile'))
function Test-OwnProfile([string]$CommandLine,[string]$ExpectedProfile=$resetProfile){
 $match=[regex]::Match($CommandLine,'(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|(\S+)))')
 if(-not $match.Success){return $false}
 $candidate=@($match.Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -First 1)[0].Value
 try{return [IO.Path]::GetFullPath($candidate).TrimEnd([char[]]'\/') -ieq $ExpectedProfile.TrimEnd([char[]]'\/')}catch{return $false}
}
$chromeProcesses=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
$homeClosed=@($chromeProcesses | Where-Object {Test-OwnProfile ([string]$_.CommandLine) $uiProfile}).Count -gt 0
$owned=@($chromeProcesses | Where-Object {(Test-OwnProfile ([string]$_.CommandLine)) -or (Test-OwnProfile ([string]$_.CommandLine) $uiProfile)})
$ownedIds=@($owned | ForEach-Object {[int]$_.ProcessId})
do{
 $children=@($chromeProcesses | Where-Object {[int]$_.ParentProcessId -in $ownedIds -and [int]$_.ProcessId -notin $ownedIds})
 $owned+= $children;$ownedIds+=@($children | ForEach-Object {[int]$_.ProcessId})
}while($children.Count)
foreach($candidate in @($owned | Sort-Object CreationDate -Descending)){
 $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$candidate.ProcessId) -ErrorAction Stop
 if(-not $current){continue}
 if($current.Name -ine 'chrome.exe' -or $current.CreationDate -ne $candidate.CreationDate -or $current.CommandLine -cne $candidate.CommandLine){throw '专用浏览器进程已变化，请重新确认清理'}
 Stop-Process -Id ([int]$candidate.ProcessId) -Force -ErrorAction Stop
}
foreach($candidate in $owned){
 Wait-Process -Id ([int]$candidate.ProcessId) -Timeout 10 -ErrorAction SilentlyContinue
 $remaining=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$candidate.ProcessId) -ErrorAction Stop
 if($remaining -and $remaining.CreationDate -eq $candidate.CreationDate){
  $process=Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction SilentlyContinue
  if($process -and -not $process.HasExited){throw '专用浏览器未关闭，请处理后重试清理'}
 }
}
@{closed=$ownedIds;home_closed=$homeClosed} | ConvertTo-Json -Compress
