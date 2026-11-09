import {useRef,useState} from 'react';
import {AlertCircle,CheckCircle2,LoaderCircle,X} from 'lucide-react';
import {Dialog} from './Ui.jsx';
import './workflow-progress.css';

export const workflowStatus=task=>!task?'idle':task.pause_requested&&['queued','running'].includes(task.status)?'pausing':task.status==='done'?'completed':task.status;

export function AbandonedTaskNotice({message='已完成的结果仍保留。'}){
 const [closed,setClosed]=useState(false);
 if(closed)return null;
 return <section className="abandoned-task-notice" aria-label="已放弃任务提示"><div><AlertCircle size={18}/><p><strong>任务已放弃</strong><span>{message}</span></p></div><button type="button" aria-label="关闭已放弃任务提示" title="关闭提示" onClick={()=>setClosed(true)}><X size={18} aria-hidden="true"/></button></section>;
}

export function WindowRestore({task,busy,action}){
 const [restoring,setRestoring]=useState(false),restoreInFlight=useRef(false);
 const window=task?.progress_window;
 if(!window?.available)return null;
 return <button className="pc-link" disabled={restoring||!window.hidden} onClick={async()=>{if(restoreInFlight.current)return;restoreInFlight.current=true;setRestoring(true);try{await action(`/api/workflow-tasks/${task.id}/window`,{hidden:false});}finally{restoreInFlight.current=false;setRestoring(false);}}}>显示{window.type==='browser'?'大':'小'}窗口</button>;
}

export default function WorkflowProgress({task,title,busy,locked,action,onContinue,idleMessage,abandonMessage,children,summary,continueDisabled=false,continueLabel,continueHint,abandonNotice=false}){
 const [confirm,setConfirm]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(''),submitting=useRef(false);
 const status=workflowStatus(task),progress=task?.result?.progress||{},running=['queued','running','pausing'].includes(status),failed=status==='failed',paused=status==='paused',completed=status==='completed';
 async function submit(operation){if(submitting.current)return;submitting.current=true;setPending(operation);setError('');try{const response=await action(`/api/workflow-tasks/${task.id}/${operation}`,operation==='abandon'?{confirmed:true}:{},'POST',{localError:true});if(response?.error)setError(response.error);else if(response)setConfirm(false);}finally{submitting.current=false;setPending('');}}
 if(status==='abandoned')return abandonNotice?<AbandonedTaskNotice key={task.id} message="已完成的岗位结果仍保留在列表中。"/>:null;
 const label=abandonNotice&&status==='queued'?'排队等待':abandonNotice&&failed?'失败':({idle:'未开始',queued:'进行中',running:'进行中',pausing:'暂停中',paused:'已暂停',failed:'未完成',completed:'已完成'}[status]||status);
 const Icon=completed?CheckCircle2:running?LoaderCircle:AlertCircle;
 return <><section className={`pc-progress ${failed?'failed':completed?'completed':''}`} aria-label={title+'网页进度'} aria-live="polite"><div className="pc-copy"><Icon size={19} className={running?'spin':undefined}/><div><strong>{title} · {label}</strong>{summary&&<p>{summary}</p>}{status==='idle'?<p>{idleMessage}</p>:<>{progress.stage&&<p>{progress.stage==='completed'?'已完成':progress.stage}{progress.total!=null&&<> · {progress.completed??0} / {progress.total}</>}</p>}{!progress.stage&&task?.result?.stage&&<p>{task.result.stage==='completed'?'已完成':task.result.stage}</p>}{status==='pausing'&&<p>正在等待当前操作到达安全停点，请稍候。</p>}{paused&&<p>本次操作已暂停，已有结果保留。</p>}{failed&&task.error&&<p className="pc-error">{task.error}</p>}</>}{(failed||paused)&&continueHint&&<p>{continueHint}</p>}{children}{error&&<p className="pc-error" role="alert">{error}</p>}</div></div><div className="pc-actions">{running&&<button disabled={!!pending||status==='pausing'} onClick={()=>submit('pause')}>{status==='pausing'?'暂停中':'暂停'}</button>}{(failed||paused)&&<><button disabled={busy||locked||continueDisabled} onClick={()=>onContinue?onContinue(task,paused?'resume':'retry'):submit(paused?'resume':'retry')}>{continueLabel||(failed?'重试':'恢复')}</button><button className="pc-danger" disabled={busy} onClick={()=>setConfirm(true)}>放弃本次任务</button></>}<WindowRestore task={task} busy={busy} action={action}/></div></section>{confirm&&<Dialog title="放弃本次任务？" onClose={()=>setConfirm(false)} footer={<><button className="secondary-button" disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button className="primary-button" disabled={busy} onClick={()=>submit('abandon')}>确认放弃</button></>}><p>结束本次任务，关闭对应窗口。</p><p>{abandonMessage}</p></Dialog>}</>;
}
