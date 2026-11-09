$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=Split-Path -Parent $PSScriptRoot
$browserRoot=Join-Path $root 'runtime\browser'
$copyRoot=Join-Path $root 'data\browser-runtime'
$marker=Join-Path $copyRoot 'source.json'
$required=@('chrome.exe','chrome.dll','chrome_elf.dll','resources.pak','icudtl.dat','v8_context_snapshot.bin','chrome_100_percent.pak','chrome_200_percent.pak','locales/en-US.pak','locales/zh-CN.pak')
$stage='source.read'

function Test-BrowserFiles([string]$Directory){
 foreach($name in $required){
  $file=Get-Item -LiteralPath (Join-Path $Directory $name) -ErrorAction Stop
  if($file.PSIsContainer -or $file.Length -le 0){throw [IO.InvalidDataException]::new('内置浏览器文件不完整。')}
 }
}
function Set-BrowserReadAccess([string]$Directory,[bool]$MayRelocate=$false){
 $acl=Get-Acl -LiteralPath $Directory
 $changed=$false
 foreach($sidText in @('S-1-15-2-1','S-1-15-2-2')){
  $sid=[Security.Principal.SecurityIdentifier]::new($sidText)
  $readAllowed=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {
   $_.IdentityReference -eq $sid -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
   ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute -and
   ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -and
   ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit)
  }).Count -gt 0
  if(-not $readAllowed){
   $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
   $acl.AddAccessRule($rule);$changed=$true
  }
 }
 if($changed){
  try{Set-Acl -LiteralPath $Directory -AclObject $acl}
  catch{
   if($MayRelocate -and ($_.Exception -is [UnauthorizedAccessException] -or $_.Exception.InnerException -is [UnauthorizedAccessException] -or $_.CategoryInfo.Category -eq 'PermissionDenied')){return $false}
   throw
  }
 }
 return $true
}

try{
 Test-BrowserFiles $browserRoot
 # File metadata identifies this package's browser revision; it is not a checksum.
 $source=@(foreach($name in $required){$file=Get-Item -LiteralPath (Join-Path $browserRoot $name);[ordered]@{file=$name;size=$file.Length;modified_ms=([DateTimeOffset]$file.LastWriteTimeUtc).ToUnixTimeMilliseconds()}}) | ConvertTo-Json -Compress
 $stage='copy.reuse'
 if((Test-Path -LiteralPath $marker -PathType Leaf) -and [IO.File]::ReadAllText($marker) -ceq $source){
  Test-BrowserFiles $copyRoot
  $stage='copy.permissions'
  $null=Set-BrowserReadAccess $copyRoot
  @{path=(Join-Path $copyRoot 'chrome.exe')} | ConvertTo-Json -Compress
  return
 }
 $stage='source.permissions'
 if(Set-BrowserReadAccess $browserRoot $true){
  @{path=(Join-Path $browserRoot 'chrome.exe')} | ConvertTo-Json -Compress
  return
 }
 # Only a denied DACL write takes this branch. Business files and profiles stay put.
 $stage='copy.create'
 $null=New-Item -ItemType Directory -Path $copyRoot -Force
 if(Test-Path -LiteralPath $marker){Remove-Item -LiteralPath $marker -Force}
 $stage='copy.permissions'
 $null=Set-BrowserReadAccess $copyRoot
 $stage='copy.files'
 Get-ChildItem -LiteralPath $browserRoot -Force | Copy-Item -Destination $copyRoot -Recurse -Force
 Test-BrowserFiles $copyRoot
 $stage='copy.record'
 [IO.File]::WriteAllText($marker,$source,[Text.UTF8Encoding]::new($false))
 @{path=(Join-Path $copyRoot 'chrome.exe')} | ConvertTo-Json -Compress
}catch{
 $exception=$_.Exception
 while($exception.InnerException){$exception=$exception.InnerException}
 $code=if($exception.NativeErrorCode){[string]$exception.NativeErrorCode}else{'HRESULT 0x'+$exception.HResult.ToString('X8')}
 [Console]::Error.WriteLine(('无法准备内置浏览器，请确认软件数据目录可写、磁盘空间充足，并关闭本软件的浏览器窗口后重试。（阶段 {0}；{1}/{2}）' -f $stage,$exception.GetType().Name,$code))
 exit 1
}
