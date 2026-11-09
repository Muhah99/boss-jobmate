import {selectPowerShell,powerShellArguments} from '../runtime/powershell.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,readFile,unlink,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import crypto,{randomUUID} from 'node:crypto';
import {redactSecrets} from './agent-runtime.mjs';
import {profileStageText,profileErrorText} from './profile-display.mjs';
import {recordDiagnostic,diagnosticId,diagnosticCode} from './diagnostics.mjs';
import {detectBrowser,publicBrowserStatus,browserMissingMessage} from './browser-program.mjs';
import {readyBrowser} from '../runtime/browser.mjs';
const execute=promisify(execFile);
const encode=value=>encodeURIComponent(String(value)).replace(/[!'()*]/g,ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase());
const abortCheck=signal=>{if(signal?.aborted)throw signal.reason||new Error('本次处理已停止。');};
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const payload=value=>Buffer.from(JSON.stringify(value),'utf8').toString('base64');
const expected=job=>({job_id:job.job_id||job.boss_id||job.id,title:job.title||job.job_title,company:job.company||job.company_name,salary:job.salary||'',city:job.city||'',recruiter:typeof job.recruiter==='object'?job.recruiter.name||'':job.recruiter||job.boss_name||''});
export function detailUrl(job){const url=job.detail_url||job.url||'';const match=/^https:\/\/www\.zhipin\.com\/job_detail\/([^/?#]+)\.html$/.exec(url);if(!match||((job.job_id||job.boss_id)&&match[1]!==String(job.job_id||job.boss_id)))throw new Error('岗位链接无效，请重新读取岗位。');return url;}
// Chat metadata only; never project UIA names, addresses, message text or error messages.
function chatDiagnostic(value, context={}) {
 try {
  const stages=['action.exception', 'activation.enter', 'activation.requery', 'activation.requery.target', 'activation.scroll', 'activation.selected', 'activation.target', 'branch', 'header.after', 'header.after_scroll', 'header.initial', 'invoke.after', 'invoke.enter', 'invoke.return', 'locate.document', 'locate.enter', 'locate.exception', 'locate.exit', 'locate.focus.before', 'locate.focus.verified', 'locate.target', 'pattern.exception', 'pointer.after', 'pointer.down.enter', 'pointer.down.return', 'pointer.exception', 'pointer.focus.before', 'pointer.focus.verified', 'pointer.move', 'pointer.moved', 'pointer.previous', 'pointer.request', 'pointer.restore', 'pointer.target', 'pointer.up.enter', 'pointer.up.return', 'prepare.after', 'prepare.before', 'prepare.before.document', 'prepare.document', 'prepare.enter', 'search.matches', 'selection.after', 'selection.enter', 'selection.return', 'structure.matches'];
  const events=[];
  for(const source of Array.isArray(value?.events)?value.events:[]){
   if(!stages.includes(source?.stage))continue;
   const row={stage:source.stage};
   for(const key of ['call_completed','api_result','point_matches_request','foreground_matches_target','is_chat','same_window','same_document','scrolled','requeried','matched'])if(typeof source[key]==='boolean')row[key]=source[key];
   for(const key of ['process_id','target_window','foreground_window','point_x','point_y','actual_x','actual_y','bounds_left','bounds_top','bounds_width','bounds_height','candidate_count','contact_count'])if(typeof source[key]==='number'&&Number.isFinite(source[key]))row[key]=source[key];
   if(Array.isArray(source.target_runtime_id))row.target_runtime_id=source.target_runtime_id.filter(Number.isSafeInteger);
   if(Array.isArray(source.document_runtime_id)&&source.document_runtime_id.length&&source.document_runtime_id.every(Number.isSafeInteger))row.document_runtime_id=source.document_runtime_id;
   if(Array.isArray(source.missing_fields))row.missing_fields=source.missing_fields.filter(x=>['title','company','salary','city','recruiter'].includes(x));
   if(source.stage.startsWith('header.')){
    if(typeof source.structure_ok==='boolean')row.structure_ok=source.structure_ok;
    for(const key of ['conversation_count','user_info_count','position_count'])if(Number.isSafeInteger(source[key])&&source[key]>=0)row[key]=source[key];
    if(['ok','conversation_missing','conversation_ambiguous','header_branch_missing','header_branch_ambiguous','header_branch_hidden','read_error'].includes(source.structure_status))row.structure_status=source.structure_status;
   }
   if(['current_chat','current_structure','search'].includes(source.branch))row.branch=source.branch;
   if(['ok','failed','user_action_required'].includes(source.status))row.status=source.status;
   if(['clickable_point','bounds_center'].includes(source.point_source))row.point_source=source.point_source;
   for(const key of ['error_type','diagnostic_error_type'])if(typeof source[key]==='string'&&/^[A-Za-z][A-Za-z0-9]{0,79}(?:Exception|Error)$/.test(source[key]))row[key]=source[key];
   events.push(row);
  }
  const locatedWindow=events.find(e=>e.stage==='locate.target')?.target_window,locatedDocument=events.find(e=>e.stage==='locate.document')?.document_runtime_id;
  return {action_id:diagnosticId(context.action_id),task_id:diagnosticId(context.task_id),job_id:diagnosticId(context.job_id),
   delivery_entry:['first','resume','direct'].includes(context.delivery_entry)?context.delivery_entry:null,
   original_stage:['prepared','greeting_sent','chat_located'].includes(context.original_stage)?context.original_stage:null,
   prepare_action_id:diagnosticId(context.prepare_action_id), job_stages:(Array.isArray(context.job_stages)?context.job_stages:[]).map(item=>({job_id:diagnosticId(item.job_id),original_stage:['prepared','greeting_sent','chat_located'].includes(item.original_stage)?item.original_stage:null})),
   same_prepared_window:Number.isSafeInteger(context.prepared_window)&&context.prepared_window!==0&&Number.isSafeInteger(locatedWindow)&&locatedWindow!==0?context.prepared_window===locatedWindow:null,
   same_prepared_document:Array.isArray(context.prepared_document)&&context.prepared_document.length&&context.prepared_document.every(Number.isSafeInteger)&&Array.isArray(locatedDocument)&&locatedDocument.length?JSON.stringify(context.prepared_document)===JSON.stringify(locatedDocument):null,events};
 }catch{return null;}
}
// Detail readiness metadata from the existing reads only; no UIA names, URLs or body text.
function detailReadinessDiagnostic(value) {
 if(!value||typeof value!=='object')return null;
 const output={};
 const reasons=['exception','ok','headhunter_skipped','job_closed','login_required','verification_required','detail_load_timeout','detail_navigation_mismatch','detail_summary_mismatch','communication_button_not_found'];
 const points=['before_loop','address','login','identity','address_mismatch','deadline_before_header','document','header','hunter','header_check','settle','headhunter','header_mismatch','job_closed','button','ready','deadline_after_button','button_missing','page_not_ready','login_not_ready'];
 const time=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)?value:null;
 const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
 const runtimeId=value=>typeof value==='string'&&/^-?\d+(?:\.-?\d+)*$/.test(value)?value:null;
 output.started_at=time(value.started_at);
 output.elapsed_ms=number(value.elapsed_ms);output.remaining_end_ms=number(value.remaining_end_ms);
 output.return_reason=reasons.includes(value.return_reason)?value.return_reason:null;
 output.stop_point=points.includes(value.stop_point)?value.stop_point:null;
 const navigation=value.navigation;
 output.navigation=navigation?{branch:['pending','current_detail','existing_tab','open_detail'].includes(navigation.branch)?navigation.branch:null,started_at:time(navigation.started_at),elapsed_ms:number(navigation.elapsed_ms)}:null;
 output.checks=(Array.isArray(value.checks)?value.checks:[]).map(source=>{
  const row={};
  for(const key of ['index','started_elapsed_ms','remaining_start_ms','remaining_before_header_ms','remaining_after_button_ms','elapsed_ms','remaining_end_ms','address_elapsed_ms','document_elapsed_ms','login_elapsed_ms','identity_elapsed_ms','header_elapsed_ms','hunter_elapsed_ms','header_check_elapsed_ms','button_elapsed_ms','settle_elapsed_ms','sleep_elapsed_ms'])row[key]=number(source?.[key]);
  for(const key of ['address_matches','document_present','same_previous_tab','same_previous_document','page_ready','header_structure_ok','header_matched','is_headhunter','job_closed','button_present'])row[key]=typeof source?.[key]==='boolean'?source[key]:null;
  for(const key of ['tab_id','document_id','previous_tab_id','previous_document_id'])row[key]=runtimeId(source?.[key]);
  row.login_state=['logged_in','login_required','verification_required','unknown'].includes(source?.login_state)?source.login_state:null;
  row.missing_fields=Array.isArray(source?.missing_fields)?source.missing_fields.filter(field=>['title','company','salary','city','detail_structure'].includes(field)):null;
  row.stop_point=points.includes(source?.stop_point)?source.stop_point:null;
  return row;
 });
 return output;
}
export class NativeProgress {
 constructor({root,spawnProcess=spawn,returnUrl='',getSecrets=()=>({})}={}){this.getSecrets=getSecrets;this.root=root;this.spawnProcess=spawnProcess;this.returnUrl=returnUrl;this.path=path.join(root,'data','progress','desktop.json');this.child=null;this.pending=Promise.resolve();this.states=new Map();this.hiddenTasks=new Set();}
 visibility(taskId){const state=this.states.get(taskId);return {available:!!state?.window_controls&&this.currentTaskId===taskId&&!['done','completed','success','abandoned','cancelled','closed','hidden'].includes(state.status),hidden:this.hiddenTasks.has(taskId)||!this.child,type:state?.type};}
 async setVisibility(taskId,hidden){
  const state=this.states.get(taskId),current=this.visibility(taskId),wasHidden=this.hiddenTasks.has(taskId);
  if(!current.available||hidden&&state.type==='browser')throw new Error('当前任务没有可隐藏的小窗口。');
  if(hidden)this.hiddenTasks.add(taskId);else this.hiddenTasks.delete(taskId);
  if(await this.update(state)===false){if(wasHidden)this.hiddenTasks.add(taskId);else this.hiddenTasks.delete(taskId);throw new Error('窗口显示状态未能保存，请稍后手动重试。');}
  return this.visibility(taskId);
 }
 update(state){this.currentTaskId=state.taskId;this.states.set(state.taskId,state);this.pending=this.pending.then(async()=>{let phase='hud.write';try{await mkdir(path.dirname(this.path),{recursive:true});const temp=this.path+'.tmp';await writeFile(temp,JSON.stringify({...state,window_hidden:this.hiddenTasks.has(state.taskId),stage:profileStageText(state.stage),error:profileErrorText(state.error),return_url:state.return_url||this.returnUrl,updated_at:new Date().toISOString()}));await rename(temp,this.path);
  if(!this.child&&process.platform==='win32'&&!(this.hiddenTasks.has(state.taskId)&&state.type!=='browser')){phase='hud.spawn';this.child=this.spawnProcess(await selectPowerShell(this.root),[...powerShellArguments,'-File',path.join(this.root,'scripts','desktop-progress.ps1'),'-StatusFile',this.path],{windowsHide:true,stdio:'ignore'});const child=this.child;this.child.on('error',error=>{if(this.child!==child)return;void recordDiagnostic(this.root,{component:'progress',operation:'hud',phase:'hud.spawn',outcome:'error',task_id:diagnosticId(state.taskId),error_code:diagnosticCode(error)},()=>this.getSecrets());this.child=null;});this.child.on('exit',(code,signal)=>{if(this.child!==child)return;if(Number.isInteger(code)&&code!==0||signal&&!child.killed)void recordDiagnostic(this.root,{component:'progress',operation:'hud',phase:'hud.exit',outcome:'error',task_id:diagnosticId(state.taskId),exit_code:Number.isInteger(code)?code:null,signal:['SIGTERM','SIGKILL','SIGINT','SIGABRT'].includes(signal)?signal:null},()=>this.getSecrets());this.child=null;});this.child.unref();}
  }catch(error){await recordDiagnostic(this.root,{component:'progress',operation:'hud',phase,outcome:'error',task_id:diagnosticId(state.taskId),error_code:diagnosticCode(error)},()=>this.getSecrets());return false;}
 });return this.pending;}
 hide(taskId){this.pending=this.pending.then(async()=>{try{const current=JSON.parse(await readFile(this.path,'utf8'));if(current.taskId===taskId)await writeFile(this.path,JSON.stringify({taskId,status:'hidden'}));}catch(error){if(error.code!=='ENOENT'){await recordDiagnostic(this.root,{component:'progress',operation:'hud',phase:'hud.hide',outcome:'error',task_id:diagnosticId(taskId),error_code:diagnosticCode(error)},()=>this.getSecrets());return false;}}});return this.pending;}
 async initGuide(hidden=false){
  const id='init-browser-guide';
  if(hidden){
   if(this.currentTaskId!==id)return;
   this.hiddenTasks.add(id);return this.update(this.states.get(id));
  }
  this.hiddenTasks.delete(id);
  return this.update({taskId:id,type:'init-guide',status:'user_action_required',title:'初始化 · BOSS 资料准备'});
 }
 async close(){await this.pending;await writeFile(this.path,JSON.stringify({status:'closed'})).catch(async error=>{await recordDiagnostic(this.root,{component:'progress',operation:'hud',phase:'hud.close',outcome:'error',error_code:diagnosticCode(error)},()=>this.getSecrets());});this.child?.kill();this.child=null;}
}
export class ExternalServices {
 constructor({root,getSecrets=()=>({}),progress=()=>{},executeFile=execute,spawnProcess=spawn,fetchImpl=fetch,chromePath,browserDetector}={}){
  Object.assign(this,{root:path.resolve(root),getSecrets,progress,executeFile,spawnProcess,fetchImpl,chromePath});this.profile=path.join(this.root,'data','chrome-profile');this.browserBusy=false;this.jobsReady=false;this.mapQueue=Promise.resolve();this.lastMapRequest=0;
  this.browserDetector=browserDetector||(chromePath===undefined?()=>detectBrowser(this.root):()=>({installed:!!this.chromePath,status:this.chromePath?'ready':'missing',source:this.chromePath?'system':null,path:this.chromePath,message:this.chromePath?undefined:browserMissingMessage}));
 }
 async detectChrome(){
  try{const result=await readyBrowser(this.root,{detector:this.browserDetector,executeFile:this.executeFile});this.chromePath=result.path;return publicBrowserStatus(result);}
  catch(error){this.chromePath=null;return {installed:false,status:'error',source:'bundled',message:error.message};}
 }
 async openChromeDownload(){const request=this.executeFile(await selectPowerShell(this.root),[...powerShellArguments,'-Command',"Start-Process -FilePath 'https://www.google.com/chrome/'"],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});request.child?.stdin?.end();await request;return {opened:true};}
 #requireBrowser(){const result=this.browserDetector();this.chromePath=result.path;if(!result.installed)throw new Error(result.message||browserMissingMessage);return result;}
 async #launchBrowser(args){
  await selectPowerShell(this.root);
   const browser=await readyBrowser(this.root,{detector:()=>this.#requireBrowser(),executeFile:this.executeFile});this.chromePath=browser.path;
   if(browser.source==='bundled')args=['--disable-features=PreemptiveSodaDownload',...args];
  try{
   const child=this.spawnProcess(browser.path,args,{windowsHide:false,detached:true,stdio:'ignore'});
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return child;
  }catch(error){if(['ENOENT','EACCES','EPERM'].includes(error.code)){const failure=new Error('浏览器文件已变化或无法启动，请前往系统配置重新检测。');failure.code=error.code;throw failure;}throw error;}
 }
 async clearBrowserSession(){
  if(this.browserBusy)throw new Error('当前有浏览器操作正在执行，请结束后再清理');
  const request=this.executeFile(await selectPowerShell(this.root),[...powerShellArguments,'-File',path.join(this.root,'scripts/reset-browser.ps1'),'-InstallationRoot',this.root],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});request.child?.stdin?.end();const result=await request;
  this.jobsReady=false;this.mapQueue=Promise.resolve();this.lastMapRequest=0;
  return {homeClosed:JSON.parse(result?.stdout?.replace(/^\uFEFF/,'').trim()||'{}').home_closed===true};
 }
 async reopenHome(){const request=this.executeFile(await selectPowerShell(this.root),[...powerShellArguments,'-File',path.join(this.root,'open.ps1')],{windowsHide:true,timeout:45000,maxBuffer:1024*1024});request.child?.stdin?.end();await request;}
 async #uia(action,{body,args=[],signal,timeoutMs=300000,taskId=null,jobId=null,diagnostic=true,chatContext=null}={}){
  const started=Date.now(),trace={component:'browser',operation:action,task_id:diagnosticId(taskId),job_id:diagnosticId(jobId),phase:'uia.prepare',outcome:'error'};
  const isChat=['PrepareChatBatch','LocateChatFromBatch','SendChatMessageFromBatch','VerifyDelivery'].includes(action);
  const context=isChat?{...chatContext,action_id:randomUUID(),task_id:taskId,job_id:jobId}:null;
  if(isChat)trace.contact_diagnostic=chatDiagnostic(null,context);
  try{
  abortCheck(signal);const powershell=await selectPowerShell(this.root);const argumentsList=[...powerShellArguments,'-File',path.join(this.root,'scripts','boss-uia.ps1'),'-Action',action,'-ChromeProfileDirectory',this.profile,'-ActionDelayMs','2000','-JobDetailSettleMinMs','5000','-JobDetailSettleMaxMs','10000',...args];
  if(body)argumentsList.push('-PayloadBase64',payload(body));
  trace.phase='uia.spawn';const result=await new Promise((resolve,reject)=>{
   const child=this.spawnProcess(powershell,argumentsList,{windowsHide:true,stdio:['ignore','pipe','pipe']});
   const stdout=[],stderr=[];let outputSize=0,failure;
   const interrupt=error=>{if(failure)return;failure=error;child.kill();};
   const collect=target=>chunk=>{if(failure)return;const bytes=Buffer.from(chunk);if(target===stderr)trace.stderr_bytes=(trace.stderr_bytes||0)+bytes.length;outputSize+=bytes.length;if(outputSize>10*1024*1024){trace.reason='output_limit';interrupt(new Error('UI Automation output exceeded the allowed size.'));return;}target.push(bytes);};
   child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));
   child.on('error',error=>{failure||=error;});
   const cancel=()=>interrupt(signal.reason||new Error('本次处理已停止。'));
   signal?.addEventListener('abort',cancel,{once:true});
   trace.phase='uia.execute';const timer=setTimeout(()=>{trace.reason='timeout';interrupt(new Error(`UI Automation timed out after ${timeoutMs} ms.`));},timeoutMs);
   child.on('close',code=>{trace.exit_code=Number.isInteger(code)?code:null;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(failure||code!==0){
    const error=failure||new Error(Buffer.concat(stderr).toString('utf8').trim()||`UI Automation exited with code ${code}.`);
    if(isChat){try{trace.contact_diagnostic=chatDiagnostic(JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/,'').trim()).contact_diagnostic,context);}catch{}error.contact_diagnostic=trace.contact_diagnostic;}
    if(action==='ApplyFromDetail'){
     try{trace.detail_readiness_diagnostic=detailReadinessDiagnostic(JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/,'').trim()).detail_readiness_diagnostic);}catch{}
    }
    reject(error);
   }else resolve({stdout:Buffer.concat(stdout).toString('utf8')});});
   if(signal?.aborted)cancel();
  });
  abortCheck(signal);trace.phase='uia.parse';const output=JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim()||'{}');
   if(action==='ReadJobDetails'&&body&&'screening_detail_interval' in body){
    const detail=output.results?.[0],interval=detail?.screening_detail_interval,navigation=detail?.screening_detail_navigation;
    trace.screening_detail_interval={...Object.fromEntries(['ready_at_ms','target_ms'].filter(key=>Number.isFinite(interval?.[key])).map(key=>[key,interval[key]])),...Object.fromEntries(['previous_ready_at_ms','previous_target_ms','navigation_started_at_ms','remaining_wait_ms'].filter(key=>Number.isFinite(navigation?.[key])).map(key=>[key,navigation[key]]))};
   }
  if(isChat){trace.contact_diagnostic=chatDiagnostic(output?.contact_diagnostic,context);if(trace.contact_diagnostic)output.contact_diagnostic=trace.contact_diagnostic;else delete output.contact_diagnostic;}
  if(action==='ApplyFromDetail'){trace.detail_readiness_diagnostic=detailReadinessDiagnostic(output?.detail_readiness_diagnostic);if(trace.detail_readiness_diagnostic)output.detail_readiness_diagnostic=trace.detail_readiness_diagnostic;else delete output.detail_readiness_diagnostic;}
  trace.error_reason=['detail_load_timeout','detail_navigation_mismatch','detail_summary_mismatch','communication_button_not_found','matching_chat_header_mismatch','chat_contact_not_found','chat_contact_ambiguous','job_closed','already_contacted','chat_send_outcome_unknown','sent_message_not_visible','greeting_outcome_unknown','chat_input_not_found','chat_input_verification_failed','send_button_not_found','unexpected_chat_message_error','fixed_greeting_not_recorded'].includes(output?.error)?output.error:null;
  trace.status=['ok','failed','user_action_required','closed','uncertain','already_contacted'].includes(output?.status)?output.status:null;trace.browser_state=['ready','not_ready','not_found'].includes(output?.browser_state)?output.browser_state:null;trace.login_state=['logged_in','login_required','verification_required','unknown'].includes(output?.login_state)?output.login_state:null;
  for(const key of ['focused','confirmation_visible','greeting_sent','message_sent','confirmed'])if(typeof output?.[key]==='boolean')trace[key]=output[key];
  trace.phase='complete';trace.outcome=trace.status==='user_action_required'?'user_action_required':trace.status==='failed'?'error':'success';return output;
  }catch(error){if(isChat)error.contact_diagnostic=trace.contact_diagnostic;trace.outcome=signal?.aborted?'cancelled':trace.reason==='timeout'?'timeout':'error';trace.error_code=diagnosticCode(error);
   if(['ReadFirstJobSample','CloseSampleWindow','CloseTaskWindows'].includes(action)&&!signal?.aborted){
    trace.native_error=redactSecrets(error,await this.getSecrets());
    const line=trace.native_error.split(/\r?\n/)[0].trim();
    const brief=line&&!/(?:[A-Za-z]:[\\/]|\.ps1(?::|\s)|^At\s|^所在位置)/i.test(line)?line:'本次浏览器读取或关窗未完成，请核对专用BOSS页面后再试。';
    const safe=new Error(brief);safe.code=error.code;throw safe;
   }
   throw error;}
  finally{if(diagnostic)await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
 async #browser(title,stage,signal,operation){
  if(this.browserBusy)throw new Error('本项目浏览器正在自动操作，请等待当前环节完成。');this.browserBusy=true;
  try{abortCheck(signal);await selectPowerShell(this.root);await this.progress({type:'browser',title,stage,status:'running'});const result=await operation();abortCheck(signal);return result;}
  catch(error){const safe=new Error(redactSecrets(error,await this.getSecrets()));safe.code=error.code;if(error.contact_diagnostic)safe.contact_diagnostic=error.contact_diagnostic;throw safe;}
  finally{this.browserBusy=false;}
 }
 async #ensure(signal,taskId=null,requireJobsPage=true){
  const started=Date.now(),trace={component:'browser',operation:'browser.ensure',task_id:diagnosticId(taskId),phase:'ensure.status',outcome:'error'};
  try{
  abortCheck(signal);this.#requireBrowser();let status;try{const focus=await this.#uia('FocusDedicatedWindow',{signal,diagnostic:false});trace.focused=typeof focus.focused==='boolean'?focus.focused:null;status=await this.#uia('Status',{signal,diagnostic:false});}catch(error){trace.last_error_code=diagnosticCode(error);trace.last_failure=error instanceof SyntaxError?'json':error?.code==='ENOENT'?'spawn':'uia';}
  abortCheck(signal);
  if(status?.browser_state==='ready'&&(!requireJobsPage||this.jobsReady)){trace.outcome='success';return status;}
  if(status?.browser_state==='ready'){try{const jobs=await this.#uia('ListExpectations',{signal,taskId,diagnostic:false});this.jobsReady=true;trace.browser_state=status.browser_state==='ready'?'ready':null;trace.login_state=['logged_in','login_required','verification_required','unknown'].includes(jobs.login_state||status.login_state)?jobs.login_state||status.login_state:null;trace.outcome='success';return {...status,jobs_page:'ready',jobs_login_state:jobs.login_state||status.login_state};}catch(error){trace.last_error_code=diagnosticCode(error);trace.last_failure=error instanceof SyntaxError?'json':error?.code==='ENOENT'?'spawn':'uia';}}
  abortCheck(signal);
  trace.phase='ensure.launch';await mkdir(this.profile,{recursive:true});abortCheck(signal);if(!requireJobsPage)this.jobsReady=false;
  await this.#launchBrowser([`--user-data-dir=${this.profile}`,'--new-window','--lang=zh-CN','--no-first-run','--force-renderer-accessibility',requireJobsPage?'https://www.zhipin.com/web/geek/jobs':'https://www.zhipin.com/web/geek/chat']);
  trace.phase='ensure.ready';const deadline=Date.now()+25000;while(Date.now()<deadline){abortCheck(signal);try{const focus=await this.#uia('FocusDedicatedWindow',{signal,diagnostic:false});trace.focused=typeof focus.focused==='boolean'?focus.focused:null;status=await this.#uia('Status',{signal,diagnostic:false});if(status?.browser_state==='ready'){if(!requireJobsPage){trace.outcome='success';return status;}const jobs=await this.#uia('ListExpectations',{signal,taskId,diagnostic:false});this.jobsReady=true;trace.browser_state=status.browser_state==='ready'?'ready':null;trace.login_state=['logged_in','login_required','verification_required','unknown'].includes(jobs.login_state||status.login_state)?jobs.login_state||status.login_state:null;trace.outcome='success';return {...status,jobs_page:'ready',jobs_login_state:jobs.login_state||status.login_state};}}catch(error){trace.last_error_code=diagnosticCode(error);trace.last_failure=error instanceof SyntaxError?'json':error?.code==='ENOENT'?'spawn':'uia';}abortCheck(signal);await sleep(500);}
  throw new Error('本项目专用浏览器 尚未就绪，请在专用窗口完成登录后重试。');
  }catch(error){trace.outcome=signal?.aborted?'cancelled':'error';trace.error_code=diagnosticCode(error);throw error;}
  finally{await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
 async readExpectations({signal,taskId=null}={}){return this.#browser('读取求职期望','读取 BOSS 求职期望',signal,async()=>{await this.#ensure(signal,taskId);const result=await this.#uia('ListExpectations',{signal,taskId});this.#requireBrowserResult(result,'请在专用浏览器完成登录或安全验证，然后点击【重试】继续读取求职期望。');return result.expectations.map(item=>({...item,title:item.keyword,source_id:item.id}));});}
 async readFirstJobSample({expectation,signal,taskId=null}={}){return this.#browser('读取求职期望','读取 BOSS 求职期望',signal,async()=>{
  const result=await this.#uia('ReadFirstJobSample',{signal,taskId,args:['-ExpectationId',expectation.source_id]});this.#requireBrowserResult(result);return {sample:result.sample,window:result.window};
 });}
 async closeSampleWindow({window,signal,taskId=null}={}){return this.#browser('读取求职期望','读取 BOSS 求职期望',signal,async()=>{
  const result=await this.#uia('CloseSampleWindow',{signal,taskId,body:window});this.#requireBrowserResult(result);this.jobsReady=false;return result;
 });}
 async closeTaskWindows({signal,taskId=null}={}){
  if(this.browserBusy)throw new Error('本项目浏览器正在自动操作，未关闭窗口。');
  this.browserBusy=true;
  try{
   const result=await this.#uia('CloseTaskWindows',{signal,taskId});
   this.#requireBrowserResult(result);this.jobsReady=false;return result;
  }finally{this.browserBusy=false;}
 }
 #requireBrowserResult(result,userActionMessage='请在本项目 BOSS 浏览器完成登录或安全验证后继续。'){if(result.status==='user_action_required'){const error=new Error(userActionMessage);error.code='user_action_required';throw error;}if(result.status!=='ok')throw new Error('浏览器处理未完成：'+(result.error||result.status||'未返回结果'));}
 async collect({expectation,params,signal,taskId=null}={}){return this.#browser('采集岗位','批量采集岗位',signal,async()=>{
  await this.#ensure(signal,taskId);const excluded=[...(params.excluded_job_ids||[])],jobs=[];const target=Number(params.collect_count||params.collection_count||params.count||30);let remaining=target;
  const directory=path.join(this.root,'data','temp');await mkdir(directory,{recursive:true});
  while(remaining>0){abortCheck(signal);const file=path.join(directory,`exclusions-${randomUUID()}.json`);await writeFile(file,JSON.stringify(excluded));
   try{const result=await this.#uia('CollectJobsIncrement',{signal,taskId,args:['-ExpectationId',expectation.source_id||expectation.boss_id||`boss:${encodeURIComponent(`${expectation.title}(${expectation.city})`)}`,'-TargetNewCount',String(Math.min(60,remaining)),'-Limit','1000','-ExcludedJobIdsFile',file,'-ExcludedCompaniesBase64',payload(params.excluded_companies||[]),'-TitleFilterBase64',payload(params.title_filter||{version:'jobmate-v0.1.0',exclude_contains_any:[],conditional_exclusions:[]} ),'-SalaryTargetBase64',payload({salary_min_k:params.salary_min??params.salary_min_k,salary_max_k:params.salary_max??params.salary_max_k})]});this.#requireBrowserResult(result);
    const requested=Math.min(60,remaining),added=Number(result.new_candidate_count);
    const received=(result.jobs||[]).filter(job=>!excluded.includes(job.job_id));for(const job of received){jobs.push({...job,boss_id:job.job_id,title:job.title||job.job_title,company:job.company||job.company_name,url:job.detail_url});excluded.push(job.job_id);}
    remaining-=added;await this.progress({type:'browser',title:'采集岗位',stage:'批量采集岗位',status:'running',completed:target-remaining,total:target});if(added<requested)break;
   }finally{await unlink(file).catch(()=>{});}
  }return jobs;
 });}
 async readDetail({job,signal,taskId=null,screening=false,previousDetailInterval=null}={}){return this.#browser('读取岗位详情','读取完整 JD',signal,async()=>{await this.#ensure(signal,taskId);const result=await this.#uia('ReadJobDetails',{signal,taskId,jobId:job.id,body:{jobs:[{...expected(job),detail_url:detailUrl(job)}],...(screening?{screening_detail_interval:previousDetailInterval}:{})}});this.#requireBrowserResult(result);const detail=result.results?.[0];if(!detail)throw new Error('岗位详情未返回。');if(['failed','incomplete'].includes(detail.status)&&!['job_closed','already_contacted'].includes(detail.error))throw new Error('岗位详情读取失败：'+detail.error);const screeningInterval=detail.screening_detail_interval||null;delete detail.screening_detail_interval;delete detail.screening_detail_navigation;return {...job,...detail,...(screening?{screeningInterval}:{}),boss_id:detail.job_id||job.boss_id,title:detail.title||detail.job_title||job.title,company:detail.company||detail.company_name||job.company,jd:detail.description||detail.jd_text||detail.jd||job.jd||'',address:detail.address||detail.job_address||job.address||'',closed:detail.error==='job_closed'||detail.status==='closed',contacted:detail.already_contacted===true||detail.error==='already_contacted'||detail.status==='already_contacted',is_headhunter:detail.is_headhunter===true||detail.status==='headhunter_skipped'};});}
 async openJob(job){
  const started=Date.now(),trace={component:'browser',operation:'browser.openJob',job_id:diagnosticId(job?.id),phase:'chrome.prepare',outcome:'error'};
  try{
  if(this.browserBusy)throw new Error('本项目浏览器正在自动操作，请稍后打开岗位。');
  this.#requireBrowser();
  const url=detailUrl(job);this.browserBusy=true;
  try{
   await mkdir(this.profile,{recursive:true});
   trace.phase='chrome.spawn';const child=await this.#launchBrowser([`--user-data-dir=${this.profile}`,'--no-first-run','--force-renderer-accessibility',url]);
   let launchError;const focusAbort=new AbortController();
   const onExit=code=>{trace.exit_code=Number.isInteger(code)?code:null;if(code!==null&&code!==0){launchError=new Error('未能打开岗位，本项目专用浏览器 启动失败。');trace.phase='chrome.exit';focusAbort.abort(launchError);}};
   child.once('exit',onExit);if(child.exitCode!=null)onExit(child.exitCode);
   try{
    if(launchError)throw launchError;
    trace.phase='chrome.focus';let focused=false;
    try{focused=(await this.#uia('FocusDedicatedWindow',{body:{target_url:url,wait_for_window:true},timeoutMs:15000,signal:focusAbort.signal})).focused===true;}catch{}
    if(launchError)throw launchError;
    trace.outcome='success';trace.focused=focused;return {opened:true,focused,message:focused?'已打开岗位，并切到本项目专用浏览器。':'岗位已打开，但未能切到前台，请手动切换到本项目专用浏览器。'};
   }finally{child.removeListener('exit',onExit);}
  }finally{this.browserBusy=false;}
  }catch(error){trace.error_code=diagnosticCode(error);throw error;}
  finally{await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
 async #mapRequest(endpoint,parameters,signal,context={}){
  const started=Date.now(),trace={component:'map',operation:endpoint,task_id:diagnosticId(context.taskId),job_id:diagnosticId(context.jobId),origin_id:diagnosticId(context.originId),phase:'map.prepare',outcome:'error'};
  try{
  const secrets=await this.getSecrets();if(!secrets.map_ak||!secrets.map_sk)throw new Error('请先填写并保存百度地图 AK/SK。');
  const run=async()=>{trace.phase='map.queue';abortCheck(signal);const delay=Math.max(0,1100-(Date.now()-this.lastMapRequest));if(delay)await sleep(delay);abortCheck(signal);const entries={...parameters,ak:secrets.map_ak,timestamp:Math.floor(Date.now()/1000)};const query=Object.entries(entries).filter(([,value])=>value!=null).map(([key,value])=>`${encode(key)}=${encode(value)}`).join('&');const sn=crypto.createHash('md5').update(encode(`${endpoint}?${query}${secrets.map_sk}`)).digest('hex');this.lastMapRequest=Date.now();
   trace.phase='map.request';trace.queue_ms=Date.now()-started;let response;try{response=await this.fetchImpl(`https://api.map.baidu.com${endpoint}?${query}&sn=${sn}`,{signal});}catch(error){trace.error_code=diagnosticCode(error);abortCheck(signal);throw new Error('无法连接百度地图，请检查网络后手动重试。');}trace.phase='map.http';trace.http_status=Number.isInteger(response.status)?response.status:null;if(!response.ok)throw new Error(`百度地图请求失败（HTTP ${response.status}）。`);trace.phase='map.parse';const body=await response.json();trace.vendor_status=Number.isFinite(Number(body.status))?Number(body.status):null;trace.phase='map.vendor';if(Number(body.status)!==0)throw new Error(`百度地图未完成请求（状态 ${Number(body.status)}），请检查凭据或权限。`);trace.result_count=Array.isArray(body.results)?body.results.length:Array.isArray(body.result?.routes)?body.result.routes.length:null;trace.phase='complete';trace.outcome='success';return body;
  };const request=this.mapQueue.then(run,run);this.mapQueue=request.catch(()=>{});return await request;
  }catch(error){trace.outcome=signal?.aborted?'cancelled':'error';trace.error_code||=diagnosticCode(error);throw error;}
  finally{await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
 async searchPlaces({city,query,signal,taskId=null,jobId=null}){const body=await this.#mapRequest('/place/v2/search',{query,region:city,city_limit:true,scope:2,output:'json',page_size:10},signal,{taskId,jobId});return(body.results||[]).filter(item=>Number.isFinite(item.location?.lat)&&Number.isFinite(item.location?.lng)).map(item=>({name:item.name||'',address:item.address||'',province:item.province||'',city:item.city||city,area:item.area||'',poi_id:item.uid||'',placeId:item.uid||'',longitude:item.location.lng,latitude:item.location.lat,lng:item.location.lng,lat:item.location.lat,coord_type:'bd09ll',coordinateType:'bd09ll'}));}
 async commute({job,origins,signal,taskId=null}={}){
  const started=Date.now(),trace={component:'map',operation:'commute',task_id:diagnosticId(taskId),job_id:diagnosticId(job?.id),origin_count:origins?.length||0,status:'failed'};
  try{
  if(!origins?.length){trace.status='not_configured';return {status:'not_configured',selected:null,origins:[]};}
  const address=job.address||job.job_address||'';if(!address){trace.status='no_route';return {status:'no_route',selected:null,origins:[]};}
  try{const body=await this.#mapRequest('/geocoding/v3/',{address,city:job.city||'',output:'json'},signal,{taskId,jobId:job.id});let destination=body.result?.location;
   if(!destination||body.result?.precise!==1){const places=await this.searchPlaces({city:job.city||'',query:address,signal,taskId,jobId:job.id});if(!places.length){trace.status='no_route';return {status:'no_route',selected:null,origins:[]};}destination={lat:places[0].latitude,lng:places[0].longitude};}
   const results=[];for(const stored of origins){const origin={...stored,latitude:stored.latitude??stored.lat,longitude:stored.longitude??stored.lng,poi_id:stored.poi_id??stored.placeId};abortCheck(signal);if(!Number.isFinite(origin.latitude)||!Number.isFinite(origin.longitude)){results.push({origin,status:'not_configured'});continue;}
    try{const routes=await this.#mapRequest('/direction/v2/transit',{origin:`${origin.latitude},${origin.longitude}`,destination:`${destination.lat},${destination.lng}`,origin_uid:origin.poi_id||null,coord_type:'bd09ll',output:'json',tactics_incity:0,page_size:3},signal,{taskId,jobId:job.id,originId:stored.id});
     const valid=(routes.result?.routes||[]).filter(route=>Number.isFinite(Number(route.duration))&&Number(route.duration)>0).sort((a,b)=>Number(a.duration)-Number(b.duration));const route=valid[0];if(!route){results.push({origin,status:'no_route'});continue;}
     const schemes=(route.steps||[]).flatMap(step=>step||[]).flatMap(item=>item.schemes||[]);results.push({origin,status:'ok',duration_minutes:Number(route.duration)/60,distance_km:route.distance!=null&&Number.isFinite(Number(route.distance))?Math.round(Number(route.distance)/100)/10:null,distance_type:'公共交通路线',walking_meters:schemes.reduce((sum,item)=>sum+(Number(item.vehicle_info?.type)===5?Number(item.distance)||0:0),0),lines:schemes.map(item=>item.vehicle_info?.detail?.name||'').filter(Boolean)});
    }catch(error){abortCheck(signal);results.push({origin,status:'failed',error:redactSecrets(error,await this.getSecrets())});}
   }const selected=results.filter(item=>item.status==='ok').sort((a,b)=>a.duration_minutes-b.duration_minutes)[0]||null;trace.status=selected?'ok':results.some(item=>item.status==='failed')?'failed':'no_route';return {status:trace.status,selected,origins:results};
  }catch(error){abortCheck(signal);return {status:'failed',selected:null,origins:[],error:redactSecrets(error,await this.getSecrets())};}
  }finally{await recordDiagnostic(this.root,{...trace,outcome:signal?.aborted?'cancelled':trace.status,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
 async applyFromDetails({job,signal,taskId=null}={}){return this.#browser('实际投递','发送固定招呼',signal,async()=>{await this.#ensure(signal,taskId);const result=await this.#uia('ApplyFromDetail',{signal,taskId,jobId:job.id,body:{...expected(job),detail_url:detailUrl(job),detail_tab_runtime_id:job.detail_tab_runtime_id||''}});return {...result,job_closed:result.error==='job_closed'||result.status==='closed',login_required:result.status==='user_action_required'&&result.login_state==='login_required',security_required:result.status==='user_action_required'&&result.login_state==='verification_required'};});}
 async prepareChatBatch({jobs,signal,taskId=null,chatContext=null}={}){return this.#browser('实际投递','定位本次投递的聊天会话',signal,async()=>{await this.#ensure(signal,taskId,false);return this.#uia('PrepareChatBatch',{signal,taskId,chatContext,body:{items:jobs.map((job,index)=>({item_no:index+1,expected:expected(job)}))}});});}
 async sendFromChat({job,message,plan,snapshot,signal,taskId=null,chatContext=null}={}){if(!message?.trim())throw new Error('不能投递空消息。');if(!plan||!snapshot)throw new Error('请先定位本次投递的聊天会话后发送。');return this.#browser('实际投递','发送已确认消息',signal,async()=>{await this.#ensure(signal,taskId,false);
  const result=await this.#uia('SendChatMessageFromBatch',{signal,taskId,jobId:job.id,chatContext,body:{expected:expected(job),message,send_mode:'send',plan,snapshot}});
  const stopErrors=['chat_input_not_found','chat_input_verification_failed','send_button_not_found','unexpected_chat_message_error'];
  return {...result,login_required:result.status==='user_action_required'&&result.login_state==='login_required',security_required:result.status==='user_action_required'&&result.login_state==='verification_required',stop_reason:result.status==='user_action_required'?result.login_state:stopErrors.includes(result.error)?result.error:null};
 });}
 async deliver({job,message,signal,onPhase}={}){
  const state=job.delivery_status||'prepared';if(['message_sent','sent','already_contacted','job_closed','headhunter_skipped'].includes(state))return {status:state};
  if(['uncertain','send_uncertain','verify_required'].includes(state))return {status:'uncertain',requires_verification:true};
  let greeting=null;if(!['greeting_sent','chat_located'].includes(state)){greeting=await this.applyFromDetails({job,signal});await onPhase?.({phase:'greeting',result:greeting});if(greeting.status!=='ok'||!greeting.confirmation_visible)return {status:greeting.greeting_sent?'uncertain':greeting.already_contacted?'already_contacted':greeting.error==='job_closed'?'job_closed':greeting.status,greeting};}
  abortCheck(signal);const prepared=await this.prepareChatBatch({jobs:[job],signal});if(prepared.status!=='ok'||!prepared.items?.[0])return {status:'failed',greeting,prepared};let chat;try{chat=await this.sendFromChat({job,message,plan:prepared.items[0],snapshot:prepared.snapshot,signal});}catch(error){return {status:'uncertain',greeting,error:redactSecrets(error,await this.getSecrets())};}await onPhase?.({phase:'message',result:chat});return {status:chat.message_sent?'sent':chat.send_result?.status==='not_attempted'?'failed':'uncertain',greeting,chat};
 }
 async verifyDelivery({job,message,phase='message',fixed_greeting,signal,taskId=null}={}){return this.#browser('核实投递结果','核实当前聊天记录',signal,async()=>{await this.#ensure(signal,taskId);if(phase==='greeting'&&!fixed_greeting)return {status:'uncertain',greeting_sent:false,confirmed:false,message_sent:false,error:'fixed_greeting_not_recorded'};const result=await this.#uia('VerifyDelivery',{signal,taskId,jobId:job.id,body:{...expected(job),message:phase==='greeting'?fixed_greeting:message}});return phase==='greeting'?{...result,greeting_sent:result.message_sent===true,confirmed:result.message_sent===true,message_sent:false}:result;});}
 async pickProgram(){const request=this.executeFile(await selectPowerShell(this.root),[...powerShellArguments,'-File',path.join(this.root,'scripts','select-cli-program.ps1')],{windowsHide:true,timeout:10*60*1000,maxBuffer:1024*1024});request.child?.stdin?.end();const result=await request;return JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim()||'null')?.path||null;}
 async openProfile(){
  const started=Date.now(),trace={component:'browser',operation:'browser.openProfile',job_id:null,phase:'chrome.prepare',outcome:'error'};
  try{
  if(this.browserBusy)throw new Error('本项目浏览器正在自动操作，请稍后打开。');
  this.#requireBrowser();this.browserBusy=true;
  try{
   await mkdir(this.profile,{recursive:true});
   trace.phase='chrome.spawn';const child=await this.#launchBrowser([`--user-data-dir=${this.profile}`,'--no-first-run','--force-renderer-accessibility','https://www.zhipin.com/web/user/']);
   let launchError;
   child.once('exit',code=>{trace.exit_code=Number.isInteger(code)?code:null;if(code!==null&&code!==0)launchError=new Error('未能打开本项目专用浏览器，Chrome 启动失败。');});
   trace.phase='chrome.focus';let focused=false;
   try{focused=(await this.#uia('FocusDedicatedWindow',{body:{wait_for_window:true},timeoutMs:15000})).focused===true;}catch{}
   if(launchError)throw launchError;
   trace.outcome='success';trace.focused=focused;return {opened:true,focused,message:focused?'已打开，并切到本项目专用浏览器。':'已打开，但未能切到前台，请手动切换到本项目专用浏览器。'};
  }finally{this.browserBusy=false;}
  }catch(error){trace.error_code=diagnosticCode(error);throw error;}
  finally{await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
 async extractPdf(filePath,{signal,taskId=null}={}){
  const started=Date.now(),trace={component:'pdf',operation:'pdf.extract',task_id:diagnosticId(taskId),upload_id:typeof filePath==='string'?diagnosticId(path.basename(filePath).replace(/^tool-/,'').replace(/\.pdf$/i,'')):null,phase:'pdf.prepare',outcome:'error'};
  try{
   const pythonPath=path.join(this.root,'runtime','python','python.exe');if(!existsSync(pythonPath)){trace.reason='runtime_missing';throw new Error('包内 PDF 运行时尚未准备，请运行项目发行准备脚本。');}
   try{trace.bytes=(await stat(filePath)).size;}catch{}
   trace.phase='pdf.execute';const pending=this.executeFile(pythonPath,['-I',path.join(this.root,'scripts','extract-pdf.py'),path.resolve(filePath)],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,signal});const closed=pending.child?new Promise(resolve=>pending.child.once('close',resolve)):null;
   let result;try{result=await pending;}finally{if(signal?.aborted&&closed)await closed;}
   trace.exit_code=0;trace.phase='pdf.parse';const output=JSON.parse(result.stdout.trim());trace.pages=Number.isInteger(output.pages)?output.pages:null;trace.text_type=typeof output.text;trace.text_length=typeof output.text==='string'?[...output.text].length:null;
   trace.phase='pdf.text';if(!output.text?.trim()){trace.reason='empty_text';throw new Error('empty');}
   trace.phase='complete';trace.outcome='success';return output.text;
  }catch(error){
   trace.outcome=signal?.aborted?'cancelled':error.killed&&error.code!=='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'timeout':'error';trace.error_code=diagnosticCode(error);if(Number.isInteger(error.code))trace.exit_code=error.code;
   if(/FileNotDecryptedError|WrongPasswordError|PasswordError/.test(error.stderr||''))trace.reason='encrypted';else if(/PdfReadError|PdfStreamError|EmptyFileError/.test(error.stderr||''))trace.reason='invalid_pdf';else if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')trace.reason='output_limit';
   abortCheck(signal);if(trace.phase==='pdf.prepare')throw error;
   throw new Error('无法读取这份 PDF 正文，请重新选择未加密的文字版 PDF；首版不支持扫描件 OCR。');
  }finally{await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>this.getSecrets());}
 }
}
