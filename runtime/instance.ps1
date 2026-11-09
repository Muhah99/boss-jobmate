# Shared installation identity check for start/open/stop. Never use a fixed port.
function Get-JobmateProcess($state) {
  if (-not $state -or $state.root -ne $projectRoot -or $state.entry -ne $entryPath -or [int]$state.port -lt 1 -or [int]$state.port -gt 65535) { return $null }
  $ownedProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$state.pid) -ErrorAction SilentlyContinue
  $entryArgument = '(?:^|\s)"?' + [regex]::Escape($entryPath) + '"?(?:\s|$)'
  if (-not $ownedProcess -or $ownedProcess.ExecutablePath -ne $nodePath -or $ownedProcess.CommandLine -notmatch $entryArgument) { return $null }
  return $ownedProcess
}
function Read-JobmateRecord {
  try { return Get-Content -LiteralPath (Join-Path $projectRoot 'data/run/web.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}
function Get-JobmateInstance {
  $state = Read-JobmateRecord
  if (-not (Get-JobmateProcess $state)) { return $null }
  try {
    $identity = Invoke-RestMethod -Uri ('http://127.0.0.1:' + [int]$state.port + '/api/runtime') -TimeoutSec 1
    if ($identity.name -eq 'boss-jobmate' -and $identity.root -eq $projectRoot -and $identity.entry -eq $entryPath -and [int]$identity.pid -eq [int]$state.pid -and [int]$identity.port -eq [int]$state.port) { return $state }
  } catch {}
  return $null
}
