import {CheckCircle2,ArrowRight,BookOpen} from 'lucide-react';
import {Dialog} from './Ui.jsx';
import {submittedKnowledge} from './SubmittedKnowledgeNotice.jsx';
import './review-submission-flow.css';

// Same persisted-item completion states as the delivery page's unfinished list.
export function batchDeliverySummary(batch){
 const final=new Set(['message_sent','already_contacted','job_closed','headhunter_skipped','not_delivering']);
 const accepted=batch.jobs.filter(item=>item.choice==='deliver');
 return {count:accepted.length,pending:accepted.filter(item=>!final.has(item.delivery_status)).length};
}
export function ReviewSubmissionStatus({batch,state,navigate}){
 if(!['submitted','completed'].includes(batch.status))return null;
 const {pending}=batchDeliverySummary(batch),{task,status}=submittedKnowledge(batch,state.tasks);
 const label={queued:'等待更新',running:'正在更新中',completed:'已完成更新',failed:'更新失败，尚未完成',stopped:'更新已停止，尚未完成'}[status];
 return <section className="submission-overview" aria-label="本次投递的审阅与知识更新状态" aria-live="polite"><div className="submission-batch-line"><div className="submission-batch-title"><CheckCircle2 size={20}/><strong>本次投递已完成审阅</strong></div>{pending>0?<button className="submission-pending" onClick={()=>navigate('today')}><b>{pending}</b> 待投递<ArrowRight size={16}/></button>:<span className="submission-all-done">当前没有待投递岗位</span>}</div>{label&&<div className="submission-knowledge-line"><div><BookOpen size={17}/><span>本次投递有知识更新</span><span className={'submission-knowledge-state '+status}>{label}</span></div><button className="text-button" onClick={()=>navigate('profile',{history:true,knowledge_task_id:task.id})}>查看记录<ArrowRight size={15}/></button></div>}</section>;
}
export function ReviewSubmissionResult({batch,onStay,onDelivery}){
 const {count}=batchDeliverySummary(batch);
 return <Dialog title="提交成功" className="submission-result-dialog" onClose={onStay} footer={<><button className="secondary-button" onClick={onStay}>停留在原页面</button><button className="primary-button" onClick={onDelivery}>前往投递<ArrowRight size={16}/></button></>}><div className="submission-result-primary"><CheckCircle2 size={25}/><p>已提交 <strong>{count}</strong> 个岗位至待投递</p></div>{batch.learning_task_id&&<div className="submission-result-knowledge"><BookOpen size={18}/><div><strong>本次有新的知识更新</strong><p>已提交更新</p></div></div>}</Dialog>;
}
