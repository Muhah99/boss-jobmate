import {useState} from 'react';
import {Check,Info} from 'lucide-react';
import {LoadingIcon,FailureProgress} from './Ui.jsx';
import {failureProgress} from './api.js';
import './inline-progress.css';

export default function InlineProgress({task,title,action,onRetry,retryHint,success,children,blocked=false,idleMessage,pending=false,readyAction,hideRetry=false}) {
 const [submitting,setSubmitting]=useState(false),[error,setError]=useState('');
 if(!task&&!idleMessage&&!pending||['cancelled','abandoned'].includes(task?.status))return null;
 const running=pending||['queued','running'].includes(task?.status),stopping=running&&task?.stop_requested,failed=!running&&task?.status==='failed',done=!running&&['done','completed'].includes(task?.status),idle=!task&&!running;
 const stopped=failed&&task.stop_requested;
 const names=idle?'未开始':stopping?'正在停止':failed?(stopped?'已停止':'未完成'):done?'已完成':task?.status==='queued'?'等待开始':'处理中';
 const detail=idle?idleMessage:stopping?'正在停止本次处理，请稍候。':failed?task.error:done?success||'本次处理已完成。':task?.status==='queued'?'任务已提交，正在等待开始。':task?.result?.progress?.stage||task?.result?.stage||'正在处理';
 const p=task?.result?.progress,Icon=running?LoadingIcon:done?Check:Info;
 async function submit(retry){if(submitting)return;setSubmitting(true);setError('');try{const r=retry&&onRetry?await onRetry():await action(`/api/workflow-tasks/${task.id}/${retry?'retry':'stop'}`,{},'POST',{localError:true});if(r?.error)setError(r.error);}finally{setSubmitting(false);}}
 return <div className={`ip-inline-progress ${failed&&!stopped?'is-error':done?'is-success':''}`} role="status" aria-live="polite"><div className="ip-inline-main"><Icon size={done?18:16} {...(done?{className:'ip-success-icon',strokeWidth:2.5,'aria-hidden':true}:{})}/><div><strong>{title} · {names}</strong>{failed&&(stopped?<p>{failureProgress(task).replace(/^失败环节：/,'停留环节：')}</p>:<FailureProgress task={task}/>)}<p>{detail}</p>{!failed&&Number.isInteger(p?.completed)&&Number.isInteger(p?.total)&&<small>已处理 {p.completed} / {p.total}</small>}{failed&&retryHint&&<small>{retryHint}</small>}{error&&<p role="alert">{error}</p>}{children}</div></div><div className="ip-inline-actions">{(idle||done)&&readyAction}{running&&task?.id&&<button className="setup-text-button danger" disabled={stopping||submitting} onClick={()=>submit(false)}>{stopping||submitting?'正在停止…':'停止'}</button>}{failed&&!hideRetry&&<button className="setup-text-button" disabled={submitting||blocked} onClick={()=>submit(true)}>{submitting?<LoadingIcon/>:null}{submitting?'正在提交…':task.kind==='agent_test'?'重新测试连接':'重试'}</button>}</div></div>;
}
