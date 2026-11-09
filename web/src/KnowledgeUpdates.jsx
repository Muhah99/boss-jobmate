import {useEffect,useRef,useState} from 'react';
import {BookOpen,ChevronDown,ChevronUp,ArrowRight,Info} from 'lucide-react';
import {labelBatch,labelExpectation,statusLabel} from './api.js';
import {Dialog,LoadingIcon,Note} from './Ui.jsx';
import './knowledge-records.css';
const completed=task=>task.status==='completed';
const ongoing=task=>['queued','running'].includes(task.status);
const records=state=>state.tasks.filter(task=>task.kind==='review_learning').slice().sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
function BatchInfo({task,state}){
 const batch=state.batches.find(b=>String(b.id)===String(task.input?.batch_id)),expectation=state.expectations.find(e=>String(e.id)===String(task.expectation_id));
 return <><strong>{labelBatch(batch,state.batches)}</strong><span>{labelExpectation(expectation)}</span></>;
}
function KnowledgeRow({task,state,action,busy,pendingAction,history=false}){
 const [stopConfirm,setStopConfirm]=useState(false),[working,setWorking]=useState(false),[requestError,setRequestError]=useState(''),submitting=useRef(false);
 const inProgress=ongoing(task),done=completed(task),retryPath=`/api/workflow-tasks/${task.id}/retry`,stopPath=`/api/workflow-tasks/${task.id}/stop`;
 const stage=[task.result?.stage,task.error,!stopConfirm&&requestError].filter(Boolean).join(' · ')||(done?'知识更新已完成':'本轮尚未完成，已处理项保留');
 const disabled=busy||working;
 useEffect(()=>setRequestError(''),[task.status]);
 async function submit(path){
  if(submitting.current||busy)return;
  submitting.current=true;setWorking(true);setRequestError('');
  try{const result=await action(path,{},'POST',{localError:true});if(result?.error)setRequestError(result.error);else if(result?.task&&path===stopPath)setStopConfirm(false);}
  catch(error){setRequestError(error.message);}
  finally{submitting.current=false;setWorking(false);}
 }
 return <><article tabIndex={-1} data-knowledge-task-id={task.id} className={`kh-row ${history?'history':''}`}><div className="kh-row-content"><div className="kh-row-primary"><span className={`kh-status ${done?'completed':task.status==='running'?'running':task.status==='queued'?'queued':'unfinished'}`}>{statusLabel(task.status)}</span><BatchInfo task={task} state={state}/></div><p className="kh-row-secondary" title={stage}><span>{stage}</span><small>{task.result?.completed??0} / {task.result?.total??0} 岗</small></p></div><div className="kh-row-actions">{task.status==='failed'&&<button className="text-button kh-action kh-continue" disabled={disabled} onClick={()=>submit(retryPath)}>{(working||pendingAction?.path===retryPath)&&<LoadingIcon size={14}/>}继续处理</button>}{inProgress&&<button className="text-button kh-action kh-stop" disabled={disabled||task.stop_requested} onClick={()=>{setRequestError('');setStopConfirm(true);}}>{task.stop_requested?'正在停止…':'停止'}</button>}</div></article>{stopConfirm&&<Dialog className="kh-stop-dialog" title="停止本次知识更新？" onClose={disabled?undefined:()=>setStopConfirm(false)} footer={<><button className="secondary-button" disabled={disabled} autoFocus onClick={()=>setStopConfirm(false)}>取消</button><button className="text-button kh-action kh-stop" disabled={disabled} onClick={()=>submit(stopPath)}>{working||pendingAction?.path===stopPath?'正在停止…':'停止'}</button></>}><p className="kh-stop-context"><BatchInfo task={task} state={state}/></p><p>已处理进度会保留，之后可继续处理。</p>{requestError&&<Note kind="error">{requestError}</Note>}</Dialog>}</>;
}
export function ActiveKnowledgeUpdates({state,action,navigate,busy,pendingAction,focusTaskId}){
 const section=useRef(null);
 const list=records(state).filter(task=>!completed(task)),pending=(state.supplements||[]).filter(s=>['pending','adopted'].includes(s.status));
 useEffect(()=>{if(!focusTaskId)return;const frame=requestAnimationFrame(()=>{const row=[...(section.current?.querySelectorAll('[data-knowledge-task-id]')||[])].find(e=>e.dataset.knowledgeTaskId===String(focusTaskId));if(row){row.scrollIntoView({block:'center'});row.focus({preventScroll:true});}});return()=>cancelAnimationFrame(frame);},[focusTaskId,list.some(t=>String(t.id)===String(focusTaskId))]);
 if(!list.length&&!pending.length)return null;
 return <section ref={section} className="settings-card kh-active" aria-label="进行中与未完成的知识更新">{!!list.length&&<><header className="kh-block-header"><div><BookOpen size={17}/><h2>知识更新</h2><small>进行中 {list.filter(ongoing).length} · 未完成 {list.filter(task=>!ongoing(task)).length}</small></div><button className="text-button" onClick={()=>navigate('profile',{history:true})}>全部记录<ArrowRight size={14}/></button></header><div className="kh-rows">{list.map(task=><KnowledgeRow key={task.id} {...{task,state,action,busy,pendingAction}}/>)}</div></>}{!!pending.length&&<div className="kh-pending"><Info size={15}/><span>有 {pending.length} 项补充经历尚未确认生效</span><button className="text-button" onClick={()=>navigate('profile')}>前往个人资料<ArrowRight size={14}/></button></div>}</section>;
}
export function KnowledgeUpdateHistory({state,action,busy,pendingAction,focusHistory=false,focusTaskId=null}){
 const [expanded,setExpanded]=useState(focusHistory),section=useRef(null),list=records(state);
 useEffect(()=>{if(!focusHistory)return;setExpanded(true);const frame=requestAnimationFrame(()=>{const row=[...(section.current?.querySelectorAll('[data-knowledge-task-id]')||[])].find(e=>e.dataset.knowledgeTaskId===String(focusTaskId));const target=row||section.current;target?.scrollIntoView({block:row?'center':'start'});target?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[focusHistory,focusTaskId]);
 const stats={total:list.length,completed:list.filter(completed).length,ongoing:list.filter(ongoing).length,unfinished:list.filter(task=>!completed(task)&&!ongoing(task)).length};
 return <section ref={section} tabIndex={-1} className="settings-card kh-history" id="knowledge-update-history" aria-label="知识更新记录"><button className="kh-history-toggle" aria-expanded={expanded} aria-controls="knowledge-history-records" onClick={()=>setExpanded(!expanded)}><span className="kh-history-title"><BookOpen size={18}/><strong>知识更新记录</strong></span><span className="kh-history-stats">共 {stats.total} 次<span>已完成 <b>{stats.completed}</b></span><span>进行中 <b>{stats.ongoing}</b></span><span>未完成 <b>{stats.unfinished}</b></span></span><span className="kh-fold-label">{expanded?'收起':'展开'}{expanded?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</span></button>{expanded&&<div id="knowledge-history-records"><div className="kh-history-list" tabIndex={0} role="region" aria-label="知识更新历史列表">{list.length?list.map(task=><KnowledgeRow key={task.id} task={task} state={state} action={action} busy={busy} pendingAction={pendingAction} history/>):<p className="kh-empty">暂无知识更新记录</p>}</div></div>}</section>;
}
