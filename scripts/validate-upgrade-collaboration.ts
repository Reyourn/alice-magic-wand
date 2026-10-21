import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/server/index.js';
import { runCommand } from '../src/server/repositories.js';
import type { Agent, Approval, IntegrationRecord, RuntimeKind, WorkbenchEvent, WorkflowDetail, WorkflowNode } from '../src/shared/types.js';
import { nativeFinalizationPending } from './validation-finalization.js';

/** Deliberately billable acceptance, separate from mock transport/unit tests.
 * Owns one newly-created synthetic repository and data directory. It neither
 * reads production workbench data nor updates an existing project or login.
 */
const auditReport = process.argv.find(arg=>arg.startsWith('--audit-report='))?.slice('--audit-report='.length);
if(auditReport){
  await auditCompletedReport(resolve(auditReport));
} else if (!process.argv.includes('--confirm-usage')) {
  process.stderr.write('This sends real native requests to Codex, WorkBuddy and Claude using their existing configuration. Run with --confirm-usage only after authorization. It preserves its isolated fixture and report for inspection.\n');
  process.exitCode = 2;
} else {
  await acceptance();
}

/** Reconcile a completed acceptance after a report assertion failed. This path
 * does not start the backend, adapters, model calls, or another test process.
 * Only the audit report is written. Execution records, the original failed
 * report and Git's index are left unchanged. */
async function auditCompletedReport(reportPath:string):Promise<void>{
  const original=await readFile(reportPath,'utf8'),report=JSON.parse(original);
  const directory=resolve(report.fixture),prefix=relative(tmpdir(),directory);
  assert(!prefix.startsWith('..')&&!isAbsolute(prefix)&&prefix.startsWith('awb-upgrade-collaboration-'),'Audit only an owned synthetic fixture');
  assert.equal(resolve(join(directory,relative(directory,reportPath))),reportPath);
  assert(!relative(directory,reportPath).startsWith('..'),'Report must belong to the fixture');
  const detail=report.workflow as WorkflowDetail;
  assert.equal(detail.workflow.status,'completed');
  const db=new DatabaseSync(join(directory,'data','workbench.sqlite'),{readOnly:true});
  try{
    const get=<T>(collection:string,id:string):T=>{const row=db.prepare('select json from entities where collection=? and id=?').get(collection,id) as {json:string}|undefined;assert(row,`Missing ${collection}/${id}`);return JSON.parse(row.json) as T;};
    const events=db.prepare('select id,json from events order by id').all().map(row=>({...JSON.parse(row.json as string),id:row.id})) as WorkbenchEvent[];
    const workflow=get<WorkflowDetail['workflow']>('workflows',detail.workflow.id);
    assert.equal(workflow.status,'completed');assert.deepEqual(workflow.taskIds,detail.workflow.taskIds);
    const originalReport=JSON.parse(await readFile(join(directory,'collaboration-report.json'),'utf8'));
    assert.deepEqual(workflow.taskIds,originalReport.workflow.workflow.taskIds,'Resume must keep the two original tasks');
    assert.equal(Object.keys(workflow.taskIds).length,2);
    const candidate=detail.nodes.find(row=>row.node.id==='implementation')?.bundle;assert(candidate);
    assert.deepEqual(get('artifact_bundles',candidate.id),candidate);
    const test=detail.evidence.find(row=>row.kind==='test'&&row.version===candidate.version&&row.result==='passed'&&row.exitCode===0&&!row.stale);
    const review=detail.evidence.find(row=>row.kind==='review'&&row.version===candidate.version&&row.result==='passed'&&!row.stale);
    const failedReview=detail.evidence.find(row=>row.kind==='review'&&row.result==='failed'&&row.version!==candidate.version);
    assert(test&&review&&failedReview,'Require actual failed review, passing current test and passing independent current review');
    assert.notEqual(review.reviewerId,candidate.agentId);
    for(const receipt of [test,review,failedReview])assert.equal(get<{version:string}>('verification_evidence',receipt.id).version,receipt.version);
    const round=detail.rounds.find(row=>row.id===candidate.roundId);assert(round?.state==='accepted'&&round.automaticReworkCount===1);
    const accepted=events.filter(event=>event.type==='runtime.tool'&&event.data?.tool==='accept_task'&&event.data?.phase==='completed'&&!event.data?.error&&event.data?.arguments?.workflowId===workflow.id);
    assert(accepted.some(event=>event.data?.arguments?.roundId===round.id),'Actual controller acceptance receipt missing');
    assert(accepted.some(event=>event.data?.arguments?.nodeId==='review'),'Actual controller review closure missing');
    assert.equal(report.interventions.length,3);assert.equal(new Set(report.interventions.map((row:any)=>row.runtime)).size,3);
    const finalRuntimeStates:Record<string,unknown>[]=[];
    for(const intervention of report.interventions){
      const stopped=events.find(event=>event.id===intervention.stoppedEventId);
      assert(stopped?.type==='runtime.result'&&stopped.agentId===intervention.agentId&&stopped.data?.messageId===intervention.originalMessageId&&stopped.data?.interrupted===true);
      assert(intervention.sameSession===true&&intervention.nativeSessionId);
      assert(events.some(event=>event.agentId===intervention.agentId&&event.type==='runtime.result'&&event.data?.messageId===intervention.correctionMessageId&&!event.data?.interrupted));
      const agent=get<{state:string;lastError?:string}>('agents',intervention.agentId);
      const run=get<{state:string;pid?:number}>('runs',intervention.agentId);
      assert(run.pid,'Persisted native run must identify its process');
      let alive=true;try{process.kill(run.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;alive=false;}
      assert(!alive,'Owned native process is still alive; do not audit a running fixture');
      finalRuntimeStates.push({runtime:intervention.runtime,agentState:agent.state,runState:run.state,pid:run.pid,processAlive:alive,lastError:agent.lastError});
    }
    const integration=get<IntegrationRecord>('workflow_integrations',workflow.id),check=integration.checks.at(-1);assert(check);
    assert.equal(integration.state,'verified');assert.equal(check.commit,integration.headCommit);assert.equal(check.exitCode,0);
    assert.deepEqual(check.args,['--test','average.test.mjs']);assert(integration.integratedBundleIds.includes(candidate.id));
    // Disable optional index refresh writes even for `git status`.
    const git=(args:string[],cwd:string)=>runCommand('git',['--no-optional-locks',...args],cwd);
    const repository=join(directory,'fixture');
    const targetHead=await git(['rev-parse','HEAD'],repository);
    assert.equal(targetHead,integration.baselineCommit);
    assert.equal(await git(['rev-parse','refs/heads/main'],repository),integration.baselineCommit);
    const targetStatus=await git(['status','--porcelain','--untracked-files=all'],repository);
    assert(['','M .gitignore'].includes(targetStatus),'Only the known unstaged Beads ignore append is allowed in the original target');
    const sourceFiles=[];
    for(const path of ['average.mjs','average.test.mjs','AGENTS.md']){
      const baselineBlob=await git(['rev-parse',`${integration.baselineCommit}:${path}`],repository);
      const currentBlob=await git(['hash-object','--no-filters','--',path],repository);
      assert.equal(currentBlob,baselineBlob,`Original ${path} bytes changed`);
      sourceFiles.push({path,baselineBlob,currentBlob,unchanged:true});
    }
    let allowedInfrastructureChange: {path:string;reason:string;sha256:string}|undefined;
    if(targetStatus){
      // Do not broadly ignore .gitignore changes: only bd init's exact block
      // is permitted, with no deletions, extra patterns or staged changes.
      const baselineIgnore=await git(['show',`${integration.baselineCommit}:.gitignore`],repository);
      assert.equal(baselineIgnore,'.beads/','Unexpected synthetic fixture baseline');
      const currentIgnore=await readFile(join(repository,'.gitignore'),'utf8');
      const expectedIgnore=`${baselineIgnore}\n\n# Beads / Dolt files (added by bd init)\n.dolt/\n*.db\n.beads-credential-key\n.beads/proxieddb/\n*.gate.lock*\n`;
      assert.equal(currentIgnore.replace(/\r\n/g,'\n'),expectedIgnore,'Unexpected edits to the original .gitignore');
      allowedInfrastructureChange={path:'.gitignore',reason:'Exact Beads initialization ignore block; original workspace is not fully clean.',sha256:createHash('sha256').update(currentIgnore).digest('hex')};
    }
    assert.equal(await git(['rev-parse','HEAD'],integration.worktree),integration.headCommit);
    assert.equal(await git(['status','--porcelain','--untracked-files=all'],integration.worktree),'');
    const checks={...report.checks,realThreeRuntimeWorkflow:true,threeChineseInterruptions:true,versionBoundRework:true,nativeControllerAcceptance:true,integrationTest:true,originalTargetPreserved:true,ownedNativeProcessExitConfirmed:true};
    assert(Object.values(checks).every(Boolean));
    const output=join(directory,'collaboration-final-audit.json');
    const limitations=[
      ...(report.failure?['The original native harness failed its integration response assertion. This audit validates existing business receipts; it does not mark that harness run passed.']:[]),
      ...(finalRuntimeStates.some(row=>row.agentState==='unknown')?['Original harness closed after successful controller acceptance MCP receipt while its last natural-language turn was still running. Its terminal receipt remains unknown; process exit was independently checked. No state or usage was fabricated.']:[]),
      ...(allowedInfrastructureChange?[allowedInfrastructureChange.reason]:[]),
    ];
    await writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),passed:true,fullNativeHarnessPassed:report.passed===true,mode:'Read-only audit of completed task/review/integration, not a replacement native run. No model calls, task dispatch, mutation of execution records, or repeated test execution.',sourceReport:reportPath,sourceReportSha256:createHash('sha256').update(original).digest('hex'),originalHarnessFailure:report.failure,limitations,finalRuntimeStates,checks,workflowId:workflow.id,taskIds:workflow.taskIds,candidateCommit:candidate.version,candidateBundleId:candidate.id,automaticReworkCount:round.automaticReworkCount,integration,target:{baseline:integration.baselineCommit,currentHead:targetHead,status:targetStatus,sourceFiles,allowedInfrastructureChange},interventions:report.interventions,evidenceIds:{failedReview:failedReview.id,passedReview:review.id,passedTest:test.id,controllerAcceptanceEvents:accepted.map(event=>event.id)},verificationReceipts:report.verificationReceipts,usage:report.usage,scope:report.scope},null,2),'utf8');
    process.stdout.write(`Read-only acceptance audit passed: ${output}\n`);
  }finally{db.close();}
}

async function acceptance(): Promise<void> {
  const resume = process.argv.find(arg=>arg.startsWith('--resume='))?.slice('--resume='.length);
  const verificationSource = process.argv.find(arg=>arg.startsWith('--reuse-verification-from='))?.slice('--reuse-verification-from='.length);
  const directory = resume ? resolve(resume) : await mkdtemp(join(tmpdir(), 'awb-upgrade-collaboration-'));
  if(resume){const prefix=relative(tmpdir(),directory);assert(!prefix.startsWith('..')&&!isAbsolute(prefix)&&prefix.startsWith('awb-upgrade-collaboration-'),'Resume only a preserved owned acceptance fixture');const prior=JSON.parse(await readFile(join(directory,'collaboration-report.json'),'utf8'));assert.equal(resolve(prior.fixture),directory);}
  const repository = join(directory, 'fixture'), dataDir = join(directory, 'data');
  await mkdir(repository,{recursive:true}); await mkdir(dataDir,{recursive:true});
  const token = randomUUID();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let approvalTimer: NodeJS.Timeout | undefined;
  let approvalBusy = false, origin = '', workflowId = '';
  const events: WorkbenchEvent[] = [], interventions: Record<string, unknown>[] = [], approvalReceipts: Record<string, unknown>[] = [];
  const verificationReceipts: unknown[] = [], checks: Record<string, boolean> = {};
  const reusedReports: string[] = [];
  const previousReports: {path:string;report:any}[]=[];
  if(resume)for(const name of (await readdir(directory)).filter(name=>/^collaboration-report(?:-\d+)?\.json$/.test(name))){const path=join(directory,name);previousReports.push({path,report:JSON.parse(await readFile(path,'utf8'))});}
  let agents: Agent[] = [], finalWorkflow: WorkflowDetail | undefined, failure: string | undefined;
  const reportPath = join(directory, resume ? `collaboration-report-${Date.now()}.json` : 'collaboration-report.json');
  const progress = (text: string) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
  const request = async <T>(path: string, method = 'GET', body?: unknown, key = randomUUID()): Promise<T> => {
    const response = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', 'x-workbench-token': token, 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${value.error ?? response.status}`);
    return value as T;
  };
  const waitFor = async <T>(label: string, read: () => Promise<T | undefined> | T | undefined, timeout = 600_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await read(); if (result !== undefined) return result; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  };
  const withinFixture = (path: string, cwd: string): boolean => {
    const full = resolve(cwd, path), suffix = relative(directory, full);
    return suffix !== '' && !suffix.startsWith('..') && !isAbsolute(suffix);
  };
  const approveFixtureTool = (approval: Approval): boolean => {
    const agent = app!.workbench.getAgent(approval.agentId), input = approval.input as Record<string, unknown>;
    if (!agents.some(row => row.id === agent.id)) return false;
    const tool = approval.tool.toLowerCase();
    // Scoped workbench MCP cannot mutate anything beyond this test project.
    if (tool.includes('workbench') || input?.server === 'workbench' || input?.serverName === 'workbench'
      || tool==='deferexecutetool'&&typeof input.toolName==='string'&&input.toolName.startsWith('mcp__workbench__')) return true;
    const cwd = agent.worktree ?? repository;
    const paths = ['file_path', 'path', 'filePath', 'target_file'].flatMap(key => typeof input?.[key] === 'string' ? [input[key] as string] : []);
    if (/read|write|edit|replace|list|glob|grep|search/.test(tool) && paths.length) return paths.every(path => withinFixture(path, cwd));
    const command = typeof input?.command === 'string' ? input.command.trim() : typeof input?.cmd === 'string' ? input.cmd.trim() : '';
    // Native agents commonly append an exit-code print. Accept only this exact
    // declared test, never arbitrary shell expressions or another executable.
    const test = command.match(/^(?:&\s+)?["']([^"']+node\.exe)["']\s+--test\s+average\.test\.mjs(?:;\s*(?:echo\s+)?["']EXIT(?:_CODE)?=\$(?:\?|LASTEXITCODE)["'])?$/i);
    if(test&&resolve(test[1]!).toLowerCase()===resolve(process.execPath).toLowerCase())return true;
    // Keep shell approval intentionally narrow. Complex commands require manual
    // investigation and cannot gain arbitrary authority by mentioning a fixture.
    if (command && !/[;&|<>`\r\n]/.test(command) && !/\$\(/.test(command)) {
      if (/^git\s+(?:status|diff|log|show|rev-parse)\b/.test(command)) return !/\s-C\s|--git-dir|--work-tree/.test(command);
      if (/^git\s+add\s+(?:--\s+)?(?:average\.mjs|average\.test\.mjs)(?:\s+(?:average\.mjs|average\.test\.mjs))*$/.test(command)) return true;
      if (/^git\s+commit\s+-m\s+["'][^"']+["']$/.test(command)) return true;
      if (/^(?:node|"[^"\r\n]+node\.exe")\s+--test\s+average\.test\.mjs$/.test(command)) return true;
      if (/^(?:pwd|Get-Location|git status --short)$/.test(command)) return true;
      const read = command.match(/^(?:cat|type|Get-Content)(?:\s+-LiteralPath)?\s+["']?([^"']+?)["']?$/);
      if (read) return withinFixture(read[1]!, cwd);
    }
    return false;
  };
  const message = async (agent: Agent, text: string, mode: 'queue'|'interrupt' = 'queue') => request<{messageId: string}>(`/api/agents/${agent.id}/messages`, 'POST', { text, mode });
  const messageDone = (id: string) => waitFor(`message ${id}`, () => {
    const row = app!.workbench.store.get<{state:string}>('messages', id);
    if (row?.state === 'failed' || row?.state === 'uncertain') throw new Error(`Native delivery ${id}: ${row.state}`);
    return row?.state === 'completed' ? row : undefined;
  });
  const intervene = async (agent: Agent, correction: string) => {
    await waitFor(`${agent.runtime} active turn`, () => ['running','waiting_approval'].includes(app!.workbench.getAgent(agent.id).state) ? true : undefined);
    const prior = app!.workbench.store.get<{messageId:string;nativeSessionId?:string}>('runs', agent.id);
    assert(prior?.messageId, 'Intervention needs an actual active native run');
    let before = app!.workbench.getAgent(agent.id).nativeSessionId;
    const corrected = await message(agent, correction, 'interrupt');
    await messageDone(corrected.messageId);
    const interrupted = events.find(event => event.agentId === agent.id && event.type === 'runtime.result' && event.data?.messageId === prior.messageId && event.data?.interrupted === true);
    assert(interrupted, `${agent.runtime} must report stopped before its correction runs`);
    const after = app!.workbench.getAgent(agent.id);
    before ??= events.find(event=>event.agentId===agent.id&&event.type==='runtime.ready'&&event.data?.messageId===prior.messageId&&typeof event.data?.nativeSessionId==='string')?.data?.nativeSessionId as string|undefined;
    assert(before && after.nativeSessionId === before, `${agent.runtime} intervention must retain native session`);
    if (agent.memberKind !== 'controller') {
      assert.equal(after.controlMode, 'human');
      const denied = await fetch(`${origin}/api/workflows/${workflowId}/advance`, { method:'POST',headers:{'content-type':'application/json','x-workbench-token':token,'idempotency-key':randomUUID()},body:'{}' });
      // A blocked workflow may reject advancement, or return unchanged state.
      // Either behavior must leave the member without another automatic turn.
      await denied.arrayBuffer();
      assert.equal(app!.workbench.getAgent(agent.id).controlMode, 'human');
      assert(!app!.workbench.store.all<{agentId:string;source:string;state:string}>('messages').some(row => row.agentId === agent.id && row.source !== 'human' && ['queued','sending','delivered'].includes(row.state)), 'Takeover must stop automatic delivery');
      await request(`/api/agents/${agent.id}/control`, 'POST', {mode:'auto'});
      await request(`/api/workflows/${workflowId}/pause`, 'POST', {paused:false});
    }
    interventions.push({runtime:agent.runtime,agentId:agent.id,originalMessageId:prior.messageId,correctionMessageId:corrected.messageId,nativeSessionId:before,stoppedEventId:interrupted.id,sameSession:true});
    progress(`${agent.runtime}: Chinese interruption, stop acknowledgement and same-session correction verified`);
  };

  try {
    progress(`Isolated fixture: ${directory}`);
    if(!resume){
    await runCommand('git',['init','--initial-branch=main'],repository);
    await runCommand('git',['config','user.name','Workbench Acceptance'],repository);
    await runCommand('git',['config','user.email','acceptance@localhost'],repository);
    await writeFile(join(repository,'.gitignore'),'.beads/\n');
    await writeFile(join(repository,'average.mjs'),'export function average(values) { return Number.NaN; }\n');
    await writeFile(join(repository,'average.test.mjs'),`import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {average} from './average.mjs';\ntest('中文：普通平均值',()=>assert.equal(average([2,4,6]),4));\ntest('中文：负数平均值',()=>assert.equal(average([-6,-2]),-4));\ntest('中文：空数组返回 null',()=>assert.equal(average([]),null));\n`);
    await writeFile(join(repository,'AGENTS.md'),'This is an isolated synthetic acceptance fixture. Only edit average.mjs and average.test.mjs. Do not read credentials, access the network, install packages, or change any other repository. Use the assigned workbench task and existing native tools.\n');
    await runCommand('git',['add','.'],repository); await runCommand('git',['commit','-m','Synthetic acceptance baseline'],repository);
    }
    const baseline = await runCommand('git',['rev-parse','HEAD'],repository);
    app = await buildApp({dataDir,token,staticRoot:false});
    if(resume)events.push(...app.workbench.store.events(0,20_000));
    app.workbench.on('event', (event: WorkbenchEvent) => events.push(event));
    origin = await app.listen({host:'127.0.0.1',port:0}); app.workbench.setBaseUrl(origin);
    const project = await request<{id:string}>('/api/projects','POST',{name:'升级真实三端验收',path:repository,initializeBeads:true});
    const existingWorkflow=app.workbench.workflows.list(project.id)[0];
    if(existingWorkflow){
      assert(resume,'New acceptance cannot inherit workflows');workflowId=existingWorkflow.id;
      const rounds=app.workbench.workflows.rounds(workflowId);
      assert(rounds.length<=10&&rounds.every(round=>['implementation','review'].includes(round.nodeId)),'Recovery is bounded to this original two-node fixture');
      assert(!['completed','delivered'].includes(existingWorkflow.status),'Do not replay a finished acceptance');
      assert(previousReports.some(({report})=>report.workflow?.workflow?.id===workflowId&&report.checks?.confirmationIdempotency),'Recovery needs original human confirmation evidence');
      await request(`/api/workflows/${workflowId}/pause`,'POST',{paused:true});
    }
    const existing=(runtime:RuntimeKind)=>app!.workbench.agents().find(agent=>agent.projectId===project.id&&agent.runtime===runtime);
    const lead = existing('codex')??await request<Agent>('/api/agents','POST',{projectId:project.id,name:'Codex 验收主控',runtime:'codex',memberKind:'controller',roleTemplateId:'controller',role:'主控'});
    const implementer = existing('workbuddy')??await request<Agent>('/api/agents','POST',{projectId:project.id,name:'WorkBuddy 实施',runtime:'workbuddy',memberKind:'worker',roleTemplateId:'fullstack',role:'实施'});
    let reviewer = existing('claude')??await request<Agent>('/api/agents','POST',{projectId:project.id,name:'Claude 独立审查',runtime:'claude',memberKind:'worker',roleTemplateId:'reviewer',role:'独立审查',permissionMode:'read-only'});
    if(reviewer.permissionMode!=='read-only')reviewer=await request<Agent>(`/api/agents/${reviewer.id}`,'PATCH',{permissionMode:'read-only'});
    agents = [lead,implementer,reviewer];
    if(verificationSource){
      const source=resolve(verificationSource),suffix=relative(tmpdir(),source);
      assert(!suffix.startsWith('..')&&!isAbsolute(suffix)&&suffix.startsWith('awb-upgrade-collaboration-'),'Borrow only immutable verification evidence from an owned acceptance fixture');
      const report=JSON.parse(await readFile(source,'utf8'));
      for(const agent of agents){
        const profile=app.workbench.connectionManager.get(agent.connectionId!);
        assert.equal(profile.mode,'native');
        if(profile.verifications.length)continue;
        const proof=report.verificationReceipts.find((row:any)=>row.runtime===agent.runtime&&row.connectionId===profile.id&&row.revision===profile.revision&&row.requestedModel===agent.model&&row.success&&row.contextFingerprint);
        assert(proof,`Missing original ${agent.runtime} verification evidence`);
        const {runtime:_,reused:__,...unchanged}=proof;
        app.workbench.store.put('connections',profile.id,{...profile,verifications:[unchanged]});
        // No new success/date/model is invented. Changed routing must fail;
        // the original real call only transfers to an equivalent context.
        await app.workbench.connectionManager.assertReady(profile.id,agent.model,repository,['inference','streaming','tools']);
      }
      reusedReports.push(source);
    }
    for(const {path,report:prior} of previousReports){
      for(const intervention of prior.interventions??[])if(agents.some(agent=>agent.id===intervention.agentId&&agent.runtime===intervention.runtime)&&intervention.sameSession&&!interventions.some(row=>row.runtime===intervention.runtime)){
        assert(events.some(event=>event.id===intervention.stoppedEventId&&event.type==='runtime.result'&&event.data?.interrupted===true),'Borrowed interruption must have its original native stop event');
        interventions.push(intervention);reusedReports.push(path);
      }
    }
    for (const agent of agents) {
      if(['unknown','error'].includes(app.workbench.getAgent(agent.id).state))await request(`/api/agents/${agent.id}/recover`,'POST',{});
      if(!existingWorkflow&&app.workbench.getAgent(agent.id).controlMode==='human')await request(`/api/agents/${agent.id}/control`,'POST',{mode:'auto'});
      const reusable=await app.workbench.connectionManager.assertReady(agent.connectionId!,agent.model,repository,['inference','streaming','tools']).catch(()=>undefined);
      if(reusable){verificationReceipts.push({runtime:agent.runtime,...reusable,reused:true});progress(`${agent.runtime}: unchanged native connection proof reused; no extra inference probe`);continue;}
      const verification = await request<{success:boolean;detail:string}>(`/api/connections/${agent.connectionId}/verify`,'POST',{projectId:project.id,capabilities:['inference','streaming','tools']});
      verificationReceipts.push({runtime:agent.runtime,...verification});
      assert(verification.success, `${agent.runtime} native connection: ${verification.detail}`);
      progress(`${agent.runtime}: selected native connection, streaming and temporary local MCP verified`);
    }
    approvalTimer = setInterval(() => { if (approvalBusy || !app) return; approvalBusy = true; void (async () => {
      for (const approval of app!.workbench.store.all<Approval>('approvals')) {
        const allow = approveFixtureTool(approval);
        try{await app!.workbench.respondApproval(approval.agentId,approval.id,allow);}catch(error){if(!app!.workbench.store.get('approvals',`${approval.agentId}:${approval.id}`))continue;throw error;}
        approvalReceipts.push({agentId:approval.agentId,id:approval.id,tool:approval.tool,allow});
      }
    })().catch(error=>{failure = `Approval handling: ${app!.workbench.publicError(error)}`;}).finally(()=>{approvalBusy=false;}); },100);
    const nodes: WorkflowNode[] = [
      {id:'implementation',title:'平均值函数分阶段实现',kind:'task',agentId:implementer.id,description:'这是明确授权的故障注入验收：第 1 轮在工具调用前会被人工中断；第 2 轮只修复普通与负数平均值，故意保留空数组 NaN 以便独立审查真实退回；第 3 轮处理退回要求，修复空数组为 null。不要伪报第 2 轮测试全部通过。只改 average.mjs 和必要的测试，不安装依赖。先调用 get_task_context。',acceptance:'average([2,4,6])=4，average([-6,-2])=-4，average([])=null；实际测试全部通过且另一名成员固定版本审查通过。',dependencies:[],requiredCapabilities:[],inputs:[],checks:[{id:'unit',label:'实际 Node 边界测试',kind:'test',command:process.execPath,args:['--test','average.test.mjs']},{id:'review',label:'Claude 固定候选版本审查',kind:'review'}]},
      {id:'review',title:'独立检查固定候选版本',kind:'review',agentId:reviewer.id,description:'调用 get_task_context，读取固定候选的 average.mjs 与 average.test.mjs，检查普通值、负数和空数组必须返回 null。任何一项不满足则 failed，不得因这是测试而放行。首次审查会有人工中断并在同会话人工新轮继续审查。仅使用只读工具，不修改文件，必须按系统要求输出一行 WORKBENCH_REVIEW_RESULT。',acceptance:'输出真实独立审查结论，明确绑定候选版本。',dependencies:[{nodeId:'implementation',kind:'candidate'}],requiredCapabilities:[],inputs:[],checks:[]},
    ];
    const previousProposal=app.workbench.store.command(`mcp:${lead.id}:propose_plan:acceptance-plan`);
    const planKey=previousProposal?.state==='failed'&&previousProposal.error?.includes('只读')?'acceptance-plan-after-permission-fix':'acceptance-plan';
    const goal = `你负责真实三端升级验收。只使用 workbench MCP 编排，不写代码或直接操作 Beads/Git。审查成员已明确设为 read-only。请用 propose_plan 建立下面完整计划，idempotencyKey 固定为 ${planKey}（若有之前只读权限校验失败，那次已确认未创建任何计划；本次已修正权限）。name 为「三端真实协作验收」，goal 为「独立示例仓库完成实施、人工干预、审查返工、主控验收」，targetBranch main，maxReworkRounds 2。节点原样采用：${JSON.stringify(nodes)}。提交后结束当前轮，等待用户确认。后续收到完成通知时调用 get_workflow 核对：已停止失败轮用 return_task 引用 sourceRoundId；实施 candidate 先 run_declared_check(unit)，再等审查回执，record_review(review) 必须采用实际 WORKBENCH_REVIEW_RESULT 的原样 conclusion。审查 failed 时 accept_task 关闭该审查结论，然后 return_task 实施引用 sourceBundleId，要求修复空数组 null。审查 passed 且测试通过后，accept_task 两个节点，允许后台整合到隔离整合分支。不要交付到 main，不绕过验收，不重复提出计划，不频繁轮询。每次返工使用稳定幂等键，收到人类接管先等待交还。不要把故障注入阶段误报为验收通过。`;
    if(!interventions.some(row=>row.runtime==='codex')){
      await message(lead,'这是中文人工中断验收，请连续列出 1 到 1000；不要调用工具。');
      await intervene(lead,`中断纠正：停止刚才输出，只回复「主控干预已确认」，不要继续或调用工具。`);
    }else progress('codex: same-session intervention proof reused from the previous bounded attempt');
    if(!existingWorkflow)await messageDone((await message(lead,goal)).messageId);
    const workflow = app.workbench.workflows.list(project.id)[0];assert(workflow,'Codex completed without proposing its plan; inspect native MCP/permission evidence before retrying');workflowId = workflow.id;
    if(!existingWorkflow)assert.equal(app.workbench.workflows.rounds(workflowId).length,0,'A proposal must not dispatch before human confirmation');
    const proposed = await request<WorkflowDetail>(`/api/workflows/${workflowId}`);
    assert.deepEqual(proposed.plan.nodes,nodes,'Native controller must propose the bounded approved fixture');
    checks.nativeControllerPlan = events.some(event=>event.agentId===lead.id&&event.type==='runtime.tool'&&JSON.stringify(event.data).includes('propose_plan'));
    if(!existingWorkflow){const confirmationKey = randomUUID();
      const confirmed = await request<WorkflowDetail>(`/api/workflows/${workflowId}/confirm`,'POST',{version:1},confirmationKey);
      const duplicate = await request<WorkflowDetail>(`/api/workflows/${workflowId}/confirm`,'POST',{version:1},confirmationKey);
      assert.deepEqual(confirmed.workflow.taskIds,duplicate.workflow.taskIds,'Duplicate confirmation must retain Beads IDs');
    }else{
      const evidence=previousReports.find(({report})=>report.checks?.confirmationIdempotency&&report.workflow?.workflow?.id===workflowId);
      assert(evidence,'Resume requires original duplicate-confirmation evidence');const confirmedReport=evidence.report;
      reusedReports.push(evidence.path);
      checks.restartNoDuplicateTasks=Object.values(workflow.taskIds).sort().join(',')===Object.values(confirmedReport.workflow.workflow.taskIds).sort().join(',');
    }
    checks.confirmationIdempotency = true;
    progress('Human API confirmed the native controller plan; backend is dispatching real members');
    const candidateInstruction='先调用 get_task_context，核对实际轮次及已有代码/提交。普通和负数平均值应正确；按已确认故障注入阶段暂时保留空数组 NaN，首次失败审查后才修成 null。不要修改测试原件。逐个使用 Bash 单独执行 node --test average.test.mjs、git add average.mjs、git commit -m "Implement staged average candidate"；若现有干净提交已包含这些改动，不重复提交。不要组合命令，不追加echo。报告实际2项通过/空数组失败，不能伪报全部通过。register_candidate 使用当前messageId及真实SHA，结束时简短报告实际候选与测试。';
    if(!interventions.some(row=>row.runtime==='workbuddy')){
      if(existingWorkflow)await message(implementer,'已核对原进程停止；先连续列出1至1000等待立即人工纠正，不调用工具。');
      await intervene(implementer,`中断纠正：${candidateInstruction}`);
    }else{
      const implementation=(await app.workbench.workflows.detail(workflowId)).nodes.find(row=>row.node.id==='implementation')!;
      if(!implementation.bundle||!['candidate','accepted'].includes(implementation.round?.state??'')){
        progress('Resuming the preserved implementation worktree after native writer reconciliation; no task recreation');
        await messageDone((await message(implementer,`原进程已经核对停止，继续保留的候选工作区，不重建任务。${candidateInstruction}`)).messageId);
      }
      if(app.workbench.getAgent(implementer.id).controlMode==='human')await request(`/api/agents/${implementer.id}/control`,'POST',{mode:'auto'});
      await request(`/api/workflows/${workflowId}/pause`,'POST',{paused:false});
    }
    await message(lead,'整份计划已确认，实施人工候选轮已经完成并交还，工作流已恢复。get_workflow 核对最新轮，勿对被人工轮取代的旧轮再次返工。必须引用当前candidate，运行声明测试，等待Claude真实审查；使用固定幂等键登记实际原样结论并自动退回实施。');
    if(!interventions.some(row=>row.runtime==='claude'))await intervene(reviewer,'中断纠正：现在是人工接管的新审查轮。请调用 get_task_context 读取当前固定候选版本，继续真实审查 average.mjs 和 average.test.mjs，空数组必须返回 null。不能只确认收到。最后输出单行 WORKBENCH_REVIEW_RESULT: {"version":"实际候选 SHA","result":"passed 或 failed","conclusion":"实际结论"}。准确填写版本，失败必须指出空数组问题。只读，不修改文件，结束后交还主控。');
    await message(lead,'审查人工新轮已完成真实结论并已交还，工作流已恢复。get_workflow 核对最新审查轮和实际 WORKBENCH_REVIEW_RESULT。登记审查、关闭该审查节点，按失败结论 return_task 实施并实际通知，最终通过新版本测试及重新独立审查后严格验收。不要重跑旧审查轮。');
    finalWorkflow = await waitFor('native controller acceptance after actual review and rework',async()=>{
      if(failure)throw new Error(failure);
      const detail=await app!.workbench.workflows.detail(workflowId);
      const bad=agents.map(a=>app!.workbench.getAgent(a.id)).find(a=>a.state==='error'||a.state==='unknown');
      if(bad)throw new Error(`${bad.runtime}: ${bad.lastError??bad.state}`);
      return detail.workflow.status==='completed'?detail:undefined;
    },600_000);
    const candidate = finalWorkflow.nodes.find(row=>row.node.id==='implementation')!.bundle!;
    assert(candidate,'Accepted implementation needs a concrete bundle');
    assert(finalWorkflow.evidence.some(row=>row.kind==='review'&&row.result==='failed'),'Actual rejected review missing');
    assert(finalWorkflow.evidence.some(row=>row.kind==='review'&&row.result==='passed'&&row.version===candidate.version),'Current candidate lacks passing review');
    assert(finalWorkflow.evidence.some(row=>row.kind==='test'&&row.exitCode===0&&row.version===candidate.version),'Current candidate lacks actual passing test');
    assert(finalWorkflow.integration?.integratedBundleIds.includes(candidate.id),'Accepted candidate must reach isolated integration branch');
    const integrationCheck = await request<IntegrationRecord>(`/api/workflows/${workflowId}/integration/check`,'POST',{command:process.execPath,args:['--test','average.test.mjs']});
    assert.equal(integrationCheck.state,'verified');
    const finalCheck=integrationCheck.checks.at(-1);
    assert(finalCheck,'Integration response must include its actual test receipt');
    assert.equal(finalCheck.commit,integrationCheck.headCommit);
    assert.equal(finalCheck.exitCode,0);
    await waitFor('all native final results and completion notices after acceptance',()=>nativeFinalizationPending(app!.workbench.store,agents.map(agent=>agent.id))?undefined:true,180_000);
    checks.nativeFinalTurnsConfirmed = true;
    assert.equal(await runCommand('git',['rev-parse','HEAD'],repository),baseline,'Acceptance must not update original main without delivery confirmation');
    assert((await readFile(join(repository,'average.mjs'),'utf8')).includes('Number.NaN'),'Original fixture must stay unchanged before delivery');
    checks.realThreeRuntimeWorkflow = agents.every(agent=>events.some(event=>event.agentId===agent.id&&event.type==='runtime.result'));
    checks.threeChineseInterruptions = interventions.length===3;
    checks.versionBoundRework = true; checks.integrationTest = true; checks.originalTargetPreserved = true;
    checks.nativeControllerAcceptance = events.some(event=>event.agentId===lead.id&&event.type==='runtime.tool'&&JSON.stringify(event.data).includes('accept_task'));
    assert(Object.values(checks).every(Boolean),'One or more real acceptance checks failed');
    progress('Real workflow reached an accepted and tested integration candidate; original target remains unchanged');
  } catch (error) {
    failure = app ? app.workbench.publicError(error) : error instanceof Error ? error.message : String(error);
    process.exitCode = 1; progress(`Acceptance incomplete: ${failure}`);
  } finally {
    if(approvalTimer)clearInterval(approvalTimer);
    if(app && workflowId)finalWorkflow=await app.workbench.workflows.detail(workflowId).catch(()=>finalWorkflow);
    const usage=app?.workbench.usage.records()??[];
    const runtimes=app?.workbench.agents().map(agent=>({id:agent.id,runtime:agent.runtime,nativeSessionId:agent.nativeSessionId,model:agent.observedModel,provider:agent.observedProvider,state:agent.state}))??[];
    await app?.close();
    const supplementalEvidence:Record<string,unknown>={};
    for(const name of ['review-source-repair.json','supplemental-scoped-approvals.json'])try{supplementalEvidence[name]=JSON.parse(await readFile(join(directory,name),'utf8'));}catch{}
    const report={checkedAt:new Date().toISOString(),passed:!failure&&Object.values(checks).every(Boolean),fixture:directory,scope:'Real native runtimes with existing authentication; isolated synthetic repository. Includes explicitly staged fault injection. No target-branch delivery or account switching.',failure,checks,reusedReports,supplementalEvidence,interventions,approvalReceipts,verificationReceipts,runtimes,workflow:finalWorkflow,usage,events:events.filter(event=>!['runtime.delta','runtime.tool'].includes(event.type))};
    await writeFile(reportPath,JSON.stringify(report,null,2),'utf8');
    progress(`Report: ${reportPath}`);
  }
}
