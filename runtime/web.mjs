import {selectPowerShell} from './powershell.mjs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createPipeServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.mjs';
import { createApiHandler } from '../web/server/api.mjs';
import { bootstrap, root } from './bootstrap.mjs';
import {recordDiagnostic,diagnosticCode} from '../src/diagnostics.mjs';
import {createDailyUsage} from '../src/daily-usage.mjs';

// The kernel releases this installation lock even after a crash. Acquire before SQLite.
export async function claimInstallation(directory=root) {
  const pipe='\\\\.\\pipe\\boss-jobmate:'+realpathSync(directory).toLowerCase().replaceAll('\\','|');
  if(pipe.length>256)throw new Error('\u89e3\u538b\u8def\u5f84\u8fc7\u957f\uff0c\u8bf7\u79fb\u5230\u8f83\u77ed\u7684\u76ee\u5f55\u540e\u91cd\u8bd5\u3002');
  const lock=createPipeServer(socket=>socket.destroy());
  await new Promise((yes,no)=>{lock.once('error',no);lock.listen(pipe,yes);});
  return lock;
}
export async function startWeb({application,port=0,host='127.0.0.1',recordPid=true,usageFetch=fetch}={}) {
  const powershell=recordPid?await selectPowerShell(root):null;
  const installationLock=recordPid?await claimInstallation():null;
  let ready=false,handler;
  const server=createHttpServer((req,res)=>{if(!ready){res.statusCode=503;res.end('正在启动');return;}void handler(req,res);});
  try {
  let reuseRecordedPort=false;
  if(recordPid && port===0){
    try{
      const previous=JSON.parse(await readFile(resolve(root,'data','run','web.json'),'utf8'));
      if(previous.root===root && previous.entry===fileURLToPath(import.meta.url) && Number.isInteger(previous.port) && previous.port>=1 && previous.port<=65535){port=previous.port;reuseRecordedPort=true;}
    }catch{}
  }
  // Bind before opening SQLite: a duplicate launch must not recover live tasks.
  try{
    try{await new Promise((yes,no)=>{server.once('error',no);server.listen(port,host,yes);});}
    catch(error){if(!reuseRecordedPort || error.code!=='EADDRINUSE')throw error;port=0;await new Promise((yes,no)=>{server.once('error',no);server.listen(port,host,yes);});}
  }catch(error){if(recordPid)await recordDiagnostic(root,{component:'runtime',operation:'web.start',phase:'start.bind',outcome:'error',pid:process.pid,port,error_code:diagnosticCode(error)});throw error;}
  port=server.address().port;
  try {application ??= bootstrap({port});}catch(error){server.close();if(recordPid)await recordDiagnostic(root,{component:'runtime',operation:'web.start',phase:'start.bootstrap',outcome:'error',pid:process.pid,port,error_code:diagnosticCode(error)});throw error;}
  const mcp=createServer(application),client=new Client({name:'boss-jobmate-web',version:'0.5.2'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try{await mcp.connect(serverTransport);await client.connect(clientTransport);}catch(error){if(recordPid)await recordDiagnostic(root,{component:'runtime',operation:'web.start',phase:'start.mcp',outcome:'error',pid:process.pid,port,error_code:diagnosticCode(error)});throw error;}
  const usage=createDailyUsage({store:application.store,root:application.profile?.root||root,fetchImpl:usageFetch});
  const api=createApiHandler({client,onPageOpen:usage.reportOpen,diagnosticRoot:application.profile?.root,getSecrets:()=>({...application.store.getSetting('secrets',{}),...application.store.getSetting('secretDraft',{})})});
  let assets=resolve(root,'web','dist');try{await stat(resolve(assets,'index.html'));}catch{assets=resolve(assets,'client');}
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
  handler=async(req,res)=>{
    if(req.url==='/api/runtime'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({ok:true,name:'boss-jobmate',version:'0.5.2',root,entry:fileURLToPath(import.meta.url),pid:process.pid,port,powershell}));return;}
    if(await api(req,res))return;
    try {
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);let file=resolve(assets,'.'+pathname);const rel=relative(assets,file);
      if(rel.startsWith('..') || isAbsolute(rel))throw new Error('路径无效');
      try {if(!(await stat(file)).isFile())file=resolve(assets,'index.html');}catch{file=resolve(assets,'index.html');}
      const data=await readFile(file);res.setHeader('Content-Type',mime[extname(file)] || 'application/octet-stream');res.end(data);
    } catch {res.statusCode=404;res.end('页面尚未构建，请在 boss-jobmate 执行 npm run build');}
  };
  if(recordPid){try{await mkdir(resolve(root,'data','run'),{recursive:true});await writeFile(resolve(root,'data','run','web.json'),JSON.stringify({pid:process.pid,root,entry:fileURLToPath(import.meta.url),port:server.address().port,powershell}));}catch(error){await recordDiagnostic(root,{component:'runtime',operation:'web.start',phase:'start.record',outcome:'error',pid:process.pid,port,error_code:diagnosticCode(error)});throw error;}}
  if(recordPid){let asset=null;try{asset=(await readFile(resolve(assets,'index.html'),'utf8')).match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1]||null;}catch{}await recordDiagnostic(root,{component:'runtime',operation:'web.start',phase:'complete',outcome:'success',pid:process.pid,port:server.address().port,version:'0.5.2',node:process.version,asset});}
  ready=true;
  const close=async(reason='api_close')=>{usage.close();try{await new Promise(done=>server.close(done));await client.close();await mcp.close();application.close();if(recordPid)await recordDiagnostic(root,{component:'runtime',operation:'web.stop',outcome:'closed',pid:process.pid,reason:['api_close','SIGINT','SIGTERM'].includes(reason)?reason:'unknown'});}finally{if(installationLock)await new Promise(done=>installationLock.close(done));}};
  return {server,client,application,close,address:`http://${host}:${server.address().port}/`};
  }catch(error){server.close();if(installationLock)await new Promise(done=>installationLock.close(done));throw error;}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await startWeb();console.log(`boss-jobmate v0.5.2 ${app.address}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close(signal).finally(()=>process.exit(0));});
}
