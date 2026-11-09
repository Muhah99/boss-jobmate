import {spawn} from 'node:child_process';import {once} from 'node:events';import {mkdir,mkdtemp,readFile,unlink} from 'node:fs/promises';import {openSync,closeSync} from 'node:fs';import {fileURLToPath} from 'node:url';import path from 'node:path';
import {selectPowerShell,powerShellArguments} from './powershell.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/[\\/]$/,'');
try{
 const action=process.argv[2]||'open';if(!['start','open','stop'].includes(action))throw Error('启动操作无效。');
 const powershell=await selectPowerShell(root);
 const temp=path.join(root,'data/temp');await mkdir(temp,{recursive:true});const run=await mkdtemp(path.join(temp,'launch-')),out=path.join(run,'stdout.txt'),err=path.join(run,'stderr.txt');
 const output=openSync(out,'w'),error=openSync(err,'w');let child;
 try{child=spawn(powershell,[...powerShellArguments,'-File',path.join(root,action+'.ps1'),...process.argv.slice(3)],{cwd:root,windowsHide:true,stdio:['ignore',output,error]});await once(child,'spawn');}
 finally{closeSync(output);closeSync(error);}
 // Detached backend descendants can retain PS handles. The script's exit, not pipe EOF, completes launch.
 const [code]=await once(child,'exit'),stdout=await readFile(out,'utf8'),stderr=await readFile(err,'utf8');
 await unlink(out).catch(()=>{});await unlink(err).catch(()=>{});
 if(code!==0)throw Error(stderr.trim()||'启动脚本未成功完成。');if(stdout)process.stdout.write(stdout);
}catch(error){console.error(error.stderr?.trim()||error.message);process.exitCode=1;}
