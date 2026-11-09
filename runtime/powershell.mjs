import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const execute=promisify(execFile),selections=new Map();
export const powerShellArguments=['-NoProfile','-STA','-ExecutionPolicy','Bypass'];
export function powerShellPaths(root,env=process.env,arch=process.arch){
 const windows=env.SystemRoot||env.WINDIR;
 return {system:windows?path.join(windows,arch==='ia32'&&(env.PROCESSOR_ARCHITEW6432||'').includes('64')?'Sysnative':'System32','WindowsPowerShell','v1.0','powershell.exe'):null,bundled:path.resolve(root,'runtime/powershell/pwsh.exe')};
}
function failure(message){const e=new Error('PowerShell 运行环境不可用：'+message);e.code='powershell_runtime_unavailable';return e;}
function permitted(root,file,env){return Object.values(powerShellPaths(root,env)).some(p=>p&&path.resolve(p).toLowerCase()===path.resolve(file).toLowerCase());}
export async function runningPowerShell(root){
 try{
  const record=JSON.parse(await readFile(path.join(root,'data/run/web.json'),'utf8'));
  if(record.root!==root||record.entry!==path.join(root,'runtime/web.mjs')||!Number.isInteger(record.port)||record.port<1||record.port>65535)return null;
  const response=await fetch(`http://127.0.0.1:${record.port}/api/runtime`,{signal:AbortSignal.timeout(1000)}),live=await response.json();
  if(live.root!==root||live.entry!==record.entry||live.pid!==record.pid||live.port!==record.port||live.name!=='boss-jobmate')return null;
  if(!live.powershell||!permitted(root,live.powershell,process.env))throw failure('本目录已运行后台未登记有效解释器，请先正常停止本目录后台后重开。');
  return live.powershell;
 }catch(error){if(error.code==='powershell_runtime_unavailable')throw error;return null;}
}
export function selectPowerShell(installationRoot,{env=process.env,executeFile=execute,exists=existsSync,existing=runningPowerShell}={}){
 const root=path.resolve(installationRoot);
 if(!selections.has(root))selections.set(root,(async()=>{
  const active=await existing(root);
  if(active){env.JOBMATE_POWERSHELL=active;env.JOBMATE_POWERSHELL_ROOT=root;return active;}
  if(env.JOBMATE_POWERSHELL_ROOT===root&&env.JOBMATE_POWERSHELL&&permitted(root,env.JOBMATE_POWERSHELL,env))return env.JOBMATE_POWERSHELL;
  const paths=powerShellPaths(root,env),mode=env.JOBMATE_POWERSHELL_TEST_MODE||'auto';
  if(!['auto','system','bundled'].includes(mode))throw failure('无效的内部验证方式。');
  const names=mode==='auto'?['system','bundled']:[mode],reasons=[];
  for(const name of names){
   const executable=paths[name];if(!executable||!exists(executable)){reasons.push(`${name}: 缺少 ${executable||'系统目录'}`);continue;}
   let result;
   try{const request=executeFile(executable,[...powerShellArguments,'-File',path.join(root,'runtime/powershell-probe.ps1')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});request.child?.stdin?.end();const r=await request;result=JSON.parse(r.stdout.replace(/^\uFEFF/,'').trim());}
   catch(error){
    try{result=JSON.parse((error.stdout||'').replace(/^\uFEFF/,'').trim());}catch{}
    if(['EACCES','EPERM'].includes(error.code)||result?.kind==='policy'||/AppLocker|WDAC|group policy|组策略|PSSecurityException|ConstrainedLanguage/i.test(error.stderr||''))throw failure(`${name} 被安全策略或权限阻止；不会改用其他版本绕过。${result?.reason||error.message}`);
    reasons.push(`${name}: ${result?.reason||error.message}`);continue;
   }
   const version=result?.version||'';
   if(result?.ok&&result.x64&&result.sta&&(name==='system'?/^5\.1\./.test(version):version==='7.6.9')){env.JOBMATE_POWERSHELL=executable;env.JOBMATE_POWERSHELL_ROOT=root;return executable;}
   if(result?.kind==='policy')throw failure(`${name} 被安全策略阻止；不会改用其他版本绕过。${result.reason}`);
   reasons.push(`${name}: ${result?.reason||'版本或所需桌面组件不满足要求'}`);
  }
  throw failure(reasons.join('；'));
 })());
 return selections.get(root);
}
