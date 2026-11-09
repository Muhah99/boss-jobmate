import {useEffect,useRef,useState} from 'react';
import {Check} from 'lucide-react';
import {LoadingIcon} from './Ui.jsx';
import './initialization-completion.css';

export default function InitializationCompletion({complete,error,retryReview,onRetry,onBack,onEnter}) {
 const [minimumElapsed,setMinimumElapsed]=useState(false),dialog=useRef(null);
 useEffect(()=>{const timer=setTimeout(()=>setMinimumElapsed(true),2000);return()=>clearTimeout(timer);},[]);
 useEffect(()=>{const previous=document.activeElement,overflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.focus({preventScroll:true});return()=>{document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
 const failed=!!error,done=!failed&&complete&&minimumElapsed;
 function keys(event){
  if(event.key==='Escape'){event.preventDefault();return;}
  if(event.key!=='Tab')return;
  const buttons=[...dialog.current.querySelectorAll('button:not([disabled])')],first=buttons[0],last=buttons.at(-1);
  if(!first){event.preventDefault();return;}
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){event.preventDefault();first.focus();}
 }
 return <div className="jobmate-modal-layer ar-confirm-layer"><section ref={dialog} className="jobmate-dialog ar-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="ar-dialog-title" tabIndex={-1} onKeyDown={keys}>
  <header><h2 id="ar-dialog-title">完成初始化</h2></header>
  <div className="jobmate-dialog-body"><div className={`ip-inline-progress ${failed?'is-error':done?'is-success':''}`} role="status" aria-live="polite" aria-busy={!failed&&!done}>
   <div className="ip-inline-main">{!failed&&(done?<Check size={18} strokeWidth={2.5} className="ip-success-icon" aria-hidden="true"/>:<LoadingIcon/>)}<div>
    <strong>{failed?'初始化未完成':done?'初始化完成':'初始化生效中'}</strong>
    <p>{failed?'本次初始化未完成。个人介绍、工作条件和系统设置已保留。':done?'基础配置已生效。':'正在完成初始化，请稍候。'}</p>
    {!failed&&!done&&<small className="init-duration-hint">约耗时5分钟</small>}
    {failed&&<><p className="ar-completion-error">{error}</p>{retryReview&&<small>重试仅继续核对，不重新拆解个人介绍。</small>}</>}
   </div></div>
  </div></div>
  <footer>{failed?<><button className="secondary-button" onClick={onBack}>返回设置</button><button className="primary-button" onClick={onRetry}>{retryReview?'重试核对':'重试未完成环节'}</button></>:done?<button className="primary-button" onClick={onEnter}>进入岗位任务</button>:<button className="primary-button" disabled>处理中</button>}</footer>
 </section></div>;
}
