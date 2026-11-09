import {useEffect,useRef,useState} from 'react';
import {ExternalLink,Inbox,Play} from 'lucide-react';
import {Dialog,ExpectationSelect} from './Ui.jsx';
import {chars,labelExpectation,failureProgress} from './api.js';
import WorkflowProgress from './WorkflowProgress.jsx';
import './delivery-progress-adopted.css';
const final=new Set(['message_sent','already_contacted','job_closed','headhunter_skipped','not_delivering']);
const uncertain=i=>['chat_send_outcome_unknown','sent_message_not_visible','greeting_outcome_unknown'].includes(i.last_error)||i.delivery_status==='uncertain';
const sendable=i=>!uncertain(i)&&!i.delivery_inflight&&['prepared','greeting_sent','chat_located'].includes(i.delivery_status);
const key=i=>`${i.batch_id}:${i.job_id}`;
const stepLabels={idle:'未开始',running:'进行中',done:'已完成',error:'异常'};
export function deliveryItemView(item,owner,job=item.job||{}){
 const status=item.delivery_status,unknown=uncertain(item),greetingUnknown=item.last_error==='greeting_outcome_unknown';
 const closed=status==='job_closed'||job.closed===true;
 const messageDone=status==='message_sent'&&!unknown;
 const exclusion=messageDone?'':status==='headhunter_skipped'||job.is_headhunter?'猎头岗位，已退出可执行范围':status==='already_contacted'||job.contacted||job.already_contacted||job.applied?'历史已联系岗位，已退出可执行范围':status==='not_delivering'?'本岗位不投递，已退出可执行范围':'';
 const greetingDone=!greetingUnknown&&(['greeting_sent','chat_located','message_sent'].includes(status)||!!(item.greeting_result?.greeting_sent&&(item.greeting_result.confirmation_visible||item.greeting_result.confirmed)));
 const main=closed?'closed':messageDone?'completed':greetingDone?'waiting':'pending';
 const ownError=!closed&&(!!item.last_error||unknown),exception=!closed&&(ownError||!!exclusion||!final.has(status)&&owner?.status==='failed');
 const greeting=greetingDone?'done':item.delivery_inflight==='greeting'?'running':ownError?'error':'idle';
 const message=messageDone?'done':item.delivery_inflight==='message'?'running':greetingDone&&ownError?'error':'idle';
 const reason=exclusion||(unknown?'结果尚未确认，原防重复保护保留，不会重新发送。':item.last_error||(!final.has(status)&&owner?.status==='failed'?owner.error||'原任务未完成，本岗位已完成步骤保持。':''));
 return {main,greeting,message,exception,reason,excluded:closed||!!exclusion,unknown};
}
export function TodayPage({header,state,expectationId,setExpectationId,action,navigate,busy,hudContext}){
 const [confirm,setConfirm]=useState(null),[filter,setFilter]=useState('all'),[exception,setException]=useState(null);
 useEffect(()=>{setFilter('all');setConfirm(null);setException(null);},[expectationId]);
 const batches=state.batches.filter(b=>String(b.expectation_id)===String(expectationId)&&['submitted','completed'].includes(b.status));
 const scoped=batches.flatMap(b=>b.jobs.filter(i=>i.choice==='deliver').map(i=>({...i,batch_id:b.id,batch:b})));
 function refsFor(task){return task.input?.scope||state.batches.find(b=>b.id===task.input?.batch_id)?.jobs.map(i=>({batch_id:task.input.batch_id,job_id:i.job_id}))||[];}
 function itemsFor(refs){return refs.flatMap(ref=>{const b=state.batches.find(b=>b.id===ref.batch_id),i=b?.jobs.find(i=>i.job_id===ref.job_id);return i?[{...i,batch_id:b.id,batch:b}]:[];});}
 const activeTasks=state.tasks.filter(t=>t.kind==='delivery'&&['queued','running','paused','failed'].includes(t.status));
 const ownerFor=i=>activeTasks.find(t=>refsFor(t).some(r=>key(r)===key(i)));
 const jobFor=i=>i.job||state.jobs.find(j=>j.id===i.job_id)||{};
 const viewFor=i=>deliveryItemView(i,ownerFor(i),jobFor(i));
 const executable=i=>sendable(i)&&!final.has(i.delivery_status)&&!viewFor(i).excluded;
 const groups={all:scoped,...Object.fromEntries(['pending','waiting','completed','closed'].map(id=>[id,scoped.filter(i=>viewFor(i).main===id)])),error:scoped.filter(i=>viewFor(i).exception)};
 const rows=groups[filter],eligible=rows.filter(i=>executable(i)&&!ownerFor(i));
 const runningTask=state.tasks.find(t=>['delivery','verification'].includes(t.kind)&&['queued','running'].includes(t.status));
 const locked=!!state.locks.jobs||!!runningTask||!!state.browserBusy;
 // Existing execution locks and frozen-scope greeting uncertainty remain in force.
 const continuationLocked=task=>!!state.browserBusy||!!state.locks.learning||!!state.reset?.running||!!state.weekCleanup?.due||['running','waiting','failed'].includes(state.weekCleanup?.status)||state.tasks.some(t=>t.id!==task?.id&&['queued','running','paused','waiting','awaiting_confirmation'].includes(t.status));
 const taskMatches=t=>String(t.expectation_id)===String(expectationId)||!t.expectation_id&&itemsFor(refsFor(t)).some(i=>String(i.batch.expectation_id)===String(expectationId));
 const occupyingTask=[...activeTasks].reverse().find(taskMatches)||activeTasks.at(-1);
 const deliveryTask=occupyingTask||[...state.tasks].reverse().find(t=>t.kind==='delivery'&&taskMatches(t));
 const taskItems=deliveryTask?itemsFor(refsFor(deliveryTask)):[],pending=taskItems.filter(i=>!final.has(i.delivery_status)),ready=pending.filter(executable),greetingUnknown=pending.some(i=>i.last_error==='greeting_outcome_unknown');
 const completed=taskItems.filter(i=>viewFor(i).main==='completed').length,excluded=taskItems.filter(i=>viewFor(i).excluded).length;
 const expectationLabel=labelExpectation(state.expectations.find(e=>String(e.id)===String(expectationId)));
 const taskExpectation=deliveryTask&&state.expectations.find(e=>String(e.id)===String(deliveryTask.expectation_id||taskItems[0]?.batch.expectation_id));
 const taskExpectationLabel=taskExpectation?labelExpectation(taskExpectation):'所属求职期望未记录';
 const taskScopeNote=deliveryTask&&!taskMatches(deliveryTask)?`当前下方列表为 ${expectationLabel}；本进度及暂停、继续、重试、放弃仅针对上述占用任务的原确认范围，不作用于当前列表。`:'本进度及操作仅针对本任务的原确认范围。';
 const describe=i=>{const j=jobFor(i);return {title:j.title||'岗位',company:j.company||''};};
 const buttonLabel=occupyingTask?(occupyingTask.pause_requested&&['queued','running'].includes(occupyingTask.status)?'投递暂停中':({queued:'等待投递',running:'投递进行中',paused:'任务已暂停',failed:'任务已暂停'}[occupyingTask.status])):`投递当前列表（${eligible.length}个）`;
 const continuationHint=greetingUnknown?'原确认范围存在发起沟通结果未确认，暂不可继续；防重复保护保留。':!ready.length?'原确认范围暂无可继续的岗位，请查看异常说明或岗位关闭状态。':state.locks.learning?'知识更新期间原恢复操作锁保持，当前不能继续。':'';
 function askStart(){setConfirm({retry:false,expectation:expectationLabel,expectation_id:expectationId,scope:eligible.map(i=>({batch_id:i.batch_id,job_id:i.job_id})),jobs:eligible.map(describe),count:eligible.length});}
 function askRetry(task,operation='retry'){
  const pending=itemsFor(refsFor(task)).filter(i=>!final.has(i.delivery_status)),ready=pending.filter(executable);
  if(!ready.length||pending.some(i=>i.last_error==='greeting_outcome_unknown')){setException({item:pending.find(uncertain)||pending[0],task,reason:'原确认范围仍有结果未确认或无可继续岗位；保留原记录，不会重复发送。'});return;}
  setConfirm({retry:true,operation,id:task.id,expectation:labelExpectation(state.expectations.find(e=>String(e.id)===String(task.expectation_id))),jobs:ready.map(describe),count:ready.length});
 }
 async function start(){const input=confirm;setConfirm(null);await action(input.retry?`/api/workflow-tasks/${input.id}/${input.operation||'retry'}`:'/api/applications/deliver',input.retry?{confirmed:true}:{confirmed:true,expectation_id:input.expectation_id,scope:input.scope});}
 const located=useRef(null);
 useEffect(()=>{
  if(!hudContext?.locate||located.current===hudContext.task_id)return;
  const task=state.tasks.find(t=>t.id===hudContext.task_id);if(!task||task.kind!=='delivery'||!['failed','paused'].includes(task.status))return;located.current=task.id;
  askRetry(task,task.status==='paused'?'resume':'retry');
 },[hudContext]);
 const mainLabels={pending:'待投递',waiting:'待发消息',completed:'已完成',closed:'岗位关闭'};
 const Step=({status})=><span className={`delivery-step ${status}`}>{status==='done'?'✓ ':status==='running'?'◌ ':status==='error'?'! ':''}{stepLabels[status]}</span>;
 return <main className="page-shell today-page jobmate-delivery-page delivery-adopted">
  {header}<div className="today-batch-actions delivery-list-controls"><ExpectationSelect expectations={state.expectations} value={expectationId} onChange={setExpectationId}/><button className="primary-button" disabled={busy||locked||!!occupyingTask||!eligible.length} onClick={askStart}><Play size={16}/>{buttonLabel}</button></div>
  <div className="today-content">
   {deliveryTask&&<WorkflowProgress key={deliveryTask.id} task={deliveryTask} title={`岗位投递 · ${taskExpectationLabel}`} busy={busy} locked={continuationLocked(deliveryTask)} action={action} onContinue={askRetry} summary={`本任务 ${taskItems.length} 个岗位 · 两步完成 ${completed} 个 · 排除 ${excluded} 个 · 可继续 ${greetingUnknown?0:ready.length} 个。${taskScopeNote}`} continueDisabled={greetingUnknown||!ready.length} continueLabel={`${deliveryTask.status==='paused'?'继续任务':'重试未完成岗位'}（${greetingUnknown?0:ready.length}个）`} continueHint={continuationHint} abandonNotice abandonMessage="已完成步骤、已审消息和未完成岗位保留，结果未确认保护不会重置。"/>}
   <section className="jobmate-delivery-table" aria-label="岗位列表"><header><strong>岗位列表 <span>{rows.length}</span></strong><div>{[['all','全部'],...Object.entries(mainLabels),['error','投递异常']].map(([id,label])=><button className={`secondary-button ${filter===id?'active':''}`} aria-pressed={filter===id} key={id} onClick={()=>setFilter(id)}>{label} <span>{groups[id].length}</span></button>)}</div></header>
    {rows.length?<><div className="delivery-adopted-row table-head"><span>岗位</span><span>二次沟通内容</span><span>主线进度</span><span>发起沟通</span><span>二次消息发送</span><span>查看</span></div>{rows.map(item=>{
     const j=jobFor(item),view=viewFor(item);
     return <div className="delivery-adopted-row" key={key(item)}><div><strong>{j.title}</strong><small>{[j.company,j.city].filter(Boolean).join(' · ')}</small><small>{j.salary} · 已审阅</small></div><div className="delivery-message"><p>{item.message||'暂无消息'}</p><small>已确认 · 首条招呼后发送 · {chars(item.message||'')} 字符</small></div><div><span className={`delivery-main ${view.main}`}>{mainLabels[view.main]}</span></div><div><Step status={view.greeting}/></div><div><Step status={view.message}/></div><div className="delivery-view-actions">{(j.detail_url||j.url||j.boss_url)&&<button className="setup-text-button" disabled={locked||busy} title="使用本项目专用浏览器打开" onClick={()=>action(`/api/jobs/${item.job_id}/open`,{})}><ExternalLink size={13}/>查看 BOSS 岗位</button>}{view.exception&&<button className="setup-text-button" onClick={()=>setException({item,task:ownerFor(item),reason:view.reason})}>查看异常说明</button>}</div></div>;
    })}</>:<div className="empty-state"><Inbox size={34}/><h2>{scoped.length?'当前筛选下没有岗位':'当前没有待投递岗位'}</h2><p>{scoped.length?'可切换其他状态查看岗位和历史结果。':'完成投递前审阅并成功提交后，可投递岗位会出现在这里。'}</p><button className="secondary-button" onClick={()=>navigate('review')}>前往投递前审阅</button></div>}
   </section>
  </div>
  {confirm&&<Dialog title={confirm.retry?'确认继续投递':'确认实际投递'} onClose={()=>setConfirm(null)} footer={<><button className="secondary-button" onClick={()=>setConfirm(null)}>取消</button><button className="primary-button" disabled={busy||(confirm.retry?continuationLocked(state.tasks.find(t=>t.id===confirm.id)):locked||!!occupyingTask)} onClick={start}>{confirm.retry?'确认继续投递':'确认发起实际投递'}</button></>}><p>求职期望：{confirm.expectation}</p><p>{confirm.count} 个可执行岗位</p><ul className="r23-scope">{confirm.jobs.map((j,i)=><li key={i}>{j.title} · {j.company}</li>)}</ul><p>{confirm.retry?'仅继续此前确认范围内未完成且可发送的岗位；成功、结果未确认、排除项、其他范围及后来新增岗位不会混入。':'只处理上述已确认列表；后续切换筛选或新增审阅结果不会加入本次投递。已确认首条招呼的岗位仅继续消息步骤。'}</p><p>将使用本项目专用浏览器串行操作，请完成BOSS登录或安全验证；执行期间请勿操作浏览器。</p></Dialog>}
  {exception&&<Dialog title="投递异常说明" onClose={()=>setException(null)} footer={<button className="secondary-button" onClick={()=>setException(null)}>关闭</button>}><p>{exception.item?`${describe(exception.item).title} · ${describe(exception.item).company}`:'当前投递任务'}</p><p>此处仅展示原异常和排除事实，可反馈开发者；关闭说明不改变记录或防重复保护。</p><pre className="delivery-error-detail">{[exception.reason,exception.item?.last_error,exception.task?.error,failureProgress(exception.task)].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join('\n')||'暂无更多异常详情。'}</pre></Dialog>}
 </main>;
}
