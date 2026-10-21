import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.resolve(process.argv[2]??path.join(root,'.workbench','sandbox','collaboration-demo'));
try { await access(target); throw new Error(`Target already exists: ${target}`); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
await mkdir(path.dirname(target),{recursive:true});
await cp(path.join(root,'examples','demo-template'),target,{recursive:true});
await run('git',['init','--initial-branch=main',target]);
await run('git',['-C',target,'add','.']);
await run('git',['-C',target,'-c','user.name=Workbench Demo','-c','user.email=workbench@localhost','commit','-m','Initialize synthetic collaboration fixture']);
const bd=process.env.BD_PATH??path.join(process.env.LOCALAPPDATA!,'Programs','beads-v1.3.0','bd.exe');
await run(bd,['init','--prefix','demo','--non-interactive','--skip-agents','--skip-hooks','--quiet'],{cwd:target});
await run('git',['-C',target,'add','.beads','.gitignore']);
await run('git',['-C',target,'-c','user.name=Workbench Demo','-c','user.email=workbench@localhost','commit','-m','Initialize authoritative demo task store']);
console.log(target);
