import {useEffect,useRef,useState} from 'react';
import {FileText,Save} from 'lucide-react';
import './greeting-reference.css';

export default function GreetingReference({state,action,saveDraft,disabled}){
 const saved={reference:state.settings.reference??'',message_max_chars:state.settings.message_max_chars??60};
 const restored=()=>({...saved,...Object.fromEntries(Object.entries(state.settingsDraft||{}).filter(([key])=>['reference','message_max_chars'].includes(key)))});
 const [value,setValue]=useState(restored),[error,setError]=useState(false),editing=useRef(false);
 useEffect(()=>{if(!editing.current)setValue(restored());},[JSON.stringify(saved),JSON.stringify(state.settingsDraft)]);
 const valid=/^[0-9]+$/.test(String(value.message_max_chars))&&Number.isInteger(Number(value.message_max_chars))&&Number(value.message_max_chars)>0;
 const dirty=value.reference!==saved.reference||String(value.message_max_chars)!==String(saved.message_max_chars);
 function update(patch){const next={...value,...patch};editing.current=true;setValue(next);setError(false);saveDraft('/api/settings/draft',next);}
 async function save(){
  if(disabled||!dirty||!valid)return;
  setError(false);
  const result=await action('/api/settings',{reference:value.reference,message_max_chars:Number(value.message_max_chars)},'POST',{localError:true});
  if(result?.error||!result)setError(true);
  else{editing.current=false;setValue({reference:result.settings.reference,message_max_chars:result.settings.message_max_chars});}
 }
 return <section className="settings-card setup-section greeting-reference-card" aria-label="招呼参考语设置"><div className="settings-card-head"><div><FileText size={18}/><h2>招呼参考语</h2></div></div><p className="setup-section-sub">用于消息生成，不作为岗位匹配输入。</p><div className="greeting-reference-layout"><div className="setup-message-length"><div className="setup-message-length-row"><label className="setup-field"><span>首次生成字数上限</span><div className="setup-message-length-input"><input type="text" inputMode="numeric" aria-label="首次生成字数上限" aria-describedby="message-length-help" aria-invalid={dirty&&!valid} value={value.message_max_chars} disabled={disabled} onChange={e=>update({message_max_chars:e.target.value})}/><span>字</span></div></label><div className="setup-message-length-auto"><span>自动补漏上限</span><strong>{valid?Number(value.message_max_chars)+10:'—'} <small>字</small></strong><small>首次上限 + 10，只读</small></div></div>{dirty&&!valid&&<span className="setup-message-length-error" role="alert">请输入正整数，不能留空或填写零、负数、小数及非数字。</span>}<span className="setup-help" id="message-length-help">保存后用于新任务。含标点、英文和数字，不必凑满；人工主动补漏规则不变。</span><span className="setup-help">当前生效：首次 {saved.message_max_chars} 字 · 自动补漏 {Number(saved.message_max_chars)+10} 字</span></div><div className="greeting-reference-editor"><label className="setup-field"><span>参考语 <small>可选</small></span><textarea aria-label="打招呼参考语" rows={3} value={value.reference} disabled={disabled} onChange={e=>update({reference:e.target.value})}/></label>{error&&<div className="setup-note error" role="status">招呼参考语未保存，请重试。当前生效设置保持不变。</div>}<div className="setup-section-actions"><span className="setup-help">{disabled?'相关流程处理中，暂不可修改':dirty?'有未保存的参考语改动':'招呼参考语已保存'}</span><button className="primary-button" disabled={disabled||!dirty||!valid} onClick={save}><Save size={14}/>{error?'重试保存':'保存参考语'}</button></div></div></div></section>;
}
