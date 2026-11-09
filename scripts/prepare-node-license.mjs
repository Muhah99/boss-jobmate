import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
if(!response.ok)throw new Error('当前Node版本官方许可证下载失败');
await mkdir(join(root,'runtime','licenses'),{recursive:true});
await writeFile(join(root,'runtime','licenses','NODE-LICENSE.txt'),Buffer.from(await response.arrayBuffer()));
console.log('Node许可证已准备：'+process.versions.node);
