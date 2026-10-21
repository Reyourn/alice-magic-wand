import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Project, RuntimeAdapter, RuntimeEvent, RuntimeOptions, Task, TaskBinding, WorkflowNode } from '../src/shared/types.js';
import type { GitRepository, TaskCreateInput, TaskRepository } from '../src/server/repositories.js';
import { buildApp } from '../src/server/index.js';
import type { RunRecord } from '../src/server/store.js';

class Tasks implements TaskRepository {
  rows=new Map<string,Task>();async validate(){}
  async list(project:Project){return [...this.rows.values()].filter(task=>task.projectId===project.id);}
  async get(project:Project,id:string){const task=this.rows.get(id);if(!task||task.projectId!==project.id)throw new Error('Missing task');return task;}
  async create(project:Project,input:TaskCreateInput){const task:Task={id:input.id??randomUUID(),projectId:project.id,title:input.title,description:input.description??'',acceptance:input.acceptance??'',dependencies:input.dependencies??[],status:'open'};this.rows.set(task.id,task);return task;}
  async update(project:Project,id:string,fields:{status?:string;owner?:string;reason?:string}){const task=await this.get(project,id);Object.assign(task,fields);return task;}
}
class Git implements GitRepository {
  async validate(path:string){return path;}async createWorktree():Promise<TaskBinding>{throw new Error('Office must use isolated file workspace');}
  async inspect(){return {commit:'a'.repeat(40),dirty:false,diff:''};}async resolveCommit(_project:Project,ref:string){return ref;}
}
class Transport implements RuntimeAdapter {
  kind='codex' as const;gate?:Promise<void>;acknowledge=true;failSend=false;closed=0;
  sessions=new Map<string,{options:RuntimeOptions;emit:(event:RuntimeEvent)=>void;sent:{text:string;messageId:string}[];nativeSessionId:string}>();
  async discover(){return {kind:this.kind,available:true,detail:'simulated native transport',capabilities:{interrupt:true,approvals:true,resume:true,steer:false}};}
  async connect(options:RuntimeOptions,emit:(event:RuntimeEvent)=>void){const session={options,emit,sent:[] as {text:string;messageId:string}[],nativeSessionId:randomUUID()};this.sessions.set(options.agentId,session);await this.gate;
    return {nativeSessionId:session.nativeSessionId,pid:undefined,send:async(text:string,messageId:string)=>{session.sent.push({text,messageId});if(this.failSend)throw new Error('Acknowledgement lost');},interrupt:async()=>{if(this.acknowledge)emit({type:'result',messageId:session.sent.at(-1)?.messageId,data:{interrupted:true}});},respondApproval:async()=>{},close:async()=>{this.closed++;}};
  }
}
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const clean of cleanup.splice(0).reverse())await clean();});
async function setup(){
  const directory=mkdtempSync(join(tmpdir(),'awb-service-workflow-')),transport=new Transport();
  const app=await buildApp({dataDir:directory,adapters:[transport],tasks:new Tasks(),git:new Git(),token:'test-browser',staticRoot:false,interruptTimeoutMs:25}),service=app.workbench;
  cleanup.push(async()=>{await app.close();if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe cleanup');rmSync(directory,{recursive:true,force:true,maxRetries:3});});
  // The profile protocol has its own tests; here we isolate real service and workflow scheduling.
  vi.spyOn(service.connectionManager,'assertReady').mockResolvedValue({} as never);
  const project:Project={id:randomUUID(),name:'Service fixture',kind:'office',path:directory,controlPath:directory,createdAt:new Date().toISOString()};service.store.put('projects',project.id,project);
  const worker=await service.createAgent({projectId:project.id,name:'Analyst',role:'analyst',runtime:'codex'});
  const node:WorkflowNode={id:'work',title:'Report',description:'Produce a report',acceptance:'Readable',kind:'task',agentId:worker.id,dependencies:[],inputs:[],requiredCapabilities:[],checks:[{id:'file',kind:'file',label:'Readable'}]};
  const workflow=service.workflows.createDraft({projectId:project.id,name:'Plan',goal:'Report',nodes:[node]});
  const start=async()=>{await service.workflows.confirm(workflow.id,1);await service.workflows.advance(workflow.id);await vi.waitFor(()=>expect(transport.sessions.has(worker.id)).toBe(true));return service.workflows.rounds(workflow.id)[0]!;};
  return {app,service,transport,project,worker,workflow,start};
}
describe('service workflow native lifecycle boundaries',()=>{
  it('releases a successful native turn with missing office outputs and preserves its receipt through same-session human correction',async()=>{
    const f=await setup(),original=await f.start();await vi.waitFor(()=>expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(1));
    const session=f.transport.sessions.get(f.worker.id)!,nativeSessionId=session.nativeSessionId;
    session.emit({type:'result',messageId:original.messageId,text:'Finished, but no report was written',data:{status:'completed'}});
    await vi.waitFor(()=>expect(f.service.workflows.rounds(f.workflow.id)[0]?.state).toBe('failed'));
    await vi.waitFor(()=>expect(f.service.inbox(f.project.id).some(item=>item.title==='执行结果尚未形成可验收成果')).toBe(true));
    const receipt=f.service.store.get('workflow_run_receipts',original.id);
    expect(receipt).toMatchObject({messageId:original.messageId,output:'Finished, but no report was written',failed:false,interrupted:false});
    expect(f.service.store.get<RunRecord>('runs',f.worker.id)?.state).toBe('terminal');
    expect(f.service.workflows.get(f.workflow.id).status).toBe('blocked');expect(f.service.workflows.bundles(f.workflow.id)).toHaveLength(0);
    await expect(f.service.workflows.accept(f.workflow.id,'work')).rejects.toThrow('不能验收');
    const correction=await f.service.message(f.worker.id,{text:'Write the missing report in the retained workspace'},'missing-report-correction') as {messageId:string};
    await vi.waitFor(()=>expect(session.sent).toHaveLength(2));
    const next=f.service.workflows.rounds(f.workflow.id).at(-1)!;
    expect(next).toMatchObject({sourceRoundId:original.id,messageId:correction.messageId,worktree:original.worktree,state:'running',automaticReworkCount:0});
    expect(f.service.getAgent(f.worker.id).nativeSessionId).toBe(nativeSessionId);expect(f.transport.closed).toBe(0);
    writeFileSync(join(next.worktree!,'outputs','report.txt'),'Checked report');
    session.emit({type:'result',messageId:correction.messageId,text:'Report written',data:{status:'completed'}});
    await vi.waitFor(()=>expect(f.service.workflows.bundles(f.workflow.id)).toHaveLength(1));
    const bundle=f.service.workflows.bundles(f.workflow.id)[0]!;
    expect(bundle.roundId).toBe(next.id);expect(bundle.files[0]?.name).toBe('report.txt');
    expect(f.service.store.get('workflow_run_receipts',original.id)).toEqual(receipt);
    await f.service.workflows.recordFileCheck(bundle.id,'file');await f.service.workflows.accept(f.workflow.id,'work');
    expect(f.service.workflows.get(f.workflow.id).status).toBe('completed');
  });
  it('refuses legacy status closure for a workflow task without exact round and bundle acceptance',async()=>{
    const f=await setup(),round=await f.start();
    await expect(f.service.setTaskStatus(round.taskId,{projectId:f.project.id,status:'closed'})).rejects.toThrow('验收');
    expect((await f.service.workflows.detail(f.workflow.id)).nodes[0]!.accepted).toBe(false);
  });
  it('rebuilds the native session when a bound skill file changes and retains the earlier run history',async()=>{
    const f=await setup(),path=join(f.project.path,'SKILL.md');writeFileSync(path,'Initial skill');const skill=f.service.capabilities.save({name:'Bound skill',kind:'skill',path});
    await f.service.updateAgent(f.worker.id,{capabilityIds:[skill.id]});const original=await f.start();await vi.waitFor(()=>expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(1));const before=f.transport.sessions.get(f.worker.id)!;
    writeFileSync(path,'Revised skill instructions');const reply=await f.service.message(f.worker.id,{text:'Use the revised skill'},'new-skill') as {messageId:string};
    await vi.waitFor(()=>expect(f.transport.sessions.get(f.worker.id)!.nativeSessionId).not.toBe(before.nativeSessionId));const after=f.transport.sessions.get(f.worker.id)!;
    await vi.waitFor(()=>expect(after.sent[0]?.messageId).toBe(reply.messageId));expect(f.transport.closed).toBe(1);expect(after.options.resumeSessionId).toBeUndefined();
    expect(f.service.store.get<RunRecord>('run_history',original.messageId!)).toMatchObject({state:'terminal',nativeSessionId:before.nativeSessionId,roundId:original.id});
    expect(f.service.workflows.rounds(f.workflow.id).at(-1)).toMatchObject({messageId:reply.messageId,sourceRoundId:original.id,worktree:original.worktree});
  });
  it('cancels an undelivered workflow turn while connecting and binds the human correction to a new same-session round',async()=>{
    const f=await setup();let release!:()=>void;f.transport.gate=new Promise<void>(resolve=>{release=resolve;});const original=await f.start();
    const corrected=await f.service.message(f.worker.id,{text:'Corrected goal'},'one-correction') as {messageId:string};const session=f.transport.sessions.get(f.worker.id)!;expect(session.sent).toHaveLength(0);
    release();await vi.waitFor(()=>expect(session.sent.map(item=>item.text)).toEqual(['Corrected goal']));
    const rounds=f.service.workflows.rounds(f.workflow.id),next=rounds.at(-1)!;expect(rounds).toHaveLength(2);expect(rounds[0]!.state).toBe('returned');expect(next).toMatchObject({sourceRoundId:original.id,messageId:corrected.messageId,state:'running',automaticReworkCount:0});expect(next.worktree).toBe(original.worktree);
    expect(f.service.store.get<RunRecord>('run_history',original.messageId!)!.state).toBe('terminal');expect(f.service.getAgent(f.worker.id).nativeSessionId).toBe(session.nativeSessionId);
    session.emit({type:'usage',messageId:corrected.messageId,nativeSessionId:session.nativeSessionId,data:{scope:'turn',source:'fixture',inputTokens:10,outputTokens:2,totalTokens:12}});
    expect(f.service.usage.records().find(record=>record.messageId===corrected.messageId)).toMatchObject({roundId:next.id,workflowId:f.workflow.id,taskId:next.taskId,counts:{totalTokens:12}});
  });
  it('keeps a timed-out writer unknown until its connection is closed, then starts a tracked correction without claiming prior success',async()=>{
    const f=await setup(),original=await f.start();await vi.waitFor(()=>expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(1));f.transport.acknowledge=false;
    await expect(f.service.message(f.worker.id,{text:'First correction'},'uncertain-correction')).rejects.toThrow('终止');
    expect(f.service.workflows.rounds(f.workflow.id)[0]!.state).toBe('unknown');expect(f.service.store.get('workflow_run_receipts',original.id)).toBeUndefined();
    await expect(f.service.message(f.worker.id,{text:'Duplicate writer'},'new-key')).rejects.toThrow('未知');await expect(f.service.workflows.startRound(f.workflow.id,'work')).rejects.toThrow();expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(1);
    await f.service.recover(f.worker.id);expect(f.transport.closed).toBe(1);expect(f.service.workflows.rounds(f.workflow.id)[0]!.state).toBe('failed');expect(f.service.store.get<{failed:boolean}>('workflow_run_receipts',original.id)!.failed).toBe(true);expect(f.service.workflows.bundles(f.workflow.id)).toHaveLength(0);
    f.transport.acknowledge=true;const correction=await f.service.message(f.worker.id,{text:'Continue after confirmed stop'},'safe-correction') as {messageId:string};await vi.waitFor(()=>expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(1));
    const next=f.service.workflows.rounds(f.workflow.id).at(-1)!;expect(next).toMatchObject({sourceRoundId:original.id,messageId:correction.messageId,state:'running'});expect(next.worktree).toBe(original.worktree);
  });
  it('requires the current message through the actual member HTTP token route and attributes late usage to its original round',async()=>{
    const f=await setup(),original=await f.start();await vi.waitFor(()=>expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(1));const session=f.transport.sessions.get(f.worker.id)!,token=session.options.mcpServers!.workbench!.env!.WORKBENCH_CONTROLLER_TOKEN!;
    const call=(name:string,args:Record<string,unknown>)=>f.app.inject({method:'POST',url:`/api/member/${f.worker.id}/tools`,headers:{host:'127.0.0.1',authorization:`Bearer ${token}`},payload:{name,arguments:args}});
    expect((await call('get_task_context',{})).json().messageId).toBe(original.messageId);
    const correction=await f.service.message(f.worker.id,{text:'Current correction'},'http-correction') as {messageId:string};await vi.waitFor(()=>expect(session.sent).toHaveLength(2));const next=f.service.workflows.rounds(f.workflow.id).at(-1)!;
    expect((await call('request_clarification',{messageId:original.messageId,idempotencyKey:'late',question:'Old question'})).statusCode).toBe(409);
    expect((await call('request_clarification',{messageId:correction.messageId,idempotencyKey:'current',question:'Current question'})).statusCode).toBe(200);
    expect((await call('propose_plan',{messageId:correction.messageId,idempotencyKey:'unauthorized'})).statusCode).toBe(403);
    const approve=await f.app.inject({method:'POST',url:`/api/workflows/${f.workflow.id}/confirm`,headers:{host:'127.0.0.1',authorization:`Bearer ${token}`},payload:{version:1}});expect(approve.statusCode).toBe(401);
    session.emit({type:'usage',messageId:original.messageId,nativeSessionId:session.nativeSessionId,data:{scope:'turn',source:'fixture',totalTokens:25}});session.emit({type:'usage',messageId:correction.messageId,nativeSessionId:session.nativeSessionId,data:{scope:'turn',source:'fixture',totalTokens:9}});
    expect(f.service.usage.records().find(record=>record.messageId===original.messageId)).toMatchObject({roundId:original.id,counts:{totalTokens:25}});expect(f.service.usage.records().find(record=>record.messageId===correction.messageId)).toMatchObject({roundId:next.id,counts:{totalTokens:9}});
  });
});
