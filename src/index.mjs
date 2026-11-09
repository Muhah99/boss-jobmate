import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { operations } from './application.mjs';
import {recordDiagnostic,diagnosticId,diagnosticCode} from './diagnostics.mjs';

// HTTP and stdio enter the same registered operation and authoritative data layer.
export function createServer(application) {
  const server=new McpServer({name:'boss-jobmate',version:'0.5.1'});
  server.registerTool('jobmate_operation',{description:'boss-jobmate v0.5.1 业务操作。状态查询不启动业务。真实模型、地图、BOSS 和投递仅在用户明确触发对应操作后执行；整批提交不是发送授权。',inputSchema:{operation:z.enum(operations),input:z.record(z.any()).optional()}},async({operation,input})=>{
    try {const data=await application.execute(operation,input || {});return {content:[{type:'text',text:JSON.stringify({ok:true,...data})}]};}
    catch(error){if(application.profile?.root)await recordDiagnostic(application.profile.root,{component:'mcp',operation,phase:'operation.execute',outcome:'error',task_id:diagnosticId(input?.id),job_id:diagnosticId(input?.job_id),error_code:diagnosticCode(error)},()=>({...application.store.getSetting('secrets',{}),...application.store.getSetting('secretDraft',{})}));return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:application.redact(error)})}]};}
  });return server;
}
