import {operations} from '../../src/application.mjs';
import {recordDiagnostic,diagnosticCode} from '../../src/diagnostics.mjs';
function route(method,url) {
  const path=url.pathname;
  if(method==='POST' && path==='/api/mcp')return {operation:null,params:{}};
  const simple={
    'GET /api/state':'state','POST /api/settings':'settings.save','POST /api/settings/reset':'settings.reset','POST /api/settings/map':'settings.map','POST /api/settings/draft':'settings.draft',
    'POST /api/agent/detect':'agent.detect','POST /api/agent/test':'agent.test','POST /api/agent/pick-program':'agent.pick_program','POST /api/browser/detect':'browser.detect','POST /api/browser/download':'browser.download','POST /api/browser/open-profile':'browser.open_profile','POST /api/browser/init-guide':'browser.init_guide',
    'POST /api/review/supplements':'review.supplements','POST /api/profile/upload':'profile.upload','POST /api/profile/generate':'profile.generate','POST /api/profile/preview':'profile.preview','POST /api/profile/draft':'profile.draft','POST /api/profile/update':'profile.update','POST /api/onboarding/draft':'onboarding.draft','POST /api/onboarding/generate':'onboarding.generate','POST /api/onboarding/confirm':'onboarding.confirm','POST /api/onboarding/example':'onboarding.example','POST /api/onboarding/complete':'onboarding.complete','POST /api/expectations/read':'expectations.read',
    'POST /api/applications/deliver':'delivery.start','POST /api/map/search':'map.search','POST /api/workflow-tasks/draft':'tasks.draft','POST /api/workflow-tasks':'tasks.start','GET /api/jobs':'jobs.list','GET /api/batches':'batches.list','POST /api/week-cleanup/check':'week.check','POST /api/week-cleanup/confirm':'week.confirm'
  };
  if(simple[`${method} ${path}`])return {operation:simple[`${method} ${path}`],params:Object.fromEntries(url.searchParams)};
  let m;
   if(method==='GET' && (m=path.match(/^\/api\/workflow-tasks\/([^/]+)\/progress$/)))return {operation:'tasks.progress',params:{id:m[1]}};
  if(method==='DELETE' && (m=path.match(/^\/api\/expectations\/([^/]+)$/)))return {operation:'expectations.delete',params:{id:m[1]}};
  if(method==='POST' && (m=path.match(/^\/api\/expectations\/([^/]+)\/origins$/)))return {operation:'origins.save',params:{expectation_id:m[1]}};
  if(method==='DELETE' && (m=path.match(/^\/api\/expectations\/([^/]+)\/origins\/([^/]+)$/)))return {operation:'origins.delete',params:{expectation_id:m[1],origin_id:m[2]}};
  if(method==='POST' && (m=path.match(/^\/api\/workflow-tasks\/([^/]+)\/(retry|stop|pause|resume|abandon|window)$/)))return {operation:`tasks.${m[2]}`,params:{id:m[1]}};
  if(method==='POST' && (m=path.match(/^\/api\/jobs\/([^/]+)\/open$/)))return {operation:'jobs.open',params:{id:m[1]}};
  if(method==='GET' && (m=path.match(/^\/api\/batches\/([^/]+)$/)))return {operation:'batches.get',params:{...Object.fromEntries(url.searchParams),id:m[1]}};
   if(method==='POST' && (m=path.match(/^\/api\/batches\/([^/]+)\/jobs\/([^/]+)\/(choice|begin|save|remove)$/)))return {operation:`review.${m[3]}`,params:{batch_id:m[1],job_id:m[2],...(url.searchParams.has('task_id')?{task_id:url.searchParams.get('task_id')}:{} )}};
  if(method==='POST' && (m=path.match(/^\/api\/batches\/([^/]+)\/submit$/)))return {operation:'review.submit',params:{batch_id:m[1]}};
  if(method==='POST' && (m=path.match(/^\/api\/batches\/([^/]+)\/void$/)))return {operation:'batches.void',params:{batch_id:m[1]}};
  if(method==='POST' && (m=path.match(/^\/api\/applications\/([^/]+)\/deliver$/)))return {operation:'delivery.start',params:{batch_id:m[1]}};
  if(method==='POST' && (m=path.match(/^\/api\/applications\/tasks\/([^/]+)\/(retry|stop)$/)))return {operation:`delivery.${m[2]}`,params:{id:m[1]}};
  if(method==='POST' && (m=path.match(/^\/api\/applications\/([^/]+)\/jobs\/([^/]+)\/verify$/)))return {operation:'delivery.verify',params:{batch_id:m[1],job_id:m[2]}};
  return null;
}
export function createApiHandler({client,onPageOpen=()=>{},diagnosticRoot,getSecrets=()=>({})}) {
  return async(req,res)=>{
    if(!req.url.startsWith('/api/'))return false;
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    const trace={component:'http',operation:null,phase:'http.origin',outcome:'error'};
    try {
      const url=new URL(req.url,'http://'+req.headers.host);
      if(req.headers.origin && req.headers.origin!==url.origin)throw new Error('不允许其他网页触发本地业务');
      if(req.method==='POST' && url.pathname==='/api/usage/open'){onPageOpen();req.resume();res.end(JSON.stringify({ok:true}));return true;}
      trace.phase='http.route';const matched=route(req.method,url);if(!matched){if(diagnosticRoot)await recordDiagnostic(diagnosticRoot,{...trace,http_status:404},getSecrets);res.statusCode=404;res.end(JSON.stringify({ok:false,error:'接口不存在'}));return true;}
      trace.operation=matched.operation;trace.phase='http.read';let data='';for await(const chunk of req){data+=chunk;if(data.length>36*1024*1024)throw new Error('提交内容过大');}
      trace.phase='http.parse';const body=data?JSON.parse(data):{};trace.operation=operations.includes(matched.operation||body.operation)?matched.operation||body.operation:null;trace.phase='mcp.call';
      const result=await client.callTool({name:'jobmate_operation',arguments:{operation:matched.operation || body.operation,input:matched.operation ? {...body,...matched.params}:body.input || {}}});
      trace.phase='mcp.result';const text=result.content?.find(c=>c.type==='text')?.text;if(!text)throw new Error('后台未返回业务结果');
      const value=JSON.parse(text);res.statusCode=value.ok?200:409;res.end(JSON.stringify(value));
    } catch(error) {if(diagnosticRoot)await recordDiagnostic(diagnosticRoot,{...trace,http_status:400,error_code:diagnosticCode(error)},getSecrets);res.statusCode=400;res.end(JSON.stringify({ok:false,error:error instanceof SyntaxError?'提交格式无效':error.message}));}
    return true;
  };
}
