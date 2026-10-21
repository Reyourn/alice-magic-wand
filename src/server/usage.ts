import type { Agent, RuntimeKind, RuntimeTokenUsage, Task, TokenCounts, TokenUsageRecord, TokenUsageSummary } from '../shared/types.js';
import { Store, type QueuedMessage, type RunRecord } from './store.js';

export const tokenCountKeys=['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheCreationInputTokens','reasoningOutputTokens'] as const;
const rawCountKeys=new Set<string>([...tokenCountKeys,'input_tokens','output_tokens','total_tokens','cache_read_input_tokens','cache_creation_input_tokens','cached_tokens','reasoning_tokens','inputTokenCount','outputTokenCount','totalTokenCount','cachedInputTokenCount','reasoningOutputTokenCount']);
export function isTokenCount(key:string,value:unknown):boolean {return rawCountKeys.has(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0;}
function countsOf(value:Record<string,unknown>):TokenCounts {const result:TokenCounts={};for(const key of tokenCountKeys)if(isTokenCount(key,value[key]))result[key]=value[key] as number;return result;}
function add(a:TokenCounts,b:TokenCounts):TokenCounts {const result={...a};for(const key of tokenCountKeys)if(b[key]!==undefined)result[key]=(a[key]??0)+b[key]!;return result;}
function hasCounts(counts:TokenCounts):boolean {return tokenCountKeys.some(key=>counts[key]!==undefined);}
export interface UsageContext {projectId:string;agentId:string;runtime:RuntimeKind;nativeSessionId?:string;messageId?:string;taskId?:string;model?:string;provider?:string;configuredModel?:string;connectionId?:string;connectionRevision?:number;workflowId?:string;roundId?:string;startedAt?:string;}
interface Checkpoint {counts:TokenCounts;unattributedTurns:string[];lastStartedAt?:string;partial:boolean;}

/** Stores raw session checkpoints independently from attributed turn records. No provider counter is treated as a delta. */
export class UsageLedger {
  constructor(private readonly store:Store) {}
  records():TokenUsageRecord[]{return this.store.all<TokenUsageRecord>('usage');}
  record(context:UsageContext,input:Record<string,unknown>):TokenUsageRecord[] {
    if(!['turn','session'].includes(String(input.scope))||typeof input.source!=='string'||!input.source.trim())return [];
    const usage=input as unknown as RuntimeTokenUsage;
    const counts=countsOf(input);if(!hasCounts(counts))return [];
    if(usage.scope==='turn'&&!context.messageId||usage.scope==='session'&&!context.nativeSessionId)return [];
    const updatedAt=new Date().toISOString();const changed:TokenUsageRecord[]=[];
    const turnId=context.messageId?`turn:${context.agentId}:${context.messageId}`:undefined;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if(usage.scope==='turn') {
        const previous=this.store.get<TokenUsageRecord>('usage',turnId!);
        const record:TokenUsageRecord={...context,model:context.model??previous?.model,provider:context.provider??previous?.provider,configuredModel:context.configuredModel??previous?.configuredModel,id:turnId!,scope:'turn',source:usage.source,counts:{...previous?.counts,...counts},partial:usage.partial===true||previous?.partial===true,updatedAt};
        this.store.put('usage',record.id,record);this.store.put('usage_origins',record.id,{scope:'turn'});changed.push(record);
      } else {
        const checkpointId=`${context.agentId}:${context.nativeSessionId}:${usage.source}`;
        const previous=this.store.get<Checkpoint>('usage_checkpoints',checkpointId);
        const checkpoint:Checkpoint=previous?{...previous,counts:{...previous.counts},unattributedTurns:[...previous.unattributedTurns]}:{counts:{},unattributedTurns:[],partial:usage.partial===true};
        const delta:TokenCounts={};let unassigned=false,regressed=false;
        const late=!!(context.startedAt&&checkpoint.lastStartedAt&&context.startedAt<checkpoint.lastStartedAt);
        for(const key of tokenCountKeys) {
          const next=counts[key];if(next===undefined)continue;
          const baseline=previous?.counts[key];
          if(baseline!==undefined&&next<baseline){regressed=true;continue;}
          checkpoint.counts[key]=next;
          if(context.messageId&&!late&&(baseline!==undefined||!previous&&usage.baselineKnownZero===true))delta[key]=next-(baseline??0);
          else if(baseline===undefined?next>0:next>baseline)unassigned=true;
        }
        if(context.messageId&&unassigned&&!checkpoint.unattributedTurns.includes(context.messageId))checkpoint.unattributedTurns.push(context.messageId);
        checkpoint.partial ||= usage.partial===true||regressed||unassigned;
        if(context.startedAt&&!late)checkpoint.lastStartedAt=context.startedAt;
        this.store.put('usage_checkpoints',checkpointId,checkpoint);
        const sessionId=`session:${checkpointId}`;
        const previousSession=this.store.get<TokenUsageRecord>('usage',sessionId);
        const session:TokenUsageRecord={projectId:context.projectId,agentId:context.agentId,runtime:context.runtime,nativeSessionId:context.nativeSessionId,model:context.model??previousSession?.model,provider:context.provider??previousSession?.provider,configuredModel:context.configuredModel??previousSession?.configuredModel,connectionId:context.connectionId,connectionRevision:context.connectionRevision,workflowId:context.workflowId,id:sessionId,scope:'session',source:usage.source,counts:checkpoint.counts,partial:checkpoint.partial,updatedAt};
        this.store.put('usage',sessionId,session);changed.push(session);
        if(turnId&&(hasCounts(delta)||regressed)) {
          const previousTurn=this.store.get<TokenUsageRecord>('usage',turnId);
          const origin=this.store.get<{scope:string}>('usage_origins',turnId);
          if(origin?.scope!=='turn') {
            const contributionId=`${turnId}:${usage.source}`;
            const previousContribution=this.store.get<{counts:TokenCounts}>('usage_turn_sources',contributionId);
            this.store.put('usage_turn_sources',contributionId,{turnId,counts:add(previousContribution?.counts??{},delta)});
            const observations=this.store.all<{turnId:string;counts:TokenCounts}>('usage_turn_sources').filter(item=>item.turnId===turnId);
            const combined:TokenCounts={};for(const key of tokenCountKeys){const values=observations.map(item=>item.counts[key]).filter((value):value is number=>value!==undefined);if(values.length)combined[key]=Math.max(...values);}
            const turn:TokenUsageRecord={...context,model:context.model??previousTurn?.model,provider:context.provider??previousTurn?.provider,configuredModel:context.configuredModel??previousTurn?.configuredModel,id:turnId,scope:'turn',source:usage.source,counts:combined,partial:previousTurn?.partial===true||usage.partial===true||regressed||late||checkpoint.unattributedTurns.includes(context.messageId!),updatedAt};
            this.store.put('usage',turnId,turn);this.store.put('usage_origins',turnId,{scope:'session'});changed.push(turn);
          }
        }
      }
      this.store.db.exec('COMMIT');return changed;
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  summaries(agents:Agent[],messages:QueuedMessage[],runs:RunRecord[],tasks:Task[]):TokenUsageSummary[] {
    const records=this.records();const turns=records.filter(record=>record.scope==='turn');const sessionRecords=records.filter(record=>record.scope==='session');
    const messagesById=new Map(messages.map(message=>[message.id,message]));
    const executedMessages=messages.filter(message=>!['queued','cancelled'].includes(message.state));
    const measuredById=new Map(runs.filter(run=>!['queued','cancelled'].includes(messagesById.get(run.messageId)?.state??'queued')).map(run=>[run.messageId,run]));
    // Older databases retained only the latest native run per agent. Count their executed messages
    // in coverage, while leaving the unknown session and all unknown token counts unassigned.
    for(const message of executedMessages)if(!measuredById.has(message.id))measuredById.set(message.id,{agentId:message.agentId,messageId:message.id,state:message.state==='uncertain'?'unknown':'terminal',startedAt:message.createdAt});
    const measuredRuns=[...measuredById.values()];
    const summaries:TokenUsageSummary[]=[];
    const metrics=(selected:TokenUsageRecord[],expected:RunRecord[],totals:TokenCounts,additionalPartial=false)=>{
      const reported=new Set(selected.filter(record=>record.messageId&&hasCounts(record.counts)).map(record=>record.messageId));
      const total=new Set([...expected.map(run=>run.messageId),...reported]).size;
      return {counts:totals,reportedTurns:reported.size,totalTurns:total,partial:additionalPartial||reported.size<total||selected.some(record=>record.partial||record.counts.totalTokens===undefined)||totals.totalTokens===undefined};
    };
    for(const agent of agents) {
      const agentTurns=turns.filter(record=>record.agentId===agent.id);
      const agentRuns=measuredRuns.filter(run=>run.agentId===agent.id);
      const sessionIds=new Set([...records.filter(record=>record.agentId===agent.id).map(record=>record.nativeSessionId),...agentRuns.map(run=>run.nativeSessionId)].filter((id):id is string=>!!id));
      let aggregate:TokenCounts={};let agentPartial=false;
      for(const nativeSessionId of sessionIds) {
        const selected=agentTurns.filter(record=>record.nativeSessionId===nativeSessionId);
        const snapshots=sessionRecords.filter(record=>record.agentId===agent.id&&record.nativeSessionId===nativeSessionId);
        const totals=selected.reduce((sum,record)=>add(sum,record.counts),{} as TokenCounts);
        // Session totals subsume their attributed turns. Multiple sources are alternate observations, never additive.
        for(const key of tokenCountKeys){const values=snapshots.map(record=>record.counts[key]).filter((value):value is number=>value!==undefined);if(values.length)totals[key]=Math.max(...values,totals[key]??0);}
        const detail=metrics(selected,agentRuns.filter(run=>run.nativeSessionId===nativeSessionId),totals,snapshots.some(record=>record.partial));
        summaries.push({scope:'session',projectId:agent.projectId,agentId:agent.id,nativeSessionId,...detail});aggregate=add(aggregate,totals);agentPartial ||= detail.partial;
      }
      aggregate=add(aggregate,agentTurns.filter(record=>!record.nativeSessionId).reduce((sum,record)=>add(sum,record.counts),{} as TokenCounts));
      summaries.push({scope:'agent',projectId:agent.projectId,agentId:agent.id,...metrics(agentTurns,agentRuns,aggregate,agentPartial)});
    }
    const taskKeys=new Map(tasks.map(task=>[`${task.projectId}:${task.id}`,{projectId:task.projectId,taskId:task.id}]));
    for(const message of executedMessages)if(message.taskId){const owner=agents.find(agent=>agent.id===message.agentId);if(owner)taskKeys.set(`${owner.projectId}:${message.taskId}`,{projectId:owner.projectId,taskId:message.taskId});}
    for(const record of turns)if(record.taskId)taskKeys.set(`${record.projectId}:${record.taskId}`,{projectId:record.projectId,taskId:record.taskId});
    for(const task of taskKeys.values()) {
      const selected=turns.filter(record=>record.projectId===task.projectId&&record.taskId===task.taskId);
      const expected=measuredRuns.filter(run=>{const message=messagesById.get(run.messageId);return message?.taskId===task.taskId&&agents.some(agent=>agent.id===run.agentId&&agent.projectId===task.projectId);});
      summaries.push({scope:'task',...task,...metrics(selected,expected,selected.reduce((sum,record)=>add(sum,record.counts),{} as TokenCounts))});
    }
    return summaries;
  }
}
