import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Info,Play,RotateCcw} from 'lucide-react';
import {Dialog,Note,FailureProgress,LoadingIcon} from './Ui.jsx';
import IntroductionEditor,{IntroductionReading} from './IntroductionEditor.jsx';
import {chars} from './api.js';
import InlineProgress from './InlineProgress.jsx';
import {previewMessageParts} from './introduction-test.mjs';
import './introduction-match-test.css';
import './introduction-inline-edit.css';
import SupplementEditor from './SupplementEditor.jsx';

function MatchDialog({open,onClose,value,reference,state,action,target,disabled,hudTaskId}) {
 const restored=hudTaskId?state.tasks?.find(t=>t.id===hudTaskId&&t.kind==='introduction_preview'&&t.input?.target===target):[...(state.tasks||[])].reverse().find(t=>t.kind==='introduction_preview'&&t.input?.target===target);
 const initial=restored?.input?.preview;
 const [mode,setMode]=useState(initial?.jd&&!initial.sample?'manual':'default');
 const [manual,setManual]=useState(initial?.jd&&!initial.sample?initial.jd:'');
 const [template,setTemplate]=useState(initial?.reference??reference??''),[templateEdited,setTemplateEdited]=useState(!!initial);
 const [taskId,setTaskId]=useState(restored?.id||null),[submitted,setSubmitted]=useState(null),[submitting,setSubmitting]=useState(false);
 const [selected,setSelected]=useState([]),[basisOpen,setBasisOpen]=useState(false);
 const [error,setError]=useState('');
 const pane=useRef(null),items=useRef(new Map()),retryPending=useRef(false);
 const sample=state.introductionTestJobSample,jd=mode==='default'?(sample?.jd||''):manual;
 const latest=submitting?submitted:taskId?(state.tasks?.find(t=>t.id===taskId)||submitted):null;
 const snapshot=latest?.input?.preview;
 const expired=!!snapshot&&(snapshot.introduction!==value||snapshot.jd!==jd||snapshot.reference!==template||JSON.stringify(snapshot.sample||null)!==JSON.stringify(mode==='default'?sample||null:null));
 const running=submitting||['queued','running'].includes(latest?.status);
 const failed=latest?.status==='failed';
 const matching=latest?.result?.matching,message=!running&&latest?.status==='done'?latest.result:null;
 const stage=latest?.result?.progress?.stage||latest?.result?.stage||'等待开始匹配';
 useEffect(()=>{
  if(!open)return;const previous=document.activeElement,dialog=document.querySelector('.r37-test-dialog');
  dialog?.querySelector('button')?.focus({preventScroll:true});
  const keys=e=>{if(e.key==='Escape'){e.preventDefault();onClose();}else if(e.key==='Tab'){const nodes=[...(dialog?.querySelectorAll('button:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')||[])],first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
  document.addEventListener('keydown',keys);return()=>{document.removeEventListener('keydown',keys);if(previous?.isConnected)previous.focus({preventScroll:true});};
 },[open]);
 useEffect(()=>{if(!templateEdited&&!snapshot)setTemplate(reference??'');},[reference,templateEdited]);
 useEffect(()=>setSelected([]),[value,jd,template,taskId]);
 function locate(indices){
  if(expired)return;
  setBasisOpen(true);
  if(selected.length===indices.length&&indices.every(i=>selected.includes(i))){setSelected([]);return;}
  setSelected(indices);
  requestAnimationFrame(()=>{const element=items.current.get(indices[0]);if(element&&pane.current)pane.current.scrollTop+=element.getBoundingClientRect().top-pane.current.getBoundingClientRect().top-14;});
 }
 async function generate(){
  if(running||!value.trim()||!jd.trim())return;
  const preview={introduction:value,jd,reference:template,...(mode==='default'?{sample}: {})},payload={introduction:value,jd,reference:template,...(mode==='default'?{jd_source:'sample'}:{})};
  setError('');setSelected([]);setBasisOpen(false);setSubmitting(true);setSubmitted({status:'queued',input:{preview},result:{}});setTaskId(null);
  try{const response=await action(target==='onboarding'?'/api/onboarding/example':'/api/profile/preview',payload,'POST',{localError:true});if(response?.task){setTaskId(response.task.id);setSubmitted(response.task);}else{setError(response?.error||'测试未开始，请稍后重试。');setSubmitted(null);}}finally{setSubmitting(false);}
 }
 async function retry(){
  if(disabled||running||!failed||retryPending.current)return;
  retryPending.current=true;setError('');setSubmitted(latest);setSubmitting(true);
  try{const response=await action(`/api/workflow-tasks/${latest.id}/retry`,{},'POST',{localError:true});if(response?.task){setTaskId(response.task.id);setSubmitted(response.task);}else{setError(response?.error||'重试未开始，请稍后重试。');}}catch(error){setError(error.message);}finally{retryPending.current=false;setSubmitting(false);}
 }
 if(!open)return null;
 const parts=previewMessageParts(message);
 const label={high:'高',medium:'中',low:'低'}[matching?.match_level]||'未判定';
 return <Dialog title="个人介绍匹配测试" onClose={onClose} className={`r37-test-dialog ${latest||error?'has-results':''}`} footer={<><InlineProgress blocked={disabled} task={latest} title="个人介绍匹配测试" action={action} success={expired?'输入已修改，请重新测试。旧结果保留，定位暂不可用。':'岗位匹配与打招呼消息已生成。'} hideRetry/>{!latest&&<span className="r37-footer-state"/>}<button className="secondary-button" onClick={onClose}>关闭</button><button className="primary-button r37-test-button" disabled={disabled||running||(!failed&&(!value.trim()||!jd.trim()))} onClick={failed?retry:generate}>{running?<LoadingIcon size={16}/>:failed?<RotateCcw size={16}/>:<Play size={16}/>} {failed?'重试':'测试'}</button></>}>
  <div className="r37-test-grid">
   <div className="r37-test-inputs">
    <div className="r37-field-title">测试岗位</div>
    <div className="r37-jd-modes">{[['default','测试岗位'],['manual','手动填写 JD']].map(([id,text])=><button key={id} className="secondary-button" aria-pressed={mode===id} onClick={()=>setMode(id)}>{text}</button>)}</div>
    {mode==='default'?<div className="r37-default-jd"><div><strong>{sample?.jd?(sample.title||'已读取岗位'):'尚无可用岗位样本'}</strong>{sample?.jd?<><small>{[sample.company,sample.location||sample.city,sample.salary?'岗位薪资 '+sample.salary:''].filter(Boolean).join(' · ')}</small></>:<small>请先读取求职期望，或切换为手动填写 JD。</small>}</div><p tabIndex={0} role="region" aria-label={sample?.jd?'首岗样本JD全文':'尚无可用岗位样本'}>{sample?.jd||'读取成功后，完整岗位JD会显示在此处。'}</p></div>:<label className="setup-field"><span>手动填写 JD</span><textarea aria-label="手动填写JD" className="r37-jd-input" value={manual} placeholder="粘贴完整岗位JD" onChange={e=>setManual(e.target.value)}/>{!manual.trim()&&<small className="setup-help">请填写JD后再测试。</small>}</label>}
    <label className="setup-field r37-template"><span>打招呼消息模板 <small>可选</small></span><textarea aria-label="匹配测试消息模板" rows={2} value={template} onChange={e=>{setTemplateEdited(true);setTemplate(e.target.value);}}/></label>
   </div>
   {(latest||error)&&<div className="r37-test-output">
    <h3>测试结果</h3>
    <div className="r37-match-scroll" ref={pane}>
     {error&&<Note kind="error">{error}<p>输入已保留，可手动重新测试。</p></Note>}

     {matching&&<><div className="r37-match-level"><span>匹配程度</span><strong className={matching.match_level||''}>{label}</strong></div><p className="r37-match-summary">{matching.matches.length?`本轮返回${matching.matches.length}项匹配依据，请结合原文核对。`:'本轮没有返回可定位的匹配依据。'}</p><details open={basisOpen} onToggle={e=>setBasisOpen(e.currentTarget.open)}><summary>查看匹配依据（{matching.matches.length}）</summary>{matching.matches.map((match,index)=><article role="button" tabIndex={expired?-1:0} aria-disabled={expired} aria-pressed={!expired&&selected.includes(index)} onClick={()=>locate([index])} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();locate([index]);}}} key={index} ref={el=>el?items.current.set(index,el):items.current.delete(index)} className={`r37-basis-item ${!expired&&selected.includes(index)?'is-highlighted':''}`}><p className="r37-basis-explanation">{match.explanation}</p><ul><li><small>个人介绍原文</small><p>{!expired&&selected.includes(index)?<mark>{match.introduction_quote}</mark>:match.introduction_quote}</p></li><li><small>JD原文</small><p>{match.jd_quote}</p></li></ul></article>)}</details></>}
    </div>
    {message&&<section className="r37-pinned-message"><div><h4>打招呼消息</h4><small>{chars(message.message)} 字符</small></div><p className="r17-message">{parts.map(part=>part.indices.length?<button type="button" key={part.start} className="message-quote" aria-label={'查看匹配依据：'+part.text} aria-pressed={!expired&&part.indices.every(i=>selected.includes(i))} disabled={expired} onClick={()=>locate(part.indices)}>{part.text}</button>:<span key={part.start}>{part.text}</span>)}</p></section>}
   </div>}
  </div>
 </Dialog>;
}

export function IntroductionFields({value,source,onChange,reference,state,action,disabled,testDisabled=disabled,readOnly=false,context,status,target,onSave,onUpload,onCancelEdit,editRequested,onEditHandled,hudTaskId,testActionTarget,mergeSegments,onMergeEnd}) {
 const profile=target==='profile',unsaved=profile&&(value!==(state.profile?.introduction||'')||JSON.stringify(source||null)!==JSON.stringify(state.profile?.introduction_source||null));
 const [testOpen,setTestOpen]=useState(false),[sourceOpen,setSourceOpen]=useState(false),[editMode,setEditMode]=useState(()=>unsaved?'edit':null),[saving,setSaving]=useState(false);
 useEffect(()=>{if(hudTaskId)setTestOpen(true);},[hudTaskId]);
 const [saveError,setSaveError]=useState('');
 const menu=useRef(null),editInput=useRef(null),previousEditMode=useRef(editMode);
 useEffect(()=>{if(previousEditMode.current==='edit'&&editMode!=='edit')onMergeEnd?.();previousEditMode.current=editMode;},[editMode]);
 useEffect(()=>setSaveError(''),[editMode]);
 useEffect(()=>{if(editMode!=='choice')return;const close=e=>{if(!menu.current?.contains(e.target))setEditMode(null);},keys=e=>{if(e.key==='Escape'){e.preventDefault();setEditMode(null);}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',keys);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',keys);};},[editMode]);
 useEffect(()=>{if(editRequested){setEditMode('edit');onEditHandled?.();}},[editRequested]);
 useEffect(()=>{if(profile&&unsaved)setEditMode('edit');},[profile,unsaved]);
 useEffect(()=>{if(profile&&!unsaved)setEditMode(null);},[state.profile?.introduction,JSON.stringify(state.profile?.introduction_source||null)]);
 useEffect(()=>{if(editMode==='edit')editInput.current?.focus({preventScroll:true});},[editMode]);
 return <>
  <p className="setup-introduction-purpose r37-purpose"><Info size={16}/><span>个人介绍将用于后续岗位匹配和打招呼消息生成。请检查经历、能力和参与程度是否准确。</span></p>
  <div className="r17-editor-grid r37-intro-grid"><div className="r17-editor-column">
   {source&&<div className="r17-source-note"><span>本介绍初稿由简历{source.supplement?'与补充经历':''}生成</span><button className="setup-text-button" onClick={()=>setSourceOpen(true)}>查看来源</button></div>}
   {profile?(editMode==='edit'?<label className="setup-field r39-edit-field"><span className="sr-only">编辑个人介绍</span><SupplementEditor inputRef={editInput} value={value} mergeSegments={mergeSegments} onChange={onChange} readOnly={readOnly} disabled={disabled&&!readOnly||saving}/></label>:<IntroductionReading value={value} context={context}/>):<IntroductionEditor label="完整个人介绍" value={value} disabled={disabled} onChange={onChange} context={context}/>}
   <div className="setup-section-actions"><span className="setup-help">{profile&&editMode==='edit'?(unsaved?'未保存的修改':'正在编辑个人介绍'):status||'待本人确认'}</span><div className="r17-intro-actions">{profile&&(editMode==='edit'?<><button className="secondary-button" disabled={disabled||saving} onClick={()=>{onCancelEdit?.();onMergeEnd?.();setEditMode(null);}}>取消修改</button><button className="primary-button" disabled={disabled||saving||!value.trim()||!unsaved||!onSave} onClick={async()=>{setSaveError('');setSaving(true);try{const response=await onSave(value);if(response?.error)setSaveError(response.error);}finally{setSaving(false);}}}>保存修改</button></>:<div className="r39-modify-anchor" ref={menu}><button className="primary-button" disabled={disabled} aria-expanded={editMode==='choice'} onClick={()=>setEditMode(editMode==='choice'?null:'choice')}>修改个人介绍</button>{editMode==='choice'&&<div className="r39-modify-menu" role="group" aria-label="选择修改方式"><button disabled={disabled} onClick={()=>setEditMode('edit')}>直接修改</button><button disabled={disabled} onClick={()=>{setEditMode(null);onUpload?.();}}>上传简历生成</button></div>}</div>)}{profile&&<button className="secondary-button" disabled={testDisabled||!value.trim()} onClick={()=>setTestOpen(true)}>个人介绍匹配测试</button>}</div></div>
   {saveError&&<Note kind="error">{saveError}</Note>}
  </div></div>
  {!profile&&testActionTarget&&createPortal(<button className="secondary-button" disabled={testDisabled||!value.trim()} onClick={()=>setTestOpen(true)}>个人介绍匹配测试</button>,testActionTarget)}
  <MatchDialog key={hudTaskId||'current'} open={testOpen} onClose={()=>setTestOpen(false)} value={value} reference={reference} state={state} action={action} target={target} disabled={testDisabled} hudTaskId={hudTaskId}/>
  {sourceOpen&&source&&<Dialog title="介绍初稿来源" onClose={()=>setSourceOpen(false)} className="r17-origin-dialog"><h3>简历文件名称</h3><p>{source.resume_name}</p><h3>补充经历原文</h3><div className="r17-source-copy" tabIndex={0}>{source.supplement||'未填写补充经历'}</div></Dialog>}
 </>;
}
