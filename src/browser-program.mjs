import {accessSync,constants,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const bundledFiles=['chrome.exe','chrome.dll','chrome_elf.dll','resources.pak','icudtl.dat','v8_context_snapshot.bin','chrome_100_percent.pak','chrome_200_percent.pak','locales/en-US.pak','locales/zh-CN.pak'];
export const browserMissingMessage='未检测到可用浏览器，请前往系统配置下载安装 Chrome。';
export const browserDetectionError='无法确认浏览器状态，请检查安装登记及文件读取权限后重新检测。';

// App Paths stores an executable path, never a command to execute.
const chromeRegistryScript=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Get-ChromeInstallPath($Value,$Kind) {
 if($Value -isnot [string] -or $Kind -notin @('String','ExpandString')){return $null}
 $file=$Value.Trim()
 if($Kind -eq 'ExpandString'){$file=[Environment]::ExpandEnvironmentVariables($file);if($file -match '%[^%]+%'){return $null}}
 if($file.StartsWith('"') -and $file.EndsWith('"') -and $file.Length -ge 2){$file=$file.Substring(1,$file.Length-2)}
 if($file -match '["\r\n\x00]' -or $file -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or [IO.Path]::GetFileName($file) -ine 'chrome.exe'){return $null}
 return $file
}
$paths=[Collections.Generic.List[string]]::new()
$failed=$false
$views=if([Environment]::Is64BitOperatingSystem){@([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)}else{@([Microsoft.Win32.RegistryView]::Registry32)}
foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){
 foreach($view in $views){
  $base=$null;$key=$null
  try{
   $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
   $key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',$false)
   if(-not $key){continue}
   $value=$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
   if($null -eq $value){continue}
   $file=Get-ChromeInstallPath $value ($key.GetValueKind('').ToString())
   if(-not $file -or $paths.Contains($file)){continue}
   if([IO.Directory]::Exists($file)){continue}
   $stream=$null
   try{
    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    if($stream.Length -le 0){continue}
    $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($file)
   }catch [IO.FileNotFoundException]{continue}catch [IO.DirectoryNotFoundException]{continue}finally{if($stream){$stream.Dispose()}}
   if($info.ProductName -eq 'Google Chrome' -and $info.OriginalFilename -ieq 'chrome.exe'){$paths.Add($file)}
  }catch{$failed=$true}finally{if($key){$key.Dispose()};if($base){$base.Dispose()}}
 }
}
@{paths=@($paths.ToArray());failed=$failed}|ConvertTo-Json -Compress
`;
function readChromeRegistrations(env){
 if(process.platform!=='win32')return {paths:[],failed:false};
 const powershell=path.join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(chromeRegistryScript,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:64*1024,encoding:'utf8',env});
 return JSON.parse(output.replace(/^\uFEFF/,'').trim());
}

// Preserve package/standard-path priority; query registration only if those miss.
// This does not launch a browser, visit a website, or cache installation state.
export function detectBrowser(root,{env=process.env,readable=file=>{const info=statSync(file);accessSync(file,constants.R_OK);return info.isFile()&&info.size>0;},registrations=()=>readChromeRegistrations(env)}={}){
 let failed=false;
 const available=file=>{try{return readable(file);}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))failed=true;return false;}};
 const bundled=path.join(root,'runtime','browser');
 const bundledState=bundledFiles.map(file=>available(path.join(bundled,file))),bundledIncomplete=!failed&&bundledState.some(Boolean)&&!bundledState.every(Boolean);
 if(bundledState.every(Boolean))return {installed:true,status:'ready',source:'bundled',path:path.join(bundled,'chrome.exe')};
 const directories=[env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean);
 for(const directory of directories){const file=path.join(directory,'Google','Chrome','Application','chrome.exe');if(available(file))return {installed:true,status:'ready',source:'system',path:file,bundled_incomplete:bundledIncomplete};}
 try{
  const registered=registrations();
  if(!Array.isArray(registered.paths)||typeof registered.failed!=='boolean'||registered.paths.some(file=>typeof file!=='string'))throw new Error('Invalid Chrome registration result');
  failed ||= registered.failed;
  for(const file of registered.paths){if(available(file))return {installed:true,status:'ready',source:'system',path:file,bundled_incomplete:bundledIncomplete};}
 }catch{failed=true;}
 return {installed:false,status:failed?'error':'missing',source:null,path:null,message:failed?browserDetectionError:browserMissingMessage};
}

export function publicBrowserStatus(result){const {path:program,...status}=result;return status;}
