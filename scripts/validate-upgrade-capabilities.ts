/** Explicit real native capability acceptance. Never run without --confirm-usage.
 * Reuses only supplied real connection proofs after assertReady; never creates
 * replacement verification, changes authentication, or accesses production data.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { buildApp } from '../src/server/index.js';
import type { Agent, Capability, ConnectionProfile, ConnectionVerification, RuntimeKind } from '../src/shared/types.js';

const sourceReport=process.argv.find(arg=>arg.startsWith('--verified-report='))?.slice('--verified-report='.length);
const selectedRuntime=process.argv.find(arg=>arg.startsWith('--runtime='))?.slice('--runtime='.length);
const reuseReport=process.argv.find(arg=>arg.startsWith('--reuse-report='))?.slice('--reuse-report='.length);
if(selectedRuntime&&!['codex','workbuddy','claude'].includes(selectedRuntime))throw new Error('Unknown runtime');
if(!process.argv.includes('--confirm-usage')||!sourceReport){
  process.stderr.write('This invokes each real native runtime once against an isolated local echo MCP. Run only when authorized: npx tsx scripts/validate-upgrade-capabilities.ts --confirm-usage --verified-report=<real-collaboration-report.json>\n');
  process.exitCode=2;
}else await acceptance(resolve(sourceReport),selectedRuntime as RuntimeKind|undefined,reuseReport?resolve(reuseReport):undefined);

async function acceptance(borrowedEvidenceFrom:string,selectedRuntime?:RuntimeKind,reuseReport?:string):Promise<void>{
  const fixture=await mkdtemp(join(tmpdir(),'awb-upgrade-capabilities-')),source=join(fixture,'ordinary-folder'),dataDir=join(fixture,'data');await mkdir(source);
  const serverPath=join(fixture,'echo-server.mjs'),marker=join(fixture,'actual-tool-receipts.jsonl'),nonce=randomUUID(),reportPath=join(fixture,'capability-report.json');
  const description='Echo the exact supplied text and record the real local invocation for this isolated capability verification.';
  await writeFile(serverPath,`import fs from 'node:fs';import readline from 'node:readline';
const marker=process.argv[2],nonce=process.argv[3];const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{let request;try{request=JSON.parse(line);}catch{return;}if(request.id===undefined)return;let result;
if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolated-capability-echo',version:'1'}};
else if(request.method==='ping')result={};else if(request.method==='tools/list')result={tools:[{name:'case_echo',description:${JSON.stringify(description)},inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};
else if(request.method==='tools/call'&&request.params?.name==='case_echo'){const args=request.params.arguments;if(!args||typeof args.text!=='string'||Object.keys(args).some(key=>key!=='text'))result={content:[{type:'text',text:'Only the exact text parameter is allowed.'}],isError:true};else{fs.appendFileSync(marker,JSON.stringify({nonce,text:args.text,at:new Date().toISOString()})+'\\n');result={content:[{type:'text',text:'Actual echo: '+args.text}]};}}
else return send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method/tool'}});send({jsonrpc:'2.0',id:request.id,result});});
`);
  let app:Awaited<ReturnType<typeof buildApp>>|undefined,failure:string|undefined;
  const checks:Record<string,boolean>={},borrowedVerifications:unknown[]=[],results:unknown[]=[],previousUsage:unknown[]=[],priorAttempts:unknown[]=[];let agents:Agent[]=[],capability:Capability|undefined;
  const progress=(message:string)=>process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  try{
    progress(`Isolated real capability fixture: ${fixture}`);
    const previous=JSON.parse(await readFile(borrowedEvidenceFrom,'utf8')) as {verificationReceipts?:ConnectionVerification[];borrowedVerifications?:ConnectionVerification[]};
    const prior=previous.verificationReceipts??previous.borrowedVerifications??[];
    if(reuseReport){
      const saved=JSON.parse(await readFile(reuseReport,'utf8')) as {fixture:string;capability:Capability;results:{runtime:RuntimeKind;reusedFrom?:string;validation?:{state:string;stale?:boolean};actualToolReceipts:{nonce:string;text:string;at:string}[]}[];usage:unknown[];priorAttempts?:unknown[]};
      const suffix=relative(tmpdir(),resolve(saved.fixture));assert(!isAbsolute(suffix)&&!suffix.startsWith('..')&&suffix.startsWith('awb-upgrade-capabilities-'),'Reuse only a preserved owned capability fixture');
      priorAttempts.push(...(saved.priorAttempts??[]));
      for(const result of saved.results){priorAttempts.push({report:reuseReport,...result});if(result.runtime===selectedRuntime||result.validation?.state!=='verified'||result.validation.stale)continue;
        const source=result.reusedFrom?JSON.parse(await readFile(result.reusedFrom,'utf8')) as {fixture:string;capability:Capability}:saved;
        const origin=relative(tmpdir(),resolve(source.fixture));assert(!isAbsolute(origin)&&!origin.startsWith('..')&&origin.startsWith('awb-upgrade-capabilities-'),'Unexpected evidence origin');
        const markerPath=source.capability.args?.[1];assert(markerPath&&resolve(markerPath)===resolve(source.fixture,'actual-tool-receipts.jsonl'),'Unexpected original receipt file');
        const actual=(await readFile(markerPath,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
        assert.equal(result.actualToolReceipts.length,1);assert(actual.some(row=>JSON.stringify(row)===JSON.stringify(result.actualToolReceipts[0])),'Original successful native receipt no longer matches its fixture');
        checks[`${result.runtime}ActualManagedMcp`]=true;results.push({...result,reusedFrom:result.reusedFrom??reuseReport});
      }
      previousUsage.push(...saved.usage);
    }
    app=await buildApp({dataDir,staticRoot:false});const service=app.workbench;
    const project=await service.createProject({name:'真实三端管理能力验收',path:source,kind:'office'});
    capability=service.capabilities.save({name:'Isolated real echo MCP',kind:'mcp',description,command:process.execPath,args:[serverPath,marker,nonce]});
    capability=await service.capabilities.check(capability.id);assert.equal(capability.status,'connected');assert(capability.tools.some(tool=>tool.name==='case_echo'));checks.localStdioCatalog=true;
    for(const runtime of (selectedRuntime?[selectedRuntime]:['codex','workbuddy','claude']) as RuntimeKind[]){
      const agent=await service.createAgent({projectId:project.id,name:`${runtime} 能力验收`,runtime,role:'能力用例验证',memberKind:'worker',permissionMode:'read-only',capabilityIds:[capability.id]});agents.push(agent);
      const profile=service.connectionManager.get(agent.connectionId!);
      const verification=prior.find(row=>row.connectionId===profile.id&&row.revision===profile.revision&&row.requestedModel===profile.defaultModel&&row.success&&row.contextFingerprint);
      assert(verification,`Missing unchanged real proof for ${runtime}; this script will not fabricate or automatically bill a replacement probe`);
      const stored=service.store.get<ConnectionProfile>('connections',profile.id)!;
      service.store.put('connections',profile.id,{...stored,verifications:[verification],status:verification.status});
      const checked=await service.connectionManager.assertReady(profile.id,agent.model,project.controlPath??source,['inference','streaming','tools']);borrowedVerifications.push({runtime,borrowedEvidenceFrom,...checked});
      const text=`中文能力验收-${runtime}-${randomUUID()}`;
      progress(`${runtime}: invoking the explicitly bound local MCP once`);
      const result=await service.verifyMemberCapability(capability.id,{agentId:agent.id,tool:'case_echo',arguments:{text}}) as Capability;
      const validation=result.validations.find(row=>row.runtime===runtime&&row.connectionId===profile.id&&row.connectionRevision===profile.revision);
      const receipts=await readFile(marker,'utf8').then(content=>content.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as {nonce:string;text:string;at:string})).catch(()=>[]);
      const matched=receipts.filter(row=>row.nonce===nonce&&row.text===text);
      results.push({runtime,agentId:agent.id,capabilityId:capability.id,validation,actualToolReceipts:matched});
      assert.equal(validation?.state,'verified',`${runtime}: ${validation?.detail??'no tool verification'}`);assert(!validation?.stale);assert.equal(matched.length,1,`${runtime}: expected one real local invocation`);
      service.capabilities.assertBound(service.getAgent(agent.id),[capability.id]);checks[`${runtime}ActualManagedMcp`]=true;progress(`${runtime}: native tool receipt and local invocation agree`);
    }
  }catch(error){failure=error instanceof Error?error.message:String(error);process.exitCode=1;progress(`Stopped without automatic retry: ${failure}`);}
  finally{
    const usage=[...previousUsage,...(app?.workbench.usage.records()??[])],current=capability&&app?app.workbench.capabilities.get(capability.id):capability;
    await app?.close();
    await writeFile(reportPath,JSON.stringify({checkedAt:new Date().toISOString(),passed:!failure&&['codex','workbuddy','claude'].every(runtime=>checks[`${runtime}ActualManagedMcp`]),scope:'Actual native sessions invoking a bound local stdio MCP. Previous successful runtimes are reused only with their unchanged local invocation receipt; failed attempts remain in the report. No model self-report, mock native transport, login mutation or production task data.',fixture,borrowedEvidenceFrom,borrowedVerifications,checks,failure,agents:agents.map(agent=>({id:agent.id,runtime:agent.runtime,connectionId:agent.connectionId,connectionRevision:agent.connectionRevision})),capability:current,results,priorAttempts,usage,usageCoverage:'Native receipts only, including preserved failed attempts. Do not add session and turn records together; unknown usage stays unknown, cache/reasoning subsets are not added twice.'},null,2));
    progress(`Report: ${reportPath}`);
  }
}
