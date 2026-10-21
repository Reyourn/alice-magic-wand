import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, Task, TaskBinding } from '../shared/types.js';

export class WorkbenchError extends Error {
  constructor(message: string, readonly statusCode=400, readonly retrySafe=false) { super(message); }
}
export function runCommand(command: string, args: string[], cwd: string, timeout=45000): Promise<string> {
  return new Promise((resolveOutput,reject)=> {
    const env={...process.env,NO_COLOR:'1',BD_NON_INTERACTIVE:'1'};
    // Repository routing must follow this explicit cwd, never an inherited agent's repository override.
    for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','BEADS_DIR','BEADS_DB','BEADS_DATABASE'])delete (env as NodeJS.ProcessEnv)[key];
    const nativeArgs=process.platform==='win32'&&/(?:^|[/\\])git(?:\.exe)?$/i.test(command)?['-c','core.longpaths=true',...args]:args;
    const child=spawn(command,nativeArgs,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env});
    let stdout='',stderr='',settled=false;
    const finish=(err?:Error)=> { if(settled)return; settled=true; clearTimeout(timer); err ? reject(err) : resolveOutput(stdout.trim()); };
    const timer=setTimeout(()=>{ child.kill(); finish(new Error(`${command} 执行超时，结果可能已写入；请核对后再操作。`)); },timeout);
    child.stdout.on('data',(chunk:Buffer)=>{ stdout+=chunk.toString(); if(stdout.length>4*1024*1024){child.kill();finish(new Error('命令输出超过限制'));} });
    child.stderr.on('data',(chunk:Buffer)=>{ stderr=(stderr+chunk.toString()).slice(-16000); });
    child.once('error',finish);
    child.once('close',code=>finish(code===0?undefined:new Error(`${command} 失败 (${code}): ${stderr.slice(-5000) || stdout.slice(-5000)}`)));
  });
}
export interface TaskCreateInput { title: string; description?: string; acceptance?: string; dependencies?: string[]; priority?: number; id?:string; externalRef?:string; }
export interface TaskRepository {
  validate(path: string, initialize: boolean): Promise<void>;
  list(project: Project): Promise<Task[]>;
  get(project: Project,id:string): Promise<Task>;
  create(project: Project,input: TaskCreateInput): Promise<Task>;
  update(project: Project,id:string,fields:{status?:string;owner?:string;reason?:string}): Promise<Task>;
  findByExternalRef?(project:Project,externalRef:string):Promise<Task|undefined>;
  replaceDefinition?(project:Project,id:string,input:TaskCreateInput):Promise<Task>;
}
export interface GitRepository {
  validate(path: string): Promise<string>;
  createWorktree(project: Project,taskId:string,agentId:string,baseCommit?:string): Promise<TaskBinding>;
  inspect(path:string): Promise<{commit:string;dirty:boolean;diff:string}>;
  resolveCommit(project: Project,ref:string): Promise<string>;
}
type Bead = Record<string,unknown>;
function task(project:Project,raw:Bead):Task {
  const dependencies=(Array.isArray(raw.dependencies)?raw.dependencies:[]) as Record<string,unknown>[];
  return {id:String(raw.id),projectId:project.id,title:String(raw.title??''),description:String(raw.description??''),status:String(raw.status??'open'),owner:raw.assignee?String(raw.assignee):undefined,acceptance:String(raw.acceptance_criteria??raw.acceptance??''),priority:Number(raw.priority??2),dependencies:dependencies.filter(d=>['blocks','depends-on','blocked-by'].includes(String(d.type??d.dependency_type))).map(d=>String(d.depends_on_id??d.id))};
}
const taskPath=(project:Project)=>project.controlPath??project.path;
/** Serialize CLI calls per repository: embedded Beads storage cannot share a write lock. */
export class BeadsRepository implements TaskRepository {
  private locks = new Map<string,Promise<unknown>>();
  readonly executable: string;
  constructor(executable=process.env.WORKBENCH_BD_PATH) {
    const windows=join(process.env.LOCALAPPDATA??'', 'Programs','beads-v1.3.0','bd.exe');
    this.executable=executable||(existsSync(windows)?windows:'bd');
  }
  private call(path:string,args:string[]):Promise<unknown> {
    const previous=this.locks.get(path)??Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      const output=await runCommand(this.executable,[...args,'--json'],path);
      try{return JSON.parse(output);}catch{throw new Error('Beads 返回了无法解析的数据。请检查该项目的 Beads 配置。');}
    });
    this.locks.set(path,next); void next.finally(()=>{if(this.locks.get(path)===next)this.locks.delete(path);}).catch(()=>{});
    return next;
  }
  async validate(path:string,initialize:boolean):Promise<void> {
    if(!existsSync(join(path,'.beads'))) {
      if(!initialize)throw new WorkbenchError('项目尚未初始化 Beads。请勾选初始化，或在项目中执行 bd init。');
      await runCommand(this.executable,['init','--non-interactive','--skip-hooks','--skip-agents','--prefix','awb'],path,90000);
    }
    await this.call(path,['list','--all','--limit','1']);
  }
  async list(project:Project):Promise<Task[]> {
    const raw=await this.call(taskPath(project),['list','--all','--limit','0']);
    return (raw as Bead[]).map(row=>task(project,row));
  }
  async get(project:Project,id:string):Promise<Task> {
    assertIdentifier(id);
    const raw=await this.call(taskPath(project),['show',id]);
    const row=Array.isArray(raw)?raw[0]:raw;
    if(!row)throw new WorkbenchError('任务不存在',404);
    return task(project,row as Bead);
  }
  async create(project:Project,input:TaskCreateInput):Promise<Task> {
    const args=['create','--title',input.title,'--description',input.description??'','--acceptance',input.acceptance??'','--priority',String(input.priority??2)];
    if(input.id){assertIdentifier(input.id);args.push('--id',input.id,'--force');}
    if(input.externalRef)args.push('--external-ref',input.externalRef);
    if(input.dependencies?.length){ input.dependencies.forEach(assertIdentifier); args.push('--deps',input.dependencies.join(',')); }
    const raw=await this.call(taskPath(project),args);
    return task(project,(Array.isArray(raw)?raw[0]:raw) as Bead);
  }
  async update(project:Project,id:string,fields:{status?:string;owner?:string;reason?:string}):Promise<Task> {
    assertIdentifier(id);
    const args=['update',id];
    if(fields.status)args.push('--status',fields.status);
    if(fields.owner!==undefined)args.push('--assignee',fields.owner);
    if(fields.reason)args.push('--append-notes',fields.reason);
    const raw=await this.call(taskPath(project),args);
    const row=Array.isArray(raw)?raw[0]:raw;
    return row&&typeof row==='object'&&'id' in row?task(project,row as Bead):this.get(project,id);
  }
  async findByExternalRef(project:Project,externalRef:string):Promise<Task|undefined> {
    const rows=await this.call(taskPath(project),['list','--all','--limit','0']) as Bead[];
    const row=rows.find(value=>value.external_ref===externalRef); return row?task(project,row):undefined;
  }
  async replaceDefinition(project:Project,id:string,input:TaskCreateInput):Promise<Task> {
    assertIdentifier(id);
    await this.call(taskPath(project),['update',id,'--title',input.title,'--description',input.description??'','--acceptance',input.acceptance??'']);
    const previous=await this.get(project,id), wanted=new Set(input.dependencies??[]);
    for(const dep of previous.dependencies)if(!wanted.has(dep))await this.call(taskPath(project),['dep','remove',id,dep]);
    for(const dep of wanted)if(!previous.dependencies.includes(dep)){assertIdentifier(dep);await this.call(taskPath(project),['dep','add',id,dep]);}
    return this.get(project,id);
  }
}
function assertIdentifier(id:string):void { if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,160}$/.test(id))throw new WorkbenchError('无效任务编号'); }
export class LocalGitRepository implements GitRepository {
  constructor(private readonly worktreeRoot:string) {}
  async validate(path:string):Promise<string> {
    const absolute=realpathSync(resolve(path));
    const root=await runCommand('git',['rev-parse','--show-toplevel'],absolute);
    if(realpathSync(root).toLowerCase()!==absolute.toLowerCase())throw new WorkbenchError('请选择 Git 仓库根目录，而非子目录。');
    await runCommand('git',['rev-parse','--verify','HEAD'],absolute);
    return absolute;
  }
  async resolveCommit(project:Project,ref:string):Promise<string> {
    if(!/^[a-fA-F0-9]{7,64}$/.test(ref))throw new WorkbenchError('提交引用必须只填写已存在的 Git SHA，不含说明文字。');
    return runCommand('git',['rev-parse','--verify',`${ref}^{commit}`],project.path);
  }
  async createWorktree(project:Project,taskId:string,agentId:string,baseCommit?:string):Promise<TaskBinding> {
    assertIdentifier(taskId);
    const startCommit=baseCommit?await this.resolveCommit(project,baseCommit):await runCommand('git',['rev-parse','HEAD'],project.path);
    const suffix=randomUUID().slice(0,8);
    const name=`${taskId}-${agentId.slice(0,8)}-${suffix}`;
    const target=resolve(this.worktreeRoot,project.id,name);
    mkdirSync(resolve(this.worktreeRoot,project.id),{recursive:true});
    const branch=`workbench/${name}`;
    await runCommand('git',['worktree','add','-b',branch,target,startCommit],project.path);
    return {taskId,projectId:project.id,agentId,worktree:target,branch,startCommit};
  }
  async inspect(path:string):Promise<{commit:string;dirty:boolean;diff:string}> {
    const [commit,status,diff]=await Promise.all([
      runCommand('git',['rev-parse','HEAD'],path),
      runCommand('git',['status','--porcelain'],path),
      runCommand('git',['diff','--stat','HEAD'],path)
    ]);
    return {commit,dirty:status.length>0,diff};
  }
}
