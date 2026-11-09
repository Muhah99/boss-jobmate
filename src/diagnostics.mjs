import {appendFile,mkdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const pendingWrites=new Map();
export const diagnosticId=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)?value:null;
export const diagnosticCode=error=>['ENOENT','EACCES','EPERM','EIO','ENOSPC','EBUSY','ECONNRESET','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','EPIPE','ABORT_ERR','EADDRINUSE','EEXIST','EISDIR','ERR_SQLITE_ERROR','ERR_INVALID_STATE','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ECONNABORTED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','UND_ERR_ABORTED','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_SSL_WRONG_VERSION_NUMBER'].includes(error?.code)?error.code:null;
export const diagnosticUsage=value=>({prompt_tokens:Number.isFinite(value?.prompt_tokens)?value.prompt_tokens:null,completion_tokens:Number.isFinite(value?.completion_tokens)?value.completion_tokens:null,total_tokens:Number.isFinite(value?.total_tokens)?value.total_tokens:null,reasoning_tokens:Number.isFinite(value?.completion_tokens_details?.reasoning_tokens)?value.completion_tokens_details.reasoning_tokens:null,...Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens'].filter(key=>Number.isFinite(value?.[key])).map(key=>[key,value[key]]))});

// Call sites supply explicit metadata only. This managed file is capped at 1 MiB;
// existing quote diagnostics and business files are never rotated or removed here.
export async function recordDiagnostic(root,record,getSecrets=()=>({})){
 const file=join(root,'data','logs','diagnostics.jsonl');
 const pending=(pendingWrites.get(file)||Promise.resolve()).then(async()=>{
  try{
   const secrets=await getSecrets();
   await mkdir(join(root,'data','logs'),{recursive:true});
   let size=0;try{size=(await stat(file)).size;}catch(error){if(error.code!=='ENOENT')throw error;}
   const replacer=(_,value)=>typeof value==='string'?Object.values(secrets||{}).reduce((text,secret)=>typeof secret==='string'&&secret?text.split(secret).join('[已隐藏]'):text,value):value;
   const line=JSON.stringify({created_at:new Date().toISOString(),...record},replacer)+'\n',bytes=Buffer.byteLength(line);
   if(bytes>1024*1024){console.error('诊断未能保存。');return false;}
   if(size+bytes>1024*1024)await writeFile(file,'');
   await appendFile(file,line);return true;
  }catch{console.error('诊断未能保存。');return false;}
 });
 pendingWrites.set(file,pending);const saved=await pending;
 if(pendingWrites.get(file)===pending)pendingWrites.delete(file);
 return saved;
}

// Complete existing queued writes before the explicit data deletion begins.
export async function flushDiagnostics(root){await pendingWrites.get(join(root,'data','logs','diagnostics.jsonl'));}

// Full introduction replay is local-only, separate from the capped metadata log.
// Use the same known-secret substitution as recordDiagnostic; never rotate history.
export async function recordIntroductionGeneration(root,record,getSecrets=()=>({})){
 try{
  const secrets=await getSecrets(),directory=join(root,'data','logs');await mkdir(directory,{recursive:true});
  const replacer=(_,value)=>typeof value==='string'?Object.values(secrets||{}).reduce((text,secret)=>typeof secret==='string'&&secret?text.split(secret).join('[已隐藏]'):text,value):value;
  await writeFile(join(directory,`introduction-generation-${record.local_request_id}.json`),JSON.stringify({...record,recorded_at:new Date().toISOString()},replacer,2),'utf8');return true;
 }catch{console.error('个人介绍生成记录未能保存。');return false;}
}
