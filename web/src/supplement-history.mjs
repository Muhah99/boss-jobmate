// Transient history for the merged-introduction textarea only.
const copy=x=>structuredClone(x);
export function moveRanges(ranges,start,end,length){
 const delta=length-(end-start),parts=[];
 for(const [a,b] of ranges){
  if(a<Math.min(b,start))parts.push([a,Math.min(b,start)]);
  if(Math.max(a,end)<b)parts.push([Math.max(a,end)+delta,b+delta]);
 }
 return parts.reduce((out,r)=>{if(out.length&&out.at(-1)[1]===r[0])out.at(-1)[1]=r[1];else out.push(r);return out;},[]);
}
const sameContent=(a,b)=>a.value===b.value&&!!a.unmapped===!!b.unmapped&&JSON.stringify(a.ranges)===JSON.stringify(b.ranges);
export class SessionHistory{
 constructor(value,ranges,selection=[0,0]){
  this.current={value,ranges:copy(ranges),selection:[...selection],scroll:{top:0,left:0}};
  this.entries=[];this.cursor=0;this.groupOpen=false;this.composition=null;
 }
 snapshot(){return copy(this.current);}
 select(start,end=start){this.current.selection=[start,end];this.groupOpen=false;}
 scroll(top,left=0){this.current.scroll={top,left};}
 breakGroup(){this.groupOpen=false;}
 commit(before,after,kind,merge=false){
  this.current=copy(after);
  if(sameContent(before,after)){this.groupOpen=false;return;}
  this.entries.splice(this.cursor);
  const previous=this.entries.at(-1);
  const adjacent=before.selection[0]===before.selection[1]&&previous?.after.selection[1]===before.selection[0];
  if(merge&&this.groupOpen&&previous?.kind==='insertText'&&adjacent)previous.after=copy(after);
  else this.entries.push({before:copy(before),after:copy(after),kind});
  this.cursor=this.entries.length;this.groupOpen=merge;
 }
 edit(start,end,text,{kind='insertText'}={}){
  const before=this.snapshot(),caret=start+text.length;
  const after={...before,value:before.value.slice(0,start)+text+before.value.slice(end),ranges:moveRanges(before.ranges,start,end,text.length),selection:[caret,caret]};
  const merge=kind==='insertText'&&start===end&&text.length>0;
  this.commit(before,after,kind,merge);return this.snapshot();
 }
 undo(){
  this.groupOpen=false;
  if(this.cursor){const scroll=this.current.scroll;this.current={...copy(this.entries[--this.cursor].before),scroll};}
  return this.snapshot();
 }
 redo(){
  this.groupOpen=false;
  if(this.cursor<this.entries.length){const scroll=this.current.scroll;this.current={...copy(this.entries[this.cursor++].after),scroll};}
  return this.snapshot();
 }
 beginComposition(start,end=start){this.groupOpen=false;this.composition={before:this.snapshot(),start,end};}
 updateComposition(text){
  const c=this.composition,old=this.snapshot(),caret=c.start+text.length;
  this.current={...old,value:old.value.slice(0,c.start)+text+old.value.slice(c.end),ranges:moveRanges(old.ranges,c.start,c.end,text.length),selection:[caret,caret]};
  c.end=caret;return this.snapshot();
 }
 endComposition(cancelled=false){
  const c=this.composition;this.composition=null;
  if(cancelled){const scroll=this.current.scroll;this.current={...copy(c.before),scroll};}
  else this.commit(c.before,this.snapshot(),'composition');
  return this.snapshot();
 }
 finish(){this.entries=[];this.cursor=0;this.groupOpen=false;this.composition=null;this.current.ranges=[];}
}

export function fromSegments(segments){let value="";const ranges=[];for(const s of segments){const start=value.length;value+=s.text;if(s.is_new)ranges.push([start,value.length]);}return {value,ranges};}
export function editFromInput(previous,after,event){
  let {start,end,inputType}=event;
  const insertion=/^insert(?:Text|FromPaste|FromDrop|ReplacementText|CompositionText|FromComposition)$/.test(inputType);
  const deletion=/^delete/.test(inputType);
  if(!insertion&&!deletion)return null;
  if(deletion&&start===end){
    const removed=previous.length-after.length;
    if(removed<=0)return null;
    if(/Backward$/.test(inputType))start-=removed;
    else if(/Forward$/.test(inputType))end+=removed;
    else return null;
  }
  const count=after.length-(previous.length-(end-start));
  if(start<0||end<start||end>previous.length||count<0||(deletion&&count!==0))return null;
  const inserted=after.slice(start,start+count);
  if(previous.slice(0,start)+inserted+previous.slice(end)!==after)return null;
  return {start,end,insertedLength:count};
}
