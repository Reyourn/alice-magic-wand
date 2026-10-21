import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { Agent, Approval, Artifact, Attachment, ControlMode, Project, ProjectDiscovery, RuntimeAdapter, RuntimeConnection, RuntimeEvent, RuntimeInfo, RuntimeKind, RuntimeModelCatalog, RuntimeAuthenticationSession, Snapshot, Task, TaskBinding, WorkbenchEvent } from '../shared/types.js';
import { Store, type QueuedMessage, type RunRecord } from './store.js';
import { BeadsRepository, LocalGitRepository, WorkbenchError, runCommand, type GitRepository, type TaskCreateInput, type TaskRepository } from './repositories.js';
import { UsageLedger, isTokenCount } from './usage.js';
import { safeText } from './runtime/process.js';
import { discoverProjects, type ProjectDiscoveryOptions } from './project-discovery.js';
import { Attachments, attachmentIds, prepareAttachment, runtimeAttachmentInput, type ResolvedAttachment } from './attachments.js';
import { extractDocument } from './documents.js';
import { RuntimeInputError } from './runtime/base.js';
import { ConnectionManager } from './connections/index.js';
import type { ConnectionManagerOptions } from './connections/manager.js';
import { NativeIdentityError } from './connections/native.js';
import { CapabilityManager } from './capabilities.js';
import { verifyCapability, type CapabilityVerificationInput } from './capability-probe.js';
import { ROLE_TEMPLATES, type InboxItem, type ConnectionInput, type ConnectionProfile } from '../shared/types.js';
import type { WorkflowDispatchInput, ArtifactBundle, ExecutionRound } from '../shared/types.js';
import { WorkflowManager } from './workflows/index.js';
import { PreviewServer } from './previews.js';
import { scopedTool, reviewRecords } from './scoped-tools.js';
import { DeliveryActions } from './delivery-actions.js';

type MessageSource = 'human'|'controller'|'system';
interface ActiveRun { message: QueuedMessage; terminal: Promise<void>; finish: ()=>void; output?:string; finalizing?:boolean; }
export interface ServiceOptions {
  dataDir: string;
  adapters: RuntimeAdapter[] | Record<RuntimeKind,RuntimeAdapter>;
  store?: Store;
  tasks?: TaskRepository;
  git?: GitRepository;
  maxWorkers?: number;
  baseUrl?: string;
  interruptTimeoutMs?: number;
  projectDiscovery?: ProjectDiscoveryOptions;
  connectionOptions?:Pick<ConnectionManagerOptions,'nativeLogin'|'nativeLogout'|'nativeAuthentication'>;
  authenticationMonitorIntervalMs?:number|false;
}
const now=()=>new Date().toISOString();
const controller=(agent:Agent)=>agent.memberKind==='controller';
const bindingKey=(projectId:string,taskId:string)=>`${projectId}:${taskId}`;
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkbenchError('请求正文必须为对象');
  return value as Record<string,unknown>;
}
function string(value:unknown,label:string,max=20000):string {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new WorkbenchError(`${label}不能为空，且长度不能超过 ${max}`);
  return value.trim();
}
function optionalString(value:unknown,max=20000):string { if(value===undefined)return ''; if(typeof value!=='string'||value.length>max)throw new WorkbenchError('字符串参数不合法'); return value; }
function equalKey(input:unknown):string {
  if(input===null||typeof input!=='object')return JSON.stringify(input);
  if(Array.isArray(input))return `[${input.map(equalKey).join(',')}]`;
  return `{${Object.entries(input as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${equalKey(v)}`).join(',')}}`;
}
function errorText(error:unknown):string { return error instanceof Error?error.message:String(error); }
function assertNoLiveService(db:DatabaseSync):void {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").get())return;
  const row=db.prepare("SELECT json FROM entities WHERE collection='service' AND id='owner'").get() as {json:string}|undefined;
  if(!row)return;
  const owner=JSON.parse(row.json) as {pid:number};
  let alive=false;try{process.kill(owner.pid,0);alive=true;}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM')alive=true;}
  if(alive)throw new WorkbenchError(`此数据目录正在由工作台进程 ${owner.pid} 使用；请使用现有服务或指定其他数据目录。`,409);
}

export class WorkbenchService extends EventEmitter {
  readonly store:Store;
  readonly tasks:TaskRepository;
  readonly git:GitRepository;
  readonly adapters:Map<RuntimeKind,RuntimeAdapter>;
  readonly usage:UsageLedger;
  readonly connectionManager:ConnectionManager;
  readonly capabilities:CapabilityManager;
  readonly workflows:WorkflowManager;
  readonly previews:PreviewServer;
  readonly deliveryActions:DeliveryActions;
  private readonly attachments:Attachments;
  private connections=new Map<string,RuntimeConnection>();
  private connectionCapabilityFingerprints=new Map<string,string>();
  private active=new Map<string,ActiveRun>();
  private interruptBarriers=new Set<string>();
  private locks=new Map<string,Promise<unknown>>();
  private commandPromises=new Map<string,Promise<unknown>>();
  private controllerTokens=new Map<string,string>();
  private pumping=false;
  private closing=false;
  private closed=false;
  private closePromise?:Promise<void>;
  private discovery?:{at:number;promise:Promise<RuntimeInfo[]>};
  private projectDiscoveryRequest?:Promise<ProjectDiscovery>;
  private modelCatalogs=new Map<string,{expires:number;catalog:RuntimeModelCatalog}>();
  private modelRequests=new Map<string,Promise<RuntimeModelCatalog>>();
  private taskSnapshots=new Map<string,{expires:number;promise:Promise<Task[]>}>();
  private background=new Set<Promise<unknown>>();
  private authenticationMonitor?:ReturnType<typeof setInterval>;
  private authenticationStartup?:ReturnType<typeof setTimeout>;
  private authenticationRefresh?:Promise<ConnectionProfile[]>;
  private baseUrl:string;
  private instanceId=randomUUID();
  constructor(private readonly options:ServiceOptions) {
    super();
    this.previews=new PreviewServer(join(options.dataDir,'previews'));
    // Reject an existing owner before Store performs any backup/schema writes.
    // Recheck under the write transaction below to arbitrate simultaneous starts.
    this.store=options.store??new Store(join(options.dataDir,'workbench.sqlite'),assertNoLiveService);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      assertNoLiveService(this.store.db);
      this.store.put('service','owner',{pid:process.pid,instanceId:this.instanceId,startedAt:now()});this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');this.store.close();throw error;}
    this.tasks=options.tasks??new BeadsRepository();
    this.git=options.git??new LocalGitRepository(join(options.dataDir,'worktrees'));
    this.adapters=new Map(Object.values(options.adapters).map(adapter=>[adapter.kind,adapter]));
    this.connectionManager=new ConnectionManager({dataDir:options.dataDir,store:this.store,adapters:Object.fromEntries(this.adapters) as Record<RuntimeKind,RuntimeAdapter>,...options.connectionOptions});
    for(const runtime of this.adapters.keys())this.connectionManager.ensureNative(runtime);
    this.capabilities=new CapabilityManager(this.store,()=>this.agents());
    this.baseUrl=options.baseUrl??'http://127.0.0.1:4310';
    this.usage=new UsageLedger(this.store);
    this.attachments=new Attachments(this.store,options.dataDir);
    // One-time additive legacy mapping: subsequent role/name edits never grant scheduling authority.
    for(const old of this.agents()) {
      if(!old.memberKind||!old.connectionId){const profile=old.connectionId?this.connectionManager.get(old.connectionId):this.connectionManager.ensureNative(old.runtime);this.saveAgent({...old,memberKind:old.memberKind??(['controller','主控'].includes(old.role.toLowerCase())?'controller':'worker'),connectionId:profile.id,connectionRevision:old.connectionRevision??profile.revision,capabilityIds:old.capabilityIds??[]});}
    }
    this.workflows=new WorkflowManager({store:this.store,tasks:this.tasks,git:this.git,dataDir:options.dataDir,getProject:id=>this.getProject(id),getAgent:id=>this.getAgent(id),isAgentActive:id=>this.active.has(id)||this.getAgent(id).state==='unknown'||this.messages().some(m=>m.agentId===id&&['queued','sending','delivered'].includes(m.state)),
      dispatch:async input=>this.dispatch(input.taskId,{projectId:this.getAgent(input.agentId).projectId,agentId:input.agentId,...(input.baseCommit?{baseCommit:input.baseCommit}:{}),...(input.reviewTaskId?{reviewTaskId:input.reviewTaskId}:{})},input.idempotencyKey,'controller',undefined,input) as Promise<{messageId:string}>,
      notifyController:async(projectId,text)=>{const lead=this.agents().find(a=>a.projectId===projectId&&controller(a));if(lead&&!this.closing)this.enqueue(lead.id,text,'system');},
      event:(type,data,projectId)=>{this.event(type,undefined,undefined,data,projectId);if(type==='workflow.attention')this.addInbox({projectId,workflowId:String(data.workflowId),kind:'rework',title:'工作流需要处理',detail:String(data.reason??'核对当前执行与成果')});},
      preflight:async(agent,node)=>{const errors:string[]=[];if(controller(agent))errors.push('主控不能作为实施任务负责人');try {const profile=this.connectionManager.get(agent.connectionId!);if(profile.revision!==agent.connectionRevision)errors.push('成员连接版本已过期');await this.connectionManager.assertReady(profile.id,agent.model||profile.defaultModel,this.connectionCwd(agent.projectId),['inference','streaming','tools']);}catch(error){errors.push(this.publicError(error));}try{this.capabilities.assertBound(agent,node.requiredCapabilities);}catch(error){errors.push(this.publicError(error));}return errors;}});
    this.deliveryActions=new DeliveryActions(this.store,this.workflows,this.git);
    for(const agent of this.agents()) {
      const run=this.store.get<RunRecord>('runs',agent.id);
      if(run&&!this.store.get<RunRecord>('run_history',run.messageId))this.store.put('run_history',run.messageId,run);
      const pending=this.messages().filter(m=>m.agentId===agent.id&&['queued','sending','delivered'].includes(m.state));
      if(run?.state==='active'||['running','starting','interrupting','waiting_approval'].includes(agent.state)||pending.length) {
        this.saveAgent({...agent,state:'unknown',controlMode:'human',lastError:'服务已重启；旧会话状态未确认，自动派发暂停。核对旧进程退出后恢复。'});
        if(run)this.saveRun({...run,state:'unknown'});
        for(const message of pending)if(message.state!=='queued')this.store.put('messages',message.id,{...message,state:'uncertain'});
      }
      this.expireApprovals(agent.id,'服务已重启，旧审批通道已失效。请在恢复后的会话中处理新的审批请求。');
    }
  }
  setBaseUrl(url:string):void { this.baseUrl=url; }
  listRuntimeAuthentications():RuntimeAuthenticationSession[] {
    return [...this.adapters.values()].flatMap(adapter=>adapter.authentication?.list()??[]).slice(-100).map(row=>({
      id:row.id,agentId:row.agentId,connectionId:row.connectionId,connectionRevision:row.connectionRevision,
      ...(typeof row.pid==='number'&&Number.isSafeInteger(row.pid)&&row.pid>0?{pid:row.pid}:{}),
      edition:row.edition,cwd:row.cwd,state:row.state,createdAt:row.createdAt,updatedAt:row.updatedAt,
      detail:this.publicError(row.detail),canAuthorize:row.state==='waiting'&&row.canAuthorize===true,
    }));
  }
  private authenticationOwner(id:string) {
    for(const adapter of this.adapters.values())if(adapter.authentication){const session=adapter.authentication.list().find(row=>row.id===id);if(session)return {control:adapter.authentication,session};}
    throw new WorkbenchError('原生授权会话不存在或已过期',404);
  }
  runtimeAuthenticationUrl(id:string):string {
    const {control,session}=this.authenticationOwner(id);
    if(session.state!=='waiting'||!session.canAuthorize)throw new WorkbenchError('此原生授权入口已结束或尚未就绪，请返回工作台查看当前会话',410);
    const raw=control.url(id);let url:URL;
    try{url=new URL(raw??'');}catch{throw new WorkbenchError('原生授权链接不可用',410);}
    if(url.protocol!=='https:'||url.username||url.password)throw new WorkbenchError('原生授权链接不符合 HTTPS 要求',409);
    return url.toString();
  }
  async cancelRuntimeAuthentication(id:string):Promise<{ok:true}> {
    const {control,session}=this.authenticationOwner(id);
    if(session.state==='authenticated')throw new WorkbenchError('此进程已交给成员执行；请使用成员会话的中断或停止操作',409);
    await control.cancel(id);return {ok:true};
  }
  startAuthenticationMonitoring():void {
    if(this.authenticationMonitor||this.closing||this.options.authenticationMonitorIntervalMs===false)return;
    const interval=Math.max(1000,this.options.authenticationMonitorIntervalMs??60_000);
    const refresh=()=>{if(!this.closing)this.track(this.refreshAuthenticationStatuses().catch(()=>{}));};
    this.authenticationStartup=setTimeout(refresh,1000);this.authenticationStartup.unref();
    this.authenticationMonitor=setInterval(refresh,interval);this.authenticationMonitor.unref();
  }
  refreshAuthenticationStatuses():Promise<ConnectionProfile[]> {
    if(this.closing)return Promise.resolve(this.connectionManager.list());
    if(this.authenticationRefresh)return this.authenticationRefresh;
    const work=(async()=>{
      for(const profile of this.connectionManager.list().filter(row=>row.mode==='native')){
        if(this.closing)break;
        // Account inspection must not compete with an active or uncertain native session.
        if(this.agents().some(agent=>agent.runtime===profile.runtime&&(this.active.has(agent.id)||['starting','running','waiting_approval','interrupting','unknown'].includes(agent.state))))continue;
        const agent=this.agents().find(row=>row.connectionId===profile.id),project=agent?this.projects().find(row=>row.id===agent.projectId):undefined;
        try{
          // Consume native login receipts even when the connection settings page is closed.
          await this.connectionManager.loginStatus(profile.id);
          const updated=await this.connectionManager.refreshAuthentication(profile.id,project?.path??process.cwd());
          const previous=profile.authenticationStatus,next=updated.authenticationStatus;
          if(next&&(previous?.state!==next.state||previous?.detail!==next.detail))this.event('connection.authentication',undefined,`${profile.name}：${next.state}`,{connectionId:profile.id,state:next.state,checkedAt:next.checkedAt});
        }catch{/* A login/verification in progress retains its own status and gate. */}
      }
      return this.connectionManager.list();
    })();
    this.authenticationRefresh=work;void work.finally(()=>{this.authenticationRefresh=undefined;}).catch(()=>{});return work;
  }
  projects():Project[]{return this.store.all<Project>('projects');}
  discoverProjects():Promise<ProjectDiscovery> {
    if(this.projectDiscoveryRequest)return this.projectDiscoveryRequest;
    const request=discoverProjects(this.projects(),this.options.dataDir,this.options.projectDiscovery);
    this.projectDiscoveryRequest=request;
    void request.finally(()=>{if(this.projectDiscoveryRequest===request)this.projectDiscoveryRequest=undefined;}).catch(()=>{});
    return request;
  }
  agents():Agent[]{return this.store.all<Agent>('agents');}
  private messages():QueuedMessage[]{return this.store.all<QueuedMessage>('messages');}
  private saveRun(run:RunRecord):void {this.store.put('runs',run.agentId,run);this.store.put('run_history',run.messageId,run);}
  private expireApprovals(agentId:string,reason:string):void {
    for(const approval of this.store.all<Approval>('approvals'))if(approval.agentId===agentId) {
      this.store.remove('approvals',`${agentId}:${approval.id}`);
      this.event('approval.expired',agentId,reason,{approvalId:approval.id,tool:approval.tool});
    }
  }
  getAgent(id:string):Agent { const agent=this.store.get<Agent>('agents',id); if(!agent)throw new WorkbenchError('成员不存在',404); return agent; }
  getProject(id:string):Project { const project=this.store.get<Project>('projects',id);if(!project)throw new WorkbenchError('项目不存在',404);return project; }
  private saveAgent(agent:Agent):void {this.store.put('agents',agent.id,agent);}
  private patchAgent(id:string,patch:Partial<Agent>):Agent { const agent={...this.getAgent(id),...patch};if(agent.lastError)agent.lastError=this.scrub(agent.lastError) as string;this.saveAgent(agent);return agent;}
  private assertAccepting():void {if(this.closing||this.closed)throw new WorkbenchError('工作台正在关闭，不能开始新的操作',503);}
  private serialize<T>(key:string,fn:()=>Promise<T>):Promise<T> {
    const previous=this.locks.get(key)??Promise.resolve();
    const next=previous.catch(()=>{}).then(fn);this.locks.set(key,next);
    void next.finally(()=>{if(this.locks.get(key)===next)this.locks.delete(key);}).catch(()=>{});return next;
  }
  async idempotent<T>(scope:string,key:unknown,input:unknown,fn:()=>Promise<T>):Promise<T> {
    this.assertAccepting();
    const id=string(key,'Idempotency-Key',200);
    const fullKey=`${scope}:${id}`;
    const fingerprint=createHash('sha256').update(equalKey(input)).digest('hex');
    const previous=this.store.command(fullKey);
    if(previous) {
      if(previous.fingerprint!==fingerprint)throw new WorkbenchError('同一 Idempotency-Key 已用于不同请求',409);
      if(previous.state==='done')return previous.result as T;
      if(previous.state==='failed')throw new WorkbenchError(previous.error??'此请求先前失败，请核对结果；不要盲目重发。',409,previous.retrySafe===true);
      const running=this.commandPromises.get(fullKey);if(running)return running as Promise<T>;
      throw new WorkbenchError('该请求的投递结果不确定，已暂停重发，请核对会话与任务。',409);
    }
    this.store.saveCommand({key:fullKey,fingerprint,state:'pending'});
    const promise=fn().then(result=>{this.store.saveCommand({key:fullKey,fingerprint,state:'done',result});return result;},error=>{this.store.saveCommand({key:fullKey,fingerprint,state:'failed',error:this.publicError(error),retrySafe:error instanceof WorkbenchError&&error.retrySafe});throw error;}).finally(()=>this.commandPromises.delete(fullKey));
    this.commandPromises.set(fullKey,promise);return promise;
  }
  private scrub(value:unknown):unknown {
    if(typeof value==='string') {
      let text=value;
      for(const secret of this.controllerTokens.values())text=text.split(secret).join('[redacted]');
      return this.connectionManager?safeText(this.connectionManager.scrub(text)):safeText(text);
    }
    if(Array.isArray(value))return value.map(v=>this.scrub(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,val])=>[key,isTokenCount(key,val)?val:/token|password|api.?key|authorization|secret/i.test(key)?'[redacted]':this.scrub(val)]));
    return value;
  }
  publicError(error:unknown):string {return this.scrub(errorText(error)) as string;}
  event(type:string,agentId?:string,text?:string,data?:Record<string,unknown>,projectId?:string):WorkbenchEvent {
    const event=this.store.event({type,agentId,projectId:projectId??(agentId?this.store.get<Agent>('agents',agentId)?.projectId:undefined),text:this.scrub(text) as string|undefined,data:this.scrub(data) as Record<string,unknown>|undefined,createdAt:now()});
    this.emit('event',event);return event;
  }
  async discover():Promise<RuntimeInfo[]> {
    if(this.discovery&&Date.now()-this.discovery.at<60000)return this.discovery.promise;
    const promise=Promise.all([...this.adapters.values()].map(async adapter=>{
      try{return await adapter.discover();}catch(error){return {kind:adapter.kind,available:false,detail:errorText(error),capabilities:{steer:false,interrupt:false,resume:false,approvals:false}};}
    }));
    this.discovery={at:Date.now(),promise};return promise;
  }
  async modelsForAgent(id:string,refresh=false):Promise<RuntimeModelCatalog> {
    this.assertAccepting();
    const agent=this.getAgent(id),cwd=agent.worktree??this.getProject(agent.projectId).path;
    const key=JSON.stringify([agent.runtime,cwd,agent.connectionId,agent.connectionRevision]);
    // A refresh joins an existing probe too: double clicks must not spawn extra runtimes.
    const pending=this.modelRequests.get(key);if(pending)return pending;
    const cached=this.modelCatalogs.get(key);
    if(!refresh&&cached&&cached.expires>Date.now())return cached.catalog;
    const request=(async():Promise<RuntimeModelCatalog>=>{
      const attemptedAt=now();let catalog:RuntimeModelCatalog;
      try {
        const adapter=this.adapters.get(agent.runtime);
        if(!adapter?.listModels)throw new Error('此执行工具尚未提供模型目录；可以继续手动填写模型。');
        const result=agent.connectionId?await this.connectionManager.models(agent.connectionId,cwd):await adapter.listModels(cwd);
        if(result.status!=='ready')throw new Error(result.detail||'原生工具未能返回模型目录');
        catalog={runtime:agent.runtime,status:'ready',source:this.publicError(result.source),checkedAt:result.checkedAt,attemptedAt,detail:this.publicError(result.detail),models:result.models.map(model=>({id:this.publicError(model.id),name:this.publicError(model.name),...(model.description?{description:this.publicError(model.description)}:{}),...(model.isDefault!==undefined?{isDefault:model.isDefault}:{})}))};
      }catch(error){
        const previous=cached?.catalog;
        const stale=Boolean(previous&&(previous.status==='ready'||previous.stale));
        catalog={runtime:agent.runtime,status:'unavailable',models:stale?previous!.models:[],source:stale?previous!.source:'原生工具模型发现',checkedAt:stale?previous!.checkedAt:attemptedAt,attemptedAt,stale,detail:this.publicError(error)};
      }
      // Brief failure cooldown avoids repeated auto-loads; explicit refresh can always retry.
      this.modelCatalogs.set(key,{expires:Date.now()+(catalog.status==='ready'?300000:10000),catalog});
      return catalog;
    })();
    this.modelRequests.set(key,request);
    try{return await request;}finally{if(this.modelRequests.get(key)===request)this.modelRequests.delete(key);}
  }
  async snapshot():Promise<Snapshot> {
    const projects=this.projects();const errors:string[]=[];
    const [groups,runtimes]=await Promise.all([Promise.all(projects.map(async project=>{try{return await this.readTaskSnapshot(project);}catch(error){errors.push(`${project.name} / Beads: ${errorText(error)}`);return [];} })),this.discover()]);
    for(const runtime of runtimes)if(!runtime.available)errors.push(`${runtime.kind}: ${runtime.detail}`);
    const agents=this.agents(),tasks=groups.flat();
    return {projects,agents,tasks,bindings:this.store.all<TaskBinding>('bindings'),artifacts:this.store.all<Artifact>('artifacts'),approvals:this.store.all<Approval>('approvals'),runtimes,events:this.store.events(0,500),errors:this.scrub(errors) as string[],usage:this.usage.records(),usageSummaries:this.usage.summaries(agents,this.messages(),this.store.all<RunRecord>('run_history'),tasks)};
  }
  private readTaskSnapshot(project:Project):Promise<Task[]> {
    const cached=this.taskSnapshots.get(project.id);if(cached&&cached.expires>Date.now())return cached.promise;
    const promise=this.tasks.list(project);this.taskSnapshots.set(project.id,{expires:Date.now()+1500,promise});return promise;
  }
  async createProject(input:unknown):Promise<Project> {
    this.assertAccepting();
    const body=object(input);const kind=body.kind??'code';if(!['code','office'].includes(String(kind)))throw new WorkbenchError('项目类型不合法');
    const requestedPath=string(body.path,'项目路径',2000),id=randomUUID();
    const path=kind==='office'?resolve(requestedPath):await this.git.validate(requestedPath);
    return this.serialize(`register:${path.toLowerCase()}`,async()=>{
      const existing=this.projects().find(p=>p.path.toLowerCase()===path.toLowerCase());if(existing)return existing;
      const office=kind==='office'?await this.workflows.office.registerFolder(id,path):undefined;
      if(!office)await this.tasks.validate(path,body.initializeBeads===true);
      const project:Project={id,name:string(body.name,'项目名',120),path:office?.path??path,controlPath:office?.controlPath,kind:kind as 'code'|'office',createdAt:now()};
      this.store.put('projects',project.id,project);this.event('project.created',undefined,project.name,undefined,project.id);return project;
    });
  }
  async createAgent(input:unknown):Promise<Agent> {
    this.assertAccepting();
    const body=object(input);const project=this.getProject(string(body.projectId,'项目 ID',100));
    const runtime=string(body.runtime,'执行工具',30) as RuntimeKind;if(!this.adapters.has(runtime))throw new WorkbenchError('未知执行工具');
    const template=body.roleTemplateId?ROLE_TEMPLATES.find(t=>t.id===body.roleTemplateId):undefined;if(body.roleTemplateId&&!template)throw new WorkbenchError('角色模板不存在');
    const permissionMode=body.permissionMode??template?.permissionMode??'workspace-write';if(!['read-only','workspace-write'].includes(String(permissionMode)))throw new WorkbenchError('权限模式不合法');
    const memberKind=body.memberKind??'worker';if(!['controller','worker'].includes(String(memberKind)))throw new WorkbenchError('成员调度权限不合法');
    const profile=body.connectionId?this.connectionManager.get(string(body.connectionId,'连接 ID',100)):this.connectionManager.ensureNative(runtime);if(profile.runtime!==runtime)throw new WorkbenchError('连接与执行工具不匹配');
    const capabilityIds=this.validCapabilityIds(body.capabilityIds??[]);
    const agent:Agent={id:randomUUID(),projectId:project.id,name:string(body.name,'成员名',120),role:string(body.role??template?.name,'角色',100),runtime,model:optionalString(body.model,500),instructions:body.instructions===undefined?template?.instructions??'':optionalString(body.instructions),permissionMode:memberKind==='controller'?'read-only':permissionMode as Agent['permissionMode'],controlMode:'auto',state:'offline',createdAt:now(),memberKind:memberKind as Agent['memberKind'],roleTemplateId:template?.id,connectionId:profile.id,connectionRevision:profile.revision,capabilityIds};
    if(controller(agent)&&this.agents().some(a=>a.projectId===project.id&&controller(a)))throw new WorkbenchError('每个项目只允许一个主控；可以编辑现有主控。',409);
    this.saveAgent(agent);this.event('agent.created',agent.id,agent.name);return agent;
  }
  async updateAgent(id:string,input:unknown):Promise<Agent> {
    return this.serialize(`agent:${id}`,async()=>{
      const agent=this.getAgent(id);if(this.active.has(id)||agent.state==='unknown')throw new WorkbenchError('请先停止成员并核实会话，再修改配置。',409);
      const body=object(input);const next={...agent};
      for(const field of ['name','role','model','instructions'] as const)if(body[field]!==undefined)next[field]=field==='name'||field==='role'?string(body[field],field,120):optionalString(body[field],field==='model'?500:20000);
      if(body.runtime!==undefined){if(!this.adapters.has(body.runtime as RuntimeKind))throw new WorkbenchError('未知执行工具');next.runtime=body.runtime as RuntimeKind;}
      if(body.permissionMode!==undefined){if(!['read-only','workspace-write'].includes(String(body.permissionMode)))throw new WorkbenchError('权限模式不合法');next.permissionMode=body.permissionMode as Agent['permissionMode'];}
      if(body.memberKind!==undefined){if(!['controller','worker'].includes(String(body.memberKind)))throw new WorkbenchError('成员调度权限不合法');next.memberKind=body.memberKind as Agent['memberKind'];}
      if(body.roleTemplateId!==undefined){if(!ROLE_TEMPLATES.some(t=>t.id===body.roleTemplateId))throw new WorkbenchError('角色模板不存在');next.roleTemplateId=String(body.roleTemplateId);}
      if(body.capabilityIds!==undefined)next.capabilityIds=this.validCapabilityIds(body.capabilityIds);
      const profile=body.connectionId?this.connectionManager.get(string(body.connectionId,'连接 ID',100)):next.runtime!==agent.runtime?this.connectionManager.ensureNative(next.runtime):this.connectionManager.get(next.connectionId!);
      if(profile.runtime!==next.runtime)throw new WorkbenchError('连接与执行工具不匹配');next.connectionId=profile.id;next.connectionRevision=profile.revision;
      if(controller(next))next.permissionMode='read-only';
      if(controller(next)&&this.agents().some(a=>a.id!==id&&a.projectId===agent.projectId&&controller(a)))throw new WorkbenchError('每个项目只允许一个主控',409);
      if(agent.nativeSessionId)this.store.put('session_history',`${id}:${agent.nativeSessionId}`,{...agent,archivedAt:now(),reason:'成员配置更新'});
      await this.closeConnection(id);next.nativeSessionId=undefined;next.observedModel=undefined;next.observedProvider=undefined;next.state='offline';this.saveAgent(next);this.event('agent.updated',id,'配置已更新；后续使用新会话，原会话记录保留。');return next;
    });
  }
  private validCapabilityIds(input:unknown):string[] {if(!Array.isArray(input)||input.some(id=>typeof id!=='string'))throw new WorkbenchError('能力列表必须为 ID 数组');const ids=[...new Set(input as string[])];for(const id of ids)this.capabilities.get(id);return ids;}
  connectionCwd(projectId?:string):string {if(!projectId)return this.options.dataDir;const project=this.getProject(projectId);return project.controlPath??project.path;}
  affectedConnectionMembers(id:string):Agent[] {const ids=new Set(this.connectionManager.affectedNativeConnections(id).map(profile=>profile.id));return this.agents().filter(a=>ids.has(a.connectionId!));}
  async updateConnection(id:string,input:ConnectionInput):Promise<unknown> {
    return this.serialize(`connection:${id}`,async()=>{
      const agents=this.agents().filter(a=>a.connectionId===id);
      if(agents.some(a=>this.active.has(a.id)||a.state==='unknown'||this.messages().some(m=>m.agentId===a.id&&m.state==='queued')))throw new WorkbenchError('该连接的成员正在执行、排队或状态未知；请先处理后再更换认证或服务',409);
      const profile=await this.connectionManager.update(id,input);
      for(const agent of agents){if(agent.nativeSessionId)this.store.put('session_history',`${agent.id}:${agent.nativeSessionId}`,{...agent,archivedAt:now(),reason:'连接配置修订'});await this.closeConnection(agent.id);this.patchAgent(agent.id,{connectionRevision:profile.revision,nativeSessionId:undefined,observedModel:undefined,observedProvider:undefined,state:'offline'});}
      this.event('connection.updated',undefined,'连接配置已更新，旧会话保留，相关成员下次使用新会话。',{connectionId:id});return profile;
    });
  }
  async removeConnection(id:string):Promise<{ok:true}> {if(this.agents().some(a=>a.connectionId===id))throw new WorkbenchError('该连接仍被成员引用，请先修改成员绑定；删除连接不会退出原生账号',409);await this.connectionManager.remove(id);return {ok:true};}
  async createCoreTeam(projectId:string,input:unknown):Promise<Agent[]> {
    const project=this.getProject(projectId),body=object(input),preset=body.preset??(project.kind==='office'?'office':'development');
    if(!['development','office'].includes(String(preset)))throw new WorkbenchError('团队预置不合法');
    return this.serialize(`core-team:${projectId}`,async()=>{
      const definitions=[{template:'controller',runtime:'codex' as const},{template:preset==='office'?'analyst':'fullstack',runtime:'workbuddy' as const},{template:'reviewer',runtime:'claude' as const}];
      const result:Agent[]=[];for(const definition of definitions){const template=ROLE_TEMPLATES.find(t=>t.id===definition.template)!;const existing=this.agents().find(a=>a.projectId===projectId&&(template.memberKind==='controller'?controller(a):a.roleTemplateId===template.id));
        result.push(existing??await this.createAgent({projectId,name:template.name,role:template.name,roleTemplateId:template.id,memberKind:template.memberKind,runtime:definition.runtime,permissionMode:template.permissionMode}));}
      return result;
    });
  }
  private sharedNativeProfiles(id:string) {const profile=this.connectionManager.get(id);if(profile.mode!=='native')throw new WorkbenchError('只有原生连接使用本机账号登录');return this.connectionManager.list().filter(p=>p.mode==='native'&&p.runtime===profile.runtime);}
  private assertSharedNativeIdle(id:string):void {const ids=new Set(this.sharedNativeProfiles(id).map(p=>p.id));const affected=this.agents().filter(a=>ids.has(a.connectionId!));if(affected.some(a=>this.active.has(a.id)||a.state==='unknown'||this.messages().some(m=>m.agentId===a.id&&['queued','sending','delivered'].includes(m.state))))throw new WorkbenchError(`共享原生账号的成员尚未停止或核对：${affected.map(a=>a.name).join('、')}`,409);}
  private async prepareNativeIdentityChange(id:string):Promise<void> {
    for(const agent of this.affectedConnectionMembers(id)){
      if(agent.nativeSessionId)this.store.put('session_history',`${agent.id}:${agent.nativeSessionId}`,{...agent,archivedAt:now(),reason:'共享原生账号操作'});
      try{await this.closeConnection(agent.id);}catch{throw new NativeIdentityError('共享原生账号的旧会话尚未确认停止；暂停账号操作。',false,()=>this.prepareNativeIdentityChange(id));}
      this.patchAgent(agent.id,{connectionRevision:this.connectionManager.get(agent.connectionId!).revision,nativeSessionId:undefined,observedModel:undefined,observedProvider:undefined,state:'offline'});
    }
    this.event('connection.updated',undefined,'共享原生账号的旧会话已保留；登录或退出期间停止派发，之后需要重新验证。',{connectionId:id});
  }
  async startNativeLogin(id:string,input:Record<string,unknown>):Promise<unknown> {
    this.assertAccepting();
    const method=input.method as 'browser'|'device-code'|'native-terminal'|undefined;if(method&&!['browser','device-code','native-terminal'].includes(method))throw new WorkbenchError('不支持的登录方式');
    return this.connectionManager.startLogin(id,{cwd:this.connectionCwd(typeof input.projectId==='string'?input.projectId:undefined),method,assertIdle:()=>this.assertSharedNativeIdle(id),prepare:()=>this.prepareNativeIdentityChange(id)});
  }
  async logoutNativeConnection(id:string,input:Record<string,unknown>):Promise<unknown> {
    this.assertAccepting();return this.connectionManager.logout(id,this.connectionCwd(typeof input.projectId==='string'?input.projectId:undefined),{assertIdle:()=>this.assertSharedNativeIdle(id),prepare:()=>this.prepareNativeIdentityChange(id)});
  }
  async reconcileNativeLogin(id:string,input:Record<string,unknown>):Promise<unknown> {
    this.assertAccepting();return this.connectionManager.reconcileLogin(id,input,{assertIdle:()=>this.assertSharedNativeIdle(id),prepare:()=>this.prepareNativeIdentityChange(id)});
  }
  private artifactFile(id:string):{artifact:Artifact;root:string;path:string} {
    const artifact=this.store.get<Artifact>('artifacts',id);if(!artifact||artifact.kind!=='file')throw new WorkbenchError('文件成果不存在',404);
    const binding=artifact.taskId?this.store.get<TaskBinding>('bindings',bindingKey(artifact.projectId,artifact.taskId)):undefined;
    if(!binding)throw new WorkbenchError('历史文件没有可核对的任务工作区，请在版本成果包中重新登记',409);
    return {artifact,root:binding.worktree,path:resolve(binding.worktree,artifact.value)};
  }
  async previewArtifact(id:string):Promise<unknown> {
    const artifact=this.store.get<Artifact>('artifacts',id);if(!artifact)throw new WorkbenchError('成果不存在',404);
    if(artifact.kind==='file'){const file=this.artifactFile(id);return this.previews.file(file.root,file.path,`/api/artifacts/${encodeURIComponent(id)}/download`);}
    let text=artifact.value;
    if(artifact.kind==='commit'){const project=this.getProject(artifact.projectId);const sha=await this.git.resolveCommit(project,artifact.value);text=await runCommand('git',['show','--no-ext-diff','--format=fuller',sha,'--'],project.path);}
    return {kind:'text',title:artifact.title,text,detail:'历史记录；没有完整版本证据的成果不会自动计入新工作流验收。',downloadUrl:''};
  }
  downloadArtifact(id:string){const file=this.artifactFile(id);return this.previews.bytes(file.root,file.path);}
  private bundleFile(id:string,index:number) {const bundle=this.store.get<ArtifactBundle>('artifact_bundles',id);if(!bundle||!Number.isInteger(index)||!bundle.files[index])throw new WorkbenchError('版本成果文件不存在',404);return {bundle,file:bundle.files[index]!};}
  async previewBundleFile(id:string,index:number):Promise<unknown> {const {bundle,file}=this.bundleFile(id,index);return this.previews.file(dirname(file.path),file.path,`/api/bundles/${id}/files/${index}/download`,file.sha256,bundle.files);}
  downloadBundleFile(id:string,index:number){const {file}=this.bundleFile(id,index);return this.previews.bytes(dirname(file.path),file.path,file.sha256);}
  inbox(projectId?:string):InboxItem[] {
    const rows=this.store.all<InboxItem>('inbox').filter(row=>!projectId||row.projectId===projectId);
    for(const agent of this.agents().filter(a=>!projectId||a.projectId===projectId))if(agent.state==='unknown'||agent.lastError)rows.push({id:`runtime:${agent.id}`,projectId:agent.projectId,agentId:agent.id,kind:agent.state==='unknown'?'recovery':'error',title:`${agent.name}：${agent.state==='unknown'?'待核对恢复':'执行异常'}`,detail:agent.lastError??'核对原会话和进程，再恢复执行。',state:'open',createdAt:agent.createdAt});
    for(const approval of this.store.all<Approval>('approvals')){const agent=this.getAgent(approval.agentId);if(!projectId||projectId===agent.projectId)rows.push({id:`approval:${agent.id}:${approval.id}`,projectId:agent.projectId,agentId:agent.id,kind:'approval',title:approval.tool,detail:'在成员会话中核对工具参数后允许或拒绝。',state:'open',createdAt:approval.createdAt});}
    for(const workflow of this.workflows.list(projectId))if(['draft','completed','blocked'].includes(workflow.status))rows.push({id:`workflow:${workflow.id}`,projectId:workflow.projectId,workflowId:workflow.id,kind:workflow.status==='draft'?'plan':workflow.status==='completed'?'delivery':'error',title:`${workflow.name}：${workflow.status==='draft'?'待确认计划':workflow.status==='completed'?'待交付':'需要处理'}`,detail:workflow.lastError??(workflow.status==='completed'?'任务已验收，请核对最终差异、证据和交付目标。':'在编排视图核对任务、负责人、依赖、输入与验收项后确认。'),state:'open',createdAt:workflow.updatedAt});
    return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  addInbox(input:Omit<InboxItem,'id'|'state'|'createdAt'>,stableId?:string):InboxItem {const item:InboxItem={...input,id:stableId??randomUUID(),state:'open',createdAt:now()};this.store.put('inbox',item.id,item);this.event('inbox.created',item.agentId,item.title,{inboxId:item.id},item.projectId);return item;}
  async resolveInbox(id:string,input:unknown):Promise<InboxItem> {
    const item=this.store.get<InboxItem>('inbox',id);if(!item)throw new WorkbenchError('请在对应会话或工作流中处理此事项',409);
    const answer=string(object(input).answer,'答复或处理说明',20000);if(item.state==='resolved')return item;
    const target=item.agentId?this.getAgent(item.agentId):this.agents().find(a=>a.projectId===item.projectId&&controller(a));
    if(target)await this.message(target.id,{text:`用户已回复事项 ${id}：${item.title}\n${answer}\n先核对当前任务和会话，再继续；这不是对计划外操作的自动授权。`,mode:'interrupt'},`inbox-answer:${id}`);
    const next={...item,state:'resolved' as const,answer,resolvedAt:now()};this.store.put('inbox',id,next);
    this.event('inbox.resolved',target?.id,answer,{inboxId:id},item.projectId);return next;
  }
  async verifyMemberCapability(id:string,input:unknown):Promise<unknown> {
    const body=object(input),capability=this.capabilities.get(id),agent=this.getAgent(string(body.agentId,'成员 ID',100));
    if(!agent.capabilityIds?.includes(id))throw new WorkbenchError('请先将能力绑定给成员');
    if(this.active.has(agent.id)||agent.state==='unknown')throw new WorkbenchError('请先停止成员并核对会话',409);
    const cwd=agent.worktree??this.connectionCwd(agent.projectId);
    const profile=this.connectionManager.get(agent.connectionId!);
    return this.connectionManager.withConnectionUse(profile.id,async()=>{
    await this.connectionManager.assertReady(profile.id,agent.model||profile.defaultModel,cwd);
    const connection=await this.connectionManager.resolveRuntime(profile.id,{cwd,model:agent.model||profile.defaultModel});
    const probeInput:CapabilityVerificationInput=capability.kind==='mcp'?{tool:string(body.tool,'工具名',200),arguments:object(body.arguments??{})}:capability.kind==='skill'?{scenario:string(body.scenario,'验证小用例',20000),expectedOutput:string(body.expectedOutput,'预期答案',20000)}:{};
    return verifyCapability(this.capabilities,capability,agent,this.adapters.get(agent.runtime)!,{agentId:agent.id,cwd,model:agent.model||profile.defaultModel,permissionMode:'read-only',instructions:'',connection},probeInput,(event,messageId)=>{this.usage.record({projectId:agent.projectId,agentId:agent.id,runtime:agent.runtime,messageId,nativeSessionId:event.nativeSessionId,connectionId:profile.id,connectionRevision:profile.revision},event.data??{});});
    });
  }
  async control(id:string,mode:unknown):Promise<Agent> {
    if(mode!=='human'&&mode!=='auto')throw new WorkbenchError('控制模式不合法');
    const agent=this.getAgent(id);
    if(mode==='auto'&&agent.state==='unknown')throw new WorkbenchError('先核对并恢复旧会话，再交还主控。',409);
    const updated=this.patchAgent(id,{controlMode:mode as ControlMode});
    if(mode==='human')this.cancelControllerQueue(id);
    this.event('agent.control',id,mode==='human'?'人工已接管；主控指令暂停。':'已交还主控，将使用当前任务和会话继续。',{mode});
    if(mode==='auto'&&!controller(agent)) {
      const lead=this.agents().find(a=>a.projectId===agent.projectId&&controller(a));
      if(lead)this.enqueue(lead.id,`人工已将成员 ${agent.name} (${id}) 交还主控。当前任务 ${agent.currentTaskId??'无'}；状态 ${agent.state}。先用 get_agent_events 核对人工期间的新指令和成果，再决定下一步；不要重发先前已取消的指令。`,'system');
    }
    this.schedule();if(mode==='auto')this.advanceWorkflows();return updated;
  }
  private cancelControllerQueue(id:string):void {
    for(const message of this.messages())if(message.agentId===id&&message.source!=='human'&&message.state==='queued') {
      this.store.put('messages',message.id,{...message,state:'cancelled'});
      this.event('message.cancelled',id,'人工接管后取消尚未投递的主控指令。',{messageId:message.id});
    }
  }
  async createTask(input:unknown,projectScope?:string):Promise<Task> {
    this.assertAccepting();
    const body=object(input);const project=this.getProject(projectScope??string(body.projectId,'项目 ID',100));
    if(projectScope&&body.projectId&&body.projectId!==projectScope)throw new WorkbenchError('主控只能操作自己的项目',403);
    const dependencies=body.dependencies??[];if(!Array.isArray(dependencies)||dependencies.some(d=>typeof d!=='string'))throw new WorkbenchError('dependencies 必须为任务编号数组');
    if(body.priority!==undefined&&(!Number.isInteger(body.priority)||Number(body.priority)<0||Number(body.priority)>4))throw new WorkbenchError('优先级必须为 0–4');
    for(const id of dependencies)await this.tasks.get(project,id as string);
    const inputTask:TaskCreateInput={title:string(body.title,'任务标题',300),description:optionalString(body.description),acceptance:optionalString(body.acceptance),dependencies:dependencies as string[],priority:body.priority as number|undefined};
    const task=await this.tasks.create(project,inputTask);this.taskSnapshots.delete(project.id);this.event('task.created',undefined,task.title,{taskId:task.id},project.id);return task;
  }
  async setTaskStatus(taskId:string,input:unknown,projectScope?:string):Promise<Task> {
    const body=object(input);const project=this.getProject(projectScope??string(body.projectId,'项目 ID',100));
    if(projectScope&&body.projectId&&body.projectId!==projectScope)throw new WorkbenchError('主控只能操作自己的项目',403);
    const status=string(body.status,'任务状态',30);if(!['open','in_progress','blocked','deferred','closed'].includes(status))throw new WorkbenchError('不支持的任务状态');
    await this.tasks.get(project,taskId);
    const workflow=this.workflows.getDispatchContext(project.id,taskId);
    if(workflow&&status==='closed') {
      throw new WorkbenchError('工作流任务请在编排中核对准确计划版本、轮次与成果后验收；旧任务状态入口不能替代版本确认',409);
    }
    if(workflow&&status==='open')throw new WorkbenchError('工作流任务请使用退回修改，明确引用原成果并创建新轮次',409);
    const binding=this.store.get<TaskBinding>('bindings',bindingKey(project.id,taskId));
    if(status==='closed') {
      const boundAgent=binding?this.getAgent(binding.agentId):undefined;
      if(binding&&boundAgent?.currentTaskId===taskId&&boundAgent.worktree===binding.worktree&&(this.active.has(binding.agentId)||boundAgent.state==='unknown'||this.messages().some(m=>m.agentId===binding.agentId&&m.state==='queued')))throw new WorkbenchError('成员仍在执行、排队或状态未确认，不能验收关闭任务',409);
      const evidence=this.store.all<Artifact>('artifacts').filter(a=>a.projectId===project.id&&a.taskId===taskId&&['test','review','commit','file','pr'].includes(a.kind));
      if(!evidence.length)throw new WorkbenchError('关闭任务需要已记录的测试、审查、文件、PR 或提交证据。运行结束本身不是验收。',409);
    }
    const reason=optionalString(body.reason);
    if(status==='open'&&reason.trim()){this.store.put('legacy_rework',bindingKey(project.id,taskId),{reason,createdAt:now()});const lead=this.agents().find(a=>a.projectId===project.id&&controller(a));if(lead)this.enqueue(lead.id,`任务 ${taskId} 已退回修改：${reason}。请核对最新成果并将返工纳入待确认计划。`,'system');}
    const task=await this.tasks.update(project,taskId,{status,reason});this.taskSnapshots.delete(project.id);this.event('task.updated',binding?.agentId,`${task.title}: ${status}`,{taskId},project.id);return task;
  }
  async dispatch(taskId:string,input:unknown,key:unknown,source:MessageSource='human',projectScope?:string,workflowDispatch?:WorkflowDispatchInput):Promise<unknown> {
    this.assertAccepting();
    const body=object(input);const project=this.getProject(projectScope??string(body.projectId,'项目 ID',100));
    if(projectScope&&body.projectId&&body.projectId!==projectScope)throw new WorkbenchError('主控只能操作自己的项目',403);
    return this.idempotent(`dispatch:${project.id}:${taskId}`,key,body,()=>this.serialize(`project:${project.id}`,()=>this.serialize(`agent:${body.agentId}`,async()=>{
      const agent=this.getAgent(string(body.agentId,'成员 ID',100));if(agent.projectId!==project.id)throw new WorkbenchError('成员和任务必须属于同一项目');
      this.connectionManager.assertIdentityAvailable(agent.connectionId!);
      if(controller(agent))throw new WorkbenchError('请将任务派给执行成员，主控通过会话下达目标。');
      if(source==='controller'&&agent.controlMode==='human')throw new WorkbenchError('该成员已被人工接管，主控不能派发。',409);
      this.workflows.assertDispatch(project.id,taskId,workflowDispatch?.roundId);
      if(source==='controller'&&!workflowDispatch)throw new WorkbenchError('自动派发须先提出计划并由用户确认；请通过工作流推进任务',409);
      if(agent.state==='unknown')throw new WorkbenchError('成员旧会话状态未知，须核实恢复后再派发。',409);
      if(this.active.has(agent.id)||this.messages().some(m=>m.agentId===agent.id&&m.state==='queued'))throw new WorkbenchError('成员已有执行或排队任务；请停止并处理现有任务后改派。',409);
      const task=await this.tasks.get(project,taskId);if(task.status==='closed')throw new WorkbenchError('任务已经关闭，请先退回再派发。',409);
      const prior=this.store.get<TaskBinding>('bindings',bindingKey(project.id,taskId));
      let baseCommit: string|undefined;
      let reviewedTaskId: string|undefined;
      if(project.kind!=='office'&&body.baseCommit!==undefined)baseCommit=await this.git.resolveCommit(project,string(body.baseCommit,'提交 SHA',64));
      if(project.kind!=='office'&&body.reviewTaskId!==undefined) {
        if(agent.permissionMode!=='read-only')throw new WorkbenchError('固定成果审查必须派给只读成员；可写成员不能通过 reviewTaskId 绕过任务依赖。',409);
        reviewedTaskId=string(body.reviewTaskId,'被审查任务编号',160);
        if(reviewedTaskId===taskId)throw new WorkbenchError('审查任务必须与被审查任务分开');
        await this.tasks.get(project,reviewedTaskId);
        const reviewed=this.store.get<TaskBinding>('bindings',bindingKey(project.id,reviewedTaskId));
        if(!reviewed)throw new WorkbenchError('被审查任务还没有工作区');
        const reviewedAgent=this.getAgent(reviewed.agentId);
        const ownsCandidate=reviewedAgent.currentTaskId===reviewed.taskId&&reviewedAgent.worktree===reviewed.worktree;
        if(ownsCandidate&&(this.active.has(reviewed.agentId)||['unknown','starting','running','waiting_approval','interrupting'].includes(reviewedAgent.state)||this.messages().some(m=>m.agentId===reviewed.agentId&&m.state==='queued')))throw new WorkbenchError('被审查成员仍在执行、排队或状态未知，请等待其停止。',409);
        const candidate=await this.git.inspect(reviewed.worktree);if(candidate.dirty)throw new WorkbenchError('审查需要固定提交；请先让实施成员提交工作区变更。',409);
        baseCommit=await this.git.resolveCommit(project,candidate.commit);
      }
      for(const dep of task.dependencies) {
        const prerequisite=await this.tasks.get(project,dep);
        const reviewCandidateReady=dep===reviewedTaskId&&['open','in_progress'].includes(prerequisite.status);
        if(prerequisite.status!=='closed'&&!reviewCandidateReady)throw new WorkbenchError(`依赖任务 ${dep} 尚未完成`,409);
      }
      let binding:TaskBinding;
      if(workflowDispatch?.integrationRepair) {
        const integration=this.workflows.integration.get(workflowDispatch.workflowId),round=this.store.get<ExecutionRound>('execution_rounds',workflowDispatch.roundId);
        if(!integration||integration.state!=='conflict'||!round||round.purpose!=='integration-repair'||round.agentId!==agent.id||round.taskId!==taskId||round.worktree!==integration.worktree||workflowDispatch.workspace!==integration.worktree||agent.permissionMode!=='workspace-write')throw new WorkbenchError('整合修复必须绑定当前冲突的专属可写轮次',409);
        for(const owner of this.agents().filter(a=>a.worktree&&resolve(a.worktree)===resolve(integration.worktree))) {
          if(this.active.has(owner.id)||owner.state==='unknown'||this.messages().some(m=>m.agentId===owner.id&&['queued','sending','delivered'].includes(m.state)))throw new WorkbenchError('整合工作区原写者尚未确认停止',409);
          await this.closeConnection(owner.id);this.patchAgent(owner.id,{worktree:undefined,currentTaskId:undefined,nativeSessionId:undefined,state:'offline'});
        }
        binding={taskId,projectId:project.id,agentId:agent.id,worktree:integration.worktree,branch:integration.branch,startCommit:round.startCommit!};
      } else if(project.kind==='office') {
        if(!workflowDispatch?.workspace)throw new WorkbenchError('办公任务须通过确认的工作流创建隔离输入和输出目录');
        if(prior){
          const old=this.getAgent(prior.agentId),ownsPrior=old.currentTaskId===taskId&&old.worktree===prior.worktree;
          if(ownsPrior&&(this.active.has(old.id)||old.state==='unknown'||this.messages().some(m=>m.agentId===old.id&&['queued','sending','delivered'].includes(m.state))))throw new WorkbenchError('原成员尚未确认停止，不能改派',409);
          this.store.put('binding_history',`${bindingKey(project.id,taskId)}:${randomUUID()}`,prior);
          if(prior.agentId!==agent.id&&ownsPrior){await this.closeConnection(old.id);this.patchAgent(old.id,{worktree:undefined,currentTaskId:undefined,nativeSessionId:undefined,state:'offline'});}
        }
        binding={taskId,projectId:project.id,agentId:agent.id,worktree:workflowDispatch.workspace,branch:'office',startCommit:''};
      } else if(prior) {
        const old=this.getAgent(prior.agentId);
        const ownsPrior=old.currentTaskId===taskId&&old.worktree===prior.worktree;
        if(ownsPrior&&(this.active.has(old.id)||old.state==='unknown'||this.messages().some(m=>m.agentId===old.id&&m.state==='queued')))throw new WorkbenchError('原成员尚未确认停止，禁止产生第二个写者。',409);
        if(workflowDispatch?.workspace) {
          if(resolve(workflowDispatch.workspace)!==resolve(prior.worktree))throw new WorkbenchError('恢复工作区与原任务不一致',409);
          if(prior.agentId!==agent.id&&ownsPrior){await this.closeConnection(old.id);this.patchAgent(old.id,{worktree:undefined,currentTaskId:undefined,nativeSessionId:undefined,state:'offline'});}
          binding={...prior,agentId:agent.id};
        }else if(prior.agentId===agent.id&&!body.baseCommit&&!body.reviewTaskId)binding=prior;
        else {
          const existing=await this.git.inspect(prior.worktree);if(existing.dirty)throw new WorkbenchError('原工作区存在未提交变更；请先提交成果再改派，原工作区会保留。',409);
          binding=await this.git.createWorktree(project,task.id,agent.id,baseCommit??existing.commit);
          this.store.put('binding_history',`${bindingKey(project.id,taskId)}:${randomUUID()}`,prior);
          if(prior.agentId!==agent.id&&ownsPrior){await this.closeConnection(prior.agentId);this.patchAgent(prior.agentId,{worktree:undefined,currentTaskId:undefined,nativeSessionId:undefined,state:'offline'});}
        }
      } else binding=await this.git.createWorktree(project,task.id,agent.id,baseCommit);
      const reuseConnection=agent.currentTaskId===task.id&&!!agent.worktree&&resolve(agent.worktree)===resolve(binding.worktree)&&agent.connectionRevision===this.connectionManager.get(agent.connectionId!).revision&&this.connections.has(agent.id);
      if(!reuseConnection)await this.closeConnection(agent.id);
      this.store.put('bindings',bindingKey(project.id,taskId),binding);
      this.patchAgent(agent.id,{worktree:binding.worktree,currentTaskId:task.id,...(!reuseConnection?{nativeSessionId:undefined,observedModel:undefined,observedProvider:undefined}:{}),state:reuseConnection?'idle':'offline',lastError:undefined});
      if(source==='controller'&&this.getAgent(agent.id).controlMode==='human')throw new WorkbenchError('派发准备期间成员被人工接管，工作区已保留，指令未投递。',409);
      await this.tasks.update(project,taskId,{status:'in_progress',owner:agent.id});
      this.taskSnapshots.delete(project.id);
      if(source==='controller'&&this.getAgent(agent.id).controlMode==='human')throw new WorkbenchError('更新任务期间成员被人工接管，工作区和分配记录已保留，指令未投递。',409);
      const workRule=workflowDispatch?.integrationRepair?'只修复当前冲突并 git add，不提交、不继续 cherry-pick；后台核对终态后完成整合。':project.kind==='office'?(agent.permissionMode==='read-only'?'只读审查固定输入和候选文件，不修改任何原件。':'仅在分配工作区的 outputs 目录生成输出，不修改 inputs 或原业务目录；报告输出路径和实际核对结果。'):agent.permissionMode==='read-only'?'这是只读审查任务。请检查固定提交，不修改代码。':'仅在分配的独立工作区实施，保留已有内容。完成后提交你的任务变更并报告提交 SHA。';
      const prompt=`你是团队成员 ${agent.name}，角色 ${agent.role}。\n任务 ${task.id}: ${task.title}\n${task.description}\n验收要求：${task.acceptance||'提供可核对的成果与验证记录。'}\n工作区：${binding.worktree}\n${binding.startCommit?`起始提交：${binding.startCommit}\n`:''}${workRule}\n完成后报告改动、测试命令与真实结果、待处理问题。不要因为执行结束就自行声称任务已验收。`;
      const rework=this.store.get<{reason:string}>('legacy_rework',bindingKey(project.id,taskId));
      const receipt=this.enqueue(agent.id,`${prompt}\n${workflowDispatch?.instructions??''}${rework?`\n退回修改要求（必须处理）：${rework.reason}`:''}`,source,task.id,[],workflowDispatch);this.event('task.dispatched',agent.id,task.title,{taskId,worktree:binding.worktree,branch:binding.branch,messageId:receipt.messageId,roundId:workflowDispatch?.roundId,workflowId:workflowDispatch?.workflowId});
      return {...receipt,binding};
    })));
  }
  async uploadAttachment(id:string,input:unknown,key:unknown):Promise<Attachment> {
    const agent=this.getAgent(id),attachment=prepareAttachment(input);
    return this.idempotent(`attachment:${id}`,key,{name:attachment.name,mimeType:attachment.mimeType,size:attachment.bytes.length,digest:attachment.digest},async()=>{
      if(!('kind' in attachment))return this.attachments.save(agent,attachment);
      let extracted;
      try {extracted=await extractDocument({name:attachment.name,bytes:attachment.bytes});}
      catch(error){throw new WorkbenchError(`无法读取「${attachment.name}」：${errorText(error)}`);}
      return this.attachments.save(agent,attachment,extracted);
    });
  }
  readAttachment(id:string):{image:Attachment;bytes:Buffer} {return this.attachments.read(id);}
  async message(id:string,input:unknown,key:unknown,source:MessageSource='human'):Promise<unknown> {
    this.assertAccepting();
    const body=object(input),text=optionalString(body.text,100000).trim(),ids=attachmentIds(body.attachmentIds);
    if(!text&&!ids.length)throw new WorkbenchError('消息需要文字或附件');
    const mode=body.mode??(source==='human'?'interrupt':'queue');if(mode!=='queue'&&mode!=='interrupt')throw new WorkbenchError('消息模式必须是 queue 或 interrupt');
    return this.idempotent(`message:${id}`,key,{text,mode,source,...(ids.length?{attachmentIds:ids}:{})},()=>this.serialize(`agent:${id}`,async()=>{
      let agent=this.getAgent(id);
      this.connectionManager.assertIdentityAvailable(agent.connectionId!);
      // Validate ownership and local bytes before takeover, queue cancellation or interruption.
      const attachments=this.attachments.resolve(agent,ids);
      if(agent.state==='unknown')throw new WorkbenchError('旧会话状态未知，请先核对后恢复。',409);
      if(source==='controller'&&agent.controlMode==='human')throw new WorkbenchError('成员已被人工接管，主控消息被拒绝。',409);
      if(source==='human'&&!controller(agent)){agent=this.patchAgent(id,{controlMode:'human'});this.cancelControllerQueue(id);this.event('agent.control',id,'人工直接指令已接管该成员。',{mode:'human'});}
      if(!controller(agent)&&!agent.worktree)throw new WorkbenchError('请先为成员派发任务，创建独立工作区。');
      if(mode==='interrupt')await this.interruptInternal(id);
      agent=this.getAgent(id);
      if(!controller(agent)&&!agent.worktree)throw new WorkbenchError('原任务已结束并释放工作区，请在工作流中安排下一轮；本条指令尚未投递。',409);
      return this.enqueue(id,text,source,agent.currentTaskId,attachments);
    }));
  }
  private enqueue(id:string,text:string,source:MessageSource,taskId?:string,items:ResolvedAttachment[]=[],context?:{workflowId:string;roundId?:string}):{messageId:string;status:'queued'} {
    this.assertAccepting();
    this.connectionManager.assertIdentityAvailable(this.getAgent(id).connectionId!);
    const message:QueuedMessage={id:randomUUID(),agentId:id,text,source,state:'queued',createdAt:now(),taskId,...(context?{workflowId:context.workflowId,roundId:context.roundId}:{}),...(items.length?{attachmentIds:items.map(item=>item.attachment.id)}:{})};
    const attachments=items.map(item=>item.attachment);
    this.store.put('messages',message.id,message);this.event('message.queued',id,text,{messageId:message.id,source,taskId,...(attachments.length?{attachments}:{})});this.schedule();return {messageId:message.id,status:'queued'};
  }
  private schedule():void {if(!this.closing&&!this.closed)queueMicrotask(()=>{if(!this.closing&&!this.closed)this.track(this.pump());});}
  advanceWorkflows():void {if(this.closing||this.closed)return;for(const workflow of this.workflows.list())if(['ready','running'].includes(workflow.status))this.track(this.workflows.advance(workflow.id).catch(error=>{this.event('workflow.blocked',undefined,this.publicError(error),{workflowId:workflow.id},workflow.projectId);}));}
  private track(promise:Promise<unknown>):void {
    this.background.add(promise);
    void promise.catch(error=>{if(!this.closed)this.event('scheduler.error',undefined,errorText(error));}).finally(()=>this.background.delete(promise));
  }
  private async pump():Promise<void> {
    if(this.pumping||this.closing||this.closed)return;this.pumping=true;
    try {
      const workers=()=>[...this.active.keys()].filter(id=>!controller(this.getAgent(id))).length;
      for(const agent of this.agents()) {
        if(this.closing)return;
        if(this.active.has(agent.id)||this.interruptBarriers.has(agent.id)||agent.state==='unknown')continue;
        if(!controller(agent)&&workers()>=(this.options.maxWorkers??3))continue;
        let message=this.messages().find(m=>m.agentId===agent.id&&m.state==='queued'&&(agent.controlMode==='auto'||m.source==='human'));
        if(!message)continue;
        if(message.source==='human'&&message.taskId&&!message.roundId&&!controller(agent)) {
          const context=this.workflows.getDispatchContext(agent.projectId,message.taskId);
          if(context) {
            try {
              const binding=this.store.get<TaskBinding>('bindings',bindingKey(agent.projectId,message.taskId));
              if(context.round?.agentId!==agent.id||!binding||binding.agentId!==agent.id||binding.worktree!==agent.worktree)throw new WorkbenchError('该任务已改派或工作区不再属于当前成员，请核对当前负责人后继续',409);
              const round=await this.workflows.beginHumanRound(context.workflow.id,context.node.id,{messageId:message.id,reason:message.text||'人工补充附件',writerStopped:true,agentId:agent.id});
              if(this.store.get<QueuedMessage>('messages',message.id)?.state==='cancelled') {
                await this.workflows.completeRound(round.id,{messageId:message.id,interrupted:true,error:'投递前被新的人工操作取消'});continue;
              }
              message={...message,workflowId:round.workflowId,roundId:round.id};this.store.put('messages',message.id,message);
            }catch(error){this.store.put('messages',message.id,{...message,state:'failed'});this.patchAgent(agent.id,{state:'error',controlMode:'human',lastError:this.publicError(error)});this.event('message.rejected',agent.id,this.publicError(error),{messageId:message.id,taskId:message.taskId});continue;}
          }
        }
        if(this.closing)return;
        let finish=()=>{};const terminal=new Promise<void>(resolve=>{finish=resolve;});
        this.active.set(agent.id,{message,terminal,finish});this.patchAgent(agent.id,{state:'starting',lastError:undefined});
        this.saveRun({agentId:agent.id,messageId:message.id,state:'active',startedAt:now(),runtime:agent.runtime,nativeSessionId:agent.nativeSessionId,model:agent.observedModel,provider:agent.observedProvider,configuredModel:agent.model||undefined,connectionId:agent.connectionId,connectionRevision:agent.connectionRevision,workflowId:message.workflowId,roundId:message.roundId});
        this.track(this.startTurn(agent.id,message).catch(error=>this.failRun(agent.id,error)));
      }
    } finally {this.pumping=false;}
  }
  private controllerInstructions(agent:Agent):string {
    return `${agent.instructions}\n你是本地团队主控，仅操作项目 ${agent.projectId}。先 list_team/list_workflows/list_tasks 获取真实状态。新目标必须通过 propose_plan 提出完整计划，包括负责人、依赖、输入、能力及验收项；等待用户确认，不得自己确认。检查命令必须写入验收项 command/args，审查节点使用 candidate 依赖固定候选版本。确认后后台自动派发，必要时 advance_workflow。模型空字符串表示沿用连接默认，不擅自换供应商。人工接管成员不可自动指挥。所有写操作使用稳定 idempotencyKey，结果未知不得换键重试。等待成员时结束当前轮次，不要反复轮询；后端会发送实际结果。读取 get_workflow 获取候选成果、审查与真实测试证据。候选完成后可 run_declared_check；独立审查必须输出 WORKBENCH_REVIEW_RESULT: {"version":"准确候选版本","result":"passed或failed","conclusion":"明确结论"}，后台按原回执核对。失败使用 return_task，附准确 sourceBundleId 或失败 sourceRoundId 及具体原因；默认最多两轮自动返工。通过后用 accept_task 指定准确 roundId/bundleId，不得代替用户填写人工例外或确认节点。代码在独立整合分支汇合，用户确认最终差异后才交付。不可绕过工作台工具直接修改原项目、任务数据库或交付目标。`;
  }
  private controllerToken(id:string):string {let token=this.controllerTokens.get(id);if(!token){token=randomBytes(32).toString('hex');this.controllerTokens.set(id,token);}return token;}
  authenticateController(id:string,token:string|undefined):boolean {return !!token&&this.controllerTokens.get(id)===token&&controller(this.getAgent(id));}
  authenticateMember(id:string,token:string|undefined):boolean {return !!token&&this.controllerTokens.get(id)===token&&!controller(this.getAgent(id));}
  async memberTool(id:string,name:unknown,input:unknown):Promise<unknown> {this.assertAccepting();const agent=this.getAgent(id);if(controller(agent))throw new WorkbenchError('主控不能使用普通成员入口',403);if(!this.active.has(id))throw new WorkbenchError('当前没有可操作的执行轮次',409);return scopedTool(this,agent,string(name,'工具名',100),object(input??{}));}
  private async cancelUnsentOnClose(id:string,message:QueuedMessage):Promise<void> {
    this.store.put('messages',message.id,{...message,state:'cancelled'});
    const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:'terminal'});
    this.patchAgent(id,{state:'stopped',controlMode:'human'});
    if(message.roundId)await this.workflows.completeRound(message.roundId,{messageId:message.id,interrupted:true,error:'服务关闭，指令尚未发送给原生执行工具。'});
    const active=this.active.get(id);if(active?.message.id===message.id){this.active.delete(id);active.finish();}
    this.event('message.cancelled',id,'服务关闭，指令未投递。',{messageId:message.id});
  }
  private async startTurn(id:string,message:QueuedMessage):Promise<void> {
    if(this.closing){await this.cancelUnsentOnClose(id,message);return;}
    let agent=this.getAgent(id);let connection=this.connections.get(id);
    const cwd=agent.worktree??this.getProject(agent.projectId).controlPath??this.getProject(agent.projectId).path;
    const profile=this.connectionManager.get(agent.connectionId!);
    this.connectionManager.assertIdentityAvailable(profile.id);
    if(agent.connectionRevision!==profile.revision)throw new RuntimeInputError('连接版本已经改变，请在成员设置中重新绑定；不能用旧会话切换认证来源');
    if(message.source!=='human')try {
      await this.connectionManager.assertReady(profile.id,agent.model||profile.defaultModel,cwd,['inference','streaming','tools']);
      const context=message.taskId?this.workflows.getDispatchContext(agent.projectId,message.taskId):undefined;
      if(context)this.capabilities.assertBound(agent,context.node.requiredCapabilities);
    }catch(error){throw new RuntimeInputError(this.publicError(error));}
    if(this.closing){await this.cancelUnsentOnClose(id,message);return;}
    const capabilityFingerprint=createHash('sha256').update(JSON.stringify((agent.capabilityIds??[]).map(capabilityId=>{const capability=this.capabilities.get(capabilityId);return [capabilityId,capability.revision,this.capabilities.fingerprint(capability)];}))).digest('hex');
    if(connection&&this.connectionCapabilityFingerprints.get(id)!==capabilityFingerprint) {
      if(agent.nativeSessionId)this.store.put('session_history',`${id}:${agent.nativeSessionId}`,{...agent,archivedAt:now(),reason:'绑定能力配置或本地文件已改变'});
      await this.closeConnection(id);connection=undefined;
      agent=this.patchAgent(id,{nativeSessionId:undefined,observedModel:undefined,observedProvider:undefined});
      this.event('agent.capabilities_reloaded',id,'绑定能力已变化，保留旧会话并使用新会话加载当前配置。');
    }
    if(!connection) {
      if(!agent.nativeSessionId)this.patchAgent(id,{observedModel:undefined,observedProvider:undefined});
      const sourcePath=fileURLToPath(new URL('./mcp-bridge.js',import.meta.url));
      const development=import.meta.url.endsWith('.ts');
      const mcpServers={...this.capabilities.configs(agent),workbench:{command:process.execPath,args:development?['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,sourcePath.replace(/\.js$/,'.ts')]:[sourcePath],env:{WORKBENCH_URL:this.baseUrl,WORKBENCH_CONTROLLER_ID:id,WORKBENCH_CONTROLLER_TOKEN:this.controllerToken(id),WORKBENCH_MEMBER_KIND:controller(agent)?'controller':'worker'}}};
      const overrides=await this.connectionManager.resolveRuntime(profile.id,{cwd,model:agent.model||profile.defaultModel});
      if(this.closing){await this.cancelUnsentOnClose(id,message);return;}
      const instructions=`${controller(agent)?this.controllerInstructions(agent):agent.instructions}\n${this.capabilities.instructions(agent)}`;
      connection=await this.adapters.get(agent.runtime)!.connect({agentId:id,cwd,model:agent.model||profile.defaultModel||undefined,permissionMode:controller(agent)?'read-only':agent.permissionMode,instructions,resumeSessionId:agent.nativeSessionId,mcpServers,connection:overrides},event=>this.runtimeEvent(id,event,agent.runtime));
      if(this.closing){
        const run=this.store.get<RunRecord>('runs',id)!;
        this.saveRun({...run,pid:connection.pid,nativeSessionId:connection.nativeSessionId??run.nativeSessionId});
        try {await connection.close();await this.cancelUnsentOnClose(id,message);}
        catch(error){this.markShutdownUnknown(id,error);}
        return;
      }
      this.connections.set(id,connection);
      this.connectionCapabilityFingerprints.set(id,capabilityFingerprint);
    }
    if(!this.active.has(id)||this.getAgent(id).state==='unknown')throw new Error('连接期间运行状态失去确认；停止投递。');
    const run=this.store.get<RunRecord>('runs',id)!;
    this.saveRun({...run,pid:connection.pid,nativeSessionId:connection.nativeSessionId??run.nativeSessionId});
    const latestMessage=this.store.get<QueuedMessage>('messages',message.id);
    const latestAgent=this.getAgent(id);
    if(this.closing){await this.cancelUnsentOnClose(id,message);return;}
    if(latestMessage?.state==='cancelled'||(message.source!=='human'&&latestAgent.controlMode==='human')) {
      if(latestMessage?.state!=='cancelled')this.store.put('messages',message.id,{...message,state:'cancelled'});
      if(message.roundId)await this.workflows.completeRound(message.roundId,{messageId:message.id,interrupted:true,error:'原指令在投递前取消，未发送给原生执行工具。',worktree:latestAgent.worktree});
      const active=this.active.get(id);if(active?.message.id===message.id){this.active.delete(id);active.finish();}
      this.saveRun({...run,pid:connection.pid,nativeSessionId:connection.nativeSessionId??run.nativeSessionId,state:'terminal'});
      this.patchAgent(id,{state:'idle',nativeSessionId:connection.nativeSessionId??latestAgent.nativeSessionId});
      this.event('message.cancelled',id,'连接期间原指令已取消；指令未投递，会话已保留。',{messageId:message.id});
      this.schedule();return;
    }
    let attachments:ResolvedAttachment[];
    try {attachments=this.attachments.resolve(latestAgent,message.attachmentIds??[]);}
    catch(error){if(error instanceof WorkbenchError)throw new RuntimeInputError(error.message);throw error;}
    this.patchAgent(id,{state:'running',nativeSessionId:connection.nativeSessionId??this.getAgent(id).nativeSessionId});
    this.store.put('messages',message.id,{...message,state:'sending'});this.event('message.sending',id,undefined,{messageId:message.id});
    const input=runtimeAttachmentInput(message.text,attachments);
    this.connectionManager.assertIdentityAvailable(profile.id);
    await connection.send(input.text,message.id,input.images);
    const latest=this.store.get<QueuedMessage>('messages',message.id);
    if(latest?.state==='sending')this.store.put('messages',message.id,{...latest,state:'delivered'});
    this.event('message.delivered',id,undefined,{messageId:message.id});
  }
  private runtimeEvent(id:string,event:RuntimeEvent,originRuntime?:RuntimeKind):void {
    if(this.closed)return;
    if(event.type==='usage') {
      const agent=this.getAgent(id);
      const message=event.messageId?this.store.get<QueuedMessage>('messages',event.messageId):undefined;
      if(event.messageId&&(!message||message.agentId!==id)){this.event('usage.unattributed',id,'用量回执的轮次无法核对，未归属到任务。',{messageId:event.messageId});return;}
      const run=message?this.store.get<RunRecord>('run_history',message.id):undefined;
      const nativeSessionId=event.nativeSessionId??run?.nativeSessionId;
      const mismatchedSession=!!(run?.nativeSessionId&&event.nativeSessionId&&run.nativeSessionId!==event.nativeSessionId);
      const data=event.data??{};
      const canAttribute=!!message&&!!run&&!mismatchedSession&&!['queued','cancelled'].includes(message.state);
      const changed=this.usage.record({projectId:agent.projectId,agentId:id,runtime:run?.runtime??originRuntime??agent.runtime,nativeSessionId,messageId:canAttribute?message.id:undefined,taskId:canAttribute?message.taskId:undefined,model:run?.model,provider:run?.provider,configuredModel:run?.configuredModel,connectionId:run?.connectionId,connectionRevision:run?.connectionRevision,workflowId:run?.workflowId,roundId:run?.roundId,startedAt:canAttribute?run?.startedAt:undefined},data);
      this.event('runtime.usage',id,undefined,{...data,messageId:event.messageId,nativeSessionId,recordIds:changed.map(record=>record.id)});return;
    }
    const current=this.active.get(id);
    // A connection that finishes initialization during shutdown has never sent
    // this queued message. Its close() state is not a model execution receipt.
    if(this.closing&&current&&this.store.get<QueuedMessage>('messages',current.message.id)?.state==='cancelled'&&(event.type==='result'||event.type==='state'))return;
    if(event.messageId&&current&&event.messageId!==current.message.id){this.event('runtime.stale_event',id,undefined,{originalType:event.type,messageId:event.messageId});return;}
    let agent=this.getAgent(id);
    if(event.type==='ready') {
      if(typeof event.data?.pid==='number'&&Number.isSafeInteger(event.data.pid)&&event.data.pid>0){const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,pid:event.data.pid});}
      const observed:Partial<Agent>={};
      if(typeof event.data?.model==='string'&&event.data.model.trim())observed.observedModel=this.scrub(event.data.model.trim().slice(0,500)) as string;
      if(typeof event.data?.provider==='string'&&event.data.provider.trim())observed.observedProvider=this.scrub(event.data.provider.trim().slice(0,500)) as string;
      if(Object.keys(observed).length){agent=this.patchAgent(id,observed);const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,model:agent.observedModel,provider:agent.observedProvider});}
    }
    if(event.type==='message'&&event.text){const run=this.active.get(id);if(run)run.output=event.text;}
    if(event.nativeSessionId){agent=this.patchAgent(id,{nativeSessionId:event.nativeSessionId});const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,nativeSessionId:event.nativeSessionId});}
    if(event.type==='approval'&&event.approvalId) {
      const approval:Approval={id:event.approvalId,agentId:id,tool:String(event.data?.tool??event.data?.toolName??'工具权限'),input:this.scrub(event.data?.input??event.data??{}),createdAt:now()};
      this.store.put('approvals',`${id}:${approval.id}`,approval);
      if(!['unknown','error','interrupting'].includes(agent.state))this.patchAgent(id,{state:'waiting_approval'});
    }
    if(event.type==='state'&&event.state&&agent.state!=='unknown') {
      const protectedProgress=['error','interrupting'].includes(agent.state)&&['running','waiting_approval','starting','idle'].includes(event.state);
      if(!protectedProgress&&!(this.active.has(id)&&event.state==='idle'))this.patchAgent(id,{state:event.state});
    }
    this.event(`runtime.${event.type}`,id,event.text,{...event.data,state:event.state,nativeSessionId:event.nativeSessionId,messageId:event.messageId,approvalId:event.approvalId});
    if(event.type==='result')this.track(this.finishRun(id,event));
    if(event.type==='error')this.track(this.failRun(id,new Error(event.text??'执行工具出错')));
    if(event.type==='state'&&event.state==='stopped'&&this.active.has(id))this.track(this.finishRun(id,{type:'result',text:'成员已停止',data:{interrupted:true}}));
  }
  private async finishRun(id:string,event:RuntimeEvent):Promise<void> {
    const active=this.active.get(id);if(!active||active.finalizing)return;
    active.finalizing=true;
    try {
    const interrupted=event.data?.interrupted===true;
    const failed=!interrupted&&(event.data?.isError===true||event.data?.status==='failed');
    this.store.put('messages',active.message.id,{...active.message,state:failed?'failed':'completed'});
    const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:'terminal'});
    const agent=this.patchAgent(id,{state:interrupted?'stopped':failed?'error':'idle',lastError:failed?(event.text||'执行工具返回已确认的失败终态，请查看会话详情。'):undefined});
    for(const approval of this.store.all<Approval>('approvals'))if(approval.agentId===id)this.store.remove('approvals',`${id}:${approval.id}`);
    let summary=event.text||active.output||String(event.data?.result??'当前执行轮次已结束，请查看会话详情。');
    const binding=agent.currentTaskId?this.store.get<TaskBinding>('bindings',bindingKey(agent.projectId,agent.currentTaskId)):undefined;
    if(binding&&this.getProject(agent.projectId).kind!=='office') {
      try {
        const state=await this.git.inspect(binding.worktree);
        this.store.put('bindings',bindingKey(agent.projectId,binding.taskId),{...binding,candidateCommit:state.commit});
        summary+=`\n工作区 ${binding.worktree}\n提交 ${state.commit}；未提交变更：${state.dirty?'有':'无'}`;
        if(state.commit!==binding.startCommit)await this.recordArtifact({projectId:agent.projectId,taskId:binding.taskId,agentId:id,kind:'commit',title:'执行后提交',value:state.commit});
      }catch(error){summary+=`\nGit 核对失败：${errorText(error)}`;}
    }
    if(active.message.roundId&&binding) {
      try {
        const latest=this.store.get<TaskBinding>('bindings',bindingKey(agent.projectId,binding.taskId))??binding;
        const outputDir=join(binding.worktree,'outputs');
        const files=this.getProject(agent.projectId).kind==='office'&&existsSync(outputDir)?readdirSync(outputDir,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name)):undefined;
        await this.workflows.completeRound(active.message.roundId,{messageId:active.message.id,worktree:binding.worktree,startCommit:latest.startCommit||undefined,candidateCommit:latest.candidateCommit,output:active.output||event.text||summary,failed,interrupted,files});
      } catch(error) {this.addInbox({projectId:agent.projectId,agentId:id,workflowId:active.message.workflowId,taskId:active.message.taskId,kind:'error',title:'执行结果尚未形成可验收成果',detail:this.publicError(error)});}
    }
    if(!controller(agent)) {
      try{await this.recordArtifact({projectId:agent.projectId,taskId:active.message.taskId,agentId:id,kind:'summary',title:interrupted?'中断回执':failed?'执行失败':'执行结果',value:summary.slice(0,100000)});}catch(error){this.event('artifact.error',id,`执行结果已保留在事件中；成果索引失败：${errorText(error)}`);}
      const lead=this.agents().find(a=>a.projectId===agent.projectId&&controller(a));
      if(lead&&!this.closing) {
        const notificationKey=`worker-result:${active.message.id}`;
        if(!this.store.get('notifications',notificationKey)) {
          this.store.put('notifications',notificationKey,{id:notificationKey,createdAt:now()});
          this.enqueue(lead.id,`成员 ${agent.name} (${id}) 的任务 ${active.message.taskId??'会话'} 返回了${interrupted?'中断':failed?'已确认的失败终态':'执行'}回执。原消息 ${active.message.id}。\n${summary.slice(0,16000)}\n${failed?'本轮失败，已有代码和成果仍保留。先核对错误，再决定明确的修复操作；不能当作成功验收。':'请核对证据和任务依赖，决定审查、返工或验收。'}不要重复派发相同指令。`, 'system',undefined,[],active.message.workflowId?{workflowId:active.message.workflowId}:undefined);
        }
      }
    }
    const roundPurpose=active.message.roundId?this.store.get<ExecutionRound>('execution_rounds',active.message.roundId)?.purpose:undefined;
    if(!this.closing&&roundPurpose==='integration-repair'&&!failed&&!interrupted){await this.closeConnection(id);this.patchAgent(id,{worktree:undefined,currentTaskId:undefined,nativeSessionId:undefined});}
    if(this.active.get(id)===active)this.active.delete(id);
    active.finish();
    if(!this.closing&&active.message.workflowId&&active.message.roundId&&!failed&&!interrupted){
      const workflowId=active.message.workflowId;
      for(const review of reviewRecords(this,workflowId).filter(r=>r.roundId===active.message.roundId)) {
        try {const candidate=this.store.get<ArtifactBundle>('artifact_bundles',review.bundleId)!;const detail=await this.workflows.detail(workflowId),node=detail.plan.nodes.find(n=>n.id===candidate.nodeId)!;
          for(const check of node.checks.filter(c=>c.kind==='review'))await this.workflows.recordReview(candidate.id,{requirementId:check.id,reviewRoundId:review.roundId,result:review.result,conclusion:review.conclusion});
        }catch(error){this.event('workflow.review_unverified',id,this.publicError(error),{roundId:active.message.roundId},agent.projectId);}
      }
      if(this.store.get<ExecutionRound>('execution_rounds',active.message.roundId)?.purpose==='integration-review')try{await this.workflows.recordIntegrationReview(workflowId,active.message.roundId);}catch(error){this.event('workflow.review_unverified',id,this.publicError(error),{roundId:active.message.roundId},agent.projectId);}
      if(roundPurpose==='integration-repair')try{await this.workflows.finishIntegrationRepair(workflowId,active.message.roundId);}catch(error){this.addInbox({projectId:agent.projectId,agentId:id,workflowId,taskId:active.message.taskId,kind:'error',title:'整合冲突修复未完成',detail:this.publicError(error)});}
    }
    this.event(failed?'agent.turn_failed':'agent.turn_completed',id,undefined,{messageId:active.message.id,taskId:active.message.taskId,interrupted,failed});this.schedule();this.advanceWorkflows();
    } catch(error) {
      // The native terminal receipt is real even if indexing or cleanup fails.
      // Keep automatic dispatch paused without leaving an active writer slot behind.
      const agent=this.patchAgent(id,{state:'error',controlMode:'human',lastError:`原生轮次已结束，结果处理失败：${this.publicError(error)}`});
      this.addInbox({projectId:agent.projectId,agentId:id,workflowId:active.message.workflowId,taskId:active.message.taskId,kind:'error',title:'执行已结束，结果需要核对',detail:this.publicError(error)});
      this.event('agent.result_processing_failed',id,this.publicError(error),{messageId:active.message.id,terminalConfirmed:true});
    } finally {
      if(this.active.get(id)===active)this.active.delete(id);
      active.finish();
      this.schedule();
    }
  }
  private async failRun(id:string,error:unknown):Promise<void> {
    if(this.closed)return;
    const ownedStopUnconfirmed=!!(error&&typeof error==='object'&&(error as {stopConfirmed?:boolean}).stopConfirmed===false);
    // The send acknowledgement can reject after close delivered a real terminal
    // result. Preserve that result rather than downgrading it to a transport error.
    if(this.closing&&!ownedStopUnconfirmed&&this.store.get<RunRecord>('runs',id)?.state==='terminal')return;
    const active=this.active.get(id);if(!active){const agent=this.getAgent(id);if(ownedStopUnconfirmed){const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:'unknown'});}this.patchAgent(id,{state:ownedStopUnconfirmed||agent.state==='unknown'?'unknown':'error',lastError:errorText(error)});this.event('runtime.failure',id,errorText(error));return;}
    this.active.delete(id);active.finish();
    const message=this.store.get<QueuedMessage>('messages',active.message.id)??active.message;
    const inputRejected=error instanceof RuntimeInputError;
    const managedError=error&&typeof error==='object'?error as {code?:string;stopConfirmed?:boolean}:undefined;
    const stopUnconfirmed=managedError?.stopConfirmed===false;
    const authorizationCancelled=managedError?.code==='WORKBUDDY_AUTHENTICATION_CANCELLED'&&managedError.stopConfirmed===true;
    if(authorizationCancelled){
      this.store.put('messages',message.id,{...message,state:'cancelled'});
      const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:'terminal'});
      this.patchAgent(id,{state:'stopped',controlMode:'human',lastError:undefined});
      if(message.roundId)await this.workflows.completeRound(message.roundId,{messageId:message.id,interrupted:true,error:'原生授权已取消，原指令未发送给模型。'});
      this.event('message.cancelled',id,'原生授权已取消，原指令未投递，工作区保留。',{messageId:message.id});this.schedule();return;
    }
    const uncertain=stopUnconfirmed||!inputRejected&&['sending','delivered'].includes(message.state);
    this.store.put('messages',message.id,{...message,state:uncertain?'uncertain':'failed'});
    const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:uncertain?'unknown':'terminal'});
    this.patchAgent(id,{state:uncertain?'unknown':'error',lastError:errorText(error),controlMode:'human'});
    if(message.roundId&&uncertain)await this.workflows.markUncertain(message.roundId,this.publicError(error));
    if(message.roundId&&!uncertain)await this.workflows.completeRound(message.roundId,{messageId:message.id,failed:true,error:this.publicError(error)});
    this.event('runtime.failure',id,errorText(error),{messageId:message.id,uncertain,...(inputRejected?{inputRejected:true}:{})});
    const agent=this.getAgent(id);
    if(!controller(agent)) {
      const lead=this.agents().find(a=>a.projectId===agent.projectId&&controller(a));
      const notificationKey=`worker-result:${message.id}`;
      if(lead&&!this.closing&&!this.store.get('notifications',notificationKey)) {
        this.store.put('notifications',notificationKey,{id:notificationKey,createdAt:now()});
        this.enqueue(lead.id,`成员 ${agent.name} (${id}) 的任务 ${message.taskId??'会话'} 失败。原消息 ${message.id}。\n${this.publicError(error)}\n${uncertain?'投递或终止状态未知，严禁重复派发或产生第二个写者。':inputRejected?'输入或连接预检已拒绝，尚未向原生模型投递。':'连接未完成。'}成员已暂停自动调度并交给人工核对。请解释阻塞原因，保留成果，不要用新key反复重试。`,'system',undefined,[],message.workflowId?{workflowId:message.workflowId}:undefined);
      }
    }
    this.schedule();
  }
  async interrupt(id:string):Promise<Agent> {return this.serialize(`agent:${id}`,async()=>{await this.interruptInternal(id);return this.getAgent(id);});}
  private async interruptInternal(id:string):Promise<void> {
    this.interruptBarriers.add(id);
    try{await this.interruptInternalBody(id);}finally{this.interruptBarriers.delete(id);this.schedule();}
  }
  private async interruptInternalBody(id:string):Promise<void> {
    const agent=this.getAgent(id);
    for(const message of this.messages())if(message.agentId===id&&message.state==='queued')this.store.put('messages',message.id,{...message,state:'cancelled'});
    const active=this.active.get(id);
    if(!active) {
      if(['unknown','error'].includes(agent.state)&&this.connections.has(id)) {
        await this.closeConnection(id);
        const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:'terminal'});
        this.patchAgent(id,{state:'stopped',controlMode:'human',lastError:undefined});
        this.expireApprovals(id,'异常会话已确认关闭，原审批请求已失效。');
        if(run?.roundId&&this.store.get<ExecutionRound>('execution_rounds',run.roundId)?.state==='unknown')await this.workflows.reconcileRound(run.roundId,{writerStopped:true,messageId:run.messageId,failed:true,error:'异常原生会话已确认关闭，但缺少完整成功回执；保留现有成果，以明确的新轮次继续。'});
        this.event('agent.stopped',id,'已停止本服务持有的异常会话。未确认的旧指令不会重发。');
      }
      return;
    }
    const connection=this.connections.get(id);
    if(!connection) {
      const message=this.store.get<QueuedMessage>('messages',active.message.id);
      const authorization=this.listRuntimeAuthentications().find(row=>row.agentId===id&&['starting','waiting','authenticated','unknown'].includes(row.state));
      if(authorization){await this.authenticationOwner(authorization.id).control.cancel(authorization.id);await active.terminal;return;}
      if(agent.state==='starting'&&message?.state==='cancelled') {
        // Keep the active slot until this same connection finishes; startTurn rechecks cancellation before send.
        this.event('agent.interrupting',id,'原指令尚未投递，已取消；等待连接完成后继续。',{messageId:message.id});
        return;
      }
      throw new WorkbenchError('会话正在连接，稍后再中断。',409);
    }
    this.patchAgent(id,{state:'interrupting'});this.event('agent.interrupting',id);
    try {
      await connection.interrupt();
      await Promise.race([active.terminal,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('中断未收到终止确认。请核对原进程；禁止继续投递。')),this.options.interruptTimeoutMs??20000);void active.terminal.then(()=>clearTimeout(timer));})]);
      if(this.getAgent(id).state==='unknown')throw new Error('原会话状态未知，不能确认已停止。');
    }catch(error){
      this.patchAgent(id,{state:'unknown',controlMode:'human',lastError:errorText(error)});
      const run=this.store.get<RunRecord>('runs',id);if(run)this.saveRun({...run,state:'unknown'});
      const message=this.store.get<QueuedMessage>('messages',active.message.id);if(message&&['sending','delivered'].includes(message.state))this.store.put('messages',message.id,{...message,state:'uncertain'});
      if(active.message.roundId)await this.workflows.markUncertain(active.message.roundId,this.publicError(error));
      throw new WorkbenchError(errorText(error),409);
    }
  }
  async respondApproval(id:string,approvalId:string,allow:unknown):Promise<{ok:true}> {
    const originalState=this.getAgent(id).state;if(typeof allow!=='boolean')throw new WorkbenchError('allow 必须为布尔值');
    if(!this.store.get('approvals',`${id}:${approvalId}`))throw new WorkbenchError('审批已过期或不属于此成员',404);
    const connection=this.connections.get(id);if(!connection)throw new WorkbenchError('原会话未连接，请先恢复',409);
    await connection.respondApproval(approvalId,allow);this.store.remove('approvals',`${id}:${approvalId}`);
    const pending=this.store.all<Approval>('approvals').some(approval=>approval.agentId===id);
    const currentState=this.getAgent(id).state;
    if(['waiting_approval','running'].includes(originalState)&&['waiting_approval','running'].includes(currentState)&&this.active.has(id)&&!this.active.get(id)?.finalizing)this.patchAgent(id,{state:pending?'waiting_approval':'running'});
    this.event('approval.responded',id,allow?'已允许':'已拒绝',{approvalId,allow});return {ok:true};
  }
  async recover(id:string):Promise<Agent> {
    return this.serialize(`agent:${id}`,async()=>{
      const agent=this.getAgent(id);if(agent.state!=='unknown'&&agent.state!=='error')return agent;
      const run=this.store.get<RunRecord>('runs',id);
      if(run?.pid) {let alive=false;try{process.kill(run.pid,0);alive=true;}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM')alive=true;}if(alive)throw new WorkbenchError(`旧进程 ${run.pid} 仍存在；请先在原工具中确认停止后再恢复。`,409);}
      await this.closeConnection(id);
      const active=this.active.get(id);if(active){this.active.delete(id);active.finish();}
      this.expireApprovals(id,'旧会话已恢复，原审批请求已失效；等待新会话重新请求。');
      for(const message of this.messages())if(message.agentId===id&&message.state==='queued')this.store.put('messages',message.id,{...message,state:'cancelled'});
      if(run)this.saveRun({...run,state:'terminal'});
      const updated=this.patchAgent(id,{state:'stopped',lastError:undefined,controlMode:'human'});
      if(run?.roundId&&this.store.get<ExecutionRound>('execution_rounds',run.roundId)?.state==='unknown')await this.workflows.reconcileRound(run.roundId,{writerStopped:true,messageId:run.messageId,failed:true,error:'原进程已确认退出，但缺少完整成功回执；保留现有成果，需人工核对后以新轮次继续。'});
      this.event('agent.recovered',id,'原进程已退出。保留原会话上下文；缺失成功回执的旧轮次按失败保留，不会自动重发，请发送新的明确指令。');return updated;
    });
  }
  async recordArtifact(input:unknown,projectScope?:string):Promise<Artifact> {
    const body=object(input);const agent=this.getAgent(string(body.agentId,'成员 ID',100));
    const project=this.getProject(projectScope??string(body.projectId,'项目 ID',100));if(agent.projectId!==project.id||body.projectId&&body.projectId!==project.id)throw new WorkbenchError('成果不属于该项目',403);
    const kind=string(body.kind,'成果类型',30) as Artifact['kind'];if(!['commit','test','review','pr','file','summary'].includes(kind))throw new WorkbenchError('未知成果类型');
    const taskId=body.taskId?string(body.taskId,'任务编号',160):undefined;if(taskId)await this.tasks.get(project,taskId);
    let value=string(body.value,'成果内容',100000);
    if(kind==='commit')value=await this.git.resolveCommit(project,value);
    const artifact:Artifact={id:randomUUID(),projectId:project.id,taskId,agentId:agent.id,kind,title:string(body.title,'成果标题',300),value:this.scrub(value) as string,createdAt:now()};
    this.store.put('artifacts',artifact.id,artifact);this.event('artifact.created',agent.id,artifact.title,{artifactId:artifact.id,taskId,kind});return artifact;
  }
  async controllerTool(id:string,name:unknown,argsInput:unknown):Promise<unknown> {
    this.assertAccepting();
    const lead=this.getAgent(id);if(!controller(lead))throw new WorkbenchError('该成员不是主控',403);
    const args=object(argsInput??{});const project=this.getProject(lead.projectId);
    if(args.projectId&&args.projectId!==lead.projectId)throw new WorkbenchError('主控只能操作自己的项目',403);
    const member=()=>{const agent=this.getAgent(string(args.agentId,'成员 ID',100));if(agent.projectId!==project.id)throw new WorkbenchError('成员不属于主控项目',403);return agent;};
    switch(name) {
      case 'list_team':return this.agents().filter(a=>a.projectId===project.id).map(agent=>({...agent,capabilities:(agent.capabilityIds??[]).map(capabilityId=>{const capability=this.capabilities.get(capabilityId);return {id:capability.id,name:capability.name,kind:capability.kind,status:capability.status};})}));
      case 'list_tasks':return this.tasks.list(project);
      case 'create_task':case 'dispatch_task':case 'send_message':case 'set_task_status':throw new WorkbenchError('请使用已确认工作流的派发、返工与验收工具；不能绕过计划确认。',409);
      case 'get_agent_events':{const target=member();const after=Number(args.after??0);const limit=Math.min(Math.max(Math.floor(Number(args.limit))||100,1),300);return this.store.agentEvents(target.id,Number.isFinite(after)?after:0,limit);}
      case 'record_artifact':return this.recordArtifact({...args,projectId:project.id},project.id);
      default:return scopedTool(this,lead,string(name,'工具名',100),args);
    }
  }
  private async closeConnection(id:string):Promise<void> {const connection=this.connections.get(id);if(connection){await connection.close();this.connections.delete(id);}this.connectionCapabilityFingerprints.delete(id);this.controllerTokens.delete(id);}
  close():Promise<void> {
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    clearInterval(this.authenticationMonitor);clearTimeout(this.authenticationStartup);
    this.closePromise=this.closeInternal();return this.closePromise;
  }
  private markShutdownUnknown(id:string,error:unknown,resourceUnconfirmed=false):void {
    const active=this.active.get(id),run=this.store.get<RunRecord>('runs',id);
    if(!resourceUnconfirmed&&(!active||run?.state==='terminal'))return;
    if(!run&&!active)return;
    const detail=`服务关闭时执行尚未得到终止确认：${this.publicError(error)}`;
    if(run&&run.state!=='terminal')this.saveRun({...run,state:'unknown'});
    this.patchAgent(id,{state:'unknown',controlMode:'human',lastError:detail});
    const messageId=active?.message.id??run?.messageId;
    const message=messageId?this.store.get<QueuedMessage>('messages',messageId):undefined;
    if(message&&['sending','delivered'].includes(message.state))this.store.put('messages',message.id,{...message,state:'uncertain'});
    if(message?.roundId)this.track(this.workflows.markUncertain(message.roundId,detail));
    this.event('agent.shutdown_unconfirmed',id,detail,{messageId});
  }
  private async closeInternal():Promise<void> {
    // Stop admission first, but keep the event sink and SQLite open until all
    // owned connections and in-flight connection attempts have settled.
    for(const message of this.messages())if(message.state==='queued')this.store.put('messages',message.id,{...message,state:'cancelled'});
    // Pending authorization owns a native child before connect() returns a
    // RuntimeConnection. Stop those resources before waiting for background work.
    for(const adapter of this.adapters.values())if(adapter.authentication){
      try{await adapter.authentication.close();}
      catch(error){for(const session of adapter.authentication.list().filter(row=>row.state==='unknown')){const run=this.store.get<RunRecord>('runs',session.agentId);if(run&&session.pid)this.saveRun({...run,pid:session.pid});this.markShutdownUnknown(session.agentId,error,true);}}
    }
    for(const [id,connection] of this.connections) {
      try{await connection.close();}catch(error){this.markShutdownUnknown(id,error);}
    }
    await this.connectionManager.close();
    await this.authenticationRefresh;
    // Result handlers may add more background indexing work while a connection
    // closes. A single snapshot of this set can close SQLite underneath them.
    while(this.background.size||this.modelRequests.size||this.commandPromises.size||this.locks.size)
      await Promise.allSettled([...this.background,...this.modelRequests.values(),...this.commandPromises.values(),...this.locks.values()]);
    for(const id of this.active.keys())this.markShutdownUnknown(id,'未收到原生终态或已确认停止回执');
    while(this.background.size)await Promise.allSettled([...this.background]);
    await this.previews.close();
    this.connections.clear();
    this.closed=true;
    if(this.store.get<{instanceId:string}>('service','owner')?.instanceId===this.instanceId)this.store.remove('service','owner');
    this.store.close();
  }
}
