import {profileStageText,profileErrorText} from './profile-display.mjs';

// HUD actions describe existing operations; confirmations stay in their original pages.
export const inlineProgressTask = task => ['agent_test','introduction_tool','introduction_preview','initialization'].includes(task?.kind) || task?.kind==='profile' && ['introduction','conditions'].includes(task.input?.mode);
export function hudTaskState(store,task,address='') {
  const complete=!!store.getSetting('onboarding').complete;
  const kind=task?.kind,input=task?.input||{},status=task?.status;
  const page=['delivery','verification'].includes(kind)?'today':kind==='profile'?'profile':kind==='expectations'?input.target==='onboarding'?'init':input.target==='config'?'config':complete?'config':'init':kind==='agent_test'?complete?'config':'init':['initialization','introduction_tool','introduction_preview'].includes(kind)?input.target==='onboarding'||!complete?'init':'profile':complete?'tasks':'init';
  const query=new URLSearchParams({page});if(task)query.set('hud_task',task.id);
  const return_url=`${address}/?${query}`;query.set('hud_action','retry');
  const result={taskId:task?.id,status:status==='done'?'completed':status||'failed',title:kind==='profile'&&input.mode==='conditions'?'更新工作条件':undefined,omit_repeated_title:kind==='profile'&&input.mode==='conditions',stage:profileStageText(task?.result?.progress?.stage||task?.result?.stage),error:profileErrorText(task?.error),return_url,retry_return_url:`${address}/?${query}`,retry_kind:'',retry_hint:'',stop_url:undefined};
  if(!task||['review_learning','review'].includes(kind))return result;
  if(['jobs','expectations','delivery','verification'].includes(kind))result.window_controls=true;
  result.progress_url=`${address}/api/workflow-tasks/${task.id}/progress`;
  if(['queued','running'].includes(status)&&['jobs','delivery','verification','profile','initialization','expectations','agent_test','introduction_tool','introduction_preview'].includes(kind))result.stop_url=`${address}/api/${kind==='delivery'?'applications/tasks':'workflow-tasks'}/${task.id}/stop`;
  if(kind==='profile'&&input.mode==='introduction'&&['waiting','awaiting_confirmation'].includes(status)){
    result.retry_kind='navigate';result.retry_hint='重试将返回本次个人介绍更新，确认影响范围后继续。';return result;
  }
  if(kind==='jobs'){
    result.job_actions=true;
    result.type=task.result?.progress?.type||'background';
    result.status=task.pause_requested&&['queued','running'].includes(status)?'pausing':status;
    result.completed=task.result?.progress?.completed;result.total=task.result?.progress?.total;
    if(['queued','running'].includes(status)){result.pause_url=`${address}/api/workflow-tasks/${task.id}/pause`;result.stop_url=undefined;}
    if(status==='paused')result.resume_url=`${address}/api/workflow-tasks/${task.id}/resume`;
    if(['paused','failed'].includes(status))result.abandon_url=`${address}/api/workflow-tasks/${task.id}/abandon`;
    result.abandon_hint='此前已正式保存的筛选结果、投递安排及历史记录保留；本轮未保存的消息与未完成环节缓存将清理。'+(input.rebuild_parent?'个人介绍已生效，不会回滚介绍或恢复旧投递安排。':'');
  }
  if(['expectations','delivery','verification'].includes(kind)){
    result.task_actions=true;
    result.title=kind==='expectations'?'读取求职期望':kind==='delivery'?'岗位投递':'核实发送结果';
    result.status=task.pause_requested&&['queued','running'].includes(status)?'pausing':status==='done'?'completed':status;
    result.type=['failed','paused'].includes(status)?'background':task.result?.progress?.type||'browser';
    result.completed=task.result?.progress?.completed;result.total=task.result?.progress?.total;
    result.stop_url=undefined;
    if(['queued','running'].includes(status))result.pause_url=`${address}/api/workflow-tasks/${task.id}/pause`;
    if(status==='paused'){
      result.resume_url=`${address}/api/workflow-tasks/${task.id}/resume`;
      if(kind==='delivery'){result.resume_kind='navigate';const resumeQuery=new URLSearchParams({page,hud_task:task.id,hud_action:'resume'});result.resume_return_url=`${address}/?${resumeQuery}`;}
    }
    if(['paused','failed'].includes(status)){
      result.abandon_url=`${address}/api/workflow-tasks/${task.id}/abandon`;
      result.abandon_hint=kind==='expectations'?'结束本次读取；已保存期望、样本、通勤配置和草稿保留，不跳过初始化必需步骤。':kind==='verification'?'结束本次核实；已审消息、发送记录和待核实标记保留，不会重新发送。':'结束本次投递；已发送记录、已审消息及未完成岗位保留，未知发送结果不会重置或自动重发。';
      result.abandon_hint+='其他任务不受影响。';
    }
  }
  if(status!=='failed')return result;
  if(kind==='profile'&&!['introduction','conditions','sources'].includes(input.mode))return result;
  if(kind==='profile'&&task.result?.updated){result.retry_hint='个人介绍已生效，请返回原投递准备任务继续。';return result;}
  const direct=['jobs','initialization','introduction_tool','introduction_preview','profile','expectations','verification'].includes(kind);
  if(direct){
    result.retry_kind='direct';result.retry_url=`${address}/api/workflow-tasks/${task.id}/retry`;
    result.retry_hint=kind==='expectations'?(/登录|验证/.test(task.error||'')?'请在专用浏览器完成登录或安全验证，然后点击【重试】继续读取求职期望。':'重试将直接重新读取求职期望。'):kind==='introduction_tool'?'重试将重新读取本次简历并生成个人介绍。':kind==='introduction_preview'?'重试将重新匹配并生成消息。':kind==='initialization'?'重试将按当前草稿重新整理并审核个人经历。':kind==='profile'?(input.mode==='introduction'?'重试将接续本次更新，可能需要重新确认影响范围。':'重试将按当前草稿重新发起本次资料更新。'):'';
    if(kind==='expectations')result.retry_hint='';
  }else if(['agent_test','delivery','verification'].includes(kind)){
    const batch=input.batch_id?store.getBatch(input.batch_id):null,item=batch?.jobs?.find(i=>i.job_id===input.job_id);
    const scope=kind==='delivery'?(input.scope||batch?.jobs?.map(i=>({batch_id:batch.id,job_id:i.job_id}))||[]):[];
    const finished=new Set(['message_sent','already_contacted','job_closed','headhunter_skipped','not_delivering']);
    const valid=kind==='verification'?!!item&&!finished.has(item.delivery_status):kind==='delivery'?scope.length>0&&scope.every(ref=>store.getBatch(ref.batch_id)?.jobs?.some(i=>i.job_id===ref.job_id))&&scope.some(ref=>!finished.has(store.getBatch(ref.batch_id).jobs.find(i=>i.job_id===ref.job_id).delivery_status)):true;
    if(valid){result.retry_kind='navigate';result.retry_hint=kind==='agent_test'?'重试将返回当前 Agent 配置及费用确认，确认后才会测试。':kind==='delivery'?'重试将返回原投递范围；先核实未知结果，人工确认后继续投递。':'重试将返回该岗位的核实入口，读取页面核实与本人确认分开操作。';}
  }
  return result;
}
