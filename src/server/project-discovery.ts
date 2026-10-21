import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Project, ProjectCandidate, ProjectDiscovery } from '../shared/types.js';
import { runCommand } from './repositories.js';

export interface ProjectDiscoveryOptions {
  /** Explicit overrides keep tests and alternate installations independent of the real user home. */
  codexStateFile?:string;
  cwd?:string;
  /** Replaces the default parent directory and WORKBENCH_PROJECT_ROOTS scan roots when supplied. */
  workspaceRoots?:string[];
  maxCandidates?:number;
  gitTimeoutMs?:number;
}
const REGISTERED='工作台已接入', CODEX='Codex 项目', LOCAL='本地工作目录';
const key=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
function inside(path:string,parent:string):boolean {
  const part=relative(key(parent),key(path));
  return !part||(!part.startsWith(`..${sep}`)&&part!=='..'&&!isAbsolute(part));
}
async function bounded<T>(operation:Promise<T>,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function canonical(path:string,timeout:number):Promise<string> {
  const absolute=resolve(path);
  try{return await bounded(realpath(absolute),timeout);}catch{return absolute;}
}
function integer(value:number|undefined,fallback:number,max:number):number {
  return typeof value==='number'&&Number.isInteger(value)&&value>0?Math.min(value,max):fallback;
}
type PendingCandidate={name:string;path:string;sources:string[];registeredProjectId?:string};

/** Reads project-location metadata and Git identity only; never initializes Beads or touches sessions. */
export async function discoverProjects(registered:Project[],dataDir:string,options:ProjectDiscoveryOptions={}):Promise<ProjectDiscovery> {
  const timeout=integer(options.gitTimeoutMs,1500,5000),max=integer(options.maxCandidates,48,128);
  const cwd=resolve(options.cwd??process.cwd());
  const codexState=resolve(options.codexStateFile??join(process.env.CODEX_HOME??join(homedir(),'.codex'),'.codex-global-state.json'));
  const rawRoots=options.workspaceRoots??[dirname(cwd),...(process.env.WORKBENCH_PROJECT_ROOTS??'').split(delimiter).filter(Boolean)];
  const roots=[...new Set(rawRoots.map(path=>resolve(path)))];
  const excluded=await Promise.all([
    join(dataDir,'worktrees'),join(cwd,'.workbench','sandbox'),
    join(dirname(codexState),'worktrees'),join(homedir(),'.codex','worktrees')
  ].map(path=>canonical(path,timeout)));
  const pending=new Map<string,PendingCandidate>(),sources:ProjectDiscovery['sources']=[];
  let truncated=roots.length>12;
  const isExcluded=(path:string)=>excluded.some(parent=>inside(path,parent));
  const add=async(path:string,name:string,source:string,registeredProjectId?:string)=>{
    if(!isAbsolute(path)||path.includes('\0'))return;
    // Once full, merge already-known spellings without resolving every remaining native entry.
    if(pending.size>=max) {
      const existing=pending.get(key(resolve(path)));
      if(existing){if(!existing.sources.includes(source))existing.sources.push(source);}
      else truncated=true;
      return;
    }
    const normalized=await canonical(path,timeout);
    if(isExcluded(normalized))return;
    const identity=key(normalized),existing=pending.get(identity);
    if(existing){if(!existing.sources.includes(source))existing.sources.push(source);return;}
    if(pending.size>=max){truncated=true;return;}
    pending.set(identity,{name:name.trim().slice(0,120)||basename(normalized),path:normalized,sources:[source],...(registeredProjectId?{registeredProjectId}:{})});
  };
  // Source order is also name precedence: enrolled names, native names, then folder names.
  for(const project of registered)await add(project.path,project.name,REGISTERED,project.id);
  sources.push({name:REGISTERED,available:true,detail:`已接入 ${registered.length} 个项目；读取登记信息，不改变接入状态。`});
  try {
    const info=await bounded(stat(codexState),timeout);
    if(!info.isFile()||info.size>4*1024*1024)throw new Error('invalid file');
    const document:unknown=JSON.parse(await bounded(readFile(codexState,'utf8'),timeout));
    const local=document&&typeof document==='object'&&!Array.isArray(document)?(document as Record<string,unknown>)['local-projects']:undefined;
    if(!local||typeof local!=='object')sources.push({name:CODEX,available:false,detail:'未找到可识别的 local-projects 项目登记；仍可从本地目录发现或手动添加。'});
    else {
      const entries=Array.isArray(local)?local:Object.values(local as Record<string,unknown>);
      let count=0;
      for(const entry of entries.slice(0,256)) {
        if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
        const row=entry as Record<string,unknown>;
        if(!Array.isArray(row.rootPaths))continue;
        for(const path of row.rootPaths.slice(0,16))if(typeof path==='string'&&isAbsolute(path)&&!path.includes('\0')) {
          count++;await add(path,typeof row.name==='string'?row.name:basename(path),CODEX);
        }
        if(row.rootPaths.length>16)truncated=true;
      }
      if(entries.length>256)truncated=true;
      sources.push({name:CODEX,available:true,detail:`已读取 ${count} 条本地项目路径；未读取会话内容。`});
    }
  }catch{sources.push({name:CODEX,available:false,detail:'本机 Codex 项目登记不存在、不可访问或格式不可读；仍可从本地目录发现或手动添加。'});}
  const probe=async(path:string)=>{
    try {
      // Ordinary folders are not promoted by directory scanning; explicit native entries remain visible.
      await bounded(stat(join(path,'.git')),timeout);
      await add(path,basename(path),LOCAL);
    }catch{/* Not a Git root, missing or inaccessible. */}
  };
  await probe(cwd);
  for(const root of roots.slice(0,12)) {
    const normalized=await canonical(root,timeout);
    if(isExcluded(normalized))continue;
    try {
      const folder=await bounded(opendir(normalized),timeout);let count=0;
      try {
        await probe(normalized);
        for(;;) {
          const entry=await bounded(folder.read(),timeout);
          if(!entry)break;
          if(++count>256){truncated=true;break;}
          if(entry.isDirectory()||entry.isSymbolicLink())await probe(join(normalized,entry.name));
        }
      }finally{await folder.close();}
      sources.push({name:LOCAL,available:true,detail:`已检查 ${normalized} 及其第一层目录。`});
    }catch{sources.push({name:LOCAL,available:false,detail:`无法读取目录：${normalized}`});}
  }
  const inputs=[...pending.values()],candidates:(ProjectCandidate|undefined)[]=new Array(inputs.length);
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,inputs.length)},async()=>{
    for(;;) {
      const index=cursor++;if(index>=inputs.length)return;
      const item=inputs[index];
      const candidate:ProjectCandidate={...item,status:'unavailable',detail:'项目目录不存在或暂不可访问。',beadsInitialized:false};
      candidates[index]=candidate;
      try {if(!(await bounded(stat(item.path),timeout)).isDirectory())continue;}catch{continue;}
      try{candidate.beadsInitialized=(await bounded(stat(join(item.path,'.beads')),timeout)).isDirectory();}catch{/* Existence only: never invoke Beads here. */}
      try{await bounded(stat(join(item.path,'.git')),timeout);}catch{
        candidate.status='not_git';candidate.detail='此目录不是 Git 仓库根目录，请先选择或初始化 Git 仓库。';continue;
      }
      let metadata:string[];
      try {
        metadata=(await runCommand('git',['rev-parse','--show-toplevel','--absolute-git-dir','--git-common-dir'],item.path,timeout)).split(/\r?\n/);
        if(metadata.length<3)throw new Error('invalid git metadata');
        const [root,gitDir,commonDir]=await Promise.all(metadata.slice(0,3).map(path=>canonical(resolve(item.path,path),timeout)));
        if(key(gitDir)!==key(commonDir)){candidates[index]=undefined;continue;}
        if(key(root)!==key(item.path)){candidate.status='not_git';candidate.detail='请选择 Git 仓库根目录，而非其子目录。';continue;}
      }catch{candidate.detail='Git 仓库不可读取或检查超时，请确认本机 Git 和目录权限。';continue;}
      try {
        await runCommand('git',['rev-parse','--verify','HEAD^{commit}'],item.path,timeout);
        candidate.status='ready';candidate.detail=candidate.beadsInitialized?'Git 仓库已就绪，检测到 Beads 目录。':'Git 仓库已就绪；接入时需要初始化 Beads。';
      }catch(error){
        const timedOut=error instanceof Error&&error.message.includes('超时');
        candidate.status=timedOut?'unavailable':'no_commit';
        candidate.detail=timedOut?'Git 提交检查超时，请稍后刷新。':'Git 仓库尚无可读取的提交，请完成首次提交后接入。';
      }
    }
  }));
  return {candidates:candidates.filter((candidate):candidate is ProjectCandidate=>!!candidate),sources,checkedAt:new Date().toISOString(),truncated};
}
