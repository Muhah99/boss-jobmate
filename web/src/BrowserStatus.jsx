import {useCallback,useEffect,useRef,useState} from 'react';
import {CheckCircle2,Info,RefreshCw,ExternalLink} from 'lucide-react';
import {request} from './api.js';
import './browser-status.css';

export function browserText(state){
 if(state.status==='unknown')return {label:'尚未检测浏览器',detail:'可手动重新检测；使用浏览器时仍会检查必要的运行条件。'};
 if(state.status==='checking')return {label:'正在检查浏览器…',detail:'正在检查本机程序，不会打开浏览器。'};
 if(state.status==='missing')return {label:'未检测到可用浏览器',detail:'请下载安装 Chrome 浏览器后继续使用。'};
 return {label:state.source==='bundled'?'内置Chromium':'已安装Chrome',detail:state.source==='bundled'?'已随安装包附带，无需另行下载安装。':'当前使用系统已安装的 Chrome。'};
}
export function useBrowserCheck(autoCheck,onError){
 const [state,setState]=useState({status:'unknown',installed:false}),[downloadError,setDownloadError]=useState(''),sequence=useRef(0),inFlight=useRef(null);
 const check=useCallback(async()=>{
  if(inFlight.current)return inFlight.current;
  const id=++sequence.current;setState(previous=>({...previous,status:'checking'}));
  const pending=(async()=>{
   let value,failure='';try{value=(await request('/api/browser/detect',{method:'POST',body:{}})).chrome;if(!value||!['ready','missing'].includes(value.status))throw new Error('浏览器检查未完成，请稍后重试。');}
   catch(error){failure=error.message;value={status:'error',installed:false,source:null};}
   if(id!==sequence.current)return null;
   if(failure)onError?.(failure);
   setState(value);return value;
  })();
  inFlight.current=pending;
  try{return await pending;}finally{if(inFlight.current===pending)inFlight.current=null;}
 },[onError]);
 useEffect(()=>{if(autoCheck)void check();},[autoCheck,check]);
 useEffect(()=>()=>{sequence.current++;inFlight.current=null;},[]);
 useEffect(()=>{if(!autoCheck)return;const onFocus=()=>void check();window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus);},[autoCheck,check]);
 const download=async()=>{setDownloadError('');try{await request('/api/browser/download',{method:'POST',body:{}});return true;}catch{setDownloadError('无法打开浏览器官网，请检查系统默认浏览器设置后重试。');return false;}};
 return {state,check,download,downloadError};
}
export function BrowserSettings({browser,focus}){
 const section=useRef(null);useEffect(()=>{if(focus)section.current?.scrollIntoView({block:'center'});},[focus]);
 const s=browser.state,text=browserText(s),unavailable=s.status==='missing';
 return <div id="browser-settings" ref={section} className="r42-browser-settings" aria-live="polite">{s.status!=='error'&&<div className="r42-browser-summary"><div><strong>{text.label}</strong><p>{text.detail}</p></div><span className={'setup-status '+(s.status==='ready'?'success':'neutral')}>{s.status==='ready'?<CheckCircle2 size={14}/>:<Info size={14}/>}{s.status==='ready'?'可用':s.status==='checking'?'检查中':'未就绪'}</span></div>}<div className="setup-inline-actions">{unavailable&&<button className="secondary-button" onClick={browser.download}><ExternalLink size={14}/>下载 Chrome</button>}<button className="secondary-button" disabled={s.status==='checking'} onClick={browser.check}><RefreshCw size={14}/>重新检测</button></div>{browser.downloadError&&<p role="alert">{browser.downloadError}</p>}</div>;
}
export function BrowserTaskNotice({browser,onRepair}){if(browser.state.status!=='missing')return null;return <section className="r42-browser-notice" role="status"><Info size={17}/><div><strong>未检测到可用浏览器，请前往系统配置下载安装 Chrome。</strong></div><button className="secondary-button" onClick={onRepair}>前往系统配置</button></section>;}
