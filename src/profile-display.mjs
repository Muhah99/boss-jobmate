// Only system-owned presentation labels change; stored workflow identifiers and API text stay intact.
export const profileStageText=value=>({
 '个人介绍拆解':'整理个人经历',
 '正在拆解个人介绍':'正在整理你的经历与能力…',
 '正在审核个人介绍拆解结果':'正在核对整理结果…',
 '正在审核拆解结果':'正在核对整理结果…',
 '等待重建批次':'等待重新准备投递',
 '批次已作废':'投递安排已作废',
 '聊天批次定位':'定位本次投递的聊天会话'
})[value]??value;
export function profileErrorText(value){
 if(typeof value!=='string')return value;
 const exact={
  '本批次已作废，旧请求不可恢复。':'本次投递安排已作废，旧请求无法恢复。',
  '个人介绍已更新，原批次已失效':'个人介绍已更新，原投递安排已失效',
  '请先定位本批聊天后发送。':'请先定位本次投递的聊天会话后发送。',
  '待审阅批次缺少原任务冻结参数，旧资料与批次保持。':'待审阅的投递安排缺少原任务参数，原资料与投递安排保留。',
  '聊天批次缺少当前岗位定位计划，请在原页面继续。':'本次投递缺少当前岗位的聊天会话定位计划，请在原页面继续。',
'拆解编号沿用无效':'经历条目编号沿用无效','拆解出处不在当前介绍原文中':'经历条目出处不在当前介绍原文中','请先完成个人介绍拆解和求职期望':'请先完成个人经历整理和求职期望'};
 return exact[value]??value.replace(/^聊天批次定位未完成(?=[（，])/,'本次投递的聊天会话定位未完成').replace(/^(?:个人介绍拆解失败：)+/,'个人经历整理未完成：').replace(/^(?:个人介绍审核失败：)+/,'整理结果核对未完成：');
}
export function profileTaskText(task){
 const result={...task.result};
 if(result.stage)result.stage=profileStageText(result.stage);
 for(const key of ['progress','failure_progress'])if(result[key]?.stage)result[key]={...result[key],stage:profileStageText(result[key].stage)};
 return {...task,result,error:profileErrorText(task.error)};
}
