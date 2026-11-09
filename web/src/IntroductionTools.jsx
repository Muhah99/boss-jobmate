import {useEffect,useRef,useState} from 'react';
import {FileText,Upload} from 'lucide-react';
import {Note,FailureProgress,LoadingIcon} from './Ui.jsx';
import IntroductionEditor from './IntroductionEditor.jsx';
import InlineProgress from './InlineProgress.jsx';
import {chars} from './api.js';
import './introduction-tools.css';

export function ResumeTool({state,action,target,onDone,onCancel,hudTaskId}) {
 const latest=hudTaskId?state.tasks?.find(t=>t.id===hudTaskId&&t.kind==='introduction_tool'&&t.input?.target===target):[...(state.tasks||[])].reverse().find(t=>t.kind==='introduction_tool'&&t.input?.target===target);
 const restored=['failed','queued','running'].includes(latest?.status)?latest.input.tool:null;
 const [value,setValue]=useState(()=>({resume_file:'',resume_name:'',supplement:'',...restored})),[taskId,setTaskId]=useState(restored?latest.id:null),[submitted,setSubmitted]=useState(null),[submitting,setSubmitting]=useState(false),[uploading,setUploading]=useState(false),[error,setError]=useState('');
 const task=state.tasks?.find(t=>t.id===taskId)||submitted,running=submitting||['queued','running'].includes(task?.status),consumed=useRef(null);
 const learningLocked=target==='profile'&&!!state.locks?.learning;
 useEffect(()=>{if(task?.status==='done'&&task.result?.generated&&consumed.current!==task.id){consumed.current=task.id;onDone(task.result);}},[task?.status,task?.id]);
 async function upload(file){setUploading(true);setError('');try{
  const buffer=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<buffer.length;i+=16384)binary+=String.fromCharCode(...buffer.subarray(i,i+16384));
  const result=await action('/api/profile/upload',{name:file.name,content_base64:btoa(binary)},'POST',{localError:true});if(result?.error){setError(result.error);return;}if(!result)return;
  if(value.resume_file)await action('/api/profile/generate',{cancel:true,resume_file:value.resume_file});
  setValue(v=>({...v,resume_file:result.file,resume_name:result.name||file.name}));setTaskId(null);setSubmitted(null);
 }catch(e){setError(e.message||'上传未完成，请重新选择 PDF');}finally{setUploading(false);}}
 async function generate(){setSubmitting(true);setError('');try{const result=await action(target==='onboarding'?'/api/onboarding/generate':'/api/profile/generate',value,'POST',{localError:true});if(result?.error)setError(result.error);if(result?.task){setTaskId(result.task.id);setSubmitted(result.task);}}finally{setSubmitting(false);}}
 async function cancel(){if(value.resume_file){const result=await action('/api/profile/generate',{cancel:true,resume_file:value.resume_file});if(!result)return;}onCancel();}
 const generateButton=<button className="primary-button" disabled={running||learningLocked||uploading||!value.resume_file} onClick={generate}>{running&&<LoadingIcon/>}{running?'正在生成…':task?.status==='failed'?'重试生成个人介绍':'生成个人介绍'}</button>;
 return <><div className="setup-upload"><FileText size={25}/><div><strong>{value.resume_name||'选择 PDF 简历'}</strong><small>{value.resume_name?'本次生成使用的文件':'支持含文字层的 PDF，不支持扫描件 OCR'}</small></div><label className={`secondary-button ${running||learningLocked?'disabled':''}`}><Upload size={14}/>{uploading?'上传中…':value.resume_name?'更换 PDF':'选择 PDF'}<input hidden type="file" aria-label="选择本次 PDF 简历" accept=".pdf,application/pdf" disabled={running||learningLocked||uploading} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value='';}}/></label></div><label className="setup-field"><span>补充经历 <small>选填</small></span><textarea aria-label="补充经历" rows={5} value={value.supplement} readOnly={learningLocked} disabled={running} placeholder="补充简历中未写明的经历、项目或能力" onChange={e=>setValue(v=>({...v,supplement:e.target.value}))}/></label><p className="setup-help r17-tool-note">简历仅用于本次生成，生成后不作为长期资料保存；仅保留文件名与补充经历的来源说明。</p>{error&&<Note kind="error">{error}</Note>}<InlineProgress blocked={learningLocked} pending={target==='onboarding'&&submitting} task={task} title="生成个人介绍" action={action} retryHint="重试将重新读取本次PDF并生成介绍。" onRetry={async()=>{const r=await action(`/api/workflow-tasks/${task.id}/retry`,{},'POST',{localError:true});if(r?.task){setTaskId(r.task.id);setSubmitted(r.task);}return r;}}>{target==='onboarding'&&running&&<small className="init-duration-hint">约耗时1分钟</small>}</InlineProgress><div className="r17-tool-actions"><button className="secondary-button" disabled={running||learningLocked||uploading} onClick={cancel}>{target==='onboarding'?'返回选择方式':'取消，返回个人资料'}</button>{target==='onboarding'?<div className="init-duration-action">{!running&&!task&&!error&&<span className="init-duration-hint">约耗时1分钟</span>}{generateButton}</div>:generateButton}</div></>;
}

export {IntroductionFields} from './IntroductionMatchTest.jsx';
