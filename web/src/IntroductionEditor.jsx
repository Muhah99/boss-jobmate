import {useLayoutEffect,useRef} from 'react';

export function introductionParts(text,quotes=[]) {
 const ranges=[];let missing=false;
 for(const quote of new Set(quotes)){
  if(!quote){missing=true;continue;}
  let from=0,found=false,index;
  while((index=text.indexOf(quote,from))!==-1){ranges.push([index,index+quote.length]);from=index+1;found=true;}
  if(!found)missing=true;
 }
 ranges.sort((a,b)=>a[0]-b[0]);const merged=[];
 for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
 const parts=[];let cursor=0;
 for(const [start,end] of merged){if(start>cursor)parts.push({text:text.slice(cursor,start)});parts.push({text:text.slice(start,end),highlight:true});cursor=end;}
 parts.push({text:text.slice(cursor)});return {parts,missing};
}

export function IntroductionReading({value,context}) {
 const {parts,missing}=introductionParts(value,context?.introduction_quotes||[]),reading=useRef(null);
 useLayoutEffect(()=>{reading.current?.querySelector('mark')?.scrollIntoView({block:'center'});},[context?.introduction_quotes]);
 return <><section className="r39-intro-reading" aria-label="个人介绍全文" ref={reading}><p>{parts.map((part,i)=>part.highlight?<mark key={i}>{part.text}</mark>:part.text)}</p></section>{context&&(missing||context.missing_sources)&&<p className="setup-highlight-missing" role="status">部分原文已变化，无法定位</p>}</>;
}

export default function IntroductionEditor({value,onChange,disabled,readOnly=false,context,label='个人介绍'}) {
 const backdrop=useRef(null),input=useRef(null),{parts,missing}=introductionParts(value,context?.introduction_quotes||[]);
 useLayoutEffect(()=>{const sync=()=>{if(backdrop.current&&input.current){backdrop.current.style.width=(input.current.clientWidth+2)+'px';backdrop.current.scrollTop=input.current.scrollTop;}};sync();window.addEventListener('resize',sync);return()=>window.removeEventListener('resize',sync);},[value,disabled]);
 useLayoutEffect(()=>{const quote=context?.introduction_quotes?.[0],index=quote?value.indexOf(quote):-1;if(index<0||disabled)return;input.current.focus({preventScroll:true});input.current.setSelectionRange(index,index+quote.length);const mark=backdrop.current.querySelector('mark');if(mark){input.current.scrollTop=Math.max(0,mark.offsetTop-input.current.clientHeight/2);backdrop.current.scrollTop=input.current.scrollTop;}},[context?.introduction_quotes]);
 return <><div className="setup-highlight-editor"><div className="setup-highlight-backdrop" ref={backdrop} aria-hidden="true">{parts.map((part,i)=>part.highlight?<mark key={i}>{part.text}</mark>:part.text)}{'\n'}</div><textarea ref={input} aria-label={label} className="setup-intro-input" value={value} disabled={disabled} readOnly={readOnly} onChange={e=>onChange(e.target.value)} onScroll={e=>{if(backdrop.current){backdrop.current.scrollTop=e.currentTarget.scrollTop;backdrop.current.scrollLeft=e.currentTarget.scrollLeft;}}}/></div>{context&&(missing||context.missing_sources)&&<p className="setup-highlight-missing" role="status">部分原文已变化，无法定位</p>}</>;
}
