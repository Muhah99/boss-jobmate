import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/index.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './bootstrap.mjs';
import {recordDiagnostic,diagnosticCode} from '../src/diagnostics.mjs';
// Stdio uses the running project backend so it cannot recover or race web tasks.
const application={
  async execute(operation,input) {
    let response;
    try {const state=JSON.parse(await readFile(resolve(root,'data/run/web.json'),'utf8'));if(state.root!==root || state.entry!==resolve(root,'runtime/web.mjs') || !Number.isInteger(state.port) || state.port<1 || state.port>65535)throw new Error('Invalid installation record');const address=`http://127.0.0.1:${state.port}`;const identity=await (await fetch(address+'/api/runtime')).json();if(identity.name!=='boss-jobmate' || identity.root!==root || identity.pid!==state.pid || identity.entry!==state.entry || identity.port!==state.port)throw new Error('端口属于其他服务');response=await fetch(address+'/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,input})});}
    catch(error) {await recordDiagnostic(root,{component:'mcp',operation:'mcp.proxy',phase:'proxy.request',outcome:'error',error_code:diagnosticCode(error)});throw new Error('请先用本项目 start.ps1 启动 boss-jobmate，再连接 MCP。');}
    let result;try{result=await response.json();}catch(error){await recordDiagnostic(root,{component:'mcp',operation:'mcp.proxy',phase:'proxy.response',outcome:'error',error_code:diagnosticCode(error)});throw error;}if(!result.ok)throw new Error(result.error);const {ok,...data}=result;return data;
  },
  redact:error=>error.message
};
const server=createServer(application);
await server.connect(new StdioServerTransport());
