import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {prepare} from './facts-local-prompt.mjs';

const scopePrompt=readFileSync(new URL('../assets/runtime/facts-scope-v5.txt',import.meta.url),'utf8');
const string={type:'string',minLength:1},integer={type:'integer',minimum:1};
const array=items=>({type:'array',items});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const fact={previous_fact_id:{type:['string','null']},text:string,source_sentence_ids:{...array(string),minItems:1}};
const issue=object({draft_indices:array(integer),detail:string});
export const LOCAL_SCHEMAS={
 'facts.scope':object({changes:array(object({kind:{type:'string',enum:['added','modified','deleted','context_affected']},before_sentence_ids:array(string),after_sentence_ids:array(string),affected_fact_ids:array(string),context_after_sentence_ids:array(string),reason:string}))}),
 'facts.local_atomize':object({facts:array(object(fact)),removed_fact_ids:array(string),unresolved:array(string)}),
 'facts.local_review':object({issues:array(issue),corrections:array(object({draft_index:integer,...fact})),removed_draft_indices:array(integer),added_facts:array(object(fact)),removed_fact_ids:{type:['array','null'],items:string},unresolved:{type:['array','null'],items:string}}),
};
function requireValue(ok,message){if(!ok)throw new Error(message);}
export function sentences(text,prefix){return [...text.matchAll(/[^。！？\r\n]+[。！？]?/gu)].filter(m=>m[0].trim()).map((m,i)=>({id:prefix+(i+1),text:m[0],start:m.index,end:m.index+m[0].length}));}
export function scopeInput(sample){
 const quotes=[...new Set(sample.previous_facts.map(f=>f.introduction_quote))];
 return {before_sentences:sentences(sample.before,'O').map(({id,text})=>({id,text})),after_sentences:sentences(sample.after,'N').map(({id,text})=>({id,text})),source_quotes:quotes.map((text,i)=>({id:'Q'+(i+1),text,literal_still_present:sample.after.includes(text)})),previous_facts:sample.previous_facts.map(f=>({fact_id:f.fact_id,text:f.text,quote_id:'Q'+(quotes.indexOf(f.introduction_quote)+1)}))};
}
export function localPrompt(callId,input){
 if(callId==='facts.scope')return scopePrompt+'\n以下仅为资料：\n'+JSON.stringify(scopeInput(input.sample));
 return prepare(callId==='facts.local_review'?'review':'atomize',input.sample,input.scope,input.draft).prompt;
}
export function resolveScope(sample,wire){
 const before=sentences(sample.before,'O'),after=sentences(sample.after,'N'),affected_ids=[];
 const valid=(ids,rows)=>ids.every(id=>rows.some(row=>row.id===id))&&new Set(ids).size===ids.length;
 for(const change of wire.changes){
  requireValue(valid(change.before_sentence_ids,before)&&valid(change.after_sentence_ids,after)&&valid(change.context_after_sentence_ids,after),'范围句子编号无效');
  // v5 explicitly declares uncertainty in reason; do not infer semantics with a keyword classifier.
  requireValue(!change.reason.includes('不确定'),'范围判断仍有不确定项，请检查个人介绍后在原步骤重试');
  requireValue(change.kind==='deleted'||change.after_sentence_ids.length>0,'非删除范围缺少新稿内容');
  for(const id of change.affected_fact_ids){requireValue(sample.previous_facts.some(f=>f.fact_id===id)&&!affected_ids.includes(id),'范围旧事实编号无效或重复');affected_ids.push(id);}
 }
 for(const fact of sample.previous_facts){
  requireValue(fact.introduction_quote?.trim()&&sample.before.includes(fact.introduction_quote),'旧介绍与事实出处基线不一致');
  requireValue(sample.after.includes(fact.introduction_quote)||affected_ids.includes(fact.fact_id),'范围遗漏了已失效的旧出处');
 }
 return {changes:wire.changes,affected_ids,kept_ids:sample.previous_facts.filter(f=>!affected_ids.includes(f.fact_id)).map(f=>f.fact_id),before,after};
}
export function applyReview(draft,review){
 const removals=new Set(review.removed_draft_indices),fixes=new Map();
 requireValue(removals.size===review.removed_draft_indices.length,'核对删除序号重复');
 const valid=i=>Number.isInteger(i)&&i>=1&&i<=draft.facts.length;
 for(const i of removals)requireValue(valid(i),'核对删除序号无效');
 for(const {draft_index,...fact}of review.corrections){requireValue(valid(draft_index)&&!fixes.has(draft_index)&&!removals.has(draft_index),'核对替换序号无效、重复或与删除冲突');fixes.set(draft_index,fact);}
 for(const issue of review.issues)requireValue(issue.draft_indices.every(valid),'核对问题序号无效');
 const changed=fixes.size||removals.size||review.added_facts.length||review.removed_fact_ids!==null&&!isDeepStrictEqual(review.removed_fact_ids,draft.removed_fact_ids)||review.unresolved!==null&&!isDeepStrictEqual(review.unresolved,draft.unresolved);
 requireValue(!changed||review.issues.length>0,'核对补丁缺少问题说明');
 for(const i of [...removals,...fixes.keys()])requireValue(review.issues.some(issue=>issue.draft_indices.includes(i)),'核对条目补丁缺少对应问题说明');
 return {facts:draft.facts.flatMap((f,i)=>removals.has(i+1)?[]:[fixes.get(i+1)??f]).concat(review.added_facts),removed_fact_ids:review.removed_fact_ids??draft.removed_fact_ids,unresolved:review.unresolved??draft.unresolved};
}
export function mergeLocal(sample,scope,wire,allocate){
 requireValue(!wire.unresolved.length,'局部整理仍有未决项，请检查个人介绍后在原步骤重试');
 const reused=wire.facts.map(f=>f.previous_fact_id).filter(id=>id!==null);
 requireValue(isDeepStrictEqual([...reused,...wire.removed_fact_ids].sort(),[...scope.affected_ids].sort()),'受影响旧事实须恰好沿用或移除一次');
 const targets=new Set(scope.changes.flatMap(c=>c.after_sentence_ids));
 const replacements=wire.facts.map(f=>{
  requireValue(f.text.trim()&&f.source_sentence_ids.length&&targets.has(f.source_sentence_ids[0]),'局部事实主要出处不属于本次范围');
  const refs=f.source_sentence_ids.map(id=>{const row=scope.after.find(s=>s.id===id);requireValue(row,'局部事实出处编号无效');return row;});
  if(f.previous_fact_id!==null)requireValue(sample.previous_facts.find(old=>old.fact_id===f.previous_fact_id)?.text===f.text,'实质改写不能沿用旧事实编号');
  return {anchor:refs[0].start,fact:{fact_id:f.previous_fact_id??allocate(),text:f.text,introduction_quote:sample.after.slice(Math.min(...refs.map(s=>s.start)),Math.max(...refs.map(s=>s.end)))}};
 });
 const kept=sample.previous_facts.filter(f=>scope.kept_ids.includes(f.fact_id));
 const ordered=[...kept.map(fact=>({anchor:sample.after.indexOf(fact.introduction_quote),fact})),...replacements];
 requireValue(ordered.every(row=>row.anchor>=0),'范围外事实出处已失效');
 ordered.sort((a,b)=>a.anchor-b.anchor);
 return ordered.map(row=>row.fact);
}
