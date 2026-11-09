import {useEffect,useRef,useState} from 'react';
import {ChevronDown,ChevronRight,FileText,Inbox,Info,MapPin,PencilLine,TrainFront,Trash2,ExternalLink} from 'lucide-react';
import {BatchSelect,Dialog,ExpectationSelect,Note,LoadingIcon} from './Ui.jsx';
import {chars,labelBatch,levelLabel,jobStage} from './api.js';
import {commuteText} from './WorkPages.jsx';
import './review-learning.css';
import './review-r25.css';
import {ReviewSubmissionStatus,ReviewSubmissionResult} from './ReviewSubmissionFlow.jsx';
import HighlightedJD from './HighlightedJD.jsx';

function commute(c,compact=false){
 const result=c?.selected||c;
 const text=commuteText(compact&&result?{...c,selected:{...result,origin:undefined,origin_name:undefined,distance_km:undefined}}:c);
 return text? /^(通勤|无可用)/.test(text)?text:`通勤 ${text}`:'通勤未计算';
}

export default function ReviewPage({header,state,expectationId,setExpectationId,batchId,setBatchId,action,navigate,busy,reviewJobId,reviewSelections,setReviewSelections,pendingAction}){
 const batches=state.batches.filter(b=>String(b.expectation_id)===String(expectationId));
 const batch=batches.find(b=>b.id===batchId)||(batchId==='__no-reviewing__'?null:batches.findLast(b=>b.status!=='voided'));
 const items=batch?.jobs||[];
 const [selected,setSelected]=useState(reviewJobId),[editing,setEditing]=useState(false),[original,setOriginal]=useState(false);
 const [highlight,setHighlight]=useState(null),[expanded,setExpanded]=useState(false),[pendingOriginal,setPendingOriginal]=useState(null);
 const [confirm,setConfirm]=useState(false),[voidConfirm,setVoidConfirm]=useState(false),[removeId,setRemoveId]=useState(null);
 const [legacyDiscard,setLegacyDiscard]=useState(null);
 const [submissionResult,setSubmissionResult]=useState(null),[submitError,setSubmitError]=useState(''),submissionContext=useRef(null);
 submissionContext.current=batch?.id;
 useEffect(()=>{if(!batch)return;const url=new URL(location.href);url.searchParams.set('review_batch',batch.id);url.searchParams.set('review_expectation',String(expectationId));history.replaceState(null,'',url);},[batch?.id,expectationId]);
 useEffect(()=>()=>{submissionContext.current=null;},[]);
 const [error,setError]=useState(''),[removeError,setRemoveError]=useState(''),[localDrafts,setLocalDrafts]=useState({});
 const mappingList=useRef(null),cards=useRef({}),messageBox=useRef(null);
 const drafts=setReviewSelections?(reviewSelections?.batchId===batch?.id?reviewSelections.values:{}):localDrafts;
 const setDrafts=update=>setReviewSelections?setReviewSelections(v=>({batchId:batch?.id,values:update(v.batchId===batch?.id?v.values:{})})):setLocalDrafts(update);
 const item=items.find(i=>i.job_id===selected)||items[0],job=item?.job||state.jobs.find(j=>j.id===item?.job_id)||{};
 const submitted=batch?.status!=='reviewing',reference=item?.review?.original,changed=!!reference&&item.message!==reference.original_message;
 const mappings=changed?reference.original_mappings||[]:item?.mappings||[],sources=changed?reference.sources||[]:item?.sources||[];
 const message=original&&changed?reference.original_message:item?.message||'',canLocate=!changed||original;
 const blocked=busy||submitted||state.locks.jobs||!!item?.review?.pending;
 const submittingBatch=pendingAction?.path===`/api/batches/${batch?.id}/submit`;
 const unsaved=items.some(i=>typeof drafts[i.job_id]==='string'&&drafts[i.job_id]!==i.message);
 const removing=items.find(i=>i.job_id===removeId);
 function clearLocation(){setOriginal(false);setHighlight(null);setExpanded(false);setPendingOriginal(null);}
 useEffect(()=>{setSelected(reviewJobId);setEditing(false);clearLocation();setError('');setConfirm(false);setSubmissionResult(null);setSubmitError('');setRemoveId(null);setVoidConfirm(false);},[expectationId,batch?.id,reviewJobId]);
 useEffect(()=>{if(!item)return;setEditing(typeof drafts[item.job_id]==='string');clearLocation();setError('');},[item?.job_id]);
 useEffect(()=>{
  if(highlight===null)return;
  const locate=()=>{for(const [box,node] of [[mappingList.current,cards.current[highlight]],[messageBox.current,messageBox.current?.querySelector(`[data-mapping-index="${highlight}"]`)]]){
   if(!box||!node)continue;const a=box.getBoundingClientRect(),b=node.getBoundingClientRect();
   if(b.top<a.top||b.bottom>a.bottom)box.scrollTop+=b.top-a.top-8;
  }};locate();window.addEventListener('resize',locate);return()=>window.removeEventListener('resize',locate);
 },[highlight,expanded,original]);
 function select(id){setSelected(id);setEditing(typeof drafts[id]==='string');clearLocation();setError('');}
 function messageLocate(index){
  if(highlight===index){setHighlight(null);return;}
  setExpanded(true);setHighlight(index);
 }
 function mappingLocate(index){
  if(highlight===index){setHighlight(null);return;}
  if(changed&&!original){setPendingOriginal(index);return;}
  setExpanded(true);setHighlight(index);
 }
 function messageParts(){
  if(!canLocate)return message;
  const ranges=[];
  mappings.forEach((m,index)=>{let from=0,pos;while(m.message_quote&&(pos=message.indexOf(m.message_quote,from))!==-1){ranges.push({start:pos,end:pos+m.message_quote.length,index});from=pos+m.message_quote.length;}});
  const points=[...new Set([0,message.length,...ranges.flatMap(r=>[r.start,r.end])])].sort((a,b)=>a-b);
  return points.slice(0,-1).map((p,i)=>{const links=ranges.filter(r=>r.start<=p&&r.end>=points[i+1]),r=links.find(r=>r.index===highlight)||links[0],text=message.slice(p,points[i+1]);return r?<button key={p} data-mapping-index={r.index} aria-label={'查看关联：'+text} aria-pressed={highlight===r.index} className={`r40-message-link ${highlight===r.index?'active':''}`} onClick={()=>messageLocate(r.index)}>{text}</button>:text;});
 }
 function discardDraft(id){setDrafts(v=>{const next={...v};delete next[id];return next;});}
 async function begin(){
  setError('');const r=await action(`/api/batches/${batch.id}/jobs/${item.job_id}/begin`,{},'POST',{localError:true});
  if(r?.error)setError(r.error);else if(r){setDrafts(v=>({...v,[item.job_id]:typeof v[item.job_id]==='string'?v[item.job_id]:item.message}));setEditing(true);clearLocation();}
 }
 async function save(){
  setError('');const r=await action(`/api/batches/${batch.id}/jobs/${item.job_id}/save`,{message:drafts[item.job_id]},'POST',{localError:true});
  if(r?.error)setError(r.error);else if(r){discardDraft(item.job_id);setEditing(false);clearLocation();}
 }
 async function submitBatch(){
  const id=batch.id;setSubmitError('');
  const r=await action(`/api/batches/${id}/submit`,{confirmed:true},'POST',{localError:true});
  if(submissionContext.current!==id)return;
  if(r?.error){setSubmitError(r.error);return;}
  if(r?.batch?.id===id&&['submitted','completed'].includes(r.batch.status)){setConfirm(false);clearLocation();setSubmissionResult(r.batch);}
  else if(r)setSubmitError('提交结果尚未确认，请刷新当前投递安排核对。');
 }
 async function remove(){
  setRemoveError('');const r=await action(`/api/batches/${batch.id}/jobs/${removeId}/remove`,{confirmed:true},'POST',{localError:true});
  if(r?.error)setRemoveError(r.error);else if(r){discardDraft(removeId);if(removeId===item?.job_id){setSelected(null);setEditing(false);clearLocation();setError('');}setRemoveId(null);}
 }
 const context=<div className="r40-batch"><ExpectationSelect expectations={state.expectations} value={expectationId} onChange={setExpectationId} id="review-expectation"/><BatchSelect batches={batches} allBatches={state.batches} value={batch?.id} onChange={setBatchId}/>{batch?.status==='reviewing'&&<button className="secondary-button" disabled={busy||!batch.can_void} title={batch.void_reason} onClick={()=>setVoidConfirm(true)}>作废</button>}</div>;
 if(!items.length)return <main className="page-shell r40-review-v25">{header}{context}<div className="empty-state"><Inbox size={34}/><h2>{batch?.status==='voided'?'此投递安排已作废':batch?.removed_jobs?.length?'当前投递安排暂无岗位':'当前求职期望没有待审阅的投递安排'}</h2><p>{batch?.removed_jobs?.length?'已移除的岗位可在岗位池的淘汰列表中查看。':'已有消息与关联按投递安排保存。'}</p><button className="secondary-button" onClick={()=>navigate(batch?.removed_jobs?.length?'pool':'tasks')}>{batch?.removed_jobs?.length?'查看岗位池':'查看岗位任务'}</button></div></main>;
 return <main className="page-shell r40-review-v25">{header}{context}
  {submitted&&<ReviewSubmissionStatus batch={batch} state={state} navigate={navigate}/> }
  <div className="r40-review-layout"><aside className="r40-jobs"><h3>本次投递岗位 <span>{items.length}</span></h3>
   {items.map((r,i)=>{const modified=!!r.review?.original&&r.message!==r.review.original.original_message,status=typeof drafts[r.job_id]==='string'?'未保存编辑':submitted?jobStage(r.job||{},state,batch,r):modified?'已修改':r.choice==='skip'?'不投递':'待审阅';return <div key={r.job_id} className={`r40-job ${r.job_id===item.job_id?'selected':''}`}>
    <button className="r40-job-select" onClick={()=>select(r.job_id)}><span className="r40-job-index">{i+1}</span><span className="r40-job-copy"><strong>{r.job?.title||r.job_id}</strong><small className="r40-job-meta">{[r.job?.company,r.job?.salary].filter(Boolean).join(' · ')}</small><span className="r40-job-status"><span className={`r40-list-status ${submitted?'submitted':modified?'modified':'pending'}`}>{status}</span><span className="r40-list-commute"><TrainFront size={12}/>{commute(r.job?.commute,true)}</span></span></span></button>
    <button className="r40-remove" title="移除岗位" aria-label={`移除岗位：${r.job?.title||r.job_id}`} disabled={busy} onClick={()=>{setRemoveId(r.job_id);setRemoveError('');}}><Trash2 size={19}/></button>
   </div>;})}</aside>
   <section className="r40-job-main"><div className="r40-job-heading"><h2><span className="r40-title-text">{job.title||item.job_id}<span className={`r40-match-level ${job.match_level||''}`}>匹配程度 · {levelLabel(job.match_level)||'未记录'}</span></span><strong>{job.salary}</strong></h2><p>{[job.company,job.city,job.industry,job.size||job.company_size].filter(Boolean).join(' · ')}</p>
    <div className="r40-tags">{[...new Set(job.tags||job.detail_tags||[])].slice(0,3).map(t=><span key={t}>{t}</span>)}{job.previously_applied_company&&<span>已投递公司 · 新岗位</span>}</div><div className="r40-basic-facts">{job.address&&<span><MapPin size={14}/>{job.address}</span>}<span><TrainFront size={14}/>{commute(job.commute)}</span>{(job.detail_url||job.url||job.boss_url)&&<button className="text-button" disabled={state.browserBusy||state.activeProgress?.type==='browser'} onClick={()=>action(`/api/jobs/${item.job_id}/open`,{})}><ExternalLink size={13}/>查看 BOSS 岗位</button>}</div>
   </div><div className="r40-columns"><article className="r40-jd"><h3><FileText size={16}/>岗位详情 · 完整 JD</h3><HighlightedJD text={item.jd_basis??(changed?reference.full_jd:undefined)??job.jd??'暂无 JD'} mappings={mappings} active={highlight} reference={changed} onSelect={index=>{if(!editing)mappingLocate(index);}}/></article>
    <section className="r40-message"><h3>打招呼消息{!submitted&&!editing&&<button className="secondary-button" disabled={blocked} onClick={begin}><PencilLine size={14}/>修改消息</button>}</h3>
     {editing?<><div className="r40-learning-tip"><Info size={15}/>AI 会记住你的修改，帮助后续避免同类错误。</div><div className="r40-edit-area"><label htmlFor="r40-message-edit">编辑打招呼消息</label><textarea id="r40-message-edit" aria-label="编辑打招呼消息" value={drafts[item.job_id]??item.message} disabled={blocked} onChange={e=>setDrafts(v=>({...v,[item.job_id]:e.target.value}))}/></div>{error&&<div className="r40-save-error" tabIndex={0}><Note kind="error">{error}</Note></div>}<div className="r40-edit-actions"><button className="secondary-button" disabled={busy} onClick={()=>{discardDraft(item.job_id);setEditing(false);setError('');}}>取消</button><button className="primary-button" disabled={blocked||!(drafts[item.job_id]??item.message)?.trim()} onClick={save}>保存消息</button></div></>:<>
      <div className="r40-message-fixed" ref={messageBox} tabIndex={0}><p className="r40-linked-message">{messageParts()}</p><div className="r40-message-caption"><small>{original?'原消息参考':submitted?'已提交待投递':changed?'已保存修改':'点击带下划线的文字查看对应依据'} · {chars(message)} 字符</small>{changed&&<button className="text-button" onClick={()=>{setOriginal(!original);setHighlight(null);}}>{original?'返回当前消息':'查看原消息'}</button>}</div></div>
      {error&&<Note kind="error">{error}</Note>}{item.review?.pending&&<Note kind="error">旧版自动修改已停用，请结束该未完成记录后手工编辑。{item.review.pending.error}<button disabled={busy} onClick={()=>setLegacyDiscard(item.review.pending.id)}>结束旧版修改</button></Note>}
      <button className="r40-mapping-toggle" aria-expanded={expanded} aria-controls="r40-mapping-scroll" onClick={()=>setExpanded(!expanded)}><span>{expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>} {changed?'原消息匹配依据 · 参考':'匹配依据与消息关联'}</span><span>{mappings.length} 条 · {expanded?'收起':'展开'}</span></button>
      <div id="r40-mapping-scroll" className="r40-mapping-scroll" hidden={!expanded} ref={mappingList} tabIndex={0} aria-label="匹配依据">{changed&&<p className="r40-mapping-note">消息已修改，以下保留原消息的匹配依据，仅供参考</p>}
       {mappings.map((m,i)=>{const source=sources.find(s=>s.fact_id===m.fact_id)||reference?.facts?.find(s=>s.fact_id===m.fact_id)||{},explanation=job.matches?.find(match=>(m.jd_quotes||[]).includes(match.jd_quote)&&source.introduction_quote?.includes(match.introduction_quote))?.explanation;return <article key={i} ref={node=>cards.current[i]=node} className={`r40-mapping-card ${highlight===i?'highlight':''}`} role="button" tabIndex={0} aria-label={`匹配依据 ${i+1}`} aria-pressed={highlight===i} onClick={()=>mappingLocate(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();mappingLocate(i);}}}><p className="r40-mapping-reason">{i+1}. {explanation||source.text||m.fact_id}</p><ul className="r40-mapping-sources"><li><small>个人介绍原文</small><p>{source.introduction_quote||'历史来源未保存'}</p></li>{Array.isArray(m.tag_quotes)&&m.tag_quotes.length>0&&<li><small>标签原文</small><p>{m.tag_quotes.join('；')}</p></li>}{Array.isArray(m.jd_quotes)&&m.jd_quotes.length>0&&<li><small>JD原文</small><p>{m.jd_quotes.join('；')}</p></li>}</ul></article>;})}
       {!mappings.length&&<p className="muted">此消息未保存可定位的关联。</p>}
      </div>
     </>}
    </section></div></section>
  </div><footer className={'r40-batch-footer '+(submitted?'submission-finished':'')}>{submitted?<button className="secondary-button" onClick={()=>navigate('tasks')}>返回岗位任务</button>:<><div><strong>本次投递 {items.length} 个岗位</strong>{unsaved&&<small>存在未保存编辑，请先保存或取消。</small>}</div><button className="primary-button" disabled={busy||unsaved||!batch.can_submit} onClick={()=>{setSubmitError('');setConfirm(true);}}>{submittingBatch&&!confirm&&<LoadingIcon/>}提交审阅，进入待投递</button></>}</footer>
  {pendingOriginal!==null&&<Dialog className="r40-original-confirm" title="是否查看原消息？" onClose={()=>setPendingOriginal(null)} footer={<><button className="secondary-button" onClick={()=>setPendingOriginal(null)}>否</button><button className="primary-button" onClick={()=>{setExpanded(true);setOriginal(true);setHighlight(pendingOriginal);setPendingOriginal(null);}}>是</button></>}/>}
  {removing&&<Dialog title="是否移除该岗位？" onClose={()=>{if(!busy)setRemoveId(null);}} footer={<><button className="secondary-button" disabled={busy} onClick={()=>setRemoveId(null)}>取消</button><button className="primary-button" disabled={busy} onClick={remove}>确定</button></>}><p>{removing.job?.title||removing.job_id}</p><p>{removing.job?.company}</p><p>从本次投递安排中移除，归入“淘汰”。</p>{removeError&&<Note kind="error">{removeError}</Note>}</Dialog>}
  {submissionResult?.id===batch.id&&<ReviewSubmissionResult batch={submissionResult} onStay={()=>setSubmissionResult(null)} onDelivery={()=>{setSubmissionResult(null);navigate('today');}}/>}
  {confirm&&!submitted&&<Dialog title="提交本次审阅，进入待投递？" onClose={busy?undefined:()=>setConfirm(false)} footer={<><button className="secondary-button" disabled={busy} onClick={()=>setConfirm(false)}>返回审阅</button><button className="primary-button" disabled={busy} onClick={submitBatch}>{submittingBatch&&<LoadingIcon/>}提交待投递</button></>}><p>{labelBatch(batch,state.batches)} · {items.length} 个岗位</p><p>{items.filter(i=>i.choice!=='skip').length} 个待投递{items.some(i=>i.choice==='skip')?` · ${items.filter(i=>i.choice==='skip').length} 个不投递`:''}</p><p>已保存消息将提交待投递，有效修改随后用于更新审阅知识。无需等待知识更新，不会立即发送。</p>{submitError&&<Note kind="error">{submitError}</Note>}</Dialog>}
  {voidConfirm&&<Dialog title="作废本次投递安排？" onClose={()=>setVoidConfirm(false)} footer={<><button className="secondary-button" onClick={()=>setVoidConfirm(false)}>取消</button><button className="primary-button" disabled={busy} onClick={async()=>{const r=await action(`/api/batches/${batch.id}/void`,{confirmed:true,expectation_id:expectationId});if(r){setVoidConfirm(false);setBatchId('__no-reviewing__');}}}>确认作废</button></>}><p>将清除本次投递的消息、关联与审阅记录，岗位回到岗位池。重新准备投递会消耗模型额度或费用。</p></Dialog>}
  {legacyDiscard&&<Dialog title="结束旧版未完成修改？" onClose={()=>setLegacyDiscard(null)} footer={<><button className="secondary-button" disabled={busy} onClick={()=>setLegacyDiscard(null)}>取消</button><button className="primary-button" disabled={busy} onClick={async()=>{const result=await action(`/api/workflow-tasks/${legacyDiscard}/abandon`,{confirmed:true});if(result)setLegacyDiscard(null);}}>确认结束</button></>}><p>仅结束这条旧版自动修改，当前消息、人工草稿和知识记录保留。结束后可手工编辑，不会运行旧模型处理。</p></Dialog>}
 </main>;
}
