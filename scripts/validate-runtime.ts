import { createAdapters } from '../src/server/runtime/index.js';
import type { RuntimeEvent, RuntimeKind, RuntimeConnection } from '../src/shared/types.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTokenCountField } from '../src/server/runtime/usage.js';
const kind=process.argv[2] as RuntimeKind;
if(!['codex','claude','workbuddy'].includes(kind))throw new Error('Pass codex, claude or workbuddy');
const cwd=path.resolve(process.argv[3]??'.workbench/sandbox/collaboration-demo');
const out=path.resolve('.workbench/validation');await mkdir(out,{recursive:true});
const rows:Record<string,unknown>[]=[];
let connection:RuntimeConnection|undefined;
let waiter:((e:RuntimeEvent)=>void)|undefined;
let startedOutput:(()=>void)|undefined;
let activePhase:string|undefined;
const adapter=createAdapters()[kind];
const info=await adapter.discover();console.log(JSON.stringify({kind,info}));
const record=(e:RuntimeEvent)=>{
  const rawUsage=e.data?.usage;
  const nativeUsage=rawUsage&&typeof rawUsage==='object'?Object.fromEntries(Object.entries(rawUsage).filter(([key,value])=>isTokenCountField(key,value))):undefined;
  const row={at:new Date().toISOString(),phase:activePhase,type:e.type,state:e.state,text:e.text?.slice(0,4000),nativeSessionId:e.nativeSessionId,messageId:e.messageId,approvalId:e.approvalId,interrupted:e.data?.interrupted,isError:e.data?.isError,status:e.data?.status,subtype:e.data?.subtype,usage:e.type==='usage'?e.data:undefined,nativeUsage};rows.push(row);
  if(e.type!=='delta')console.log(JSON.stringify(row));
  if(e.type==='approval'&&e.approvalId) { void connection?.respondApproval(e.approvalId,false).catch(()=>{}); }
  if(activePhase==='interrupt-test'&&['delta','message'].includes(e.type)&&e.text)startedOutput?.();
  if(['result','error'].includes(e.type))waiter?.(e);
};
const result=()=>new Promise<RuntimeEvent>((resolve,reject)=>{const timer=setTimeout(()=>{waiter=undefined;reject(new Error('Runtime response timeout'));},120000);waiter=e=>{clearTimeout(timer);waiter=undefined;resolve(e);};});
async function turn(text:string,phase:string) { activePhase=phase;const done=result(); await connection!.send(text,randomUUID()); const event=await done; if(event.type==='error'||event.data?.isError===true)throw new Error(event.text);return event; }
async function closeOwned() {
  if(!connection)return;
  const pid=connection.pid,nativeSessionId=connection.nativeSessionId;
  await connection.close();connection=undefined;
  let exited=true;if(pid)try{process.kill(pid,0);exited=false;}catch{}
  rows.push({at:new Date().toISOString(),type:'probe-process-closed',pid,nativeSessionId,exited});
  if(!exited)throw new Error('Owned runtime process is still alive after close');
}
let passed=false;
try {
  connection=await adapter.connect({agentId:`probe-${kind}`,cwd,permissionMode:'read-only',instructions:'You are validating a local agent workbench in a synthetic repository. Answer the requested text exactly. Do not use tools, access credentials, call other agents, or modify files.'},record);
  const first=await turn('请只回答：工作台连接成功。记住口令“青松”。','first');
  if(!first.text?.includes('工作台连接成功'))throw new Error('Initial response content did not match');
  const second=await turn('上一轮让你记住的口令是什么？只回答口令。','second');
  if(!second.text?.includes('青松'))throw new Error('Multi-turn context was not retained');
  const nativeSessionId=connection.nativeSessionId;
  if(!nativeSessionId)throw new Error('No native session ID returned');
  const initialUsage=rows.filter(row=>row.type==='usage'&&['first','second'].includes(String(row.phase)));
  if(!initialUsage.some(row=>Object.values(row.usage as Record<string,unknown>).some(value=>typeof value==='number')))throw new Error('Native usage returned no numeric counters');
  if(kind==='claude'&&!['first','second'].every(phase=>initialUsage.some(row=>row.phase===phase&&(row.usage as any)?.scope==='turn')))throw new Error('Claude per-turn usage was not observed for both turns');
  if(kind==='workbuddy') {
    const totals=initialUsage.map(row=>(row.usage as any)?.totalTokens).filter(value=>typeof value==='number');
    if(totals.length<2||totals[1]<totals[0])throw new Error('WorkBuddy cumulative usage did not remain monotonic across the first two turns');
  }
  await closeOwned();
  connection=await adapter.connect({agentId:`probe-${kind}`,cwd,permissionMode:'read-only',instructions:'You are validating the local agent workbench. Do not use tools or modify files.',resumeSessionId:nativeSessionId},record);
  const resumed=await turn('这是同会话恢复验证。请只回答：恢复确认（刚才记住的口令）。','resumed');
  if(!resumed.text?.includes('恢复确认')||!resumed.text.includes('青松')||connection.nativeSessionId!==nativeSessionId)throw new Error('Resume returned replay/empty content or changed the native session');
  activePhase='interrupt-test';
  let outputTimer:NodeJS.Timeout|undefined;
  const outputStarted=new Promise<void>((resolve,reject)=>{startedOutput=resolve;outputTimer=setTimeout(()=>reject(new Error('No generated output before interrupt')),60000);});
  const stopped=result();await connection.send('请连续输出数字1到3000，每个数字单独一行。',randomUUID());
  try{await outputStarted;}finally{clearTimeout(outputTimer);startedOutput=undefined;}
  await connection.interrupt();const terminal=await stopped;
  if(terminal.type!=='result'||terminal.data?.interrupted!==true)throw new Error('Interrupt did not produce a confirmed interrupted terminal');
  const after=await turn('已中断上一轮。请只回答：干预后恢复成功。','after-interrupt');
  if(!after.text?.includes('干预后恢复成功'))throw new Error('No fresh reply after interrupt');
  passed=true;
} catch(error) { console.error(String(error));rows.push({type:'probe-error',text:String(error)});process.exitCode=1; }
finally { if(connection)await closeOwned().catch(error=>{passed=false;process.exitCode=1;rows.push({type:'probe-close-error',text:String(error)});});const report=JSON.stringify({kind,cwd,passed,observedAt:new Date().toISOString(),events:rows},null,2);await writeFile(path.join(out,`${kind}-runtime-${Date.now()}.json`),report);await writeFile(path.join(out,`${kind}-runtime.json`),report); }
