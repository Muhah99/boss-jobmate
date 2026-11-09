// Positions are explicit UTF-16 offsets supplied with this message, never inferred
// from the first occurrence of a repeated phrase.
export function previewMessageParts(result) {
 const message=result?.message||'',matches=result?.matching?.matches||[];
 const ranges=(result?.mappings||[]).filter(m=>Number.isInteger(m.message_start)&&message.slice(m.message_start,m.message_start+m.message_quote.length)===m.message_quote)
  .map(m=>({start:m.message_start,end:m.message_start+m.message_quote.length,indices:(m.match_indices||[]).filter(i=>matches[i]?.introduction_quote===m.introduction_quote)})).filter(m=>m.indices.length);
 const boundaries=[...new Set([0,message.length,...ranges.flatMap(m=>[m.start,m.end])])].sort((a,b)=>a-b);
 return boundaries.slice(0,-1).map((start,i)=>({start,text:message.slice(start,boundaries[i+1]),indices:[...new Set(ranges.filter(m=>m.start<=start&&m.end>=boundaries[i+1]).flatMap(m=>m.indices))]}));
}

// Presentation follows the actual read task; it never converts an old sample into a new success.
export function expectationSampleFeedback(task,sample) {
 const displayError=value=>{if(typeof value!=='string')return value;const line=value.split(/\r?\n/)[0].trim();return /(?:[A-Za-z]:[\\/]|\.ps1(?::|\s)|^At\s|^所在位置)/i.test(line)?'本次读取未完成，请核对专用BOSS页面后再试。':line;};
 const result=task?.result||{},active=['queued','running'].includes(task?.status),stopping=active&&!!task?.stop_requested,taskError=!active?displayError(task?.error):undefined;
 if(active&&!stopping) {
  if(result.sample?.status==='saved')return {taskError,stopping,kind:'info',closing:true,text:'岗位测试样本已保存，正在关闭本次使用的专用BOSS浏览器…'};
  return {taskError,stopping,kind:'info',text:result.expectations?.length?'已读取求职期望，正在选中第一个期望并读取首个岗位及JD…':'正在读取BOSS中设置的求职期望…'};
 }
 if(result.sample?.status==='saved') {
  if(result.browser_close?.status==='closed')return {taskError,stopping,kind:'success',text:'求职期望和岗位测试样本已保存，专用BOSS浏览器已关闭。'};
  return {taskError,stopping,kind:'info',text:'岗位测试样本已保存，尚未确认专用BOSS浏览器已关闭。请核对并按需手动关闭该窗口，已保存样本可继续用于岗位测试。',error:displayError(result.browser_close?.error)};
 }
 if(result.sample?.status==='failed') {
  const error=displayError(result.sample.error)||'',retained=sample?.jd?'原有效样本保持。':'';
  if(error.startsWith('岗位测试样本未能保存：'))return {taskError,stopping,kind:'error',text:'求职期望已保留，岗位测试样本未能保存。专用BOSS浏览器保持打开，请稍后主动重新读取；'+retained,error};
  if(/登录|安全验证/.test(error))return {taskError,stopping,kind:'error',text:'求职期望已保留。请在专用BOSS浏览器完成登录或安全验证后主动重新读取；本次未保存新岗位样本。',error};
  if(/岗位列表为空/.test(error))return {taskError,stopping,kind:'error',text:'求职期望已保留。第一个求职期望的岗位列表为空，本次未保存新样本；可稍后重新读取，或在岗位测试中手动填写JD。',error};
  if(/没有可用JD/.test(error))return {taskError,stopping,kind:'error',text:'求职期望已保留。第一个岗位没有可用JD，本次未保存新样本；可处理后重新读取，或在岗位测试中手动填写JD。',error};
  return {taskError,stopping,kind:'error',text:sample?.jd?'本次岗位样本读取未完成，未更新样本。求职期望和上次成功保存的样本均保留，专用BOSS浏览器保持打开。':'求职期望已保留，本次未能读取岗位样本。专用BOSS浏览器保持打开，请处理后重新读取；也可手动填写JD。',error};
 }
 if(result.expectations?.length)return {taskError,stopping,kind:'info',text:'求职期望已保存，本次未完成新的岗位测试样本读取。'+(sample?.jd?'上次成功保存的样本保持。':'可在岗位测试中手动填写JD。')};
 if(task?.status==='failed')return {taskError:displayError(task.error)||'本次读取未完成，请主动重新读取。',stopping,kind:'error',text:'读取求职期望失败'};
 // A previous expectation-only success is not evidence of sample capture.
 return {taskError,stopping,kind:'info',text:sample?.jd?'已保存的岗位测试样本可继续使用；本次没有新的样本读取结果。':'尚未读取岗位测试样本。完成准备后，请读取求职期望及首个岗位。'};
}
