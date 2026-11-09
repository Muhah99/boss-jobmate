import {useEffect,useRef,useState} from 'react';
import {AlertTriangle,ShieldAlert,Trash2} from 'lucide-react';
import {Dialog,Note,Section} from './Ui.jsx';
import './reset-data.css';

export function ResetDataSection({state,busy,action}) {
 const [open,setOpen]=useState(false),[seconds,setSeconds]=useState(5),[submitting,setSubmitting]=useState(false),[failed,setFailed]=useState(false),[error,setError]=useState('');
 const cancel=useRef(null),entry=useRef(null),sending=useRef(false),runningRef=useRef(false);
 const running=submitting||state.reset?.running,blocked=!!state.reset?.blocked;
 runningRef.current=running;
 function close(){if(sending.current||runningRef.current)return;setOpen(false);entry.current?.focus();}
 function show(){if(busy||blocked)return;setSeconds(5);setOpen(true);setFailed(false);setError('');}
 useEffect(()=>{
  if(!open)return;
  cancel.current?.focus();const end=Date.now()+5000;
  const timer=failed?null:setInterval(()=>setSeconds(Math.max(0,Math.ceil((end-Date.now())/1000))),100);
  function keydown(e){if(e.key==='Escape'){e.preventDefault();close();}}
  document.addEventListener('keydown',keydown);
  return()=>{clearInterval(timer);document.removeEventListener('keydown',keydown);};
 },[open,failed]);
 async function confirm(){
  if(seconds>0||busy||blocked||sending.current)return;
  sending.current=true;setSubmitting(true);
  const result=await action('/api/settings/reset',{confirmed:true});
  sending.current=false;setSubmitting(false);
  if(!result||result.error){setError(result?.error||state.reset?.error||'清理未完成，请处理后重试。');setFailed(true);}
 }
 return <Section icon={ShieldAlert} title="清理数据" className="reset-data-section" sub="清空本软件全部数据，并恢复到首次初始化状态。">
  <div className="reset-data-entry"><p className="setup-help">包括系统配置、密钥与专用登录状态；清理后需重新配置和登录。</p><button ref={entry} type="button" className="setup-danger-button" disabled={busy||blocked} onClick={show}><Trash2 size={15}/>清理所有数据</button></div>
  {blocked&&<p className="setup-help" role="status">{state.reset.reason}</p>}
  {!open&&(failed||state.reset?.error)&&<Note kind="error">{error||state.reset?.error||'清理未完成，请处理后重试。可能已有部分数据被清理。'}</Note>}
  {open&&<Dialog className={`reset-data-dialog${failed?' reset-data-failure':''}`} title={failed?'清理未完成':'清理所有数据并恢复初始化？'} onClose={running?undefined:close} footer={failed?<>
   <button ref={cancel} type="button" className="secondary-button" disabled={running} onClick={close}>返回系统配置</button>
   <button type="button" className="setup-danger-button" disabled={busy||blocked||running} onClick={show}>重试清理</button>
  </>:<>
   <button ref={cancel} type="button" className="secondary-button" disabled={running} onClick={close}>取消</button>
   <button type="button" className="setup-danger-button" disabled={seconds>0||busy||blocked||running} onClick={confirm}>{running?'正在清理…':seconds>0?`确认清空（${seconds}秒）`:'确认清空'}</button>
  </>}>
   {failed?<div className="setup-note error" role="alert"><AlertTriangle size={20}/><div><strong>清理未完成，请处理后重试</strong><p>{error||state.reset?.error||'清理未完成，请处理后重试。'}</p><p>可能有部分数据被清除，尚未恢复到初始化状态。请处理后重试，重试仍需重新确认清理范围。</p></div></div>:<>
   <Note kind="error"><strong>本软件的所有数据将被永久清空，且无法撤销。</strong></Note>
   <div className="reset-data-groups"><section><h3>资料与求职记录</h3><p>简历、补充经历、个人介绍、整理后的个人经历、工作条件、求职期望、岗位、任务、投递安排、消息、审阅草稿、投递记录及反馈案例全部删除。</p></section>
    <section><h3>配置与本地文件</h3><p>系统设置、API Key、地图配置和本地缓存、日志、诊断、临时业务文件及本安装业务恢复副本全部清除。</p></section>
    <section><h3>专用登录状态</h3><p>本项目专用浏览器和 Codex CLI 的登录状态、配置与业务会话清除，需要重新配置和登录。清理时会关闭本项目专用浏览器。</p></section></div>
   <p className="setup-help reset-data-boundary">仅清理本软件当前安装的数据，保留软件和内置初始化资源；不影响其他项目、原始简历文件与共享 CLI 登录，也不会撤回 BOSS 上已发送的消息；不注销远端账号或撤销远端 API Key。</p>
   {running?<Note>正在清理数据，请勿关闭软件</Note>:blocked&&<Note>{state.reset.reason}</Note>}
   </>}
  </Dialog>}
 </Section>;
}
