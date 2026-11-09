import {CheckCircle2,ChevronRight} from 'lucide-react';

// Use the batch's saved task identity and its reciprocal batch link, never a global latest task.
export function submittedKnowledge(batch,tasks){
 const task=batch.learning_task_id&&tasks.find(t=>t.kind==='review_learning'&&String(t.id)===String(batch.learning_task_id)&&String(t.input?.batch_id)===String(batch.id));
 const status=task?(task.status==='failed'&&task.stop_requested?'stopped':task.status):batch.learning?.status==='unchanged'?'unchanged':'none';
 return {task,status};
}
export function SubmittedKnowledgeNotice({batch,state,navigate}){
 if(!['submitted','completed'].includes(batch.status))return null;
 const {task,status}=submittedKnowledge(batch,state.tasks);
 const hasTask=['queued','running','completed','failed','stopped'].includes(status),done=status==='completed',unfinished=['failed','stopped'].includes(status);
 const copy={queued:'知识更新已排队',running:'知识更新处理中',completed:'知识已更新完毕',failed:'知识更新未完成',stopped:'知识更新已停止'}[status];
 const go=()=>navigate(done?'profile':'tasks',{history:done,knowledge_task_id:task.id});
 return <section className="r40-submitted submitted-knowledge-notice" aria-label="投递审阅提交结果" aria-live="polite"><div className="submitted-knowledge-copy"><div className="submitted-knowledge-heading"><CheckCircle2 size={19} aria-hidden="true"/><strong>本次审阅已提交，等待投递</strong></div>{copy&&<div className={'submitted-knowledge-state '+(done?'done':unfinished?'unfinished':'')}><span>{copy}{unfinished?'，可前往岗位任务继续处理':''}</span></div>}</div><div className="submitted-knowledge-actions">{hasTask&&<button className="text-button" onClick={go}>{done?'查看记录':unfinished?'查看并处理':'查看知识进度'}<ChevronRight size={15}/></button>}<button className="secondary-button" onClick={()=>navigate('today')}>查看待投递</button></div></section>;
}
