import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { JobmateStore } from '../src/data-store.mjs';
import { AgentRuntime } from '../src/agent-runtime.mjs';
import { ExternalServices, NativeProgress } from '../src/external-services.mjs';
import { createApplication } from '../src/application.mjs';
import { hudTaskState, inlineProgressTask } from '../src/hud-actions.mjs';

export const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
export function bootstrap({port}) {
  const address=`http://127.0.0.1:${port}`;
  const store=new JobmateStore(resolve(root,'data','boss-jobmate.db'));
  const getSecrets=()=>store.getSetting('secrets',{});
  const native=new NativeProgress({root,getSecrets,returnUrl:address+'/'});
  const progress={update:s=>{
    if(s.taskId && ['review_learning','review'].includes(store.getTask(s.taskId)?.kind))return;
    const task=s.taskId?store.getTask(s.taskId):store.listTasks().find(t=>['running','queued'].includes(t.status)&&!['review_learning','review'].includes(t.kind));
    if(task?.status==='abandoned')return native.hide(task.id);
    if(inlineProgressTask(task))return native.hide(task.id);
    const actions=hudTaskState(store,task,address);
    return native.update({...s,...actions,taskId:s.taskId||task?.id,status:actions.window_controls?actions.status:s.status==='done'?'completed':s.status,title:actions.title||s.title||s.name,stage:actions.window_controls?actions.stage||s.stage:s.stage||actions.stage,error:task?.kind==='jobs'?actions.error:s.error||actions.error});
  },initGuide:hidden=>native.initGuide(hidden),visibility:id=>({...native.visibility(id),...(store.getTask(id)?.status==='abandoned'?{available:false}:{})}),setVisibility:(id,hidden)=>native.setVisibility(id,hidden),finish:s=>progress.update({...s,type:'background',title:'岗位处理',stage:s.status==='failed'?'处理未完成':'处理结束'}),close:()=>native.close()};
  const agent=new AgentRuntime({root,getSecrets});
  const external=new ExternalServices({root,getSecrets,progress:s=>progress.update(s)});
  return createApplication({root,store,agent,external,progress});
}
