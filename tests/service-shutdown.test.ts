import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Agent, Project, RuntimeAdapter, RuntimeEvent, RuntimeOptions, TaskBinding, TokenUsageRecord } from '../src/shared/types.js';
import type { GitRepository, TaskRepository } from '../src/server/repositories.js';
import { WorkbenchService } from '../src/server/service.js';
import type { QueuedMessage, RunRecord } from '../src/server/store.js';
import { nativeFinalizationPending } from '../scripts/validation-finalization.js';

function gate() {let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
type Session={options:RuntimeOptions;emit:(event:RuntimeEvent)=>void;sent:{text:string;messageId:string}[];nativeSessionId:string;closed:number};
class Transport implements RuntimeAdapter {
  kind='codex' as const;
  connectGate?:Promise<void>;pid?:number;
  sessions=new Map<string,Session>();
  onClose:(session:Session)=>Promise<void>=async()=>{};
  async discover(){return {kind:this.kind,available:true,detail:'controlled transport; no model call',capabilities:{interrupt:true,approvals:true,resume:true,steer:false}};}
  async connect(options:RuntimeOptions,emit:(event:RuntimeEvent)=>void) {
    const session:Session={options,emit,sent:[],nativeSessionId:randomUUID(),closed:0};
    this.sessions.set(options.agentId,session);await this.connectGate;
    return {nativeSessionId:session.nativeSessionId,pid:this.pid,
      send:async(text:string,messageId:string)=>{session.sent.push({text,messageId});},
      interrupt:async()=>{},respondApproval:async()=>{},
      close:async()=>{session.closed++;await this.onClose(session);}};
  }
}
class Git implements GitRepository {
  inspectGate?:Promise<void>;
  async validate(path:string){return path;}
  async createWorktree():Promise<TaskBinding>{throw new Error('Not part of shutdown test');}
  async inspect(){await this.inspectGate;return {commit:'a'.repeat(40),dirty:false,diff:''};}
  async resolveCommit(_project:Project,ref:string){return ref;}
}
const tasks={list:async()=>[],get:async()=>{throw new Error('No task read expected');},validate:async()=>{},create:async()=>{throw new Error('No task creation expected');},update:async()=>{throw new Error('No task update expected');}} as TaskRepository;
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup() {
  const directory=mkdtempSync(join(tmpdir(),'awb-shutdown-')),transport=new Transport(),git=new Git();
  const service=new WorkbenchService({dataDir:directory,adapters:[transport],tasks,git});
  cleanup.push(async()=>{await service.close();if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe fixture cleanup');rmSync(directory,{recursive:true,force:true,maxRetries:3});});
  const project:Project={id:randomUUID(),name:'Shutdown fixture',kind:'code',path:directory,createdAt:new Date().toISOString()};
  service.store.put('projects',project.id,project);
  const lead=await service.createAgent({projectId:project.id,name:'Lead',role:'controller',memberKind:'controller',runtime:'codex'});
  const worker=await service.createAgent({projectId:project.id,name:'Worker',role:'worker',runtime:'codex'});
  service.store.put('agents',worker.id,{...worker,worktree:directory});
  const start=async(id=worker.id)=>{
    const receipt=await service.message(id,{text:'Bounded synthetic task'},randomUUID()) as {messageId:string};
    await vi.waitFor(()=>expect(transport.sessions.get(id)?.sent).toHaveLength(1));
    return {...receipt,session:transport.sessions.get(id)!};
  };
  const read=<T>(collection:string,id?:string):T=>{
    const db=new DatabaseSync(join(directory,'workbench.sqlite'),{readOnly:true});
    try {
      if(id){const row=db.prepare('SELECT json FROM entities WHERE collection=? AND id=?').get(collection,id) as {json:string}|undefined;return (row?JSON.parse(row.json):undefined) as T;}
      return (db.prepare('SELECT json FROM entities WHERE collection=?').all(collection) as {json:string}[]).map(row=>JSON.parse(row.json)) as T;
    }finally{db.close();}
  };
  return {directory,service,transport,git,project,lead,worker,start,read};
}

describe('service shutdown preserves receipts without starting more work',()=>{
  it('keeps real final usage/result arriving during close, cancels the queue, and rejects new HTTP/MCP service operations',async()=>{
    const f=await setup(),first=await f.start(),closing=gate();
    f.transport.onClose=async()=>{await closing.promise;};
    const queued=await f.service.message(f.worker.id,{text:'Queued instruction',mode:'queue'},'queued') as {messageId:string};
    const advance=vi.spyOn(f.service.workflows,'advance');
    const close=f.service.close();expect(f.service.close()).toBe(close);
    await expect(f.service.message(f.worker.id,{text:'During shutdown'},'forbidden')).rejects.toThrow('关闭');
    await expect(f.service.createTask({projectId:f.project.id,title:'During shutdown'})).rejects.toThrow('关闭');
    await expect(f.service.controllerTool(f.lead.id,'propose_plan',{})).rejects.toThrow('关闭');
    await expect(f.service.memberTool(f.worker.id,'register_candidate',{})).rejects.toThrow('关闭');
    first.session.emit({type:'usage',messageId:first.messageId,nativeSessionId:first.session.nativeSessionId,data:{scope:'turn',source:'controlled.usage',inputTokens:7,outputTokens:3}});
    first.session.emit({type:'result',messageId:first.messageId,text:'Native result received',data:{status:'completed'}});
    await vi.waitFor(()=>expect(f.service.store.get<RunRecord>('runs',f.worker.id)?.state).toBe('terminal'));
    // A repeated late provider receipt replaces the same turn counters; it must
    // not create a second usage row or charge the same seven/three tokens twice.
    first.session.emit({type:'usage',messageId:first.messageId,nativeSessionId:first.session.nativeSessionId,data:{scope:'turn',source:'controlled.usage',inputTokens:7,outputTokens:3}});
    closing.release();await close;
    expect(first.session.closed).toBe(1);expect(first.session.sent).toHaveLength(1);expect(advance).not.toHaveBeenCalled();
    expect(f.read<Agent>('agents',f.worker.id).state).toBe('idle');
    expect(f.read<QueuedMessage>('messages',first.messageId).state).toBe('completed');
    expect(f.read<QueuedMessage>('messages',queued.messageId).state).toBe('cancelled');
    expect(f.read<QueuedMessage[]>('messages').filter(message=>message.agentId===f.lead.id)).toHaveLength(0);
    const usage=f.read<TokenUsageRecord[]>('usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({agentId:f.worker.id,messageId:first.messageId,nativeSessionId:first.session.nativeSessionId,source:'controlled.usage'});
    expect(usage[0]!.counts).toEqual({inputTokens:7,outputTokens:3});
  });

  it('does not downgrade a confirmed terminal result while asynchronous Git indexing is finishing',async()=>{
    const f=await setup(),indexing=gate();f.git.inspectGate=indexing.promise;
    const binding:TaskBinding={projectId:f.project.id,taskId:'existing-task',agentId:f.worker.id,worktree:f.directory,branch:'fixture',startCommit:'a'.repeat(40)};
    f.service.store.put('bindings',`${f.project.id}:${binding.taskId}`,binding);
    f.service.store.put('agents',f.worker.id,{...f.service.getAgent(f.worker.id),currentTaskId:binding.taskId});
    const first=await f.start();
    first.session.emit({type:'result',messageId:first.messageId,text:'Done',data:{status:'completed'}});
    expect(f.service.store.get<RunRecord>('runs',f.worker.id)?.state).toBe('terminal');
    expect(nativeFinalizationPending(f.service.store,[f.worker.id])).toBe(true);
    const close=f.service.close();let closed=false;void close.then(()=>{closed=true;});
    await Promise.resolve();expect(closed).toBe(false);
    indexing.release();await close;
    expect(f.read<Agent>('agents',f.worker.id).state).toBe('idle');
    expect(f.read<RunRecord>('runs',f.worker.id).state).toBe('terminal');
    expect(f.read<QueuedMessage[]>('messages').filter(message=>message.agentId===f.lead.id)).toHaveLength(0);
  });

  it('closes a connection that finishes startup after shutdown without ever sending its cancelled message',async()=>{
    const f=await setup(),connecting=gate();f.transport.connectGate=connecting.promise;
    f.transport.onClose=async(session)=>{session.emit({type:'state',state:'stopped'});};
    const receipt=await f.service.message(f.worker.id,{text:'Must never be submitted'},'connect-race') as {messageId:string};
    await vi.waitFor(()=>expect(f.transport.sessions.has(f.worker.id)).toBe(true));
    const close=f.service.close();connecting.release();await close;
    const session=f.transport.sessions.get(f.worker.id)!;
    expect(session.sent).toHaveLength(0);expect(session.closed).toBe(1);
    expect(f.read<QueuedMessage>('messages',receipt.messageId).state).toBe('cancelled');
    expect(f.read<RunRecord>('runs',f.worker.id)).toMatchObject({state:'terminal',nativeSessionId:session.nativeSessionId});
    expect(f.read<Agent>('agents',f.worker.id).state).toBe('stopped');
  });

  it('preserves unknown if a late startup connection cannot confirm closure',async()=>{
    const f=await setup(),connecting=gate();f.transport.connectGate=connecting.promise;
    f.transport.onClose=async()=>{throw new Error('Stop acknowledgement unavailable');};
    const receipt=await f.service.message(f.worker.id,{text:'Unsent'},'connect-stop-failure') as {messageId:string};
    await vi.waitFor(()=>expect(f.transport.sessions.has(f.worker.id)).toBe(true));
    const close=f.service.close();connecting.release();await close;
    expect(f.transport.sessions.get(f.worker.id)!.sent).toHaveLength(0);
    expect(f.read<RunRecord>('runs',f.worker.id).state).toBe('unknown');
    expect(f.read<Agent>('agents',f.worker.id).state).toBe('unknown');
    expect(f.read<QueuedMessage>('messages',receipt.messageId).state).toBe('cancelled');
  });

  it('records confirmed forced stop as interruption rather than successful execution',async()=>{
    const f=await setup(),first=await f.start();
    f.transport.onClose=async(session)=>{session.emit({type:'result',messageId:first.messageId,data:{interrupted:true}});session.emit({type:'state',state:'stopped'});};
    await f.service.close();
    expect(f.read<RunRecord>('runs',f.worker.id).state).toBe('terminal');
    expect(f.read<Agent>('agents',f.worker.id).state).toBe('stopped');
    expect(f.read<{title:string}[]>('artifacts')).toEqual(expect.arrayContaining([expect.objectContaining({title:'中断回执'})]));
    expect(f.read<{title:string}[]>('artifacts').some(row=>row.title==='执行结果')).toBe(false);
  });

  it('keeps absent receipts unknown even after an actual owned process exits, and restart never redispatches them',async()=>{
    const f=await setup();
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'pipe',windowsHide:true});
    await once(child,'spawn');f.transport.pid=child.pid;
    cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
    const first=await f.start();
    f.transport.onClose=async()=>{const exited=once(child,'exit');child.kill();await exited;};
    await f.service.close();
    expect(f.read<RunRecord>('runs',f.worker.id).state).toBe('unknown');
    expect(f.read<QueuedMessage>('messages',first.messageId).state).toBe('uncertain');
    expect(f.read<Agent>('agents',f.worker.id).state).toBe('unknown');
    const nextTransport=new Transport(),restarted=new WorkbenchService({dataDir:f.directory,adapters:[nextTransport],tasks,git:f.git});
    try {
      expect(restarted.getAgent(f.worker.id).state).toBe('unknown');
      await expect(restarted.message(f.worker.id,{text:'Do not retry'},'new-key')).rejects.toThrow('未知');
      expect(nextTransport.sessions.size).toBe(0);
      await restarted.recover(f.worker.id);
      expect(restarted.getAgent(f.worker.id).state).toBe('stopped');
      expect(restarted.store.get<QueuedMessage>('messages',first.messageId)?.state).toBe('uncertain');
      expect(nextTransport.sessions.size).toBe(0);
    }finally{await restarted.close();}
  });

  it('does not accept an idle gap before a queued controller completion notice or an unindexed terminal event',async()=>{
    const f=await setup(),first=await f.start(f.lead.id);
    const queued=await f.service.message(f.lead.id,{text:'Completion notice',mode:'queue'},'next') as {messageId:string};
    expect(nativeFinalizationPending(f.service.store,[f.lead.id])).toBe(true);
    // Model receipt persistence alone is earlier than service finalization.
    f.service.store.put('messages',first.messageId,{...f.service.store.get<QueuedMessage>('messages',first.messageId),state:'completed'});
    f.service.store.put('runs',f.lead.id,{...f.service.store.get<RunRecord>('runs',f.lead.id),state:'terminal'});
    f.service.store.put('messages',queued.messageId,{...f.service.store.get<QueuedMessage>('messages',queued.messageId),state:'cancelled'});
    expect(nativeFinalizationPending(f.service.store,[f.lead.id])).toBe(true);
    f.service.event('agent.turn_completed',f.lead.id,undefined,{messageId:first.messageId});
    expect(nativeFinalizationPending(f.service.store,[f.lead.id])).toBe(false);
    const historicalId=randomUUID();
    f.service.store.put('messages',historicalId,{id:historicalId,agentId:f.lead.id,text:'Old missing receipt',source:'human',state:'uncertain',createdAt:new Date(0).toISOString()});
    expect(nativeFinalizationPending(f.service.store,[f.lead.id])).toBe(false);
    expect(f.service.store.get<QueuedMessage>('messages',historicalId)?.state).toBe('uncertain');
  });
});
