/**
 * Explicit, bounded native shutdown acceptance; never part of `npm test`.
 * Uses an already-built immutable server, inherited native authentication,
 * real Git/Beads and one tiny read-only turn per runtime in fresh fixtures.
 * It does not log in, probe a replacement model, or retry a failed native call.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { buildApp as BuildApp } from '../src/server/index.js';
import type { Agent, RuntimeInfo, RuntimeKind, TokenUsageRecord, WorkbenchEvent } from '../src/shared/types.js';
import type { QueuedMessage, RunRecord } from '../src/server/store.js';
import { nativeFinalizationPending } from './validation-finalization.js';

const argument = (name:string) => process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const serverBuild = argument('server-build'), selected = argument('runtime');
if (selected && !['codex','workbuddy','claude'].includes(selected)) throw new Error('Unknown runtime');
if (!process.argv.includes('--confirm-usage') || !serverBuild) {
  console.log('No model request sent. Explicit authorized use:');
  console.log('node --import tsx scripts/validate-upgrade-terminal.ts --confirm-usage --server-build=<existing-build-directory> [--runtime=codex|workbuddy|claude]');
  process.exitCode=2;
} else await acceptance(resolve(serverBuild), selected as RuntimeKind|undefined);

type Persisted = {
  agent?:Agent; run?:RunRecord; messages:QueuedMessage[]; usage:TokenUsageRecord[];
  events:WorkbenchEvent[]; serviceOwnerPresent:boolean;
};
type NativeResult = {
  runtime:RuntimeKind; fixture:string; checkedAt:string; passed:boolean;
  runtimeInfo?:RuntimeInfo; agentId?:string; taskId?:string; messageId?:string; nonce?:string;
  closeTrigger?:string; pendingAtClose?:boolean; observedPids:number[]; aliveAfterClose:number[];
  failure?:string; cleanupErrors:string[]; checks:Record<string,boolean>;
  beforeCloseUsage?:TokenUsageRecord[]; afterClose?:Persisted;
  restart?:{agentState?:string; runState?:string; messageCount:number; usageCount:number; newEventTypes:string[]; nativeDispatchCount:number};
};
function progress(text:string):void {console.log(`${new Date().toISOString()} ${text}`);}
function digest(bytes:Buffer|string):string {return createHash('sha256').update(bytes).digest('hex');}
async function bounded<T>(promise:Promise<T>, ms:number, label:string):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  try {return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out; outcome not inferred`)),ms);})]);}
  finally {if(timer)clearTimeout(timer);}
}
function processAlive(pid:number):boolean {
  try {process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
function readPersisted(dataDir:string,agentId:string):Persisted {
  const db=new DatabaseSync(join(dataDir,'workbench.sqlite'),{readOnly:true});
  try {
    const rows=<T>(collection:string)=>(db.prepare('SELECT json FROM entities WHERE collection=? ORDER BY rowid').all(collection) as {json:string}[]).map(row=>JSON.parse(row.json) as T);
    return {
      agent:rows<Agent>('agents').find(row=>row.id===agentId),
      run:rows<RunRecord>('runs').find(row=>row.agentId===agentId),
      messages:rows<QueuedMessage>('messages').filter(row=>row.agentId===agentId),
      usage:rows<TokenUsageRecord>('usage').filter(row=>row.agentId===agentId),
      events:(db.prepare('SELECT id,json FROM events ORDER BY id').all() as {id:number;json:string}[]).map(row=>({...JSON.parse(row.json),id:row.id} as WorkbenchEvent)).filter(row=>row.agentId===agentId),
      serviceOwnerPresent:!!db.prepare("SELECT 1 FROM entities WHERE collection='service' AND id='owner'").get(),
    };
  } finally {db.close();}
}
async function buildFingerprint(build:string):Promise<{path:string;sha256:string}[]> {
  const files:{path:string;sha256:string}[]=[];
  const visit=async(directory:string):Promise<void>=>{
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      assert(!entry.isSymbolicLink(),'Native acceptance build must not contain symlinks');
      const path=join(directory,entry.name);
      if(entry.isDirectory())await visit(path);
      else if(entry.isFile()&&entry.name.endsWith('.js'))files.push({path:relative(build,path).replaceAll('\\','/'),sha256:digest(await readFile(path))});
    }
  };
  await visit(join(build,'server'));await visit(join(build,'shared'));
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

async function acceptance(build:string,selected?:RuntimeKind):Promise<void> {
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const buildPart=relative(join(repo,'.workbench','builds'),build);
  assert(buildPart&&!buildPart.startsWith('..')&&!isAbsolute(buildPart),'Use an existing versioned .workbench/builds server so live source edits cannot race this check');
  const before=await buildFingerprint(build);
  const {buildApp}=await import(pathToFileURL(join(build,'server','index.js')).href) as {buildApp:typeof BuildApp};
  const {runCommand}=await import(pathToFileURL(join(build,'server','repositories.js')).href) as {runCommand:(command:string,args:string[],cwd:string,timeout?:number)=>Promise<string>};
  const {safeText}=await import(pathToFileURL(join(build,'server','runtime','process.js')).href) as {safeText:(value:unknown)=>string};
  const {classifyConnectionError}=await import(pathToFileURL(join(build,'server','connections','manager.js')).href) as {classifyConnectionError:(error:unknown)=>unknown};
  const fixture=await mkdtemp(join(tmpdir(),'awb-upgrade-terminal-'));
  const results:NativeResult[]=[];
  progress(`Native terminal fixture: ${fixture}`);
  for(const runtime of (selected?[selected]:['codex','workbuddy','claude']) as RuntimeKind[]) {
    const result=await one(runtime);
    results.push(result);
    await save();
    // An unconfirmed owned process must not be hidden by starting another run.
    if(result.aliveAfterClose.length||result.cleanupErrors.length)break;
  }
  const unchanged=JSON.stringify(before)===JSON.stringify(await buildFingerprint(build));
  if(!unchanged)process.exitCode=1;
  await save(unchanged);

  async function save(buildUnchanged?:boolean):Promise<void> {
    const expected=selected?1:3;
    const passed=results.length===expected&&results.every(row=>row.passed)&&buildUnchanged===true;
    await writeFile(join(fixture,'native-terminal-report.json'),JSON.stringify({
      checkedAt:new Date().toISOString(),passed,fixture,serverBuild:build,buildFingerprint:before,buildUnchanged,
      scope:'Actual native transports, inherited native credentials, real Beads/Git/SQLite and explicit human dispatch. One tiny text-only request per selected runtime. Close is started synchronously on the actual native terminal event, before service finalization; the same DB is then reopened without sending messages.',
      exclusions:['No login/logout or alternate provider/account/model','No dual API profile or quota balance acceptance','No production data or existing native session reuse','No collaboration/rework rerun','No retroactive repair of historical unknown receipts'],
      usageCoverage:'Native receipt counts only. Missing counters and financial cost remain unknown. Turn and session counters must not be added together; cached/reasoning subsets are not added twice.',
      monetaryCost:null,results,
      failureClassification:results.filter(row=>row.failure).map(row=>({runtime:row.runtime,...classifyConnectionError(row.failure) as object})),
    },null,2));
    if(buildUnchanged!==undefined) {
      if(!passed)process.exitCode=1;
      progress(`Native terminal ${passed?'passed':'incomplete'}; report ${join(fixture,'native-terminal-report.json')}`);
    }
  }

  async function one(runtime:RuntimeKind):Promise<NativeResult> {
    const root=join(fixture,runtime),source=join(root,'source'),dataDir=join(root,'data');
    await mkdir(source,{recursive:true});
    const result:NativeResult={runtime,fixture:root,checkedAt:new Date().toISOString(),passed:false,observedPids:[],aliveAfterClose:[],cleanupErrors:[],checks:{}};
    let app:Awaited<ReturnType<typeof BuildApp>>|undefined;
    let closePromise:Promise<void>|undefined;
    let timeout:NodeJS.Timeout|undefined;
    let closed=false;
    const close=(trigger:string):void=>{
      if(!app||closePromise)return;
      result.closeTrigger=trigger;
      const service=app.workbench;
      const run=result.agentId?service.store.get<RunRecord>('runs',result.agentId):undefined;
      if(run?.pid)result.observedPids=[...new Set([...result.observedPids,run.pid])];
      result.pendingAtClose=result.agentId?nativeFinalizationPending(service.store,[result.agentId]):undefined;
      result.beforeCloseUsage=service.usage.records();
      // Deliberately start closing inside the real result callback, while
      // WorkbenchService has not yet called finishRun for that same event.
      closePromise=bounded(service.close(),45000,`${runtime} native close`);
      void closePromise.then(()=>{closed=true;},error=>{result.cleanupErrors.push(safeText(error));closed=true;});
    };
    try {
      app=await buildApp({dataDir,staticRoot:false});
      result.runtimeInfo=await app.workbench.adapters.get(runtime)!.discover();
      if(!result.runtimeInfo.available)throw new Error(result.runtimeInfo.detail);
      await runCommand('git',['init','--initial-branch=main'],source);
      await writeFile(join(source,'README.md'),'# Isolated terminal receipt acceptance\nNo user input files or external deployments.\n');
      await runCommand('git',['add','README.md'],source);
      await runCommand('git',['-c','user.name=Workbench native acceptance','-c','user.email=native-acceptance@localhost','commit','-m','Isolated read-only terminal fixture'],source);
      const origin=await app.listen({host:'127.0.0.1',port:0});app.workbench.setBaseUrl(origin);
      const project=await app.workbench.createProject({name:`${runtime} 真实关停回执验收`,path:source,kind:'code',initializeBeads:true});
      const nonce=`中文终态已确认-${runtime}-${randomUUID()}`;
      result.nonce=nonce;
      const agent=await app.workbench.createAgent({
        projectId:project.id,name:`${runtime} 终态验收`,runtime,role:'只读回执验收',memberKind:'worker',permissionMode:'read-only',
        instructions:'这是已获授权的单次纯文字通信验收。不要调用任何工具、不要读取或修改文件、不要规划任务。只需按用户要求原样回复一行中文识别码，然后结束本轮。',
      });
      result.agentId=agent.id;
      const task=await app.workbench.createTask({projectId:project.id,title:'只回复中文验收识别码',description:`无需查看仓库、调用工具或执行命令。仅原样回复下面这一行，然后结束：\n${nonce}`,acceptance:`返回包含 ${nonce} 的真实最终响应；不修改任何文件。`});
      result.taskId=task.id;
      app.workbench.on('event',(event:WorkbenchEvent)=>{
        if(event.agentId!==agent.id)return;
        if(['runtime.ready','runtime.result','runtime.error'].includes(event.type))progress(`${runtime}: ${event.type}`);
        if(event.type==='runtime.result')close('native-result');
        if(event.type==='runtime.error'){result.failure=event.text??'Native runtime error';close('native-error');}
        if(event.type==='runtime.approval'){result.failure='Native runtime requested an unexpected tool approval in a text-only test; stopped without approval or retry';close('unexpected-approval');}
        if(event.type==='runtime.tool'){result.failure='Native runtime attempted a tool operation despite the text-only instruction; bounded check stopped';close('unexpected-tool');}
      });
      timeout=setTimeout(()=>{result.failure='Native terminal receipt timeout after 180000 ms; no retry';close('timeout');},180000);
      progress(`${runtime}: dispatching exactly one tiny read-only Chinese request`);
      const receipt=await app.workbench.dispatch(task.id,{projectId:project.id,agentId:agent.id},`terminal-${runtime}-${randomUUID()}`) as {messageId:string};
      result.messageId=receipt.messageId;
      while(!closed)await delay(200);
      assert(closePromise,'No close operation recorded');
      await closePromise;
      await app.close();app=undefined;
      if(timeout)clearTimeout(timeout);
      result.afterClose=readPersisted(dataDir,agent.id);
      const saved=result.afterClose;
      result.observedPids=[...new Set([...result.observedPids,...(saved.run?.pid?[saved.run.pid]:[])])];
      result.aliveAfterClose=result.observedPids.filter(processAlive);
      const final=saved.events.filter(row=>row.type==='runtime.result'&&row.data?.messageId===receipt.messageId);
      const text=saved.events.filter(row=>['runtime.result','runtime.message'].includes(row.type)).map(row=>row.text??'').join('\n');
      result.checks={
        closedAtRealResult:result.closeTrigger==='native-result'&&result.pendingAtClose===true,
        realSuccessfulResult:final.length===1&&final[0]!.data?.interrupted!==true&&final[0]!.data?.isError!==true&&final[0]!.data?.status!=='failed',
        chineseResponse:text.includes(nonce),
        oneDispatch:saved.messages.length===1&&saved.events.filter(row=>row.type==='message.sending').length===1,
        terminalPersisted:saved.run?.state==='terminal'&&saved.messages[0]?.state==='completed',
        completionPersisted:saved.events.filter(row=>row.type==='agent.turn_completed'&&row.data?.messageId===receipt.messageId).length===1,
        noUnknownDowngrade:saved.agent?.state!=='unknown'&&!saved.events.some(row=>row.type==='agent.shutdown_unconfirmed'),
        originalUsagePreserved:(result.beforeCloseUsage??[]).every(row=>saved.usage.some(stored=>stored.id===row.id&&JSON.stringify(stored.counts)===JSON.stringify(row.counts))),
        nativeUsageAttributed:saved.usage.length>0&&saved.usage.every(row=>row.agentId===agent.id&&row.runtime===runtime&&row.connectionId===`native-${runtime}`&&(!row.messageId||row.messageId===receipt.messageId)&&row.nativeSessionId===saved.run?.nativeSessionId),
        noDuplicateUsageRows:new Set(saved.usage.map(row=>row.id)).size===saved.usage.length,
        ownedProcessExited:result.observedPids.length>0&&result.aliveAfterClose.length===0,
        serviceOwnerReleased:!saved.serviceOwnerPresent,
      };
      const lastEvent=Math.max(0,...saved.events.map(row=>row.id));
      app=await buildApp({dataDir,staticRoot:false});
      await delay(1200);
      const afterRestart=readPersisted(dataDir,agent.id);
      const added=afterRestart.events.filter(row=>row.id>lastEvent);
      result.restart={agentState:afterRestart.agent?.state,runState:afterRestart.run?.state,messageCount:afterRestart.messages.length,usageCount:afterRestart.usage.length,newEventTypes:added.map(row=>row.type),nativeDispatchCount:added.filter(row=>['message.sending','runtime.ready','runtime.result'].includes(row.type)).length};
      result.checks.restartKeepsTerminal=afterRestart.run?.state==='terminal'&&afterRestart.messages[0]?.state==='completed'&&!nativeFinalizationPending(app.workbench.store,[agent.id]);
      result.checks.restartDoesNotDispatch=added.every(row=>!['message.queued','message.sending','runtime.ready','runtime.result'].includes(row.type))&&JSON.stringify(afterRestart.messages)===JSON.stringify(saved.messages)&&JSON.stringify(afterRestart.usage)===JSON.stringify(saved.usage);
      result.passed=!result.failure&&Object.values(result.checks).every(Boolean);
      if(!result.passed&&!result.failure)result.failure=`Failed checks: ${Object.entries(result.checks).filter(([,ok])=>!ok).map(([key])=>key).join(', ')}`;
    } catch(error) {
      result.failure??=app?app.workbench.publicError(error):safeText(error);
    } finally {
      if(timeout)clearTimeout(timeout);
      if(app)try {await bounded(app.close(),45000,`${runtime} service cleanup`);}catch(error){result.cleanupErrors.push(safeText(error));}
      result.aliveAfterClose=result.observedPids.filter(processAlive);
      if(result.cleanupErrors.length||result.aliveAfterClose.length)result.passed=false;
      result.checkedAt=new Date().toISOString();
      await writeFile(join(root,'terminal-result.json'),JSON.stringify(result,null,2));
      progress(`${runtime}: ${result.passed?'passed':`incomplete (${result.failure??'cleanup not confirmed'})`}`);
    }
    return result;
  }
}
