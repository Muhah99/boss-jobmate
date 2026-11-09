import {useEffect,useRef} from 'react';
import './jd-highlight.css';

// Exact saved quotes only. Indices preserve distinct mappings even when fact IDs or text repeat.
export function jdQuoteParts(text,mappings){
 const ranges=[];
 mappings.forEach((m,index)=>{for(const quote of m.jd_quotes||[]){if(!quote)continue;let at=text.indexOf(quote);while(at>=0){ranges.push({start:at,end:at+quote.length,index});at=text.indexOf(quote,at+quote.length);}}});
 const cuts=[...new Set([0,text.length,...ranges.flatMap(r=>[r.start,r.end])])].sort((a,b)=>a-b);
 return cuts.slice(0,-1).map((start,i)=>({start,text:text.slice(start,cuts[i+1]),links:[...new Set(ranges.filter(r=>r.start<=start&&r.end>=cuts[i+1]).map(r=>r.index))]}));
}
export default function HighlightedJD({text='',mappings=[],active=null,reference=false,onSelect}){
 const panel=useRef(null);
 useEffect(()=>{const locate=()=>{const p=panel.current,e=p?.querySelector('.jd-source-mark.active');if(!e)return;const a=p.getBoundingClientRect(),b=e.getBoundingClientRect();if(b.top<a.top||b.bottom>a.bottom)p.scrollTop+=b.top-a.top-16;};locate();window.addEventListener('resize',locate);return()=>window.removeEventListener('resize',locate);},[active,text]);
 return <><p className="jd-highlight-caption">{reference?'下划线为原消息引用的 JD 原文，点击查看对应依据，仅供参考':'下划线为消息引用的 JD 原文，点击查看对应依据'}</p><div className="r40-jd-body" ref={panel} tabIndex={0} aria-label="完整JD与引用高亮">{jdQuoteParts(text,mappings).map(part=>{if(!part.links.length)return part.text;const selected=part.links.includes(active),index=selected?active:part.links[0];return <mark key={part.start} role="button" tabIndex={0} data-jd-mapping-indices={part.links.join(',')} aria-pressed={selected} aria-label={'查看JD匹配依据：'+part.text} onClick={()=>onSelect?.(index)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect?.(index);}}} className={'jd-source-mark'+(selected?' active':'')}>{part.text}</mark>;})}</div></>;
}
