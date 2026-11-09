export async function request(path,{method='GET',body,signal}={}) {
  const form=body instanceof FormData;
  const response=await fetch(path,{method,signal,headers:body&&!form?{'Content-Type':'application/json'}:undefined,body:body?form?body:JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({error:'服务返回了无法读取的结果，请重新读取。'}));
  if(!response.ok||data.ok===false)throw new Error(data.error?.message||data.error||data.message||'操作未完成，请手动重试。');
  return data;
}
export const labelExpectation=e=>e?`${e.title||e.name||e.job_name||e.keyword} · ${e.city}`:'未选择求职期望';
export function labelBatch(batch,batches) {
 if(!batch?.created_at)return '日期未记录';
 const format={year:'numeric',month:'2-digit',day:'2-digit'},date=new Date(batch.created_at).toLocaleDateString('zh-CN',format);
 const daily=batches.filter(b=>String(b.expectation_id)===String(batch.expectation_id)&&b.created_at&&new Date(b.created_at).toLocaleDateString('zh-CN',format)===date).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
 return `${date} · 第 ${daily.findIndex(b=>String(b.id)===String(batch.id))+1} 次投递`;
}
export const chars=value=>Array.from(value||'').length;
export function jobStage(job,state,batch,item){
 if(!batch){batch=state.batches.find(b=>b.status!=='voided'&&b.jobs.some(i=>i.job_id===job.id));item=batch?.jobs.find(i=>i.job_id===job.id);}
 if(!item)return statusLabel(job.verdict);
 if(item.choice==='skip')return '不投递';
 if(batch.status==='reviewing')return '待审阅';
 if(item.delivery_status==='message_sent')return '已投递';
 if(['chat_send_outcome_unknown','sent_message_not_visible','greeting_outcome_unknown'].includes(item.last_error)||item.delivery_status==='uncertain')return '待核实';
 if(item.last_error)return '投递失败';
 const active=state.tasks.some(t=>t.kind==='delivery'&&['queued','running'].includes(t.status)&&(t.input?.scope?t.input.scope.some(r=>r.batch_id===batch.id&&r.job_id===item.job_id):t.input?.batch_id===batch.id));
 if(active&&!['already_contacted','job_closed','headhunter_skipped','not_delivering'].includes(item.delivery_status))return '投递中';
 return ['prepared','greeting_sent','chat_located'].includes(item.delivery_status)?'待投递':statusLabel(item.delivery_status);
}
export function failureProgress(task){
 if(task?.status!=='failed')return '';
 const p=task.result?.failure_progress||task.result?.progress||(task.result?.stage?{stage:task.result.stage}:null);
 if(typeof p?.stage!=='string'||!p.stage.trim()||['failed','running','completed','queued','idle'].includes(p.stage))return '';
 const counted=Number.isInteger(p.completed)&&Number.isInteger(p.total)&&p.total>0&&p.completed>=0&&p.completed<=p.total;
 return `失败环节：${p.stage}${counted?` ${p.completed}/${p.total}`:''}`;
}
export const levelLabel=value=>({high:'高',medium:'中',low:'低'})[value]||'';
export const statusLabel=value=>({done:'已完成',not_required:'不涉及',prepared:'待投递',submitted:'已审阅待投递',message_sent:'已发送',already_contacted:'已联系',job_closed:'岗位已关闭',headhunter_skipped:'猎头已跳过',not_delivering:'不投递',paused:'已暂停',pausing:'正在暂停',queued:'等待处理',running:'处理中',failed:'失败待处理',completed:'已完成',succeeded:'已完成',abandoned:'已放弃',voided:'已作废',reviewing:'待审阅',reviewed:'审阅完成',waiting:'待发起',sent:'已发送',pending:'待处理',send_uncertain:'待人工核实',greeting_sent:'待继续核实',not_deliver:'不投递',deliver:'可投递',selected:'入选',eliminated:'淘汰',unqualified:'不符'})[value]||value||'待处理';
