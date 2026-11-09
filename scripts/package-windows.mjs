import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {selectPowerShell,powerShellArguments} from '../runtime/powershell.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.platform!=='win32')throw Error('Windows包请在Windows构建。');
// A complete staged installation is the input. Never copy business data.
for(const file of ['boss-jobmate.exe','runtime/launch.mjs','runtime/instance.ps1','runtime/browser.mjs','runtime/prepare-browser.ps1','runtime/powershell.mjs','runtime/powershell-probe.ps1','runtime/powershell/pwsh.exe','runtime/powershell/LICENSE.txt','runtime/powershell/ThirdPartyNotices.txt','runtime/node/node.exe','runtime/python/python.exe','runtime/python-manifest.json','runtime/licenses/NODE-LICENSE.txt','web/dist/index.html'])await stat(join(root,file));
const outputIndex=process.argv.indexOf('--output');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const folder=outputIndex>=0?resolve(process.argv[outputIndex+1]):join(root,'dist',`boss-jobmate-v${version}-`+new Date().toISOString().replace(/[:.]/g,'-'));
if(outputIndex<0)await mkdir(join(root,'dist'),{recursive:true});
await mkdir(folder,{recursive:false});
for(const file of ['src','scripts','assets','node_modules','package.json','package-lock.json','boss-jobmate.exe','start.ps1','stop.ps1','open.ps1','README.md','LICENSE','NOTICE.md'])await cp(join(root,file),join(folder,file),{recursive:true});
try{await cp(join(root,'开源说明.txt'),join(folder,'开源说明.txt'));}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(join(folder,'web'));for(const file of ['dist','server'])await cp(join(root,'web',file),join(folder,'web',file),{recursive:true});
await cp(join(root,'runtime'),join(folder,'runtime'),{recursive:true,filter:file=>file!==join(root,'runtime','packages')});
const manifest=JSON.parse(await readFile(join(folder,'runtime/distribution.json'),'utf8'));
manifest.powershell=JSON.parse(await readFile(join(root,'runtime/powershell-manifest.json'),'utf8'));manifest.created_at=new Date().toISOString();manifest.data='empty-on-first-run';
await writeFile(join(folder,'runtime/distribution.json'),JSON.stringify(manifest,null,2)+'\n');
if(!process.argv.includes('--directory-only')){
 const powershell=await selectPowerShell(root),request=promisify(execFile)(powershell,[...powerShellArguments,'-File',join(root,'scripts/zip-package.ps1'),'-PackagePath',folder,'-ZipPath',folder+'.zip'],{windowsHide:true,maxBuffer:2*1024*1024});request.child.stdin.end();await request;
 console.log(folder+'.zip');
}else console.log(folder);
