import {recordDiagnostic,diagnosticCode} from './diagnostics.mjs';

export const USAGE_ENDPOINT='https://boss-jobmate-stats-d7c8v195eb326-1258494458.ap-shanghai.app.tcloudbase.com/daily-ip-stats';
export const beijingDate=date=>new Date(date.getTime()+8*60*60*1000).toISOString().slice(0,10);

// Claim the local date synchronously, before any network wait. No retries or identifiers.
export function createDailyUsage({store,root,fetchImpl=fetch,now=()=>new Date(),timeoutMs=3000,diagnostic=recordDiagnostic}) {
 const pending=new Set();let closed=false;
 const log=record=>diagnostic(root,{component:'usage',operation:'daily.open',...record});
 async function send() {
  const controller=new AbortController();pending.add(controller);
  const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
  let http_status=null;
  try {
   const response=await fetchImpl(USAGE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'manual',signal:controller.signal});
   http_status=response.status;
   const accepted=response.ok&&(await response.json()).ok===true;
   await log({phase:'usage.report',outcome:accepted?'success':'error',http_status});
  }catch(error){await log({phase:'usage.report',outcome:'error',http_status,error_code:diagnosticCode(error)});}
  finally{clearTimeout(timer);controller.abort();pending.delete(controller);}
 }
 return {
  reportOpen() {
   if(closed)return false;
   try {
    const date=beijingDate(now());
    const claimed=store.transaction(()=>{
     if(store.getSetting('dailyUsageAttempt')?.date===date)return false;
     store.setSetting('dailyUsageAttempt',{date});return true;
    });
    if(claimed)void send();
    return claimed;
   }catch(error){void log({phase:'usage.claim',outcome:'error',error_code:diagnosticCode(error)});return false;}
  },
  close(){closed=true;for(const controller of pending)controller.abort();}
 };
}
