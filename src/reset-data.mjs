import {lstat,realpath,readdir,readFile,rm,rmdir,truncate} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {recordDiagnostic,diagnosticCode,flushDiagnostics} from './diagnostics.mjs';

// This installation owns data/, while its open database and current process record stay in place.
export async function resetInstallation({root,store,external,progress,onCleared}) {
  const trace={component:'database',operation:'settings.reset',phase:'reset.validate',outcome:'error',partial_cleanup_possible:false};
  try{
  const install=await realpath(root),data=join(install,'data'),database=resolve(store.path);
  const inside=path=>{const rel=relative(data,path);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('清理路径不属于本安装数据目录');};
  if((await lstat(data)).isSymbolicLink() || await realpath(data)!==data)throw new Error('数据目录是链接，无法安全清理');
  inside(database);if(await realpath(database)!==database)throw new Error('数据库不属于本安装实际数据目录');
  async function check(path){inside(path);const entry=await lstat(path);if(entry.isSymbolicLink())throw new Error('数据目录含链接，请先处理链接后重试');if(entry.isDirectory())for(const child of await readdir(path))await check(join(path,child));}
  for(const name of await readdir(data))await check(join(data,name));
  trace.phase='reset.browser';trace.partial_cleanup_possible=true;const browser=await external.clearBrowserSession();
  trace.phase='reset.progress';await progress.close?.();
  await flushDiagnostics(root);
  let keepProcess=false;try{const record=JSON.parse(await readFile(join(data,'run/web.json'),'utf8'));keepProcess=record.pid===process.pid && resolve(record.root)===resolve(root) && resolve(record.entry)===resolve(root,'runtime/web.mjs');}catch{}
  const kept=new Set([join(data,'run/start.lock'),database,database+'-wal',database+'-shm',database+'-journal',...(keepProcess?[join(data,'run/web.json')]:[])]);
  const runningLogs=new Set([join(data,'logs/web-out.log'),join(data,'logs/web-error.log')]);
  async function remove(path){inside(path);inside(await realpath(path));if(kept.has(path))return;const stat=await lstat(path);if(stat.isSymbolicLink())throw new Error('清理期间目录出现链接，已停止');if(stat.isDirectory()){
    for(const child of await readdir(path))await remove(join(path,child));
    if(!(await readdir(path)).length)await rmdir(path);
  }else if(runningLogs.has(path))await truncate(path,0);else await rm(path);}
  trace.phase='reset.files';for(const name of await readdir(data))await remove(join(data,name));
  trace.phase='reset.database';store.reset();
  // Files and database are clear; the reopened page can now issue its first requests.
  onCleared?.();
  if(browser?.homeClosed){trace.phase='reset.browser.reopen';await external.reopenHome();}
  return {reset:true,message:'数据已清空，请重新完成初始化'};
  }catch(error){await recordDiagnostic(root,{...trace,error_code:diagnosticCode(error)},()=>store.getSetting('secrets',{}));throw error;}
}
