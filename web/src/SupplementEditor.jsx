import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {SessionHistory,editFromInput,moveRanges,fromSegments} from './supplement-history.mjs';
import './supplement-highlight.css';

// Only the current merged-introduction editing session owns this in-memory history.
export default function SupplementEditor({value,onChange,mergeSegments,inputRef,disabled,readOnly}){
 const local=useRef(null),back=useRef(null),history=useRef(null),snapshot=useRef(null),composition=useRef(null),ending=useRef(null),handled=useRef(null);
 const [,paint]=useState(0),change=useRef(onChange);change.current=onChange;
 const h=history.current,state=h?.current,tracked=!!h;
 function redraw(){paint(n=>n+1);}
 function syncScroll(){if(back.current&&local.current){back.current.scrollTop=local.current.scrollTop;back.current.scrollLeft=local.current.scrollLeft;}}
 useLayoutEffect(()=>{
  history.current=mergeSegments?new SessionHistory(value,fromSegments(mergeSegments).ranges):null;
  snapshot.current=null;composition.current=null;redraw();
 },[mergeSegments]);
 useLayoutEffect(syncScroll);
 useEffect(()=>()=>{clearTimeout(ending.current);history.current?.finish();},[]);
 useEffect(()=>{if(history.current&&!composition.current&&value!==history.current.current.value){history.current=null;snapshot.current=null;redraw();}},[value]);
 function apply(next){
  const el=local.current,top=el.scrollTop,left=el.scrollLeft;
  el.value=next.value;el.setSelectionRange(...next.selection);el.scrollTop=top;el.scrollLeft=left;
  change.current(next.value);redraw();syncScroll();
 }
 function restore(direction){
  const current=history.current,el=local.current;if(!current||composition.current)return;
  current.scroll(el.scrollTop,el.scrollLeft);apply(direction==='undo'?current.undo():current.redo());snapshot.current=null;
 }
 function suppress(direction){handled.current=direction;queueMicrotask(()=>{if(handled.current===direction)handled.current=null;});}
 const handlers=useRef({});
 handlers.current={
  input:e=>input(e),
  before(e){
   const current=history.current,el=local.current;if(!current)return;
   if(/^history/.test(e.inputType)&&!composition.current){
    const direction=e.inputType==='historyUndo'?'undo':'redo';
    if(e.cancelable){e.preventDefault();if(handled.current!==direction)restore(direction);else apply(current.snapshot());suppress(direction);}return;
   }
   if(!composition.current){if(current.current.selection[0]!==el.selectionStart||current.current.selection[1]!==el.selectionEnd)current.select(el.selectionStart,el.selectionEnd);snapshot.current={value:el.value,start:el.selectionStart,end:el.selectionEnd,inputType:e.inputType};}
  },
  start(){
   const current=history.current,el=local.current;if(!current)return;
   current.select(el.selectionStart,el.selectionEnd);composition.current={before:current.snapshot(),start:el.selectionStart,end:el.selectionEnd,escape:false};
  },
  end(){
   const c=composition.current;if(!c)return;
   clearTimeout(ending.current);ending.current=setTimeout(()=>{
    const current=history.current,el=local.current;if(!current||composition.current!==c||!el)return;
    if(c.escape&&el.value===c.before.value){current.current={...structuredClone(c.before),scroll:{top:el.scrollTop,left:el.scrollLeft}};apply(current.snapshot());}
    else current.commit(c.before,current.snapshot(),'composition');
    composition.current=null;snapshot.current=null;redraw();
   },0);
  }
 };
 useEffect(()=>{
  const el=local.current,before=e=>handlers.current.before(e),onInput=e=>handlers.current.input(e),start=e=>handlers.current.start(e),end=e=>handlers.current.end(e);
  el.addEventListener('beforeinput',before);el.addEventListener('input',onInput);el.addEventListener('compositionstart',start);el.addEventListener('compositionend',end);
  return()=>{el.removeEventListener('beforeinput',before);el.removeEventListener('input',onInput);el.removeEventListener('compositionstart',start);el.removeEventListener('compositionend',end);};
 },[]);
 function input(e){
  const el=e.target,current=history.current,event=e.nativeEvent||e;
  if(!current){change.current(el.value);return;}
  if(/^history/.test(event.inputType||'')&&!composition.current){const direction=event.inputType==='historyUndo'?'undo':'redo';if(handled.current===direction)apply(current.snapshot());else restore(direction);return;}
  const c=composition.current,before=c?.before||current.snapshot(),captured=c?{value:c.before.value,start:c.start,end:c.end,inputType:'insertCompositionText'}:snapshot.current;
  const edit=captured?.value===before.value?editFromInput(before.value,el.value,captured):null;
  const unmapped=!!before.unmapped||!edit;
  const after={value:el.value,ranges:unmapped?before.ranges:moveRanges(before.ranges,edit.start,edit.end,edit.insertedLength),selection:[el.selectionStart,el.selectionEnd],scroll:{top:el.scrollTop,left:el.scrollLeft},unmapped};
  if(c)current.current=after;
  else current.commit(before,after,unmapped?'unmapped':captured.inputType,!unmapped&&captured.inputType==='insertText'&&captured.start===captured.end&&edit.insertedLength>0);
  snapshot.current=null;change.current(el.value);redraw();syncScroll();
 }
 function keys(e){
  const current=history.current;if(!current)return;
  if(e.nativeEvent.isComposing||composition.current){if(e.key==='Escape'&&composition.current)composition.current.escape=true;return;}
  const k=e.key.toLowerCase();if((e.ctrlKey||e.metaKey)&&!e.altKey&&(k==='z'||k==='y')){e.preventDefault();const direction=k==='y'||e.shiftKey?'redo':'undo';restore(direction);suppress(direction);return;}
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Tab'].includes(e.key))current.breakGroup();
 }
 const parts=[];let at=0;
 if(state&&!state.unmapped){for(const [a,b]of state.ranges){parts.push(value.slice(at,a),<mark key={a}>{value.slice(a,b)}</mark>);at=b;}parts.push(value.slice(at));}
 const note=state?.unmapped?'已保留输入；本次输入的高亮位置尚未确定。':state?.ranges.length?'黄色为本次补充内容；编辑时保留剩余原文高亮，新输入不标记。':'本次补充高亮已全部移除，可撤销恢复。';
 return <>{tracked&&<span className="supplement-highlight-note" role="status">{note}</span>}<div className={`supplement-highlight-surface ${tracked?'is-tracked':''}`}>
  {tracked&&<div className="supplement-highlight-backdrop" aria-hidden="true" ref={back}>{state.unmapped?value:parts}{'\n'}</div>}
  <textarea ref={el=>{local.current=el;if(inputRef)inputRef.current=el;}} className="r39-intro-edit-input" aria-label="编辑个人介绍" rows={10} value={value} readOnly={readOnly} disabled={disabled} onChange={()=>{}} onKeyDown={keys} onPointerDown={()=>history.current?.breakGroup()} onBlur={()=>history.current?.breakGroup()} onScroll={syncScroll}/>
 </div></>;
}
