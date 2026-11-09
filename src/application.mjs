import { JobmateStore } from './data-store.mjs';
import { hudTaskState } from './hud-actions.mjs';
import { ProfileService, editingLocks } from './profile-service.mjs';
import { createJobWorkflows } from './job-workflows.mjs';
import { createReviewWorkflows } from './review-workflows.mjs';
import { resolve } from 'node:path';
import { resetInstallation } from './reset-data.mjs';
import {profileTaskText,profileErrorText} from './profile-display.mjs';
import {pendingSupplements,learningActive,learningEditReason,learningStartNotice} from './review-learning.mjs';

export const operations=['tasks.window','tasks.progress','state','settings.reset','settings.save','settings.map','settings.draft','agent.detect','agent.test','agent.pick_program','browser.detect','browser.download','browser.open_profile','browser.init_guide','profile.upload','profile.generate','profile.preview','profile.draft','profile.update','onboarding.draft','onboarding.generate','onboarding.confirm','onboarding.example','onboarding.complete','expectations.read','expectations.delete','map.search','origins.save','origins.delete','tasks.draft','tasks.start','tasks.retry','tasks.stop','tasks.pause','tasks.resume','tasks.abandon','jobs.list','jobs.open','batches.list','batches.get','batches.void','review.choice','review.begin','review.remove','review.save','review.supplements','review.submit','delivery.start','delivery.retry','delivery.stop','delivery.verify','week.check','week.confirm'];
const publicProfile=p=>{const {resume_text,...publicValue}=p || {};return publicValue;};
const publicTask=t=>profileTaskText(t.kind==='review_learning'&&t.status!=='completed'?{...t,result:{...t.result,items:{}}}:t);
export function createApplication({root,store=new JobmateStore(resolve(root,'data','boss-jobmate.db')),agent,external,progress={}}) {
  store.recoverInterrupted();
  let resetRunning=false,activeOperations=0,resetError='',initBrowserOpened=false;
  let browserDetection=null,browserCheck=null;
  function detectBrowserForInstance(){
    if(browserDetection)return browserDetection;
    browserCheck={status:'checking',installed:false,source:browserCheck?.source||null};
    browserDetection=Promise.resolve().then(()=>external.detectChrome()).then(chrome=>{
      browserCheck=chrome;
      const onboarding=store.getSetting('onboarding');onboarding.chrome=chrome;store.setSetting('onboarding',onboarding);
      return chrome;
    }).catch(error=>{browserCheck={status:'error',installed:false,source:null};throw error;}).finally(()=>{browserDetection=null;});
    return browserDetection;
  }
  const initGuideAvailable=()=>{const init=store.getSetting('onboarding');return initBrowserOpened&&!init.complete&&(init.step||1)===1;};
  const jobs=createJobWorkflows({store,agent,external,progress});
  const review=createReviewWorkflows({store,agent,external,progress});
  const profile=new ProfileService({root,store,agent,external,progress:s=>progress.update?.(s),reassess:jobs.reassess,introductionScope:jobs.introductionScope,createRebuilds:jobs.createRebuilds,runRebuilds:jobs.runRebuilds,hasProcessing:()=>profile.running.size>0 || jobs.runners.size>0 || review.runners.size>0,waitForProcessing:()=>Promise.allSettled([...profile.running.values(),...jobs.runners.values(),...review.runners.values()]),stopJobs:async()=>{for(const t of store.listTasks().filter(t=>t.kind==='jobs' && ['queued','running'].includes(t.status)))jobs.stop(t.id);await Promise.all([...jobs.runners.values()]);}});
  const associatedJobs=(expectationId)=>{
    const batches=store.listBatches(),tasks=store.listTasks(),levels=new Map([['high',0],['medium',1],['low',2]]);
    // Stable sort retains the store's created_at/rowid order within each level.
    return store.listJobs(expectationId).sort((a,b)=>(levels.get(a.match_level)??3)-(levels.get(b.match_level)??3))
      .map(job=>({...job,batch_id:batches.find(b=>b.jobs.some(j=>j.job_id===job.id))?.id || null,cached_batch_id:tasks.find(t=>t.kind==='jobs' && !['completed','abandoned'].includes(t.status) && t.result?.batch?.job_ids?.includes(job.id))?.result.batch.id || null}));
  };
  profile.resumeIntroduction();
  const readOnly=new Set(['state','tasks.progress','jobs.list','batches.list','batches.get']);
  function hasActiveWork(){return activeOperations>0 || profile.running.size>0 || jobs.runners.size>0 || review.runners.size>0 || agent.inflight>0 || agent.queue?.length>0 || external.browserBusy || store.listTasks().some(t=>['queued','running','paused','waiting','awaiting_confirmation'].includes(t.status)) || ['waiting','running'].includes(store.getSetting('weekCleanup',{}).status);}
  function resetStatus(){return {running:resetRunning,blocked:!!(resetRunning || hasActiveWork()),reason:resetRunning?'正在清理数据，请勿关闭软件':hasActiveWork()?'当前有任务正在执行，请结束后再清理':'',error:resetError};}
  function state() {
    profile.resumeIntroduction();
    const onboarding=store.getSetting('onboarding');
    return {supplements:pendingSupplements(store),browserCheck:browserCheck||{status:'unknown',installed:false,source:null},browserBusy:!!external.browserBusy,profile:publicProfile(store.getProfile()),profileDraft:store.getSetting('profileDraft',{}),settings:profile.publicSettings(),settingsDraft:store.getSetting('settingsDraft',{}),agentTest:{...store.getSetting('agentTest',{}),error:profileErrorText(store.getSetting('agentTest',{}).error)},expectations:store.listExpectations(),introductionTestJobSample:store.getSetting('introductionTestJobSample'),tasks:store.listTasks().map(t=>publicTask({id:t.id,kind:t.kind,status:t.status,stop_requested:!!t.stop_requested,pause_requested:!!t.pause_requested,expectation_id:t.expectation_id,input:{params:t.input?.params,batch_id:t.input?.batch_id,job_id:t.input?.job_id,mode:t.input?.mode,reevaluate:t.input?.reevaluate,scope:t.input?.scope,rebuild_parent:t.input?.rebuild_parent,replaces_batch_id:t.input?.replaces_batch_id,preview:t.input?.preview,target:t.input?.target,tool:t.kind==='introduction_tool'?{resume_file:t.input.resume_file,resume_name:t.input.resume_name,supplement:t.input.supplement}:undefined},result:t.result,error:t.error,created_at:t.created_at,updated_at:t.updated_at,progress_window:progress.visibility?.(t.id)})),batches:store.listBatches().map(b=>review.view(b.id)),jobs:associatedJobs(),locks:resetRunning?{editing:true,jobs:true,reason:'正在清理数据，请勿关闭软件'}:review.learning.confirming?{editing:true,jobs:true,learning:true,reason:'补充经历正在整合，请等待本次结果。'}:editingLocks(store),reset:resetStatus(),onboarding:{...onboarding,init_guide_available:initGuideAvailable(),...profile.initializationStatus(),draft:publicProfile(onboarding.draft)},weekCleanup:store.getSetting('weekCleanup',{status:'idle'}),taskDrafts:store.getSetting('taskDrafts',{})};
  }
  function assertJobAction(ignoreTaskId=null) {if(review.learning.confirming)throw new Error('补充经历正在整合，请等待本次结果。');if(editingLocks(store,ignoreTaskId).jobs)throw new Error(editingLocks(store,ignoreTaskId).reason || '已有岗位任务正在执行');if(!store.getSetting('onboarding').complete)throw new Error('请先完成初始化');}
  async function execute(operation,input={}) {
    if(operation==='settings.reset'){
      if(resetRunning)throw new Error('正在清理数据，请勿重复提交');
      if(input.confirmed!==true)throw new Error('请明确确认清理所有数据');
      if(hasActiveWork())throw new Error('当前有任务正在执行，请结束后再清理');
      resetRunning=true;resetError='';
      let cleared=false;
      try{return await resetInstallation({root,store,external,progress,onCleared:()=>{cleared=true;resetRunning=false;initBrowserOpened=false;browserCheck=null;}});}
      catch(error){resetError='清理未完成，请处理后重试。可能已有部分数据被清理。'+profile.redact(error);throw new Error(resetError);}
      finally{if(!cleared)resetRunning=false;}
    }
    if(resetRunning && !readOnly.has(operation))throw new Error('正在清理数据，请勿关闭软件');
    if(learningActive(store)&&((operation.startsWith('profile.')&&operation!=='profile.preview'&&!(operation==='profile.update'&&input.cancel===true))||operation.startsWith('onboarding.')))throw new Error(learningEditReason);
    if(review.learning.confirming&&(operation.startsWith('profile.')||operation.startsWith('onboarding.')||operation==='review.supplements'))throw new Error('补充经历正在整合，请等待本次结果。');
    if(!readOnly.has(operation))activeOperations++;
    try{
    const week=store.getSetting('weekCleanup',{});
    if((week.due || ['waiting','running','failed'].includes(week.status)) && !['state','tasks.progress','tasks.window','jobs.list','batches.list','batches.get','browser.detect','browser.download','browser.init_guide','week.check','week.confirm','tasks.stop','delivery.stop'].includes(operation))throw new Error('请先确认并完成每周清理');
    switch(operation) {
      case 'state':return state();
      case 'tasks.progress':{
        const task=store.getTask(input.id);
        if(!task||task.kind==='review_learning')throw new Error('原任务已不存在，请返回原页面处理');
        return {progress:{...hudTaskState(store,task),window_hidden:!!progress.visibility?.(task.id)?.hidden},task:{id:task.id,kind:task.kind,status:task.status,pause_requested:!!task.pause_requested,updated_at:task.updated_at}};
      }
      case 'tasks.window':{
        const task=store.getTask(input.id);
        if(!task||!['jobs','expectations','delivery','verification'].includes(task.kind)||!['queued','running','paused','failed'].includes(task.status)||typeof input.hidden!=='boolean'||!progress.setVisibility)throw new Error('当前任务没有可切换的进度窗口。');
        return {window:await progress.setVisibility(task.id,input.hidden)};
      }
      case 'settings.save':return {settings:profile.saveSettings(input),...(Object.keys(input).length&&Object.keys(input).every(key=>['reference','message_max_chars'].includes(key))?{message:'招呼参考语已保存。'}:{})};
      case 'settings.map':return {settings:profile.saveMap(input)};
      case 'settings.draft':return {draft:profile.saveDraft('settings',input)};
      case 'profile.draft':return {draft:profile.saveDraft('profile',input)};
      case 'onboarding.draft':{
        const onboarding=profile.saveDraft('onboarding',input);
        if((onboarding.step||1)!==1)await progress.initGuide?.(true);
        return {onboarding};
      }
      case 'agent.detect':{
        profile.assertEditable();
        const config={...profile.config(),...input},result=await agent.detect(config),tested=store.getSetting('agentTest',{});
        const sameConfig=tested.config?.provider===config.provider && tested.config?.cli_path===(config.cli_path || '') && tested.config?.deepseek_model===config.deepseek_model;
        if(result.provider==='cli' && tested.status==='done' && sameConfig && (!result.installed || !result.supported || !result.logged_in))profile.invalidateAgentTest();
        return result;
      }
      case 'agent.pick_program':profile.assertEditable();return {path:await external.pickProgram()};
      case 'agent.test':{
        profile.assertEditable();
        const config={...profile.config(),...Object.fromEntries(['provider','cli_path','deepseek_model'].filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]))};
        const testKey=input.deepseek_key || profile.secretDraft().deepseek_key || profile.secrets().deepseek_key;
        profile.invalidateAgentTest();
        store.setSetting('agentTest',{status:'running'});
        return {task:profile.start('agent_test',{config},async (task,signal)=>{
          profile.phase(task,'测试所选 Agent');try {const result=await agent.test(config,{key:testKey,signal,taskId:task.id});profile.active(task);store.setSetting('agentTest',{status:'done',config,result});const onb=store.getSetting('onboarding');onb.draft.agent_tested=true;store.setSetting('onboarding',onb);task.result=result;}
          catch(error){store.setSetting('agentTest',{status:'failed',error:profile.redact(error)});throw error;}
        })};
      }
      case 'browser.detect':{
        return {chrome:await detectBrowserForInstance()};
      }
      case 'browser.download':return await external.openChromeDownload();
      case 'browser.open_profile':{
        profile.assertEditable();profile.assertNoProcessing();
        const result=await external.openProfile();
        if(result.opened&&input.target==='onboarding'&&!store.getSetting('onboarding').complete&&(store.getSetting('onboarding').step||1)===1){
          initBrowserOpened=true;
          if(await progress.initGuide?.(false)===false)throw new Error('专用浏览器已打开，但登录引导未能显示；请通过原页面继续或手动显示登录引导。');
          if(!browserCheck)await detectBrowserForInstance();
        }
        return result;
      }
      case 'browser.init_guide':{
        if(typeof input.hidden!=='boolean')throw new Error('请指定登录引导显示状态');
        if(!input.hidden){
          if(!initGuideAvailable())throw new Error('请先在初始化第一步打开专用浏览器');
          profile.assertEditable();profile.assertNoProcessing();
        }
        if(await progress.initGuide?.(input.hidden)===false)throw new Error('登录引导未能显示或隐藏，请稍后手动重试');
        if(!input.hidden&&!browserCheck)await detectBrowserForInstance();
        return {guide:{available:initGuideAvailable(),hidden:input.hidden}};
      }
      case 'profile.upload':return await profile.upload(input);
      case 'profile.update':return {task:profile.update(input)};
      case 'profile.generate':return {task:await profile.generate({...input,target:store.getSetting('onboarding').complete?'profile':'onboarding'})};
      case 'profile.preview':return {task:profile.example(input)};
      case 'onboarding.generate':return {task:await profile.generate({...input,target:'onboarding'})};
      case 'onboarding.example':return {task:profile.example(input)};
      case 'onboarding.confirm':return {task:profile.confirm(input)};
      case 'onboarding.complete':{
        const onboarding=profile.complete(input);await progress.initGuide?.(true);return {onboarding};
      }
      case 'expectations.read':{
        if(input.source==='init-guide'&&(!initGuideAvailable()||input.target!=='onboarding'))throw new Error('当前初始化登录引导已失效，请返回原页面核对');
        if(input.target==='onboarding'&&!store.getSetting('onboarding').complete){
          const chrome=browserDetection?await browserDetection:browserCheck||await detectBrowserForInstance();
          if(chrome?.status!=='ready'||!chrome.installed)throw new Error('浏览器尚未就绪，请在原页面重新检测后再读取求职期望');
          if(input.source==='init-guide'&&!initGuideAvailable())throw new Error('当前初始化登录引导已失效，请返回原页面核对');
        }
        return {task:profile.readExpectations(input)};
      }
      case 'expectations.delete':profile.assertEditable();if(!input.confirmed)throw new Error('请明确确认删除全部关联历史');store.deleteExpectation(input.id);return {};
      case 'map.search':return {places:await profile.searchPlaces(input)};
      case 'origins.save':return {expectation:profile.saveOrigin(input.expectation_id,input.origin)};
      case 'origins.delete':return {expectation:profile.deleteOrigin(input.expectation_id,input.origin_id)};
      case 'tasks.draft':{
        if(!store.getExpectation(input.expectation_id))throw new Error('求职期望不存在');
        const drafts=store.getSetting('taskDrafts',{});drafts[input.expectation_id]=input.params;store.setSetting('taskDrafts',drafts);return {draft:input.params};
      }
      case 'tasks.start':{
        assertJobAction();
        if(store.listTasks().some(t=>t.kind==='jobs'&&['failed','paused'].includes(t.status)&&String(t.expectation_id)===String(input.expectation_id)))throw new Error('请先重试或放弃当前求职期望的未完成任务。');
        if((store.listTasks().some(t=>t.kind==='review_learning'&&t.status!=='completed')||pendingSupplements(store).length)&&input.knowledge_update_confirmed!==true)return {confirmation:{kind:'review_learning',message:learningStartNotice}};
        const {knowledge_update_confirmed,...params}=input;return {task:jobs.start(params)};
      }
      case 'tasks.retry':{
        const task=store.getTask(input.id);if(task?.kind==='delivery'){assertJobAction(input.id);return {task:review.retryDelivery(input.id,input)};}if(task?.kind==='verification'){assertJobAction(input.id);return {task:review.retryVerification(input.id,input)};}if(['profile','initialization','introduction_tool','introduction_preview','expectations'].includes(task?.kind))return {task:profile.retryProfile(input.id)};
        if(task?.kind==='review_learning')return {task:review.learning.retry(input.id)};
        assertJobAction();return {task:jobs.retry(input.id)};
      }
      case 'tasks.pause':{
        const task=store.getTask(input.id);
        if(task?.kind==='expectations')return {task:profile.pauseExpectations(input.id)};
        if(task?.kind==='delivery')return {task:review.pauseDelivery(input.id)};
        if(task?.kind==='verification')return {task:review.pauseVerification(input.id)};
        return {task:jobs.pause(input.id)};
      }
      case 'tasks.resume':{
        const task=store.getTask(input.id);
        if(task?.kind==='expectations')return {task:profile.resumeExpectations(input.id)};
        assertJobAction(input.id);
        if(task?.kind==='delivery')return {task:review.resumeDelivery(input.id,input)};
        if(task?.kind==='verification')return {task:review.resumeVerification(input.id,input)};
        return {task:jobs.resume(input.id)};
      }
      case 'tasks.abandon':{
        const task=store.getTask(input.id);
        if(task?.kind==='review'||!task&&store.listBatches().some(b=>b.jobs.some(i=>i.review?.pending?.id===input.id)))return review.discardLegacyReview(input.id,input);
        if(input.confirmed!==true)throw new Error('请先确认放弃本次任务。');
        if(task?.kind==='expectations')return {task:profile.abandonExpectations(input.id,input)};
        if(task?.kind==='delivery')return {task:review.abandonDelivery(input.id,input)};
        if(task?.kind==='verification')return {task:review.abandonVerification(input.id,input)};
        return {task:jobs.abandon(input.id)};
      }
      case 'tasks.stop':{
        const task=store.getTask(input.id);
        if(task?.kind==='review_learning')return {task:review.learning.stop(input.id)};
        if(task?.status==='failed' && ['jobs','profile','initialization','expectations','agent_test','verification','introduction_tool','introduction_preview'].includes(task.kind))return {task};
        if(['profile','initialization','expectations','agent_test','introduction_tool','introduction_preview'].includes(task?.kind))return {task:profile.stop(input.id)};
        if(task?.kind==='verification')return {task:review.stopVerification(input.id)};
        if(task?.kind==='delivery')return {task:review.stopDelivery(input.id)};
        return {task:jobs.stop(input.id)};
      }
      case 'jobs.list':{
        const records=associatedJobs(input.expectation_id);
        const delivered=new Set(store.listBatches(input.expectation_id).flatMap(b=>(b.jobs || []).filter(j=>j.delivery_status==='message_sent').map(j=>j.job_id)));
        return {jobs:records.filter(j=>!input.pool || input.pool==='all' || input.pool==='selected' && j.verdict==='selected' || input.pool==='eliminated' && j.verdict==='eliminated' || input.pool==='delivered' && delivered.has(j.id))};
      }
      case 'jobs.open':{
        const job=store.getJob(input.id);if(!job)throw new Error('岗位不存在');return await external.openJob(job);
      }
      case 'batches.list':return {batches:store.listBatches(input.expectation_id).map(b=>review.view(b.id,input.expectation_id))};
      case 'batches.get':return {batch:review.view(input.id,input.expectation_id)};
      case 'review.choice':return {batch:review.choose(input.batch_id,input.job_id,input.choice,input.existing_progress)};
      case 'review.remove':return {batch:review.removeJob(input.batch_id,input.job_id,input)};
      case 'review.begin':return {batch:review.beginEdit(input.batch_id,input.job_id)};
      case 'review.save':return {batch:review.saveMessage(input.batch_id,input.job_id,input.message),message:'消息已保存，提交本次审阅后更新审阅知识。'};
      case 'review.supplements':return await review.learning.confirm(input);
      case 'review.submit':return {batch:review.submit(input.batch_id,input)};
      case 'batches.void':return {batch:review.voidBatch(input.batch_id,input)};
      case 'delivery.start':assertJobAction();return {task:review.deliver(input.batch_id,input)};
      case 'delivery.retry':assertJobAction(input.id);return {task:review.retryDelivery(input.id,input)};
      case 'delivery.stop':{
        const task=store.getTask(input.id);
        if(task?.kind==='delivery' && task.status==='failed')return {task};
        return {task:review.stopDelivery(input.id)};
      }
      case 'delivery.verify':assertJobAction();return {result:await review.verifyDelivery(input.batch_id,input.job_id,input)};
      case 'week.check':return {weekCleanup:profile.checkWeek()};
      case 'week.confirm':return {weekCleanup:await profile.cleanup(input)};
      default:throw new Error('未知业务操作');
    }
    }finally{if(!readOnly.has(operation))activeOperations--;}
  }
  return {store,profile,jobs,review,state,execute:async(...args)=>{const result=await execute(...args);return result.task?{...result,task:publicTask(result.task)}:result;},redact:error=>profileErrorText(profile.redact(error)),close:()=>{progress.close?.();store.close();}};
}
