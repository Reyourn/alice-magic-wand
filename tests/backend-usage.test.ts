import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, Task } from '../src/shared/types.js';
import { Store, type QueuedMessage, type RunRecord } from '../src/server/store.js';
import { UsageLedger, type UsageContext } from '../src/server/usage.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(){const store=new Store(':memory:');cleanup.push(()=>store.close());return {store,ledger:new UsageLedger(store)};}
function context(messageId?:string,taskId?:string):UsageContext{return {agentId:'a',projectId:'p',runtime:'codex',nativeSessionId:'native',messageId,taskId,model:'reported-model',configuredModel:'configured-alias',startedAt:messageId==='m1'?'2026-01-01T00:00:01Z':'2026-01-01T00:00:02Z'};}
const agent:Agent={id:'a',projectId:'p',name:'A',role:'developer',runtime:'codex',model:'configured-alias',instructions:'',permissionMode:'workspace-write',controlMode:'auto',state:'idle',createdAt:'2026-01-01'};
const messages:QueuedMessage[]=['m1','m2'].map((id,index)=>({id,agentId:'a',taskId:`t${index+1}`,text:'test',source:'human',state:'completed',createdAt:`2026-01-01T00:00:0${index+1}Z`}));
const runs:RunRecord[]=messages.map(message=>({agentId:'a',messageId:message.id,nativeSessionId:'native',runtime:'codex',state:'terminal',startedAt:message.createdAt}));
const tasks:Task[]=['t1','t2'].map(id=>({id,projectId:'p',title:id,description:'',status:'in_progress',acceptance:'verify',dependencies:[]}));
const session=(counts:Record<string,unknown>,extra:Record<string,unknown>={})=>({scope:'session',source:'native.total',...counts,...extra});

describe('persistent token usage ledger',()=>{
  it('upserts per-turn snapshots without adding repeated reports or filling missing counters with zero',()=>{
    const {ledger}=setup();
    ledger.record(context('m1','t1'),{scope:'turn',source:'provider.result',inputTokens:10,outputTokens:4,totalTokens:14});
    ledger.record(context('m1','t1'),{scope:'turn',source:'provider.result',inputTokens:15,totalTokens:19});
    ledger.record(context('m1','t1'),{scope:'turn',source:'provider.result',inputTokens:15,totalTokens:19});
    const record=ledger.records()[0];expect(ledger.records()).toHaveLength(1);
    expect(record.counts).toEqual({inputTokens:15,outputTokens:4,totalTokens:19});expect(record.counts.cachedInputTokens).toBeUndefined();
    expect(record.model).toBe('reported-model');expect(record.configuredModel).toBe('configured-alias');
  });
  it('differences session snapshots per turn while aggregate summaries avoid counting both levels',()=>{
    const {ledger}=setup();
    ledger.record(context('m1','t1'),session({inputTokens:100,outputTokens:20,totalTokens:120},{baselineKnownZero:true}));
    ledger.record(context('m1','t1'),session({inputTokens:120,outputTokens:30,totalTokens:150},{baselineKnownZero:true}));
    ledger.record(context('m2','t2'),session({inputTokens:180,outputTokens:45,totalTokens:225},{baselineKnownZero:true}));
    ledger.record(context('m2','t2'),session({inputTokens:180,outputTokens:45,totalTokens:225},{baselineKnownZero:true}));
    const records=ledger.records().filter(record=>record.scope==='turn');
    expect(records.find(record=>record.messageId==='m1')?.counts.totalTokens).toBe(150);
    expect(records.find(record=>record.messageId==='m2')?.counts).toEqual({inputTokens:60,outputTokens:15,totalTokens:75});
    const summaries=ledger.summaries([agent],messages,runs,tasks);
    expect(summaries.find(summary=>summary.scope==='agent')).toMatchObject({counts:{totalTokens:225},reportedTurns:2,totalTurns:2,partial:false});
    expect(summaries.find(summary=>summary.scope==='session')?.counts.totalTokens).toBe(225);
    expect(summaries.find(summary=>summary.taskId==='t2')?.counts.totalTokens).toBe(75);
  });
  it('keeps checkpoints across restart and ignores the duplicate historical resume baseline',()=>{
    const directory=mkdtempSync(join(tmpdir(),'workbench-usage-'));let store=new Store(join(directory,'usage.sqlite'));let ledger=new UsageLedger(store);
    cleanup.push(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
    ledger.record(context('m1','t1'),session({totalTokens:100},{baselineKnownZero:true}));store.close();
    store=new Store(join(directory,'usage.sqlite'));ledger=new UsageLedger(store);
    ledger.record(context(),session({totalTokens:100}));
    ledger.record(context('m2','t2'),session({totalTokens:160}));
    expect(ledger.records().find(record=>record.messageId==='m2')?.counts.totalTokens).toBe(60);
    expect(ledger.summaries([agent],messages,runs,tasks).find(summary=>summary.scope==='agent')).toMatchObject({counts:{totalTokens:160},partial:false});
  });
  it('keeps unknown resumed history session-only instead of charging it to the current task',()=>{
    const {ledger}=setup();ledger.record(context('m1','t1'),session({totalTokens:1000}));
    expect(ledger.records().filter(record=>record.scope==='turn')).toEqual([]);
    let summaries=ledger.summaries([agent],messages.slice(0,1),runs.slice(0,1),tasks);
    expect(summaries.find(summary=>summary.scope==='agent')).toMatchObject({counts:{totalTokens:1000},reportedTurns:0,totalTurns:1,partial:true});
    expect(summaries.find(summary=>summary.taskId==='t1')?.counts.totalTokens).toBeUndefined();
    ledger.record(context('m1','t1'),session({totalTokens:1200}));ledger.record(context('m2','t2'),session({totalTokens:1500}));
    summaries=ledger.summaries([agent],messages,runs,tasks);
    expect(summaries.find(summary=>summary.taskId==='t1')).toMatchObject({counts:{totalTokens:200},partial:true});
    expect(summaries.find(summary=>summary.taskId==='t2')).toMatchObject({counts:{totalTokens:300},partial:false});
    expect(summaries.find(summary=>summary.scope==='agent')?.counts.totalTokens).toBe(1500);
  });
  it('does not regress counters or manufacture a negative delta after a reset/out-of-order frame',()=>{
    const {ledger}=setup();ledger.record(context('m1','t1'),session({totalTokens:100},{baselineKnownZero:true}));
    ledger.record(context('m2','t2'),session({totalTokens:80}));ledger.record(context('m2','t2'),session({totalTokens:130}));
    expect(ledger.records().find(record=>record.messageId==='m2')).toMatchObject({counts:{totalTokens:30},partial:true});
    expect(ledger.records().find(record=>record.scope==='session')).toMatchObject({counts:{totalTokens:130},partial:true});
  });
  it('treats alternate session sources as observations, not additive consumption',()=>{
    const {ledger}=setup();ledger.record(context('m1','t1'),session({totalTokens:100},{baselineKnownZero:true}));
    ledger.record(context('m1','t1'),session({totalTokens:100},{source:'other.total',baselineKnownZero:true}));
    expect(ledger.records().find(record=>record.scope==='turn')?.counts.totalTokens).toBe(100);
    expect(ledger.summaries([agent],messages.slice(0,1),runs.slice(0,1),tasks).find(summary=>summary.scope==='agent')?.counts.totalTokens).toBe(100);
  });
  it('rejects invalid counts and exposes missing-report coverage without fake zero totals',()=>{
    const {ledger}=setup();ledger.record(context('m1','t1'),{scope:'turn',source:'provider',inputTokens:-1,outputTokens:Infinity,totalTokens:'token-secret'});
    expect(ledger.records()).toEqual([]);
    ledger.record(context('m1','t1'),{scope:'turn',source:'provider',outputTokens:5});
    const summary=ledger.summaries([agent],messages,runs,tasks).find(item=>item.scope==='agent')!;
    expect(summary.counts).toEqual({outputTokens:5});expect(summary).toMatchObject({reportedTurns:1,totalTurns:2,partial:true});
  });
  it('includes legacy executed messages missing run history in agent and task coverage without inventing sessions',()=>{
    const {ledger}=setup();ledger.record(context('m2','t2'),{scope:'turn',source:'provider',totalTokens:50});
    const legacy=[...messages,...Array.from({length:18},(_,index)=>({...messages[0],id:`legacy-${index}`}))];
    const summaries=ledger.summaries([agent],legacy,runs.slice(1),tasks);
    expect(summaries.find(summary=>summary.scope==='agent')).toMatchObject({counts:{totalTokens:50},reportedTurns:1,totalTurns:20,partial:true});
    expect(summaries.find(summary=>summary.taskId==='t1')).toMatchObject({counts:{},reportedTurns:0,totalTurns:19,partial:true});
    expect(summaries.find(summary=>summary.scope==='session')).toMatchObject({reportedTurns:1,totalTurns:1});
  });
});
