import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, Project, RuntimeAdapter, RuntimeConnection, RuntimeEvent, RuntimeKind, RuntimeModelCatalog, RuntimeOptions, RuntimeState, Task, TaskBinding } from '../src/shared/types.js';
import { buildApp } from '../src/server/index.js';
import { WorkbenchService } from '../src/server/service.js';
import type { GitRepository, TaskCreateInput, TaskRepository } from '../src/server/repositories.js';
import { Store } from '../src/server/store.js';

class FakeTasks implements TaskRepository {
  values:Task[]=[];unavailable=false;
  async validate():Promise<void>{}
  async list(project:Project):Promise<Task[]>{if(this.unavailable)throw new Error('Beads unavailable');return this.values.filter(t=>t.projectId===project.id);}
  async get(project:Project,id:string):Promise<Task>{const task=this.values.find(t=>t.id===id&&t.projectId===project.id);if(!task)throw new Error('Task not found');return task;}
  async create(project:Project,input:TaskCreateInput):Promise<Task>{const task:Task={id:`test-${this.values.length+1}`,projectId:project.id,title:input.title,description:input.description??'',acceptance:input.acceptance??'',status:'open',dependencies:input.dependencies??[]};this.values.push(task);return task;}
  async update(project:Project,id:string,fields:{status?:string;owner?:string}):Promise<Task>{const task=await this.get(project,id);Object.assign(task,fields);return task;}
}
class FakeGit implements GitRepository {
  created:TaskBinding[]=[];dirty=false;commit='a'.repeat(40);
  async validate(path:string):Promise<string>{return path;}
  async createWorktree(project:Project,taskId:string,agentId:string,baseCommit?:string):Promise<TaskBinding>{const value={projectId:project.id,taskId,agentId,worktree:`${project.path}/worktrees/${randomUUID()}`,branch:'workbench/test',startCommit:baseCommit??'a'.repeat(40)};this.created.push(value);return value;}
  async inspect():Promise<{commit:string;dirty:boolean;diff:string}>{return {commit:this.commit,dirty:this.dirty,diff:''};}
  async resolveCommit(_project:Project,ref:string):Promise<string>{return ref;}
}
class FakeAdapter implements RuntimeAdapter {
  kind:RuntimeKind='codex';
  listModels?:RuntimeAdapter['listModels'];
  sessions=new Map<string,{emit:(event:RuntimeEvent)=>void;sent:string[];options:RuntimeOptions}>();
  acknowledgeInterrupt=true;sendFails=false;connectFails=false;
  approvalResponseState?:RuntimeState;
  approvalGate?:Promise<void>;
  sessionSequence=0;connectCalls=0;interruptCalls=0;
  connectGate?:Promise<void>;
  async discover(){return {kind:this.kind,available:true,detail:'fake transport for tests',capabilities:{steer:false,interrupt:true,resume:true,approvals:true}};}
  async connect(options:RuntimeOptions,emit:(event:RuntimeEvent)=>void):Promise<RuntimeConnection>{
    this.connectCalls++;
    const session={emit,sent:[] as string[],options};this.sessions.set(options.agentId,session);
    await this.connectGate;
    if(this.connectFails)throw new Error('initialization failed');
    return {nativeSessionId:`native-${options.agentId}-${++this.sessionSequence}`,pid:undefined,send:async(text)=>{session.sent.push(text);if(this.sendFails)throw new Error('Lost acknowledgement');},interrupt:async()=>{this.interruptCalls++;if(this.acknowledgeInterrupt)emit({type:'result',data:{interrupted:true}});},respondApproval:async()=>{await this.approvalGate;if(this.approvalResponseState)emit({type:'state',state:this.approvalResponseState});},close:async()=>{}};
  }
  finish(id:string,text='done'):void {this.sessions.get(id)!.emit({type:'result',text});}
}
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const clean of cleanups.splice(0).reverse())await clean();});
async function flush(){for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));}
async function setup(maxWorkers=3,interruptTimeoutMs=20) {
  const dir=mkdtempSync(join(tmpdir(),'workbench-test-'));
  const tasks=new FakeTasks(),git=new FakeGit(),adapter=new FakeAdapter();
  const service=new WorkbenchService({dataDir:dir,tasks,git,adapters:[adapter],maxWorkers,interruptTimeoutMs});
  // Scheduler tests isolate transport/ordering; real profile validation is covered separately.
  vi.spyOn(service.connectionManager,'assertReady').mockResolvedValue({} as never);
  cleanups.push(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  const project=await service.createProject({name:'Test',path:'C:/synthetic'});
  const makeAgent=(name:string,role='developer',permissionMode:Agent['permissionMode']='workspace-write')=>service.createAgent({name,role,memberKind:role==='controller'?'controller':'worker',permissionMode,projectId:project.id,runtime:'codex'});
  const makeTask=(title='Implement')=>service.createTask({title,projectId:project.id,acceptance:'real evidence'});
  return {dir,service,tasks,git,adapter,project,makeAgent,makeTask};
}

describe('backend scheduling and durable state',()=>{
  it('deduplicates concurrent dispatch and refuses key reuse for a different payload',async()=>{
    const {service,git,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A'),task=await makeTask();
    const input={projectId:project.id,agentId:agent.id};
    const [a,b]=await Promise.all([service.dispatch(task.id,input,'same'),service.dispatch(task.id,input,'same')]);
    expect(a).toEqual(b);expect(git.created).toHaveLength(1);
    await expect(service.dispatch(task.id,{...input,baseCommit:'b'.repeat(40)},'same')).rejects.toThrow('不同请求');
  });
  it('limits parallel workers and starts the next queued member only after a terminal result',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup(1);const a=await makeAgent('A'),b=await makeAgent('B');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:a.id},'a');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:b.id},'b');await flush();
    expect(adapter.sessions.has(a.id)).toBe(true);expect(adapter.sessions.has(b.id)).toBe(false);
    adapter.finish(a.id);await flush();expect(adapter.sessions.has(b.id)).toBe(true);
  });
  it('keeps human messages sequential and prevents controller messages after takeover',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    await service.message(agent.id,{text:'下一轮补充',mode:'queue'},'human');
    expect(service.getAgent(agent.id).controlMode).toBe('human');expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(1);expect(adapter.interruptCalls).toBe(0);
    await expect(service.message(agent.id,{text:'override'},'controller','controller')).rejects.toThrow('人工接管');
    adapter.finish(agent.id);await flush();expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(2);expect(adapter.sessions.get(agent.id)!.sent[1]).toBe('下一轮补充');
  });
  it('sends idle human messages by default without interrupting the idle connection',async()=>{
    const {service,adapter,makeAgent}=await setup();const agent=await makeAgent('Lead','controller','read-only');
    await service.message(agent.id,{text:'first'},'first');await flush();adapter.finish(agent.id);await flush();
    await service.message(agent.id,{text:'next'},'next');await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toEqual(['first','next']);
    expect(adapter.interruptCalls).toBe(0);expect(adapter.connectCalls).toBe(1);
  });
  it('defaults human corrections to one same-session delivery only after confirmed interruption',async()=>{
    const {service,adapter,makeAgent}=await setup(3,1000);const agent=await makeAgent('Lead','controller','read-only');
    await service.message(agent.id,{text:'first'},'first');await flush();
    const session=adapter.sessions.get(agent.id)!,nativeSessionId=service.getAgent(agent.id).nativeSessionId;
    adapter.acknowledgeInterrupt=false;
    // An untrusted body source must not change the human API's default behavior.
    const body={text:'corrected',source:'controller'};
    const first=service.message(agent.id,body,'correct'),retry=service.message(agent.id,body,'correct');
    await flush();expect(session.sent).toEqual(['first']);expect(adapter.interruptCalls).toBe(1);
    expect(service.getAgent(agent.id).state).toBe('interrupting');
    session.emit({type:'result',data:{interrupted:true}});
    expect(await first).toEqual(await retry);await flush();
    expect(session.sent).toEqual(['first','corrected']);expect(adapter.connectCalls).toBe(1);
    expect(service.getAgent(agent.id).nativeSessionId).toBe(nativeSessionId);
  });
  it('replaces an unsent human message while connecting without releasing its active slot',async()=>{
    const {service,adapter,makeAgent}=await setup();const agent=await makeAgent('Lead','controller','read-only');
    let release=()=>{};adapter.connectGate=new Promise<void>(resolve=>{release=resolve;});
    const original=await service.message(agent.id,{text:'never send'},'original') as {messageId:string};await flush();
    try {
      await service.message(agent.id,{text:'corrected'},'correct');await flush();
      expect(service.store.get<{state:string}>('messages',original.messageId)?.state).toBe('cancelled');
      expect(service.getAgent(agent.id).state).toBe('starting');
      expect(adapter.sessions.get(agent.id)!.sent).toEqual([]);expect(adapter.connectCalls).toBe(1);
    } finally {release();await flush();}
    expect(adapter.sessions.get(agent.id)!.sent).toEqual(['corrected']);
    expect(adapter.connectCalls).toBe(1);expect(adapter.interruptCalls).toBe(0);
  });
  it.each(['controller','system'] as const)('keeps default %s messages queued until the current turn finishes',async(source)=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    await service.message(agent.id,{text:'next automated instruction'},'next',source);await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(1);expect(adapter.interruptCalls).toBe(0);
    adapter.finish(agent.id);await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(2);
    expect(adapter.sessions.get(agent.id)!.sent[1]).toBe('next automated instruction');
  });
  it('waits for actual interruption and never sends correction after an uncertain stop',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();adapter.acknowledgeInterrupt=false;
    await expect(service.message(agent.id,{text:'纠正方向',mode:'interrupt'},'correct')).rejects.toThrow('中断未收到终止');
    expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(1);expect(service.getAgent(agent.id).state).toBe('unknown');
  });
  it('keeps an interrupt timeout unknown when a pending approval is later denied',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    const emit=adapter.sessions.get(agent.id)!.emit;emit({type:'approval',approvalId:'pending',data:{tool:'run'}});
    adapter.acknowledgeInterrupt=false;await expect(service.interrupt(agent.id)).rejects.toThrow('中断未收到终止');
    const error=service.getAgent(agent.id).lastError;
    adapter.approvalResponseState='running';await service.respondApproval(agent.id,'pending',false);
    expect(service.getAgent(agent.id)).toMatchObject({state:'unknown',controlMode:'human',lastError:error});
    expect(service.store.all('approvals')).toHaveLength(0);
    await expect(service.message(agent.id,{text:'unsafe continuation'},'unsafe')).rejects.toThrow('状态未知');
  });
  it.each(['error','interrupting'] as const)('preserves %s across approval callbacks and delayed runtime progress',async(state)=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    const emit=adapter.sessions.get(agent.id)!.emit;emit({type:'approval',approvalId:'pending',data:{tool:'run'}});emit({type:'state',state});
    adapter.approvalResponseState='running';await service.respondApproval(agent.id,'pending',false);
    emit({type:'state',state:'waiting_approval'});emit({type:'state',state:'idle'});
    expect(service.getAgent(agent.id).state).toBe(state);
  });
  it('rechecks state after the asynchronous approval reply before returning to running',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    const emit=adapter.sessions.get(agent.id)!.emit;emit({type:'approval',approvalId:'pending',data:{tool:'run'}});
    let release=()=>{};adapter.approvalGate=new Promise<void>(resolve=>{release=resolve;});
    const responding=service.respondApproval(agent.id,'pending',true);emit({type:'state',state:'interrupting'});release();await responding;
    expect(service.getAgent(agent.id).state).toBe('interrupting');
  });
  it('keeps ambiguous delivery uncertain and does not replay it',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();adapter.sendFails=true;const agent=await makeAgent('A'),task=await makeTask();
    const request={projectId:project.id,agentId:agent.id};await service.dispatch(task.id,request,'dispatch');await flush();
    expect(service.getAgent(agent.id).state).toBe('unknown');await service.dispatch(task.id,request,'dispatch');await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(1);
    await expect(service.message(agent.id,{text:'try again'},'fresh-key')).rejects.toThrow('状态未知');
  });
  it('does not let a trailing runtime state erase an uncertain delivery',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    const emit=adapter.sessions.get(agent.id)!.emit;
    emit({type:'error',text:'transport disconnected'});emit({type:'state',state:'error'});await flush();
    expect(service.getAgent(agent.id).state).toBe('unknown');
    await expect(service.message(agent.id,{text:'new command'},'unsafe')).rejects.toThrow('状态未知');
  });
  it('cancels paused controller instructions on takeover and checks dependencies before creating worktrees',async()=>{
    const {service,adapter,git,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');const prerequisite=await makeTask('prerequisite');
    const blocked=await service.createTask({projectId:project.id,title:'dependent',dependencies:[prerequisite.id]});
    await expect(service.dispatch(blocked.id,{projectId:project.id,agentId:agent.id},'blocked')).rejects.toThrow('依赖任务');expect(git.created).toHaveLength(0);
    await service.dispatch(prerequisite.id,{projectId:project.id,agentId:agent.id},'dispatch');await flush();
    await service.message(agent.id,{text:'old automated command'},'queued-controller','controller');
    await service.control(agent.id,'human');adapter.finish(agent.id);await flush();await service.control(agent.id,'auto');await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(1);
  });
  it('rechecks takeover after asynchronous connection initialization before sending',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A');
    await service.dispatch((await makeTask()).id,{projectId:project.id,agentId:agent.id},'initial');await flush();adapter.finish(agent.id);await flush();
    await service.updateAgent(agent.id,{model:'new-model'});
    let release=()=>{};adapter.connectGate=new Promise<void>(resolve=>{release=resolve;});
    await service.message(agent.id,{text:'automatic follow-up'},'follow-up','controller');await flush();
    await service.control(agent.id,'human');release();await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toHaveLength(0);expect(service.getAgent(agent.id).state).toBe('idle');
    await service.message(agent.id,{text:'人工新的指令'},'human');await flush();
    expect(adapter.sessions.get(agent.id)!.sent).toEqual(['人工新的指令']);
  });
  it('recovers persisted in-flight messages as unknown without replaying',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-recovery-'));const path=join(dir,'workbench.sqlite');
    const store=new Store(path);const project:Project={id:'p',name:'P',path:'C:/synthetic',createdAt:new Date().toISOString()};
    const agent:Agent={id:'a',projectId:'p',name:'A',role:'developer',runtime:'codex',model:'',instructions:'',permissionMode:'workspace-write',controlMode:'auto',state:'running',createdAt:project.createdAt};
    store.put('projects','p',project);store.put('agents','a',agent);store.put('messages','m',{id:'m',agentId:'a',text:'do it',source:'controller',state:'delivered',createdAt:project.createdAt});store.put('runs','a',{agentId:'a',messageId:'m',state:'active',startedAt:project.createdAt});store.close();
    const adapter=new FakeAdapter();const service=new WorkbenchService({dataDir:dir,tasks:new FakeTasks(),git:new FakeGit(),adapters:[adapter]});
    cleanups.push(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});await flush();
    expect(service.getAgent('a').state).toBe('unknown');expect(adapter.sessions.size).toBe(0);expect(service.store.get<{state:string}>('messages','m')!.state).toBe('uncertain');
    await service.recover('a');expect(service.getAgent('a').state).toBe('stopped');expect(adapter.sessions.size).toBe(0);
  });
  it('expires disconnected approvals on restart and recovery while preserving their audit events',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-approval-recovery-'));const store=new Store(join(dir,'workbench.sqlite'));
    const createdAt=new Date().toISOString();
    store.put('projects','p',{id:'p',name:'P',path:'C:/synthetic',createdAt});
    store.put('agents','a',{id:'a',projectId:'p',name:'A',role:'developer',runtime:'codex',model:'',instructions:'',permissionMode:'workspace-write',controlMode:'auto',state:'waiting_approval',createdAt} satisfies Agent);
    store.put('runs','a',{agentId:'a',messageId:'m',state:'active',startedAt:createdAt});
    store.put('approvals','a:old',{id:'old',agentId:'a',tool:'command',input:{command:'test'},createdAt});
    store.event({type:'runtime.approval',agentId:'a',projectId:'p',data:{approvalId:'old'},createdAt});store.close();
    const service=new WorkbenchService({dataDir:dir,tasks:new FakeTasks(),git:new FakeGit(),adapters:[new FakeAdapter()]});
    cleanups.push(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
    expect(service.getAgent('a').state).toBe('unknown');expect((await service.snapshot()).approvals).toEqual([]);
    expect(service.store.events().map(event=>event.type)).toEqual(['runtime.approval','approval.expired']);
    await expect(service.respondApproval('a','old',true)).rejects.toThrow('审批已过期');
    service.store.put('approvals','a:residual',{id:'residual',agentId:'a',tool:'command',input:{command:'test'},createdAt});
    await service.recover('a');expect(service.store.all('approvals')).toEqual([]);
    expect(service.store.events().filter(event=>event.type==='approval.expired').map(event=>event.data?.approvalId)).toEqual(['old','residual']);
    await expect(service.respondApproval('a','residual',false)).rejects.toThrow('审批已过期');
  });
  it('persists concrete model receipts beyond event windows and restart, without empty ready frames erasing them',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-receipts-'));const tasks=new FakeTasks(),git=new FakeGit(),adapter=new FakeAdapter();
    let service=new WorkbenchService({dataDir:dir,tasks,git,adapters:[adapter]});
    cleanups.push(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
    const project=await service.createProject({name:'P',path:'C:/synthetic'});
    const agent=await service.createAgent({name:'Lead',role:'controller',memberKind:'controller',runtime:'codex',projectId:project.id,model:'configured-alias'});
    await service.message(agent.id,{text:'Goal'},'goal');await flush();
    const emit=adapter.sessions.get(agent.id)!.emit;
    emit({type:'ready',data:{model:'observed-model',provider:'observed-provider'}});
    emit({type:'ready'});emit({type:'ready',data:{model:' ',provider:123}});
    for(let index=0;index<510;index++)emit({type:'tool',text:`tool output ${index}`});
    adapter.finish(agent.id);await flush();
    const snapshot=await service.snapshot();
    expect(snapshot.events.some(event=>event.type==='runtime.ready')).toBe(false);
    expect(snapshot.agents[0]).toMatchObject({model:'configured-alias',observedModel:'observed-model',observedProvider:'observed-provider'});
    await service.close();service=new WorkbenchService({dataDir:dir,tasks,git,adapters:[adapter]});
    expect(service.getAgent(agent.id)).toMatchObject({observedModel:'observed-model',observedProvider:'observed-provider'});
    await service.updateAgent(agent.id,{model:'new-configuration'});
    expect(service.getAgent(agent.id).observedModel).toBeUndefined();expect(service.getAgent(agent.id).observedProvider).toBeUndefined();
  });
  it('attributes late usage to its persisted original turn, task, session and observed model',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const agent=await makeAgent('A'),first=await makeTask('First'),second=await makeTask('Second');
    const initial=await service.dispatch(first.id,{projectId:project.id,agentId:agent.id},'first') as {messageId:string};await flush();
    const original=adapter.sessions.get(agent.id)!,nativeSessionId=service.getAgent(agent.id).nativeSessionId;
    original.emit({type:'ready',data:{model:'observed-old-model',provider:'observed-old-provider'}});adapter.finish(agent.id);await flush();
    await service.updateAgent(agent.id,{model:'new-model'});
    const current=await service.dispatch(second.id,{projectId:project.id,agentId:agent.id},'second') as {messageId:string};await flush();
    adapter.sessions.get(agent.id)!.emit({type:'ready',data:{model:'observed-new-model',provider:'new-provider'}});
    original.emit({type:'usage',messageId:initial.messageId,nativeSessionId,data:{scope:'turn',source:'provider.result',inputTokens:20,outputTokens:5,totalTokens:25}});
    original.emit({type:'usage',nativeSessionId,data:{scope:'turn',source:'provider.result',totalTokens:999}});
    const snapshot=await service.snapshot();expect(snapshot.usage).toHaveLength(1);
    expect(snapshot.usage[0]).toMatchObject({messageId:initial.messageId,taskId:first.id,nativeSessionId,model:'observed-old-model',provider:'observed-old-provider',counts:{totalTokens:25}});
    expect(snapshot.usage.some(record=>record.messageId===current.messageId)).toBe(false);
    expect(service.getAgent(agent.id)).toMatchObject({currentTaskId:second.id,observedModel:'observed-new-model',state:'running'});
    expect(snapshot.usageSummaries.find(summary=>summary.taskId===second.id)).toMatchObject({counts:{},reportedTurns:0,totalTurns:1,partial:true});
  });
  it('retains only allowlisted numeric token counters while redacting credentials and malformed token values',async()=>{
    const {service}=await setup();
    const event=service.event('token-redaction-check',undefined,undefined,{totalTokens:42,input_tokens:30,outputTokens:12,access_token:'secret',session_token:999,cache_read_input_tokens:Infinity,reasoningOutputTokens:'secret'});
    expect(event.data).toEqual({totalTokens:42,input_tokens:30,outputTokens:12,access_token:'[redacted]',session_token:'[redacted]',cache_read_input_tokens:'[redacted]',reasoningOutputTokens:'[redacted]'});
  });
  it('requires evidence before task closure and preserves dirty worktrees during reassignment',async()=>{
    const {service,adapter,git,project,makeAgent,makeTask}=await setup();const a=await makeAgent('A'),b=await makeAgent('B'),task=await makeTask();
    await service.dispatch(task.id,{projectId:project.id,agentId:a.id},'dispatch');await flush();adapter.finish(a.id);await flush();
    await expect(service.setTaskStatus(task.id,{projectId:project.id,status:'closed'})).rejects.toThrow('证据');
    git.dirty=true;await expect(service.dispatch(task.id,{projectId:project.id,agentId:b.id},'reassign')).rejects.toThrow('未提交变更');expect(git.created).toHaveLength(1);
    await service.recordArtifact({projectId:project.id,agentId:a.id,taskId:task.id,kind:'test',title:'Test execution',value:'npm test: 4 passed'});
    await service.setTaskStatus(task.id,{projectId:project.id,status:'closed'});expect((await service.tasks.get(project,task.id)).status).toBe('closed');
  });
  it('reassigns a historical task without clearing its previous member newer task session',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const a=await makeAgent('A'),b=await makeAgent('B'),first=await makeTask('First'),second=await makeTask('Second');
    await service.dispatch(first.id,{projectId:project.id,agentId:a.id},'first');await flush();adapter.finish(a.id);await flush();
    await service.dispatch(second.id,{projectId:project.id,agentId:a.id},'second');await flush();adapter.finish(a.id);await flush();
    const before=service.getAgent(a.id);const originalConnection=adapter.sessions.get(a.id);
    await service.dispatch(first.id,{projectId:project.id,agentId:b.id},'reassign');await flush();
    expect(service.getAgent(a.id)).toEqual(before);expect(adapter.sessions.get(a.id)).toBe(originalConnection);
    expect(service.store.get<TaskBinding>('bindings',`${project.id}:${second.id}`)?.agentId).toBe(a.id);
    await service.message(a.id,{text:'继续第二项任务'},'continue-second');await flush();
    expect(originalConnection!.sent.at(-1)).toBe('继续第二项任务');
  });
  it.each(['open','in_progress'])('reviews a clean immutable candidate without prematurely closing its %s implementation dependency',async(status)=>{
    const {service,adapter,git,tasks,project,makeAgent,makeTask}=await setup();
    const writer=await makeAgent('Writer'),reviewer=await makeAgent('Reviewer','reviewer','read-only'),implementation=await makeTask('Implementation');
    await service.dispatch(implementation.id,{projectId:project.id,agentId:writer.id},'implement');await flush();
    git.commit='b'.repeat(40);adapter.finish(writer.id);await flush();await tasks.update(project,implementation.id,{status});
    const review=await service.createTask({projectId:project.id,title:'Review',dependencies:[implementation.id]});
    const receipt=await service.dispatch(review.id,{projectId:project.id,agentId:reviewer.id,reviewTaskId:implementation.id},'review') as {binding:TaskBinding};await flush();
    expect(receipt.binding.startCommit).toBe('b'.repeat(40));expect(receipt.binding.worktree).not.toBe(service.getAgent(writer.id).worktree);
    expect((await tasks.get(project,implementation.id)).status).toBe(status);
    expect(adapter.sessions.get(reviewer.id)!.options.permissionMode).toBe('read-only');
  });
  it.each(['active','dirty','unknown'])('rejects review of a %s implementation candidate',async(condition)=>{
    const {service,adapter,git,project,makeAgent,makeTask}=await setup();
    const writer=await makeAgent('Writer'),reviewer=await makeAgent('Reviewer','reviewer','read-only'),implementation=await makeTask('Implementation');
    await service.dispatch(implementation.id,{projectId:project.id,agentId:writer.id},'implement');await flush();
    if(condition!=='active'){adapter.finish(writer.id);await flush();}
    if(condition==='dirty')git.dirty=true;
    if(condition==='unknown')service.store.put('agents',writer.id,{...service.getAgent(writer.id),state:'unknown'});
    const review=await service.createTask({projectId:project.id,title:'Review',dependencies:[implementation.id]});
    await expect(service.dispatch(review.id,{projectId:project.id,agentId:reviewer.id,reviewTaskId:implementation.id},'review')).rejects.toThrow(condition==='dirty'?'固定提交':'状态未知');
    expect(git.created).toHaveLength(1);expect(adapter.sessions.has(reviewer.id)).toBe(false);
  });
  it('does not let a writable reviewer or an ordinary readonly task bypass unfinished dependencies',async()=>{
    const {service,adapter,git,project,makeAgent,makeTask}=await setup();
    const writer=await makeAgent('Writer'),writable=await makeAgent('Writable reviewer','reviewer'),readonly=await makeAgent('Readonly reviewer','reviewer','read-only'),implementation=await makeTask('Implementation');
    await service.dispatch(implementation.id,{projectId:project.id,agentId:writer.id},'implement');await flush();adapter.finish(writer.id);await flush();
    const review=await service.createTask({projectId:project.id,title:'Review',dependencies:[implementation.id]});
    await expect(service.dispatch(review.id,{projectId:project.id,agentId:writable.id,reviewTaskId:implementation.id},'writable-review')).rejects.toThrow('只读成员');
    await expect(service.dispatch(review.id,{projectId:project.id,agentId:readonly.id,baseCommit:git.commit},'ordinary-readonly')).rejects.toThrow('尚未完成');
    expect(git.created).toHaveLength(1);
  });
  it('keeps unrelated review dependencies and blocked implementation dependencies gated',async()=>{
    const {service,adapter,git,tasks,project,makeAgent,makeTask}=await setup();
    const writer=await makeAgent('Writer'),reviewer=await makeAgent('Reviewer','reviewer','read-only'),implementation=await makeTask('Implementation'),other=await makeTask('Other prerequisite');
    await service.dispatch(implementation.id,{projectId:project.id,agentId:writer.id},'implement');await flush();adapter.finish(writer.id);await flush();
    const review=await service.createTask({projectId:project.id,title:'Review',dependencies:[implementation.id,other.id]});
    await expect(service.dispatch(review.id,{projectId:project.id,agentId:reviewer.id,reviewTaskId:implementation.id},'other-dependency')).rejects.toThrow(`依赖任务 ${other.id}`);
    await tasks.update(project,other.id,{status:'closed'});await tasks.update(project,implementation.id,{status:'blocked'});
    await expect(service.dispatch(review.id,{projectId:project.id,agentId:reviewer.id,reviewTaskId:implementation.id},'blocked-implementation')).rejects.toThrow(`依赖任务 ${implementation.id}`);
    expect(git.created).toHaveLength(1);
  });
  it('reports one source failure without dropping other state',async()=>{
    const {service,tasks,makeAgent}=await setup();await makeAgent('A');tasks.unavailable=true;const snapshot=await service.snapshot();expect(snapshot.agents).toHaveLength(1);expect(snapshot.errors.join()).toContain('Beads unavailable');
  });
  it('refuses a second scheduler against the same live data directory',async()=>{
    const {dir,tasks,git,adapter}=await setup();
    expect(()=>new WorkbenchService({dataDir:dir,tasks,git,adapters:[adapter]})).toThrow('正在由工作台进程');
  });
  it('restricts MCP operations to the controller project and returns worker results exactly once',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();const lead=await makeAgent('Lead','controller'),worker=await makeAgent('A');
    await service.message(lead.id,{text:'安排任务'},'goal');await flush();
    const token=adapter.sessions.get(lead.id)!.options.mcpServers!.workbench.env!.WORKBENCH_CONTROLLER_TOKEN;
    expect(service.authenticateController(lead.id,token)).toBe(true);expect(service.authenticateController(lead.id,'incorrect')).toBe(false);
    expect(service.getAgent(lead.id).controlMode).toBe('auto');
    await expect(service.controllerTool(lead.id,'list_tasks',{projectId:'other'})).rejects.toThrow('自己的项目');
    const task=await makeTask();await expect(service.controllerTool(lead.id,'dispatch_task',{taskId:task.id,agentId:worker.id,idempotencyKey:'dispatch'})).rejects.toThrow('不能绕过计划确认');
    await service.dispatch(task.id,{projectId:project.id,agentId:worker.id},'user-dispatch');await flush();
    adapter.finish(worker.id,'实施完成');adapter.finish(worker.id,'duplicate native notification');await flush();
    const notifications=service.store.all<{source:string;text:string}>('messages').filter(m=>m.source==='system');expect(notifications).toHaveLength(1);expect(notifications[0].text).toContain('实施完成');
    expect(service.store.events().some(e=>JSON.stringify(e).includes(token))).toBe(false);
  });
  it('returns uncertain failures to the controller once without replaying worker input',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();await makeAgent('Lead','controller');const worker=await makeAgent('A'),task=await makeTask();
    await service.dispatch(task.id,{projectId:project.id,agentId:worker.id},'dispatch');await flush();
    const emit=adapter.sessions.get(worker.id)!.emit;emit({type:'error',text:'ack lost'});emit({type:'error',text:'secondary transport error'});await flush();
    const notifications=service.store.all<{source:string;text:string}>('messages').filter(m=>m.source==='system');
    expect(notifications).toHaveLength(1);expect(notifications[0].text).toContain('严禁重复派发');expect(service.getAgent(worker.id).state).toBe('unknown');
    expect(adapter.sessions.get(worker.id)!.sent).toHaveLength(1);
  });
  it.each(['connect','send'] as const)('returns %s failures to the controller exactly once',async(kind)=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();await makeAgent('Lead','controller');const worker=await makeAgent('A'),task=await makeTask();
    if(kind==='connect')adapter.connectFails=true;else adapter.sendFails=true;
    await service.dispatch(task.id,{projectId:project.id,agentId:worker.id},'dispatch');await flush();
    const notifications=service.store.all<{source:string;text:string}>('messages').filter(m=>m.source==='system');
    expect(notifications).toHaveLength(1);expect(notifications[0].text).toContain('失败');expect(service.getAgent(worker.id).state).toBe(kind==='send'?'unknown':'error');
    expect(adapter.sessions.get(worker.id)!.sent).toHaveLength(kind==='send'?1:0);
  });
  it('records an explicit unsuccessful result as failed rather than successful or uncertain',async()=>{
    const {service,adapter,project,makeAgent,makeTask}=await setup();await makeAgent('Lead','controller');const worker=await makeAgent('A'),task=await makeTask();
    await service.dispatch(task.id,{projectId:project.id,agentId:worker.id},'dispatch');await flush();
    const emit=adapter.sessions.get(worker.id)!.emit;
    emit({type:'result',text:'provider request rejected',data:{isError:true,status:'failed'}});emit({type:'state',state:'idle'});await flush();
    expect(service.getAgent(worker.id).state).toBe('error');
    expect(service.store.all<{agentId:string;state:string}>('messages').find(m=>m.agentId===worker.id)!.state).toBe('failed');
    const notifications=service.store.all<{source:string;text:string}>('messages').filter(m=>m.source==='system');expect(notifications).toHaveLength(1);expect(notifications[0].text).toContain('已确认的失败终态');
  });
});

describe('native model discovery',()=>{
  const catalog=(name='native-model'):RuntimeModelCatalog=>({runtime:'codex',models:[{id:name,name,description:'Native selector item',isDefault:true}],source:'native.model/list',status:'ready',checkedAt:new Date().toISOString(),detail:'Catalog only, not quota verification'});
  it('coalesces probes including refreshes without creating a session or changing persisted state',async()=>{
    const {service,adapter,makeAgent,project}=await setup();const agent=await makeAgent('A');
    service.store.put('agents',agent.id,{...agent,state:'unknown',nativeSessionId:'existing-session',controlMode:'human'});
    const before=await service.snapshot();let release!:(value:RuntimeModelCatalog)=>void;
    adapter.listModels=vi.fn(()=>new Promise<RuntimeModelCatalog>(resolve=>{release=resolve;}));
    const first=service.modelsForAgent(agent.id),second=service.modelsForAgent(agent.id,true);
    await vi.waitFor(()=>expect(adapter.listModels).toHaveBeenCalledTimes(1));
    const [cwd,connection]=vi.mocked(adapter.listModels).mock.calls[0]!;
    expect(cwd).toBe(project.path);expect(connection?.connectionId).toBe(agent.connectionId);expect(connection?.revision).toBe(agent.connectionRevision);release(catalog());
    expect(await first).toEqual(await second);expect(adapter.sessions.size).toBe(0);
    expect(await service.snapshot()).toEqual(before);expect(service.store.all('messages')).toEqual([]);
  });
  it('uses a five-minute cache, isolates working directories and tools, and bypasses it on refresh',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-model-cache-')),adapter=new FakeAdapter(),other=new FakeAdapter();other.kind='claude';
    const service=new WorkbenchService({dataDir:dir,tasks:new FakeTasks(),git:new FakeGit(),adapters:[adapter,other]});
    cleanups.push(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
    const project=await service.createProject({name:'P',path:'C:/synthetic'});
    const a=await service.createAgent({projectId:project.id,name:'A',role:'developer',runtime:'codex'}),b=await service.createAgent({projectId:project.id,name:'B',role:'developer',runtime:'codex'});
    adapter.listModels=vi.fn(async()=>catalog());
    await service.modelsForAgent(a.id);await service.modelsForAgent(b.id);expect(adapter.listModels).toHaveBeenCalledTimes(1);
    await service.modelsForAgent(a.id,true);expect(adapter.listModels).toHaveBeenCalledTimes(2);
    const timestamp=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(timestamp+300001);
    try{await service.modelsForAgent(a.id);}finally{clock.mockRestore();}
    expect(adapter.listModels).toHaveBeenCalledTimes(3);
    service.store.put('agents',b.id,{...b,worktree:'C:/different-worktree'});
    await service.modelsForAgent(b.id);expect(vi.mocked(adapter.listModels).mock.calls.at(-1)?.[0]).toBe('C:/different-worktree');
    other.listModels=vi.fn(async()=>({...catalog('claude-native'),runtime:'claude' as const}));
    const nativeClaude=service.connectionManager.ensureNative('claude');
    await service.updateAgent(a.id,{runtime:'claude',connectionId:nativeClaude.id});
    expect((await service.modelsForAgent(a.id)).models[0].id).toBe('claude-native');expect(other.listModels).toHaveBeenCalledTimes(1);
  });
  it('labels stale results after a failed refresh and permits recovery without exposing credentials',async()=>{
    const {service,adapter,makeAgent}=await setup();const agent=await makeAgent('A');adapter.listModels=vi.fn(async()=>catalog());
    const first=await service.modelsForAgent(agent.id);
    adapter.listModels=vi.fn(async()=>{throw new Error('connection refused '+JSON.stringify({api_key:'private-fixture-value'}));});
    const stale=await service.modelsForAgent(agent.id,true);
    expect(stale).toMatchObject({status:'unavailable',stale:true,checkedAt:first.checkedAt,models:first.models});
    expect(stale.detail).toMatch(/\[redacted\]/i);expect(JSON.stringify(stale)).not.toContain('private-fixture-value');
    expect(await service.modelsForAgent(agent.id)).toEqual(stale);expect(adapter.listModels).toHaveBeenCalledTimes(1);
    adapter.listModels=vi.fn(async()=>catalog('refreshed-model'));
    expect(await service.modelsForAgent(agent.id,true)).toMatchObject({status:'ready',models:[{id:'refreshed-model'}]});
  });
  it('returns explicit unavailable metadata without inventing models and rejects nonexistent agents',async()=>{
    const {service,adapter,makeAgent}=await setup();const agent=await makeAgent('A');
    expect(await service.modelsForAgent(agent.id)).toMatchObject({status:'unavailable',stale:false,models:[]});
    adapter.listModels=async()=>({...catalog(),status:'unavailable',detail:'native catalog unsupported'});
    expect(await service.modelsForAgent(agent.id,true)).toMatchObject({status:'unavailable',models:[],detail:'native catalog unsupported'});
    await expect(service.modelsForAgent('nonexistent')).rejects.toThrow('成员不存在');
  });
  it('whitelists public metadata even if an adapter includes extra provider fields',async()=>{
    const {service,adapter,makeAgent}=await setup();const agent=await makeAgent('A');
    adapter.listModels=async()=>({...catalog(),account:{apiKey:'private-fixture-value'},models:[{id:'native',name:'Native',apiKey:'private-fixture-value'}]});
    const result=await service.modelsForAgent(agent.id);expect(result.models).toEqual([{id:'native',name:'Native'}]);expect(JSON.stringify(result)).not.toContain('private-fixture-value');
  });
  it('provides an agent-scoped API and protects model probing with the existing origin perimeter',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-models-api-')),adapter=new FakeAdapter();adapter.listModels=vi.fn(async()=>catalog());
    const app=await buildApp({dataDir:dir,tasks:new FakeTasks(),git:new FakeGit(),adapters:[adapter],staticRoot:false});
    cleanups.push(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
    const project=await app.workbench.createProject({name:'P',path:'C:/actual-project'}),agent=await app.workbench.createAgent({name:'A',role:'developer',projectId:project.id,runtime:'codex'});
    const url=`/api/agents/${agent.id}/models`;
    expect((await app.inject({method:'GET',url,headers:{host:'attacker.example'}})).statusCode).toBe(403);
    expect((await app.inject({method:'GET',url,headers:{origin:'https://attacker.example'}})).statusCode).toBe(403);
    expect(adapter.listModels).not.toHaveBeenCalled();
    expect((await app.inject({method:'GET',url:`${url}?cwd=C:/untrusted&runtime=claude`})).json()).toMatchObject({runtime:'codex',status:'ready'});
    expect(adapter.listModels).toHaveBeenCalledTimes(1);expect(vi.mocked(adapter.listModels).mock.calls[0]?.[0]).toBe(project.path);expect(vi.mocked(adapter.listModels).mock.calls[0]?.[1]?.connectionId).toBe(agent.connectionId);
    await app.inject({method:'GET',url});expect(adapter.listModels).toHaveBeenCalledTimes(1);
    await app.inject({method:'GET',url:`${url}?refresh=1`});expect(adapter.listModels).toHaveBeenCalledTimes(2);
    expect((await app.inject({method:'GET',url:'/api/agents/missing/models'})).statusCode).toBe(404);
  });
});

describe('HTTP perimeter',()=>{
  it('requires CSRF token and refuses non-loopback host and origin',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-api-'));const app=await buildApp({dataDir:dir,tasks:new FakeTasks(),git:new FakeGit(),adapters:[new FakeAdapter()],staticRoot:false,token:'fixed-test-token'});
    cleanups.push(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
    expect((await app.inject({method:'GET',url:'/api/health'})).statusCode).toBe(200);
    expect((await app.inject({method:'GET',url:'/api/bootstrap',headers:{host:'attacker.example'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/projects',payload:{name:'P',path:'C:/test'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/projects',headers:{'x-workbench-token':'fixed-test-token',origin:'https://attacker.example'},payload:{name:'P',path:'C:/test'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/projects',headers:{'x-workbench-token':'fixed-test-token'},payload:{name:'P',path:'C:/test'}})).statusCode).toBe(201);
  });
  it('replays SSE events after a cursor, delivers live events, and closes open streams on shutdown',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'workbench-sse-'));const app=await buildApp({dataDir:dir,tasks:new FakeTasks(),git:new FakeGit(),adapters:[new FakeAdapter()],staticRoot:false});
    cleanups.push(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
    const address=await app.listen({host:'127.0.0.1',port:0});const first=app.workbench.event('fixture.first');app.workbench.event('fixture.second');
    const abort=new AbortController();const response=await fetch(`${address}/api/events?after=${first.id}`,{signal:abort.signal});
    const reader=response.body!.getReader();const replay=new TextDecoder().decode((await reader.read()).value);
    expect(replay).toContain('fixture.second');expect(replay).not.toContain('fixture.first');
    await new Promise(resolve=>setTimeout(resolve,50));app.workbench.event('fixture.live');
    const live=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>{abort.abort();reject(new Error('No live SSE event'));},2000);timer.unref();})]);
    expect(new TextDecoder().decode(live.value)).toContain('fixture.live');
    await app.close();const end=await reader.read();expect(end.done).toBe(true);
  });
});
