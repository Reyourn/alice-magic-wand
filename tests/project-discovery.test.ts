import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Project, ProjectDiscovery } from '../src/shared/types.js';
import { buildApp } from '../src/server/index.js';
import { discoverProjects, type ProjectDiscoveryOptions } from '../src/server/project-discovery.js';
import { runCommand, type TaskRepository } from '../src/server/repositories.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture() {
  const base=await mkdtemp(join(tmpdir(),'workbench-discovery-'));
  cleanups.push(async()=>{
    const absolute=resolve(base),parent=resolve(tmpdir());
    if(!absolute.startsWith(`${parent}${sep}`)||!relative(parent,absolute).startsWith('workbench-discovery-'))throw new Error('Unsafe test cleanup target');
    await rm(absolute,{recursive:true,force:true});
  });
  const workspace=join(base,'workspace'),codexStateFile=join(base,'codex','.codex-global-state.json'),dataDir=join(base,'data');
  await mkdir(workspace,{recursive:true});await mkdir(dirname(codexStateFile),{recursive:true});
  const options:ProjectDiscoveryOptions={cwd:workspace,workspaceRoots:[workspace],codexStateFile,gitTimeoutMs:3000};
  const native=async(entries:unknown,extra:Record<string,unknown>={})=>writeFile(codexStateFile,JSON.stringify({'local-projects':entries,...extra}));
  return {base,workspace,codexStateFile,dataDir,options,native};
}
async function repository(path:string,commit=true):Promise<string> {
  await mkdir(path,{recursive:true});await runCommand('git',['init','--quiet'],path);
  if(commit)await runCommand('git',['-c','user.name=Discovery Test','-c','user.email=discovery@example.invalid','commit','--quiet','--allow-empty','-m','test fixture'],path);
  return path;
}
async function contents(path:string):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  const visit=async(dir:string)=>{
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const child=join(dir,entry.name);
      if(entry.isDirectory())await visit(child);
      else if(entry.isFile())result[relative(path,child)]=createHash('sha256').update(await readFile(child)).digest('hex');
    }
  };
  await visit(path);return result;
}
const enrolled=(path:string,name='已接入自定义名'):Project=>({id:'registered-project',name,path,createdAt:'2026-10-15T00:00:00.000Z'});

describe('read-only local project discovery',()=>{
  it('merges native, shallow and registered paths without changing names, source files or repositories',async()=>{
    const f=await fixture(),ready=await repository(join(f.workspace,'ready')),empty=await repository(join(f.workspace,'empty'),false);
    const plain=join(f.workspace,'plain'),missing=join(f.workspace,'gone');await mkdir(plain);await mkdir(join(ready,'.beads'));
    await f.native({one:{name:'Codex 自定义名称',rootPaths:[ready]},two:{name:'普通目录',rootPaths:[plain]},three:{name:'失效项目',rootPaths:[missing]},invalid:{rootPaths:[12,'relative/path']},unrelated:'ignored'}, {'secret-token':'must-not-leak','thread-title':'private-history'});
    const before=await contents(f.base);
    const result=await discoverProjects([enrolled(ready)],f.dataDir,f.options);
    const candidate=result.candidates.find(row=>row.path===ready)!;
    expect(candidate).toMatchObject({name:'已接入自定义名',status:'ready',beadsInitialized:true,registeredProjectId:'registered-project'});
    expect(new Set(candidate.sources)).toEqual(new Set(['工作台已接入','Codex 项目','本地工作目录']));
    expect(result.candidates.filter(row=>row.path===ready)).toHaveLength(1);
    expect(result.candidates.find(row=>row.path===empty)?.status).toBe('no_commit');
    expect(result.candidates.find(row=>row.path===plain)?.status).toBe('not_git');
    expect(result.candidates.find(row=>row.path===missing)?.status).toBe('unavailable');
    expect(result.candidates.some(row=>row.path===f.workspace)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|private-history|secret-token|thread-title/);
    expect(result.truncated).toBe(false);expect(await contents(f.base)).toEqual(before);
    const nativeOnly=await discoverProjects([],f.dataDir,f.options);
    expect(nativeOnly.candidates.find(row=>row.path===ready)?.name).toBe('Codex 自定义名称');
  });
  it('filters actual linked Git worktrees and exact managed temporary areas without matching ordinary names',async()=>{
    const f=await fixture(),repo=await repository(join(f.workspace,'main'));
    const linked=join(f.workspace,'linked-copy');await runCommand('git',['worktree','add','--quiet','--detach',linked,'HEAD'],repo);
    const ordinary=await repository(join(f.workspace,'worktrees-product'));
    const sandbox=join(repo,'.workbench','sandbox','sample'),managed=join(f.dataDir,'worktrees','sample'),codexTree=join(dirname(f.codexStateFile),'worktrees','sample');
    for(const path of [sandbox,managed,codexTree])await mkdir(join(path,'.git'),{recursive:true});
    await f.native([{name:'主仓库',rootPaths:[repo]},{name:'工作树',rootPaths:[linked]},{name:'临时区域',rootPaths:[sandbox,managed,codexTree]},{name:'合法名称',rootPaths:[ordinary]}]);
    const result=await discoverProjects([],f.dataDir,{...f.options,cwd:repo});
    expect(result.candidates.map(row=>row.path).sort()).toEqual([repo,ordinary].sort());
    expect(result.candidates.every(row=>row.status==='ready')).toBe(true);
  });
  it.each(['{bad JSON',JSON.stringify({unrelated:[{rootPaths:['must-not-use']}]}),JSON.stringify({'local-projects':'schema changed'})])('degrades unreadable or changed native metadata while retaining shallow Git discovery (%s)',async body=>{
    const f=await fixture(),repo=await repository(join(f.workspace,'local'));
    await writeFile(f.codexStateFile,body);
    const result=await discoverProjects([],f.dataDir,f.options);
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]).toMatchObject({path:repo,status:'ready'});
    expect(result.sources.find(source=>source.name==='Codex 项目')?.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain('must-not-use');
  });
  it('bounds discovery and reports unavailable roots without traversing deeper folders',async()=>{
    const f=await fixture(),first=await repository(join(f.workspace,'first')),second=await repository(join(f.workspace,'second'));
    await repository(join(f.workspace,'group','nested'));
    await f.native([{name:'First',rootPaths:[first]},{name:'Second',rootPaths:[second]}]);
    const result=await discoverProjects([],f.dataDir,{...f.options,maxCandidates:1,workspaceRoots:[f.workspace,join(f.base,'missing')]});
    expect(result.truncated).toBe(true);expect(result.candidates).toHaveLength(1);expect(result.candidates[0].path).toBe(first);
    expect(result.sources.some(source=>source.name==='本地工作目录'&&!source.available)).toBe(true);
  });
  it.skipIf(process.platform!=='win32')('deduplicates Windows casing and trailing separators',async()=>{
    const f=await fixture(),repo=await repository(join(f.workspace,'MixedCase'));
    await f.native([{name:'Native',rootPaths:[repo.toUpperCase()+sep,repo.toLowerCase()]}]);
    const result=await discoverProjects([enrolled(repo)],f.dataDir,f.options);
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]).toMatchObject({name:'已接入自定义名',registeredProjectId:'registered-project'});
  });
  it('serves discovery without writes or Beads calls and refreshes enrollment after explicit registration',async()=>{
    const f=await fixture(),repo=await repository(join(f.workspace,'app'));
    await f.native([{name:'原生项目',rootPaths:[repo]}]);
    const validate=vi.fn(async()=>{}),list=vi.fn(async()=>[]);
    const tasks:TaskRepository={validate,list,get:vi.fn(),create:vi.fn(),update:vi.fn()};
    const app=await buildApp({dataDir:f.dataDir,adapters:[],tasks,staticRoot:false,token:'test-local-token',projectDiscovery:f.options});
    cleanups.push(()=>app.close());
    const state=()=>({projects:app.workbench.projects(),agents:app.workbench.agents(),events:app.workbench.store.events(),rows:app.workbench.store.db.prepare('SELECT * FROM entities ORDER BY collection,id').all()});
    const before=state();
    const one=app.workbench.discoverProjects(),two=app.workbench.discoverProjects();expect(one).toBe(two);await one;
    const responses=await Promise.all([app.inject({url:'/api/projects/discovery'}),app.inject({url:'/api/projects/discovery'})]);
    for(const response of responses){expect(response.statusCode).toBe(200);expect(response.json<ProjectDiscovery>().candidates[0]).toMatchObject({status:'ready',beadsInitialized:false});}
    expect(state()).toEqual(before);expect(validate).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
    const registration=await app.inject({method:'POST',url:'/api/projects',headers:{'x-workbench-token':'test-local-token'},payload:{name:'已接入新名称',path:repo,initializeBeads:true}});
    expect(registration.statusCode).toBe(201);expect(validate).toHaveBeenCalledOnce();
    const again=await app.inject({url:'/api/projects/discovery'});
    expect(again.json<ProjectDiscovery>().candidates[0]).toMatchObject({name:'已接入新名称',registeredProjectId:registration.json<Project>().id});
    expect(app.workbench.projects()).toHaveLength(1);
  });
});
