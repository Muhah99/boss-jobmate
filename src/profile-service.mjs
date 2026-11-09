import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { initialSettings, initialProfile } from './data-store.mjs';
import { isDeepStrictEqual } from 'node:util';
import { buildPrompt, OUTPUT_SCHEMAS, validateOutput } from './agent-prompts.mjs';
import { CALL_CONFIG } from './agent-runtime.mjs';
import {recordDiagnostic,recordIntroductionGeneration,diagnosticId,diagnosticCode} from './diagnostics.mjs';
import {resolveSupplements,learningActive,learningEditReason} from './review-learning.mjs';
import {resolveScope,applyReview,mergeLocal} from './facts-local.mjs';

// Internal manual choice for sequential user trials, with no page mode switch.
const EXPECTATIONS_PAUSE=Symbol('expectations.pause');
export const INITIALIZATION_BACKGROUND_MODE='all'; // 'review': wait for draft; 'all': continue after submission.
export function editingLocks(store,ignoreTaskId=null) {
  const tasks=store.listTasks().filter(t=>t.id!==ignoreTaskId);
  const updating=tasks.some(t=>['profile','initialization','expectations','agent_test','introduction_tool'].includes(t.kind) && ['queued','running','waiting','awaiting_confirmation',...(t.kind==='expectations'?['paused']:[])].includes(t.status));
  const running=tasks.some(t=>['jobs','delivery','verification'].includes(t.kind) && ['queued','running',...(['delivery','verification'].includes(t.kind)?['paused']:[])].includes(t.status));
  const verifying=tasks.some(t=>t.kind==='verification' && ['queued','running'].includes(t.status));
  const unresolved=tasks.some(t=>t.kind==='jobs' && ['queued','running','failed','paused'].includes(t.status));
  const batch=store.listBatches().some(b=>b.status==='reviewing');
  const week=store.getSetting('weekCleanup',{});
  const cleaning=week.due || ['running','waiting','failed'].includes(week.status);
  return {learning:learningActive(store),editing:updating || unresolved || batch || cleaning || running,jobs:updating || running || cleaning,reason:cleaning?'每周清理尚未完成':updating?'资料或初始化正在处理':verifying?'正在核实投递结果':unresolved?'岗位任务尚未完成':running?'正在执行实际投递':batch?'投递前审阅尚未完成':''};
}

export function currentWeek(date=new Date()) {
  const d=new Date(date);d.setHours(0,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7));return d.toISOString();
}
function checkText(value,label,allowEmpty=false) { if (typeof value!=='string' || (!allowEmpty && !value.trim())) throw new Error(`${label}不能为空`);return value; }
export class ProfileService {
  constructor({root,store,agent,external,progress=()=>{},reassess=async()=>[],stopJobs=async()=>{},introductionScope,createRebuilds,runRebuilds,waitForProcessing=async()=>{},hasProcessing=()=>false}) {
    Object.assign(this,{root,store,agent,external,progress,reassess,stopJobs,introductionScope,createRebuilds,runRebuilds,waitForProcessing,hasProcessing});this.running=new Map();this.signals=new Map();
  }
  secrets() { return this.store.getSetting('secrets',{}); }
  secretDraft() { return this.store.getSetting('secretsDraft',{}); }
  secretInput(input,keys) {const draft=this.secretDraft();return Object.fromEntries(keys.map(key=>[key,input[key]?.trim() && !/^[•*]+$/.test(input[key])?input[key]:draft[key] || '']));}
  clearSecretDraft(keys) {const draft=this.secretDraft();for(const key of keys)delete draft[key];this.store.setSetting('secretsDraft',draft);}
  redact(error) {
    let message=error?.message || String(error);
    for (const secret of [...Object.values(this.secrets()),...Object.values(this.secretDraft())]) if (typeof secret==='string' && secret.length) message=message.split(secret).join('[已隐藏]');
    return message.replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').slice(0,500);
  }
  initializationTask() {const state=this.store.getSetting('onboarding'),task=state.facts_task_id?this.store.getTask(state.facts_task_id):null;return !state.complete&&task?.input.initialization_mode&&task.status!=='abandoned'?task:null;}
  initializationStatus() {const state=this.store.getSetting('onboarding'),task=this.initializationTask();return {continuation_ready:!!(task&&(task.input.initialization_mode==='all'||task.result.preparation?.facts_draft)),applying:!!(state.completion_requested&&task&&['queued','running'].includes(task.status)),completion_error:state.completion_error||(state.completion_requested&&task?.status==='failed'?task.error:'')};}
  assertEditable(onboarding=false) { const task=onboarding&&this.initializationStatus().continuation_ready?this.initializationTask():null,locks=editingLocks(this.store,task?.id);if (locks.editing) throw new Error(locks.reason); }
  assertLearningEditable() {if(learningActive(this.store))throw new Error(learningEditReason);}
  assertNoProcessing(allowLearning=false,ignoreTaskId=null) { if (this.store.listTasks().some(t=>t.id!==ignoreTaskId && ['queued','running',...(['expectations','delivery','verification'].includes(t.kind)?['paused']:[])].includes(t.status)&&!(allowLearning&&t.kind==='review_learning'))) throw new Error('已有处理正在执行'); }
  settings() { return {...initialSettings,...this.store.getSetting('settings',{}),map_configured:!!(this.secrets().map_ak && this.secrets().map_sk)}; }
  publicSettings() { const s=this.settings(),secrets=this.secrets(),draft=this.secretDraft();return {...s,deepseek_key_configured:!!secrets.deepseek_key,map_ak_configured:!!secrets.map_ak,map_sk_configured:!!secrets.map_sk,...Object.fromEntries(['deepseek_key','map_ak','map_sk'].map(key=>[`${key}_draft_configured`,!!draft[key]]))}; }
  config(overrides={}) { const s=this.settings();return Object.fromEntries(['provider','cli_path','deepseek_model'].map(key=>[key,overrides[key] ?? s[key]])); }
  saveSecrets(input,keys) {
    const secrets=this.secrets();
    for (const key of keys) if (typeof input[key]==='string' && input[key].trim() && !/^[•*]+$/.test(input[key])) secrets[key]=input[key].trim();
    this.store.setSetting('secrets',secrets);
  }
  saveSettings(input) {
    if(Object.hasOwn(input,'module'))return this.saveSettingsModule(input);
    const referenceKeys=['reference','message_max_chars'];
    if(Object.keys(input).length&&Object.keys(input).every(key=>referenceKeys.includes(key))){
      this.assertLearningEditable();this.assertEditable();
      return this.store.transaction(()=>{
        const next={...this.settings()};
        for(const key of referenceKeys)if(Object.hasOwn(input,key))next[key]=input[key];
        if(!Number.isInteger(next.message_max_chars)||next.message_max_chars<1)throw new Error('首次生成字数上限须为正整数');
        checkText(next.reference,'参考语',true);
        this.store.setSetting('settings',next);
        const draft={...this.store.getSetting('settingsDraft',{})};
        for(const key of referenceKeys)if(Object.hasOwn(input,key))delete draft[key];
        this.store.setSetting('settingsDraft',draft);return this.publicSettings();
      });
    }
    this.assertEditable(true);
    const previous=this.settings(),next={...previous};
    const completed=this.store.getSetting('onboarding').complete;
    for (const key of Object.keys(initialSettings)) if (Object.hasOwn(input,key)&&!(completed&&referenceKeys.includes(key))) next[key]=input[key];
    if (!['cli','deepseek'].includes(next.provider)) throw new Error('请选择有效 Agent');
    if (!['deepseek-flash','deepseek-v4-pro'].includes(next.deepseek_model)) throw new Error('请选择支持的 DeepSeek 模型');
    if (!['off','calculate_only','filter'].includes(next.commute_mode)) throw new Error('请选择有效通勤方式');
    if (!['calculate_only','filter'].includes(next.commute_enabled_mode)) throw new Error('请选择开启后的通勤方式');
    if (!Number.isInteger(next.message_max_chars) || next.message_max_chars < 1) throw new Error('首次生成字数上限须为正整数');
    next.weekly_cleanup=!!next.weekly_cleanup;checkText(next.reference,'参考语',true);checkText(next.cli_path,'CLI路径',true);
    return this.store.transaction(()=>{
      const secretInput=this.secretInput(input,['deepseek_key']);
      if(['provider','cli_path','deepseek_model'].some(key=>next[key]!==previous[key]) || secretInput.deepseek_key?.trim())this.invalidateAgentTest();
      this.saveSecrets(secretInput,['deepseek_key']);
      const secrets=this.secrets();
      if (next.provider==='deepseek' && !secrets.deepseek_key) throw new Error('请填写 DeepSeek API Key');
      if (next.commute_mode!=='off' && !(secrets.map_ak && secrets.map_sk)) throw new Error('请先保存地图 AK/SK');
      if (next.commute_mode!=='off') next.commute_enabled_mode=next.commute_mode;
      if (!previous.weekly_cleanup && next.weekly_cleanup) this.store.setSetting('weekCleanup',{baseline_week:currentWeek(),status:'idle'});
      if(completed){const latest=this.settings();for(const key of referenceKeys)next[key]=latest[key];}
      this.store.setSetting('settings',next);this.clearSecretDraft(['deepseek_key']);const draft=this.store.getSetting('settingsDraft',{});this.store.setSetting('settingsDraft',Object.fromEntries(Object.entries(draft).filter(([key])=>key==='origin_drafts'||completed&&referenceKeys.includes(key))));return this.publicSettings();
    });
  }
  saveMap(input) {
    this.assertEditable(true);
    return this.store.transaction(()=>{
      this.saveSecrets(this.secretInput(input,['map_ak','map_sk']),['map_ak','map_sk']);if (!(this.secrets().map_ak && this.secrets().map_sk)) throw new Error('请填写同一应用的地图 AK/SK');this.clearSecretDraft(['map_ak','map_sk']);return this.publicSettings();
    });
  }
  saveSettingsModule(input) {
    this.assertEditable(true);
    const fields={agent:['provider','cli_path','deepseek_model'],commute:['commute_mode','commute_enabled_mode'],weekly:['weekly_cleanup']}[input.module];
    if(!fields)throw new Error('请选择有效配置模块');
    const secretKeys=input.module==='agent'?['deepseek_key']:input.module==='commute'?['map_ak','map_sk']:[];
    const previous=this.settings(),next={...previous};
    for(const key of fields)if(Object.hasOwn(input,key))next[key]=input[key];
    if(input.module==='agent'){
      if(!['cli','deepseek'].includes(next.provider))throw new Error('请选择有效 Agent');
      if(!['deepseek-flash','deepseek-v4-pro'].includes(next.deepseek_model))throw new Error('请选择支持的 DeepSeek 模型');
      checkText(next.cli_path,'CLI路径',true);
    }
    if(input.module==='commute'){
      if(!['off','calculate_only','filter'].includes(next.commute_mode))throw new Error('请选择有效通勤方式');
      if(!['calculate_only','filter'].includes(next.commute_enabled_mode))throw new Error('请选择开启后的通勤方式');
      if(next.commute_mode!=='off')next.commute_enabled_mode=next.commute_mode;
    }
    if(input.module==='weekly')next.weekly_cleanup=!!next.weekly_cleanup;
    return this.store.transaction(()=>{
      const secretsInput=this.secretInput(input,secretKeys);
      this.saveSecrets(secretsInput,secretKeys);
      const secrets=this.secrets();
      if(input.module==='agent'){
        if(next.provider==='deepseek'&&!secrets.deepseek_key)throw new Error('请填写 DeepSeek API Key');
        if(fields.some(key=>next[key]!==previous[key])||secretsInput.deepseek_key?.trim())this.invalidateAgentTest();
      }
      if(input.module==='commute'&&next.commute_mode!=='off'&&!(secrets.map_ak&&secrets.map_sk))throw new Error('请填写同一应用的地图 AK/SK');
      if(input.module==='weekly'&&!previous.weekly_cleanup&&next.weekly_cleanup)this.store.setSetting('weekCleanup',{baseline_week:currentWeek(),status:'idle'});
      this.store.setSetting('settings',next);
      this.clearSecretDraft(secretKeys);
      const draft={...this.store.getSetting('settingsDraft',{})};
      for(const key of fields)delete draft[key];
      this.store.setSetting('settingsDraft',draft);
      return this.publicSettings();
    });
  }
  saveDraft(type,input) {
    if(type==='settings'&&['reference','message_max_chars'].some(key=>Object.hasOwn(input,key)))this.assertLearningEditable();
    if(type==='profile'||type==='onboarding')this.assertLearningEditable();
    const introductionOnly=type==='profile' && Object.keys(input).every(key=>['introduction','introduction_source'].includes(key));
    if(introductionOnly){if(this.store.listTasks().some(t=>t.kind==='profile' && ['queued','running','waiting','awaiting_confirmation'].includes(t.status)))throw new Error('本次介绍更新处理中，取消等待或确认后再编辑');}
    else this.assertEditable(type==='onboarding');
    const current=type==='onboarding'?this.store.getSetting('onboarding').draft:this.store.getSetting('settingsDraft',{});
    if(input.agent_tested===false || Object.hasOwn(input,'deepseek_key') || ['provider','cli_path','deepseek_model'].some(key=>Object.hasOwn(input,key) && input[key] !== (current[key] ?? this.settings()[key])))this.invalidateAgentTest();
    if(type!=='profile'){const secrets=this.secretDraft();for(const key of ['deepseek_key','map_ak','map_sk'])if(Object.hasOwn(input,key) && typeof input[key]==='string'){if(input[key].trim() && !/^[•*]+$/.test(input[key]))secrets[key]=input[key].trim();else if(!input[key].trim())delete secrets[key];}this.store.setSetting('secretsDraft',secrets);}
    if (type==='onboarding') {
      const state=this.store.getSetting('onboarding'),previous=state.draft;
      if(Number.isInteger(input.step)&&input.step>1)this.assertBossPrepared();
      if(Number.isInteger(input.step)&&input.step>2&&!state.draft.agent_tested)throw new Error('请先完成 Agent 连接测试');
      const sourcesChanged=Object.hasOwn(input,'resume_file') && input.resume_file!==previous.resume_file;
      const introductionChanged=Object.hasOwn(input,'introduction') && input.introduction!==previous.introduction;
      if(sourcesChanged){const task=this.initializationTask();if(task&&['queued','running'].includes(task.status)){this.store.saveTask({...task,status:'abandoned',error:'个人介绍已修改，旧整理结果不再生效'});this.signals.get(task.id)?.abort();}delete state.facts_task_id;}
      if(sourcesChanged||introductionChanged){delete state.completion_requested;delete state.completion_error;}
      if(Number.isInteger(input.step)&&input.step>4&&!state.draft.facts?.length&&!this.initializationStatus().continuation_ready)throw new Error('请先确认个人介绍并完成当前拆解');
      state.draft={...previous,...this.cleanDraft(input)};
      if(sourcesChanged){state.draft.resume_text='';state.step=3;}
      else if(introductionChanged){state.draft.facts=[];state.step=4;}
      if (Number.isInteger(input.step) && !sourcesChanged && !introductionChanged) state.step=Math.max(1,Math.min(6,input.step));
      this.store.setSetting('onboarding',state);return state;
    }
    const key=type==='settings'?'settingsDraft':'profileDraft';const next={...this.store.getSetting(key,{}),...this.cleanDraft(input)};
    if(type==='settings'&&Object.hasOwn(input,'message_max_chars'))next.message_max_chars=input.message_max_chars;
    if(type==='profile' && Object.hasOwn(input,'introduction') && input.introduction===this.store.getProfile().introduction && next.review_supplements?.length){
      // Restoring the saved introduction discards these adopted additions, not their pending review.
      return this.store.transaction(()=>{
        for(const ref of next.review_supplements){
          const task=this.store.getTask(ref.task_id),supplement=task?.result.items?.[ref.job_id]?.supplementary_experiences?.[ref.index];
          if(supplement?.status==='adopted'){supplement.status='pending';this.store.saveTask(task);}
        }
        delete next.review_supplements;
        this.store.setSetting(key,next);return next;
      });
    }
    this.store.setSetting(key,next);return next;
  }
  invalidateAgentTest() {const onb=this.store.getSetting('onboarding');onb.draft.agent_tested=false;this.store.setSetting('onboarding',onb);this.store.setSetting('agentTest',{});}
  assertBossPrepared(){const state=this.store.getSetting('onboarding');if(!state.complete&&(!state.chrome?.installed||!state.draft.boss_prepared||!this.store.listExpectations().length))throw new Error('请先检查 Chrome，并确认 BOSS 资料和求职期望已准备好');}
  cleanDraft(input) { const result={};for(const key of ['resume_file','resume_name','supplement','introduction','introduction_source','introduction_method','conditions','mode','reevaluate','provider','cli_path','deepseek_model','commute_mode','commute_enabled_mode','reference','weekly_cleanup','origin_drafts']) if(Object.hasOwn(input,key))result[key]=input[key];if(result.origin_drafts)result.origin_drafts=Object.fromEntries(Object.entries(result.origin_drafts).filter(([id])=>this.store.getExpectation(id)));return result; }
  filePath(file) { const p=resolve(this.root,'data','uploads',file);const rel=relative(resolve(this.root,'data','uploads'),p);if (!file || rel.startsWith('..') || isAbsolute(rel)) throw new Error('简历文件必须属于本项目');return p; }
  async upload({name,content_base64}) {
    this.assertLearningEditable();
    const started=Date.now(),trace={component:'pdf',operation:'profile.upload',phase:'upload.editability',outcome:'error'};
    try{this.assertEditable();trace.phase='upload.validate';if (!/\.pdf$/i.test(name || '') || typeof content_base64!=='string'){trace.reason='input_type';throw new Error('请选择 PDF 简历');}
    const bytes=Buffer.from(content_base64,'base64');trace.bytes=bytes.length;if (bytes.length>25*1024*1024 || !bytes.subarray(0,1024).toString().includes('%PDF-')){trace.reason=bytes.length>25*1024*1024?'file_too_large':'not_pdf';throw new Error('文件不是可读取的 PDF 或文件过大');}
    const file=`tool-${randomUUID()}.pdf`;trace.upload_id=diagnosticId(file.slice(5,-4));trace.phase='upload.write';await mkdir(resolve(this.root,'data','uploads'),{recursive:true});await writeFile(this.filePath(file),bytes);
    trace.outcome='success';return {file,name:String(name).replace(/[\/\\]/g,'')};
    }catch(error){trace.error_code=diagnosticCode(error);throw error;}finally{await recordDiagnostic(this.root,{...trace,elapsed_ms:Date.now()-started},()=>({...this.secrets(),...this.secretDraft()}));}
  }
  start(kind,input,worker,previous=null) {
    this.assertNoProcessing(kind==='introduction_preview',previous?.id);const task=this.store.saveTask({...previous,kind,status:'queued',stop_requested:false,pause_requested:false,input,result:kind==='expectations'?{...previous?.result,progress:previous?.result?.progress||{type:'browser',stage:'读取 BOSS 求职期望',completed:0,total:3},failure_progress:undefined}:kind==='profile' && input.mode==='introduction'||kind==='initialization'&&input.initialization_mode ? {...previous?.result,failure_progress:undefined,progress:undefined} : {},error:''});
    const controller=new AbortController();this.signals.set(task.id,controller);
    const work=Promise.resolve().then(async()=>{
      try {this.active(task);if(kind==='expectations')task.pause_requested=!!this.store.getTask(task.id)?.pause_requested;task.status='running';this.store.saveTask(task);await worker(task,controller.signal);this.active(task);task.result={...task.result,...this.store.getTask(task.id)?.result};task.status='done';task.error='';this.store.saveTask(task);if(!input.initialization_mode)this.progress({taskId:task.id,type:'background',title:'资料处理',stage:'已保存',status:'done'});if(input.initialization_mode&&this.store.getSetting('onboarding').completion_requested&&this.store.getSetting('onboarding').draft.introduction===task.input.introduction){try{this.complete();}catch(error){const state=this.store.getSetting('onboarding');state.completion_error=this.redact(error);this.store.setSetting('onboarding',state);}}}
      catch(error) {if(kind==='expectations'&&error===EXPECTATIONS_PAUSE){const saved=this.store.getTask(task.id);this.store.saveTask({...saved,status:'paused',pause_requested:false,error:''});this.progress({taskId:task.id,title:'读取求职期望',...saved.result.progress,status:'paused'});return;}if(input.initialization_mode&&(!this.store.getTask(task.id)||this.initializationTask()?.id!==task.id))return;if(this.store.getTask(task.id)?.status==='abandoned')return;task.stop_requested=!!this.store.getTask(task.id)?.stop_requested;task.pause_requested=false;task.status='failed';const stoppedStage={'正在拆解个人介绍':'个人介绍拆解失败：','正在审核个人介绍拆解结果':'个人介绍审核失败：'}[task.result?.stage] || '';task.error=task.stop_requested?stoppedStage+'本次处理已停止，请在原页面手动重试。':this.redact(error);const saved=this.store.getTask(task.id)?.result;const failure_progress=saved?.progress?.stage?saved.progress:saved?.stage?{stage:saved.stage}:null;task.result={...(saved?.updated || kind==='expectations' || kind==='initialization'&&input.initialization_mode || kind==='profile' && input.mode==='introduction' ? saved || {} : kind==='introduction_preview' && saved?.matching ? {matching:saved.matching} : {}),...(failure_progress?{failure_progress}:{})};this.store.saveTask(task);if(!input.initialization_mode)this.progress({taskId:task.id,type:'background',title:'资料处理',...(failure_progress||{}),stage:failure_progress?.stage||'处理未完成',status:'failed',error:task.error});}
    }).finally(()=>{this.running.delete(task.id);this.signals.delete(task.id);const ids=this.store.getTask(task.id)?.result?.rebuild_task_ids;if(ids?.length)void this.runRebuilds(ids);});this.running.set(task.id,work);return task;
  }
  async waitForTask(id) {await this.running.get(id);return this.store.getTask(id);}
  active(task) {const saved=this.store.getTask(task.id);if(['abandoned','cancelled'].includes(saved?.status))throw new Error('本次处理已作废');if(task.input?.facts_baseline&&!saved?.result?.updated){const current=this.store.getProfile();if(!isDeepStrictEqual(task.input.facts_baseline,{introduction:current.introduction,facts:current.facts}))throw new Error('个人介绍或事实基线已变化，旧结果不再生效');}if(task.input?.initialization_mode&&this.initializationTask()?.id!==task.id)throw new Error('个人介绍已修改，旧整理结果不再生效');if(['profile','initialization','introduction_tool'].includes(task.kind))this.assertLearningEditable();const signal=this.signals.get(task.id)?.signal;if(signal?.aborted || saved?.stop_requested)throw new Error('本次处理已停止，请在原页面手动重试。');return signal;}
  stop(id) {const task=this.store.getTask(id);if(!task || !['profile','initialization','expectations','agent_test','introduction_tool','introduction_preview'].includes(task.kind) || !['queued','running'].includes(task.status))throw new Error('当前处理没有正在运行。');task.stop_requested=true;this.store.saveTask(task);this.signals.get(id)?.abort();if(!task.input.initialization_mode)this.progress({taskId:id,type:task.kind==='expectations'?'browser':'background',title:'资料处理',stage:'正在停止',status:task.status});return this.store.getTask(id);}
  phase(task,stage,type='background') {this.active(task);const saved=this.store.getTask(task.id)?.result;task.result={...task.result,...saved,stage,failure_progress:undefined,progress:saved?.stage===stage?saved.progress:{stage}};this.store.saveTask(task);if(!task.input.initialization_mode)this.progress({taskId:task.id,type,title:'资料处理',stage,status:'running'});}
  async call(task,callId,input,{factsDraft=false,generationRecord,outputCorrection,outputAttempt}={}) {
    const signal=this.active(task);this.phase(task,{'introduction.generate':'正在生成个人介绍','jobs.evaluate':'正在匹配个人介绍','introduction.example':'正在生成示例打招呼消息','facts.atomize':'正在拆解个人介绍','facts.review':'正在审核个人介绍拆解结果','facts.scope':'正在确认个人介绍调整范围','facts.local_atomize':'正在拆解个人介绍','facts.local_review':'正在审核个人介绍拆解结果','cases.reassociate':'正在关联历史案例'}[callId]);
    try {
      const response=await this.agent.call({taskId:task.id,callId,input,signal,config:task.input.config || this.config(),...(['jobs.evaluate','introduction.example'].includes(callId)?{outputCorrection,outputAttempt}:{}),...(generationRecord?{generationRecord}:{}),...(factsDraft?{factsDraft:true}:{}),...(task.kind==='initialization'||task.input.target==='onboarding'||task.kind==='introduction_preview'&&!this.store.getSetting('onboarding').complete?{key:this.secretDraft().deepseek_key}:{})});
      this.active(task);
      return ['facts.atomize','facts.review'].includes(callId)?validateOutput(callId,input,response.output,{factsDraft}):response.output;
    } catch(error) {
      if(['facts.atomize','facts.review'].includes(callId)){const prefix=callId==='facts.review'?'个人介绍审核失败：':'个人介绍拆解失败：',detail=this.redact(error);throw new Error(detail.startsWith(prefix)?detail:prefix+detail);}
      throw error;
    }
  }
  generate(input) {
    this.assertLearningEditable();
    this.assertEditable();const onb=this.store.getSetting('onboarding'),target=input.target || (onb.complete?'profile':'onboarding');
    if(input.cancel)return this.cancelGeneration(input);
    if(target==='profile'&&!onb.complete || target==='onboarding'&&onb.complete)throw new Error('资料生成入口与当前初始化状态不符');
    const draft={...(target==='onboarding'?onb.draft:{}),...this.cleanDraft(input)};
    if(!/^tool-[a-f0-9-]+\.pdf$/.test(draft.resume_file||''))throw new Error('请为本次生成重新选择 PDF 简历');
    this.filePath(draft.resume_file);
    return this.start('introduction_tool',{mode:'generate',target,resume_file:draft.resume_file,resume_name:draft.resume_name||'简历.pdf',supplement:draft.supplement||'',config:this.config(target==='onboarding'?onb.draft:{})},async task=>{
      const generationRecord={local_request_id:randomUUID(),task_id:task.id,call_id:'introduction.generate',target,created_at:new Date().toISOString(),resume_text:null,supplement:task.input.supplement,request:null,provider_request_id:null,provider_response_id:null,response_model:null,session_id:null,raw_content:null,output:null,saved_introduction:null,status:'error',failure_stage:null};
      let generationStage='pdf.extract';
      try{
      this.phase(task,'本地读取 PDF');const resume_text=await this.external.extractPdf(this.filePath(task.input.resume_file),{signal:this.active(task),taskId:task.id});generationRecord.resume_text=resume_text;this.active(task);
      if (!resume_text?.trim()) throw new Error('PDF 没有可读正文，请更换文字版 PDF');
      generationStage='model.call';const introduction=await this.call(task,'introduction.generate',{resume_text,supplementary_experience:task.input.supplement},{generationRecord});generationStage='output.check';checkText(introduction,'个人介绍');
      const introduction_source={resume_name:task.input.resume_name,supplement:task.input.supplement};
      this.active(task);
      generationStage='draft.save';
      const completed={...task,status:'done',input:{mode:'generate',target,config:task.input.config},result:{generated:true,introduction,introduction_source}};
      this.store.transaction(()=>{
        if(target==='onboarding'){
          const latest=this.store.getSetting('onboarding');latest.draft={...latest.draft,introduction,introduction_source,resume_file:'',resume_name:'',resume_text:'',supplement:'',facts:[]};latest.step=4;this.store.setSetting('onboarding',latest);
        }else this.store.setSetting('profileDraft',{...this.store.getSetting('profileDraft',{}),introduction,introduction_source});
        this.store.saveTask(completed);
        // Finish the draft writes before releasing its retry input; no async stop can split these steps.
        try{unlinkSync(this.filePath(task.input.resume_file));}catch(error){if(error.code!=='ENOENT')throw error;}
      });
      Object.assign(task,completed);generationRecord.saved_introduction=introduction;generationRecord.status='success';
      }catch(error){generationRecord.failure_stage??=generationStage;generationRecord.error_code=diagnosticCode(error);throw error;}
      finally{await recordIntroductionGeneration(this.root,generationRecord,()=>[...Object.values(this.secrets()),...Object.values(this.secretDraft())]);}
    });
  }
  async releaseUpload(file) {
    if(!/^tool-[a-f0-9-]+\.pdf$/.test(file||''))throw new Error('仅可释放本次生成工具的临时文件');
    await unlink(this.filePath(file)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  async cancelGeneration(input) {
    await this.releaseUpload(input.resume_file);
    for(const task of this.store.listTasks().filter(t=>t.kind==='introduction_tool'&&t.status==='failed'&&t.input.resume_file===input.resume_file))this.store.saveTask({...task,status:'cancelled',input:{mode:'generate',target:task.input.target},result:{},error:''});
    const onb=this.store.getSetting('onboarding');if(onb.draft.resume_file===input.resume_file){onb.draft={...onb.draft,resume_file:'',resume_name:'',resume_text:'',supplement:''};this.store.setSetting('onboarding',onb);}
    return {cancelled:true};
  }
  example(input={},frozenPreview=null,previous=null) {
    this.assertEditable();const state=this.store.getSetting('onboarding'),draft=state.complete?{...this.store.getProfile(),...this.store.getSetting('profileDraft',{})}:state.draft;
    const sample=input.jd_source==='sample' || input.jd==null?this.store.getSetting('introductionTestJobSample'):null;
    if(!frozenPreview && (input.jd_source==='sample' || input.jd==null) && !sample?.jd)throw new Error('尚无首岗样本，请先读取求职期望，或手动输入测试岗位JD');
    const preview=frozenPreview?structuredClone(frozenPreview):{introduction:checkText(input.introduction ?? draft.introduction,'个人介绍'),reference:checkText(input.reference ?? draft.reference ?? this.settings().reference,'模板',true),jd:checkText(sample?.jd ?? input.jd ?? '','测试岗位JD'),...(sample?{sample:structuredClone(sample)}:{})};
    return this.start('introduction_preview',{preview,target:state.complete?'profile':'onboarding',config:previous?.input.config?structuredClone(previous.input.config):this.config(state.complete?{}:state.draft)},async task=>{
      const frozen=task.input.preview;
      const matchInput={introduction:frozen.introduction,jd:frozen.jd,expectation:frozen.sample?.expectation||{title:'',city:''},title:frozen.sample?.title||'',tags:frozen.sample?.tags||[],conditions:'',preview:true};
      // Each preview stage has one correction loop; a successful matching result is reused.
      const stage=async(callId,input)=>{
        let feedback;
        for(let attempt=1;attempt<=6;attempt++){
          try{
            return validateOutput(callId,input,await this.call(task,callId,structuredClone(input),{outputCorrection:feedback,outputAttempt:attempt}));
          }catch(error){
            this.active(task);
            if(!error.outputFailure || attempt===6)throw error;
            feedback=structuredClone(error.outputFailure);
          }
        }
      };
      const matching=previous?.result?.matching || await stage('jobs.evaluate',matchInput);
      task.result={...task.result,matching};this.store.saveTask(task);
      const messageInput={...frozen,matches:matching.matches};
      const message=await stage('introduction.example',messageInput);
      task.result={matching,...message,mappings:message.mappings.map(item=>({...item,match_indices:matching.matches.flatMap((match,index)=>match.introduction_quote===item.introduction_quote?[index]:[])}))};
      this.store.saveTask(task);
    });
  }
  async atomize(task,introduction,oldFacts=[],preparation=null,savePreparation=()=>{}) {
    const input={introduction,previous_facts:oldFacts.map(({fact_id,text})=>({fact_id,text}))};
    const draftKey={input,config:task.input.config,prompt:buildPrompt('facts.atomize',input),schema:OUTPUT_SCHEMAS['facts.atomize'],route:CALL_CONFIG['facts.atomize']};
    let draft;
    if(preparation && isDeepStrictEqual(preparation.facts_draft?.key,draftKey))draft=preparation.facts_draft.output;
    else {
      draft=await this.call(task,'facts.atomize',input,{factsDraft:true});
      if(preparation){preparation.facts_draft={key:draftKey,output:draft};delete preparation.facts;delete preparation.cases;savePreparation();}
    }
    const reviewInput={...input,draft_facts:draft.facts.map((fact,index)=>({...fact,source_index:index+1}))};
    const reviewKey={draft:draftKey,input:reviewInput,config:task.input.config,prompt:buildPrompt('facts.review',reviewInput),schema:OUTPUT_SCHEMAS['facts.review'],route:CALL_CONFIG['facts.review']};
    if(preparation && isDeepStrictEqual(preparation.facts?.key,reviewKey))return preparation.facts.output;
    const output=await this.call(task,'facts.review',reviewInput);
    this.active(task);
    let counter=this.store.getSetting('factCounter',0);const used=new Set();
    const facts=output.facts.map(f=>{
      if (f.previous_fact_id && (used.has(f.previous_fact_id) || !oldFacts.some(old=>old.fact_id===f.previous_fact_id))) throw new Error('拆解编号沿用无效');
      const fact_id=f.previous_fact_id || `F${String(++counter).padStart(4,'0')}`;used.add(fact_id);
      if (!f.text?.trim() || !f.introduction_quote?.trim() || !introduction.includes(f.introduction_quote)) throw new Error('拆解出处不在当前介绍原文中');
      return {fact_id,text:f.text,introduction_quote:f.introduction_quote};
    });
    // Counter allocation may leave gaps after failure, but never reuses a historical identifier.
    if(!facts.length)throw new Error('介绍未拆出有效事实，请在原步骤重试');
    this.store.setSetting('factCounter',counter);
    if(preparation){preparation.facts={key:reviewKey,output:facts,issues:output.issues};delete preparation.cases;savePreparation();}
    return facts;
  }
  async localFacts(task,baseline,preparation,savePreparation) {
    const sample={before:baseline.introduction,after:task.input.introduction,previous_facts:baseline.facts};
    if(sample.before===sample.after)return baseline.facts;
    if(!baseline.facts.length)return this.atomize(task,sample.after,baseline.facts,preparation,savePreparation);
    if(baseline.facts.some(f=>!f.introduction_quote?.trim()||!sample.before.includes(f.introduction_quote)))throw new Error('旧介绍与事实出处基线不一致，请检查原资料');
    const cached=preparation.local||{};
    const run=async(callId,input)=>{
      const key={input,config:task.input.config,prompt:buildPrompt(callId,input),schema:OUTPUT_SCHEMAS[callId],route:CALL_CONFIG[callId]};
      if(isDeepStrictEqual(cached[callId]?.key,key))return cached[callId].output;
      const output=validateOutput(callId,input,await this.call(task,callId,input));this.active(task);
      if(callId==='facts.scope')resolveScope(sample,output);
      cached[callId]={key,output};preparation.local=cached;savePreparation();return output;
    };
    const scope=resolveScope(sample,await run('facts.scope',{sample}));
    if(!scope.changes.length)return mergeLocal(sample,scope,{facts:[],removed_fact_ids:[],unresolved:[]},()=>{throw new Error('空范围不能分配新编号');});
    const draft=await run('facts.local_atomize',{sample,scope});
    const patch=await run('facts.local_review',{sample,scope,draft});
    let reviewed;
    try{reviewed=applyReview(draft,patch);if(reviewed.unresolved.length)throw new Error('局部整理仍有未决项，请检查个人介绍后在原步骤重试');}
    catch(error){delete cached['facts.local_review'];savePreparation();throw error;}
    const key={sample,config:task.input.config,scope,reviewed};
    if(isDeepStrictEqual(preparation.local_result?.key,key))return preparation.local_result.output;
    let counter=this.store.getSetting('factCounter',0);
    const existingIds=new Set(baseline.facts.map(f=>f.fact_id));
    let facts;
    try{facts=mergeLocal(sample,scope,reviewed,()=>{let id;do{id=`F${String(++counter).padStart(4,'0')}`;}while(existingIds.has(id));existingIds.add(id);return id;});}
    catch(error){delete cached['facts.local_review'];savePreparation();throw error;}
    this.active(task);this.store.setSetting('factCounter',counter);preparation.local_result={key,output:facts};savePreparation();return facts;
  }
  confirm({introduction},retry=false) {
    this.assertLearningEditable();checkText(introduction,'个人介绍');let state=this.store.getSetting('onboarding');if(state.complete)throw new Error('初始化已经完成');
    const existing=this.initializationTask();
    this.assertEditable(true);this.assertBossPrepared();if(!state.draft.agent_tested)throw new Error('请先完成 Agent 连接测试');
    if(existing&&existing.input.introduction===introduction&&['queued','running','done',...(!retry?['failed']:[])].includes(existing.status)){
      state.draft.introduction=introduction;
      if(existing.status==='done')state.draft.facts=existing.result.preparation?.facts?.output||state.draft.facts;
      state.step=existing.input.initialization_mode==='all'||existing.result.preparation?.facts_draft?5:4;this.store.setSetting('onboarding',state);return existing;
    }
    const previous=existing?.status==='failed'&&existing.input.introduction===introduction?existing:null;
    const replaced=existing&&existing.input.introduction!==introduction;
    const task=this.store.transaction(()=>{
      if(replaced)this.store.saveTask({...existing,status:'abandoned',error:'个人介绍已重新提交，旧整理结果不再生效'});
      state.draft.introduction=introduction;state.draft.facts=[];delete state.completion_error;
      if(!previous){state.step=INITIALIZATION_BACKGROUND_MODE==='all'?5:4;delete state.completion_requested;}
      const task=this.start('initialization',previous?.input||{config:this.config(state.draft),introduction,initialization_mode:INITIALIZATION_BACKGROUND_MODE},async task=>{
        const preparation=task.result.preparation||{};
        const savePreparation=()=>{task.result={...this.store.getTask(task.id).result,preparation};this.store.saveTask(task);};
        savePreparation();const facts=await this.atomize(task,task.input.introduction,[],preparation,savePreparation);this.active(task);
        const latest=this.store.getSetting('onboarding');if(latest.draft.introduction===task.input.introduction){latest.draft.facts=facts;this.store.setSetting('onboarding',latest);}task.result={...task.result,facts_count:facts.length};
      },previous);
      state.facts_task_id=task.id;this.store.setSetting('onboarding',state);return task;
    });
    if(replaced)this.signals.get(existing.id)?.abort();return task;
  }
  complete({settings={}}={}) {
    this.assertLearningEditable();
    settings=Object.fromEntries(Object.entries(settings).filter(([key])=>Object.hasOwn(initialSettings,key)||['deepseek_key','map_ak','map_sk'].includes(key)));
    this.assertEditable(true);let state=this.store.getSetting('onboarding');
    if (state.complete) return state;
    this.assertBossPrepared();
    if (!state.draft.introduction?.trim() || !this.store.listExpectations().length) throw new Error('请先完成个人介绍拆解和求职期望');
    const drafts=this.store.getSetting('taskDrafts',{});
    for(const expectation of this.store.listExpectations()) {
      const params=drafts[expectation.id] || {};
      if([params.salary_min,params.salary_max].some(value=>value==null || String(value).trim()==='')) throw new Error('请填写每个求职期望的薪资上下限。');
      const min=Number(params.salary_min),max=Number(params.salary_max);
      if(!Number.isFinite(min) || min<0 || !Number.isFinite(max) || max<0 || min>max) throw new Error('求职期望的薪资范围不正确。');
    }
    const task=this.initializationTask();
    if(task&&task.input.introduction!==state.draft.introduction)throw new Error('个人介绍已修改，请返回确认个人介绍并继续填写工作条件。');
    if(task&&task.status!=='done'){
      this.saveDraft('onboarding',settings);state=this.store.getSetting('onboarding');state.completion_requested=true;delete state.completion_error;this.store.setSetting('onboarding',state);return state;
    }
    if(!state.draft.facts?.length||state.draft.facts.some(f=>!f.text?.trim()||!f.introduction_quote?.trim()||!state.draft.introduction.includes(f.introduction_quote)))throw new Error('请先完成个人介绍拆解和求职期望');
    return this.store.transaction(()=>{
      const saved=this.saveSettings({...state.draft,...this.config(state.draft),...(Object.hasOwn(state.draft,'reference')?{reference:state.draft.reference}:{}),...settings});
      if(saved.commute_mode!=='off' && this.store.listExpectations().some(e=>!e.origins?.length)) throw new Error('请为每个求职期望查询并保存至少一个通勤起点。');
      const {introduction,conditions,facts,introduction_source}=state.draft;
      this.store.setProfile({...initialProfile,introduction,conditions:conditions||'',facts,introduction_source:introduction_source||null});state.complete=true;state.step=6;state.draft={};delete state.completion_requested;delete state.completion_error;this.store.setSetting('onboarding',state);return state;
    });
  }
  update(input) {
    if(!(input.mode==='introduction'&&input.cancel))this.assertLearningEditable();
    if(input.mode==='introduction')return this.updateIntroduction(input);
    if(input.mode==='sources')return this.generate({...input,target:'profile'});
    this.assertEditable();if (!this.store.getSetting('onboarding').complete) throw new Error('请先完成初始化');
    if (!['sources','introduction','conditions'].includes(input.mode)) throw new Error('资料操作无效');
    const old=this.store.getProfile(),pending={...this.store.getSetting('profileDraft',{}),...this.cleanDraft(input)};
    const fields=input.mode==='sources'?['resume_file','resume_name','supplement']:[input.mode];
    const draft={mode:input.mode,reevaluate:input.reevaluate};
    for(const field of fields)if(Object.hasOwn(pending,field))draft[field]=pending[field];
    this.store.setSetting('profileDraft',pending);
    return this.start('profile',{...draft,config:this.config()},async task=>{
      const next={...old};let cases=this.store.listCases(),updates=[];
      if (draft.mode==='conditions') {next.conditions=checkText(draft.conditions,'不接受条件',true);if (draft.reevaluate) updates=await this.reassess({profile:next,mode:'conditions',taskId:task.id,signal:this.active(task),config:task.input.config});}
      else {
        if (draft.mode==='sources') {
          next.resume_file=draft.resume_file || old.resume_file;next.resume_name=draft.resume_name || old.resume_name;next.supplement=draft.supplement ?? old.supplement;
          this.phase(task,'本地读取 PDF');next.resume_text=await this.external.extractPdf(this.filePath(next.resume_file),{signal:this.active(task),taskId:task.id});this.active(task);
          next.introduction=await this.call(task,'introduction.generate',{resume_text:next.resume_text,supplementary_experience:next.supplement});
        } else next.introduction=checkText(draft.introduction,'个人介绍');
        const branches=await Promise.allSettled([
          (async()=>{
            next.facts=await this.atomize(task,next.introduction,old.facts);
            const ids=new Set(next.facts.map(f=>f.fact_id));const affected=cases.filter(c=>!c.current_fact_ids?.length || c.current_fact_ids.some(id=>!ids.has(id)));
            if (affected.length) {
              const links=await this.call(task,'cases.reassociate',{facts:next.facts,affected_facts:old.facts,cases:affected.map(c=>({...c,case_id:c.case_id || c.id}))});
              cases=cases.map(c=>{const link=links.case_links.find(l=>l.case_id===(c.case_id || c.id));return link ? {...c,current_fact_ids:link.current_fact_ids,association_reason:link.reason}:c;});
            }
          })(),
          draft.reevaluate?this.reassess({profile:next,mode:'introduction',taskId:task.id,signal:this.active(task),config:task.input.config}).then(updates=>{this.phase(task,task.result.stage);return updates;}):Promise.resolve([])
        ]);
        const failure=branches.find(b=>b.status==='rejected');if (failure) throw failure.reason;updates=branches[1].value;
      }
      this.phase(task,'保存整轮资料');this.store.transaction(()=>{
        this.store.setProfile(next);for(const c of cases)this.store.saveCase(c);for(const job of updates || [])this.store.saveJob(job);
        const remaining=this.store.getSetting('profileDraft',{});
        for(const field of fields)delete remaining[field];
        // A successful source update replaces the introduction, including any unsaved introduction draft.
        if(draft.mode==='sources')delete remaining.introduction;
        delete remaining.mode;delete remaining.reevaluate;this.store.setSetting('profileDraft',remaining);
      });task.result={updated:true};
    });
  }
  introductionRequest() {return this.store.listTasks().find(t=>t.kind==='profile' && t.input?.mode==='introduction' && ['waiting','awaiting_confirmation','queued','running'].includes(t.status));}
  resumeIntroduction() {
    const task=this.introductionRequest();
    if(task?.status==='waiting' && !this.hasProcessing() && !this.store.listTasks().some(t=>t.id!==task.id && ['queued','running'].includes(t.status))){
      task.status='awaiting_confirmation';task.result={...task.result,impact:this.introductionScope(),stage:'请确认更新个人介绍'};return this.store.saveTask(task);
    }
    return task;
  }
  updateIntroduction(input,previous=null) {
    if(!input.cancel)this.assertLearningEditable();
    if(!this.store.getSetting('onboarding').complete)throw new Error('请先完成初始化');
    const existing=this.introductionRequest();
    if(input.cancel){
      if(!existing || existing.id!==input.id || !['waiting','awaiting_confirmation'].includes(existing.status))throw new Error('当前更新不能取消');
      return this.store.saveTask({...existing,status:'cancelled',result:{},error:''});
    }
    if(!input.confirmed){
      if(existing)throw new Error('已有个人介绍更新，请先确认或取消');
      if(this.store.listTasks().some(t=>t.kind==='profile' && ['queued','running'].includes(t.status)))throw new Error('资料正在更新');
      const introduction=checkText(input.introduction,'个人介绍');
      this.store.setSetting('profileDraft',{...this.store.getSetting('profileDraft',{}),introduction});
      const waiting=this.hasProcessing() || this.store.listTasks().some(t=>['queued','running'].includes(t.status));
      const same=previous?.input.introduction===introduction;
      const pending=this.store.getSetting('profileDraft',{}),introduction_source=Object.hasOwn(pending,'introduction_source')?pending.introduction_source:this.store.getProfile().introduction_source||null;
      const baseline=this.store.getProfile();
      const reusable=same&&isDeepStrictEqual(previous.input.facts_baseline,{introduction:baseline.introduction,facts:baseline.facts});
      const task=this.store.saveTask({...previous,kind:'profile',status:waiting?'waiting':'awaiting_confirmation',stop_requested:false,error:'',input:{mode:'introduction',introduction,introduction_source,review_supplements:pending.review_supplements||[],config:same && previous.input.config?previous.input.config:this.config(),facts_baseline:{introduction:baseline.introduction,facts:baseline.facts}},result:{...(reusable?{preparation:previous.result.preparation}:{}),...(waiting?{stage:'等待当前任务结束后更新个人介绍'}:{stage:'请确认更新个人介绍',impact:this.introductionScope()})}});
      if(waiting)queueMicrotask(()=>{void this.waitForProcessing().then(()=>this.resumeIntroduction());});
      return task;
    }
    const task=this.resumeIntroduction();
    if(!task || task.id!==input.id || task.status!=='awaiting_confirmation')throw new Error('请等待当前任务结束并确认更新');
    const impact=this.introductionScope();
    if(JSON.stringify(impact)!==JSON.stringify(task.result.impact))return this.store.saveTask({...task,result:{...task.result,impact,stage:'影响范围已变化，请再次确认'}});
    const old=this.store.getProfile();
    if(!isDeepStrictEqual(task.input.facts_baseline,{introduction:old.introduction,facts:old.facts}))throw new Error('个人介绍或事实基线已变化，请取消后重新提交');
    return this.start('profile',{...task.input,reevaluate:input.reevaluate!==false},async task=>{
      const next={...old,introduction:task.input.introduction,introduction_source:Object.hasOwn(task.input,'introduction_source')?task.input.introduction_source:old.introduction_source||null};
      const preparation=task.result.preparation?.introduction===next.introduction?task.result.preparation:{introduction:next.introduction,jobs:{}};
      const savePreparation=()=>{task.result={...this.store.getTask(task.id).result,preparation};this.store.saveTask(task);};
      savePreparation();
      next.facts=await this.localFacts(task,task.input.facts_baseline,preparation,savePreparation);
      let cases=this.store.listCases();const ids=new Set(next.facts.map(f=>f.fact_id));
      const affected=next.introduction===old.introduction?[]:cases.filter(c=>!c.current_fact_ids?.length || c.current_fact_ids.some(id=>!ids.has(id)));
      const casesInput={facts:next.facts,affected_facts:old.facts,cases:affected.map(c=>({...c,case_id:c.case_id || c.id}))};
      const casesKey={input:casesInput,config:task.input.config,prompt:buildPrompt('cases.reassociate',casesInput),schema:OUTPUT_SCHEMAS['cases.reassociate'],route:CALL_CONFIG['cases.reassociate']};
      let links;
      if(isDeepStrictEqual(preparation.cases?.key,casesKey))links=preparation.cases.output;
      else {
        links=affected.length?await this.call(task,'cases.reassociate',casesInput):{case_links:[]};
        preparation.cases={key:casesKey,output:links};savePreparation();
      }
      cases=cases.map(c=>{const link=links.case_links.find(l=>l.case_id===(c.case_id || c.id));return link?{...c,current_fact_ids:link.current_fact_ids,association_reason:link.reason}:c;});
      const reevaluate=task.input.reevaluate!==false&&next.introduction!==old.introduction;
      let updates=[];
      if(reevaluate){this.phase(task,'正在重新评估岗位');updates=await this.reassess({profile:next,mode:'introduction_rebuild',taskId:task.id,signal:this.active(task),config:task.input.config});}
      this.phase(task,reevaluate?'发布个人介绍并登记重新准备投递':'保存个人介绍');
      this.store.transaction(()=>{
        this.active(task);
        const current=this.store.getProfile();
        if(!isDeepStrictEqual(task.input.facts_baseline,{introduction:current.introduction,facts:current.facts}))throw new Error('个人介绍或事实基线已变化，旧结果不再生效');
        const batches=reevaluate?this.store.listBatches().filter(b=>b.status==='reviewing'):[];
        const rebuilds=reevaluate?this.createRebuilds(batches,next,task.id):[];
        // Failed work still carries the old introduction and must not be resumed after publication.
        for(const prior of this.store.listTasks().filter(t=>reevaluate && t.kind==='jobs' && ['failed','paused'].includes(t.status))){
          prior.status='abandoned';prior.error='个人介绍已更新，旧任务缓存已失效，请发起新任务';
          if(prior.result.screening?.status!=='completed')prior.result.screening={status:'abandoned',cache:{}};
          if(prior.result.batch?.status!=='completed')prior.result.batch={status:'abandoned',job_ids:[],updates:{},messages:{}};
          this.store.saveTask(prior);
        }
        for(const prior of this.store.listTasks().filter(t=>t.kind==='profile' && t.input?.mode==='introduction' && t.status==='failed'))this.store.saveTask({...prior,status:'abandoned',result:{},error:'新个人介绍已生效，旧更新请求已失效'});
        for(const batch of batches){
          for(const pending of this.store.listTasks().filter(t=>t.kind==='review' && t.input?.batch_id===batch.id && !['completed','abandoned'].includes(t.status)))this.store.saveTask({...pending,status:'abandoned',result:{},error:'个人介绍已更新，原投递安排已失效'});
          this.store.deleteBatch(batch.id);
        }
        this.store.setProfile(next);for(const c of cases)this.store.saveCase(c);for(const job of updates)this.store.saveJob(job);
        resolveSupplements(this.store,task.input.review_supplements);
        const draft=this.store.getSetting('profileDraft',{});delete draft.introduction;delete draft.introduction_source;delete draft.review_supplements;this.store.setSetting('profileDraft',draft);
        task.result={updated:true,reevaluated:reevaluate,rebuild_task_ids:rebuilds,impact,...(!reevaluate?{message:'个人介绍已更新，岗位匹配度暂未重新计算'}:{})};this.store.saveTask(task);
      });
    },task);
  }
  retryProfile(id) {
    const task=this.store.getTask(id);if (!task || task.status!=='failed') throw new Error('当前处理不能重试');
    if(task.kind==='expectations')return this.resumeExpectations(id,true);
    if(task.kind!=='introduction_preview')this.assertLearningEditable();
    if(task.input?.mode==='introduction' && task.result?.updated)throw new Error('个人介绍已生效，请在原投递准备任务继续');
    if(task.kind==='introduction_tool')return this.generate(task.input);
    if(task.kind==='introduction_preview')return this.example({},task.input.preview,task);
    if(task.kind==='profile') {
      if(task.input.mode==='introduction')return this.updateIntroduction({mode:'introduction',introduction:this.store.getSetting('profileDraft',{}).introduction ?? task.input.introduction},task);
      const input={...task.input},draft=this.store.getSetting('profileDraft',{});
      const fields=input.mode==='sources'?['resume_file','resume_name','supplement']:[input.mode];
      for(const field of fields)if(Object.hasOwn(draft,field))input[field]=draft[field];
      return this.update(input);
    }
    if(task.kind==='initialization') {
      if(task.input.example)return this.example();
      const draft=this.store.getSetting('onboarding').draft;
      return task.input.introduction && !task.input.resume_file ? this.confirm(draft,true):this.generate(draft);
    }
    throw new Error('请在原步骤重新发起');
  }
  expectationCheckpoint(task) {
    this.active(task);
    if(this.store.getTask(task.id)?.pause_requested)throw EXPECTATIONS_PAUSE;
  }
  pauseExpectations(id) {
    const task=this.store.getTask(id);
    if(task?.kind!=='expectations'||!['queued','running'].includes(task.status))throw new Error('当前读取任务不能暂停。');
    this.store.saveTask({...task,pause_requested:true});
    this.progress({taskId:id,title:'读取求职期望',...task.result.progress,status:'pausing'});
    return this.store.getTask(id);
  }
  resumeExpectations(id,retry=false) {
    const task=this.store.getTask(id);
    if(task?.kind!=='expectations'||task.status!==(retry?'failed':'paused'))throw new Error('当前读取任务不能继续。');
    const locks=editingLocks(this.store,id);if(locks.editing)throw new Error(locks.reason);
    return this.start('expectations',task.input,t=>this.runExpectations(t),task);
  }
  abandonExpectations(id,{confirmed}={}) {
    const task=this.store.getTask(id);
    if(confirmed!==true)throw new Error('请先确认放弃本次读取。');
    if(task?.kind!=='expectations'||!['failed','paused'].includes(task.status))throw new Error('请先暂停读取，再放弃本次任务。');
    const saved=this.store.saveTask({...task,status:'abandoned',pause_requested:false,error:''});
    this.progress({taskId:id,title:'读取求职期望',status:'abandoned'});return saved;
  }
  readExpectations({prepared=false,target}={}) {
    this.assertEditable();const before=this.store.getSetting('onboarding');
    if(!before.complete&&(!before.chrome?.installed||!prepared))throw new Error('请先检查 Chrome，并确认 BOSS 资料已准备好');
    return this.start('expectations',{target:target||(!before.complete?'onboarding':'config')},task=>this.runExpectations(task));
  }
  async runExpectations(task) {
    const save=(changes={})=>{const saved=this.store.getTask(task.id);task.result={...saved.result,...changes};this.store.saveTask({...saved,result:task.result});};
    const show=(stage,completed)=>{save({stage,progress:{type:'browser',stage,completed,total:3}});this.progress({taskId:task.id,title:'读取求职期望',...task.result.progress,status:this.store.getTask(task.id)?.pause_requested?'pausing':'running'});};
    this.expectationCheckpoint(task);
    if(!task.result.expectations){
      show('读取 BOSS 求职期望',0);
      const items=await this.external.readExpectations({signal:this.active(task),taskId:task.id});this.active(task);
      if(!items?.length)throw new Error('尚未读取到求职期望，请在 BOSS 完善后重试');
      const expectations=this.store.refreshExpectations(items),state=this.store.getSetting('onboarding');
      if(!state.complete){state.draft.boss_prepared=true;this.store.setSetting('onboarding',state);}
      save({expectations});show('读取 BOSS 求职期望',1);
    }
    this.expectationCheckpoint(task);
    const expectations=task.result.expectations;
    if(!task.result.sample){
      show('读取首个岗位样本',1);
      try{
        const captured=await this.external.readFirstJobSample({expectation:expectations[0],signal:this.active(task),taskId:task.id});this.active(task);
        if(!captured.sample?.job_id || !captured.sample?.jd?.trim())throw new Error('首个岗位没有可用JD，未更新样本');
        const sample={...captured.sample,expectation:{id:expectations[0].id,source_id:expectations[0].source_id,title:expectations[0].title,city:expectations[0].city}};
        try{this.store.setSetting('introductionTestJobSample',sample);}catch(error){throw new Error('岗位测试样本未能保存：'+this.redact(error));}
        save({sample:{status:'saved',value:sample},sample_window:captured.window,browser_close:{status:'pending'}});
      }catch(error){this.active(task);save({sample:{status:'failed',error:this.redact(error)}});}
      show('读取首个岗位样本',2);
    }
    this.expectationCheckpoint(task);
    if(task.result.browser_close?.status==='pending'){
      show('关闭样本窗口',2);
      try{await this.external.closeSampleWindow({window:task.result.sample_window,signal:this.active(task),taskId:task.id});this.active(task);save({browser_close:{status:'closed'}});}
      catch(error){this.active(task);save({browser_close:{status:'failed',error:this.redact(error)}});}
    }
    show('读取完成',3);this.expectationCheckpoint(task);
  }
  async searchPlaces({expectation_id,query,credentials_dirty}) {
    this.assertEditable(true);const e=this.store.getExpectation(expectation_id);if(!e)throw new Error('求职期望不存在');
    if(credentials_dirty || this.secretDraft().map_ak || this.secretDraft().map_sk)throw new Error('地图凭据已修改，请先保存地图配置');if(!this.settings().map_configured)throw new Error('请先保存地图 AK/SK');checkText(query,'地点关键词');
    const places=await this.external.searchPlaces({city:e.city,query}),key=`mapPlaces:${e.id}`;
    if(!this.store.getExpectation(e.id))throw new Error('求职期望不存在');
    // Other origins may still hold a selected candidate from an earlier lookup.
    const retained=this.store.getSetting(key,[]).filter(p=>!places.some(next=>p.address===next.address && p.lng===next.lng && p.lat===next.lat && p.coordinateType===next.coordinateType));
    this.store.setSetting(key,[...retained,...places]);return places;
  }
  saveOrigin(expectationId,origin) {
    this.assertEditable(true);const e=this.store.getExpectation(expectationId);if(!e)throw new Error('求职期望不存在');
    const old=e.origins.find(o=>o.id===origin.id);
    if(origin.id!=null && !old)throw new Error('通勤起点不存在或不属于当前求职期望。');
    if(old && old.address===origin.address && old.lng===origin.lng && old.lat===origin.lat) {old.name=checkText(origin.name,'起点名称');return this.store.saveExpectation(e);}
    const candidate=this.store.getSetting(`mapPlaces:${e.id}`,[]).find(p=>p.address===origin.address && p.lng===origin.lng && p.lat===origin.lat && p.coordinateType===origin.coordinateType);
    if(!candidate)throw new Error('请查询并明确选择地点，修改地址后需重新选择');
    const next={...candidate,id:old?.id || randomUUID(),name:origin.name || candidate.name};e.origins=e.origins.filter(o=>o.id!==next.id).concat(next);return this.store.saveExpectation(e);
  }
  deleteOrigin(eid,oid) {this.assertEditable(true);const e=this.store.getExpectation(eid);if(!e)throw new Error('求职期望不存在');e.origins=e.origins.filter(o=>o.id!==oid);return this.store.saveExpectation(e);}
  checkWeek() {
    const state=this.store.getSetting('weekCleanup',{status:'idle'});state.due=!!(this.settings().weekly_cleanup && state.baseline_week && currentWeek()>state.baseline_week && state.completed_week!==currentWeek());this.store.setSetting('weekCleanup',state);return state;
  }
  async cleanup({confirmed}) {
    if (!confirmed) throw new Error('请确认每周清理');let state=this.store.getSetting('weekCleanup',{status:'idle'});if(!state.due && state.status!=='failed')return state;
    if (['waiting','running'].includes(state.status)) return state;
    let diagnosticPhase='week.wait';state.status='waiting';this.store.setSetting('weekCleanup',state);
    try {
      await Promise.all([...this.running.values()]);state.status='running';this.store.setSetting('weekCleanup',state);diagnosticPhase='week.stop_jobs';await this.stopJobs();
      diagnosticPhase='week.transaction';state=this.store.transaction(()=>{
        for(const task of this.store.listTasks().filter(t=>t.kind==='jobs' && !['done','completed','abandoned'].includes(t.status)))this.store.deleteTask(task.id);
        const protectedIds=new Set(this.store.listBatches().flatMap(b=>(b.jobs || []).map(j=>j.job_id)));
        for(const job of this.store.listJobs())if(!protectedIds.has(job.id) && currentWeek(new Date(job.collected_at || job.created_at))<currentWeek())this.store.deleteJob(job.id);
        return this.store.setSetting('weekCleanup',{...state,status:'idle',completed_week:currentWeek(),error:'',due:false});
      });
    } catch(error) {await recordDiagnostic(this.root,{component:'database',operation:'week.cleanup',phase:diagnosticPhase,outcome:'error',error_code:diagnosticCode(error)},()=>this.store.getSetting('secrets',{}));state.status='failed';state.error=this.redact(error);this.store.setSetting('weekCleanup',state);}
    return state;
  }
}
