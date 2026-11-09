import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const now=()=>new Date().toISOString();
export const learningActive=store=>store.listTasks().some(t=>t.kind==='review_learning'&&['queued','running'].includes(t.status));
export const learningEditReason='审阅知识正在更新，完成后可修改个人资料。';
export const learningStartNotice='有知识更新或补充经历尚未确认生效。本次将使用当前已生效的个人资料和知识，继续发起任务吗？';
export const pendingSupplements=store=>store.listTasks().filter(t=>t.kind==='review_learning'&&t.status==='completed').flatMap(t=>Object.entries(t.result.items||{}).flatMap(([job_id,item])=>(item.supplementary_experiences||[]).flatMap((s,index)=>['pending','adopted'].includes(s.status)?[{...s,task_id:t.id,batch_id:t.input.batch_id,job_id,index,title:item.title}]:[])));

// Batch knowledge uses the same persisted tasks and manual continuation as review work.
export function createReviewLearning({store,agent,progress,runners}) {
 const signals=new Map();
 let confirming=false;
 function create(batch){
  if(batch.learning_task_id)return;
  const changed=batch.jobs.filter(j=>j.choice==='deliver'&&j.review?.original&&j.message!==j.review.original.original_message);
  if(!changed.length){batch.learning={status:'unchanged',message:'本次审阅没有有效的消息修改，无需新增审阅知识。'};return;}
  const task=store.saveTask({kind:'review_learning',status:'queued',expectation_id:batch.expectation_id,input:{batch_id:batch.id,config:{...store.getSetting('settings',{}),deepseek_model:'deepseek-flash'},items:changed.map(j=>({job_id:j.job_id,title:j.job?.title||'',boss_id:j.job?.boss_id,input:{...j.review.original,edited_message:j.message}}))},result:{stage:'等待更新审阅知识',items:{},completed:0,total:changed.length}});
  batch.learning_task_id=task.id;
  return task.id;
 }
 function schedule(id){queueMicrotask(()=>void run(id));}
 function run(id){
  if(store.getTask(id)?.status==='completed')return Promise.resolve(store.getTask(id));
  if(runners.has(id))return runners.get(id);
  const work=execute(id).finally(()=>{runners.delete(id);signals.delete(id);});runners.set(id,work);return work;
 }
 async function execute(id){
  const controller=new AbortController();signals.set(id,controller);
  const active=()=>{if(controller.signal.aborted||store.getTask(id)?.stop_requested)throw new Error('审阅知识更新已停止，请手动继续。');};
  try{
   let task=store.getTask(id);store.saveTask({...task,status:'running',error:'',updated_at:now()});
   for(const entry of task.input.items){
    active();task=store.getTask(id);if(task.result.items[entry.job_id])continue;
    task.result.stage='分析已保存消息';store.saveTask(task);
    progress?.update?.({taskId:id,name:'审阅知识更新',type:'background',stage:task.result.stage,status:'running',completed:task.result.completed,total:task.result.total});
    const input=entry.input;
    const missing=typeof input.original_message!=='string'||!input.full_jd||!Array.isArray(input.original_mappings)||!input.introduction||!Array.isArray(input.facts)||!input.facts.length;
    const response=missing?null:await agent.call({callId:'messages.correct',taskId:id,jobId:entry.job_id,input,config:task.input.config,signal:controller.signal});active();
    store.transaction(()=>{
     task=store.getTask(id);
     const output=response?.output||{mismatch_cases:[],omission_cases:[],supplementary_experiences:[]};
     task.result.items[entry.job_id]={...output,title:entry.title,...(missing?{unavailable:'原消息材料不完整，此项无法分析。'}:{}),supplementary_experiences:output.supplementary_experiences.map(s=>({...s,status:'pending'})),metadata:response?.metadata};
     task.result.completed=Object.keys(task.result.items).length;store.saveTask(task);
    });
   }
   active();store.transaction(()=>{
    task=store.getTask(id);
    const publishedJobs=new Set(store.listCases().filter(c=>c.learning_task_id===id).map(c=>c.job_id));
    for(const entry of task.input.items){
     if(publishedJobs.has(entry.job_id))continue;
     const input=entry.input,output=task.result.items[entry.job_id];
     for(const [field,type]of [['mismatch_cases','mismatch'],['omission_cases','omission']])for(const c of output[field]){
      const fact=input.facts.find(f=>f.fact_id===c.fact_id);
      const currentFacts=store.getProfile().facts||[],currentFact=fact&&(currentFacts.find(f=>f.fact_id===fact.fact_id&&f.text===fact.text)||currentFacts.find(f=>f.text===fact.text));
      store.saveCase({...c,id:randomUUID(),type,job_id:entry.job_id,boss_id:entry.boss_id,batch_id:task.input.batch_id,learning_task_id:id,fact:fact||null,current_fact_ids:currentFact?[currentFact.fact_id]:[],jd:input.full_jd,jd_keywords:c.jd_quote?[c.jd_quote]:[],applicability_hint:c.applicable_scope,message_quotes:[c.before_quote||c.after_quote].filter(Boolean),source:input,created_at:now()});
     }
    }
    store.saveTask({...task,status:'completed',result:{...task.result,stage:'审阅知识更新完成'},updated_at:now()});
   });progress?.finish?.({taskId:id,status:'completed'});
  }catch(error){const task=store.getTask(id);store.saveTask({...task,status:'failed',error:error.message,updated_at:now()});progress?.finish?.({taskId:id,status:'failed',error:error.message});}
  return store.getTask(id);
 }
 function retry(id){const task=store.getTask(id);if(task?.kind!=='review_learning'||task.status!=='failed')throw new Error('当前知识任务不能继续。');store.saveTask({...task,status:'queued',error:'',stop_requested:false});schedule(id);return store.getTask(id);}
 function stop(id){const task=store.getTask(id);if(task?.kind!=='review_learning'||!['queued','running'].includes(task.status))throw new Error('当前知识任务没有运行。');store.saveTask({...task,stop_requested:true});signals.get(id)?.abort();return store.getTask(id);}
 async function confirm({items}){
  if(confirming)throw new Error('补充经历正在整合，请等待本次结果。');
  if(learningActive(store))throw new Error(learningEditReason);
  if(!Array.isArray(items)||!items.length)throw new Error('请选择补充经历处理方式。');
  if(store.listTasks().some(t=>['profile','initialization','introduction_tool'].includes(t.kind)&&['queued','running','waiting','awaiting_confirmation'].includes(t.status)))throw new Error('请先完成或取消当前个人介绍更新。');
  const draft=store.getSetting('profileDraft',{}),formal=store.getProfile(),tasks=new Map(),changes=[],added=[],seen=new Set();
  for(const choice of items){
   const key=JSON.stringify([choice.task_id,choice.job_id,choice.index]);if(seen.has(key))continue;seen.add(key);
   const task=tasks.get(choice.task_id)||store.getTask(choice.task_id),supplement=task?.kind==='review_learning'&&task.result.items?.[choice.job_id]?.supplementary_experiences?.[choice.index];
   if(!supplement||task.status!=='completed')throw new Error('补充经历尚未完成或不存在。');
   tasks.set(task.id,task);if(supplement.status!=='pending')continue;
   if(!['adopt','discard'].includes(choice.action))throw new Error('请选择采纳或不采纳。');
   if(choice.action==='adopt'&&(typeof choice.content!=='string'||!choice.content.trim()))throw new Error('采纳内容不能为空。');
   const change={task_id:choice.task_id,job_id:choice.job_id,index:choice.index,action:choice.action,...(choice.action==='adopt'?{content:choice.content.trim()}:{})};
   changes.push(change);if(change.action==='adopt')added.push(change);
  }
  confirming=true;
  try{
   const response=added.length?await agent.call({callId:'introduction.merge',input:{introduction:draft.introduction??formal.introduction??'',supplementary_experiences:added.map(s=>s.content)},config:store.getSetting('settings',{})}):null;
   const segments=response?.output.segments;
   return store.transaction(()=>{
    if(!isDeepStrictEqual(store.getSetting('profileDraft',{}),draft)||!isDeepStrictEqual(store.getProfile(),formal)||[...tasks].some(([id,task])=>!isDeepStrictEqual(store.getTask(id),task)))throw new Error('个人介绍或补充内容已变化，本次未写入，请重新核对后确认。');
    for(const change of changes){const task=tasks.get(change.task_id),s=task.result.items[change.job_id].supplementary_experiences[change.index];s.status=change.action==='discard'?'discarded':'adopted';if(change.action==='adopt')s.confirmed_content=change.content;}
    for(const task of tasks.values())store.saveTask(task);
    if(added.length)store.setSetting('profileDraft',{...draft,introduction:segments.map(s=>s.text).join(''),review_supplements:[...(draft.review_supplements||[]),...added]});
    return {added:added.length,pending:pendingSupplements(store),...(segments?{segments}:{})};
   });
  }finally{confirming=false;}
 }

 return {create,schedule,run,retry,stop,confirm,get confirming(){return confirming;}};
}

export function resolveSupplements(store,refs){
 for(const ref of refs||[]){const task=store.getTask(ref.task_id),s=task?.result.items?.[ref.job_id]?.supplementary_experiences?.[ref.index];if(s?.status==='adopted'){s.status='resolved';store.saveTask(task);}}
}
