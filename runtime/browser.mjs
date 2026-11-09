import {selectPowerShell,powerShellArguments} from './powershell.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {detectBrowser} from '../src/browser-program.mjs';
import {recordDiagnostic,diagnosticId,diagnosticCode} from '../src/diagnostics.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export async function prepareBundledBrowser(installationRoot,executeFile=promisify(execFile)){
 try{
  const request=executeFile(await selectPowerShell(installationRoot),[...powerShellArguments,'-File',path.join(installationRoot,'runtime','prepare-browser.ps1')],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});request.child?.stdin?.end();
  const result=JSON.parse((await request).stdout.replace(/^\uFEFF/,'').trim());
  if(typeof result.path!=='string'||!result.path)throw new Error('内置浏览器准备未返回实际运行路径。');
  return result.path;
 }catch(error){throw new Error(error.stderr?.trim()||error.message,{cause:error});}
}
export async function readyBrowser(installationRoot,{detector=()=>detectBrowser(installationRoot),executeFile}={}){
 const browser=detector();
 return browser.source==='bundled'?{...browser,path:await prepareBundledBrowser(installationRoot,executeFile)}:browser;
}
if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()){
 try{
  const browser=detectBrowser(root);
  if(process.argv[2]!=='open'){process.stdout.write(JSON.stringify(browser));}
  else if(browser.source!=='bundled'&&!(process.argv[4]==='focus-return'&&browser.source==='system')){process.stdout.write(JSON.stringify({opened:false}));}
  else{
   const powershell=await selectPowerShell(root);
   const address=new URL(process.argv[3]);
   if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||!address.port||address.username||address.password)throw new Error('本目录页面地址无效。');
   if(browser.source==='bundled')browser.path=await prepareBundledBrowser(root);
   const profile=path.join(root,'data','app-browser-profile');await mkdir(profile,{recursive:true});
   const child=spawn(browser.path,['--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--force-renderer-accessibility','--disable-features=PreemptiveSodaDownload','--new-window',address.href],{windowsHide:false,detached:true,stdio:'ignore'});
   let launchError;child.once('exit',code=>{if(code!==null&&code!==0)launchError=new Error('内置浏览器启动失败，请前往系统配置重新检测，或重新完整解压软件包。');});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
   const focusTrace=process.argv[4]==='focus-return'?{component:'browser',operation:'web.return',task_id:diagnosticId(address.searchParams.get('hud_task')),browser_source:browser.source,phase:'focus.execute'}:null;
   const focusStarted=Date.now();let focused=false,focusPhase='focus.execute';
   if(focusTrace)await recordDiagnostic(root,{...focusTrace,outcome:'started'});
   try{
    const focusRequest=promisify(execFile)(powershell,[...powerShellArguments,'-File',path.join(root,'scripts','boss-uia.ps1'),'-Action','FocusDedicatedWindow','-ChromeProfileDirectory',profile,'-PayloadBase64',Buffer.from(JSON.stringify({target_url:address.href,wait_for_window:true})).toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
    focusRequest.child.stdin.end();
    const result=await focusRequest;
    focusPhase='focus.parse';focused=JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim()).focused===true;
    if(focusTrace)await recordDiagnostic(root,{...focusTrace,phase:'focus.verify',outcome:focused?'success':'error',reason:focused?null:'not_foreground',focused,elapsed_ms:Date.now()-focusStarted});
   }catch(error){
    if(focusTrace)await recordDiagnostic(root,{...focusTrace,phase:focusPhase,outcome:'error',reason:focusPhase==='focus.parse'?'invalid_json':error.killed?'timeout':typeof error.code==='number'?'process_exit':'execute_error',focused:false,elapsed_ms:Date.now()-focusStarted,exit_code:Number.isInteger(error.code)?error.code:null,error_code:diagnosticCode(error),killed:error.killed===true,signal:['SIGTERM','SIGKILL'].includes(error.signal)?error.signal:null});
   }
   if(launchError)throw launchError;
   process.stdout.write(JSON.stringify({opened:true,focused}));
  }
 }catch(error){console.error(error.code==='ENOENT'?'浏览器文件已变化，请前往系统配置重新检测。':error.message);process.exitCode=1;}
}
