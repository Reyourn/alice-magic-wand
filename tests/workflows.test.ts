import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, Project, Task, TaskBinding } from '../src/shared/types.js';
import type { WorkflowDispatchInput, WorkflowNode } from '../src/shared/workflows.js';
import { Store } from '../src/server/store.js';
import { WorkflowManager, executeCheck, fileHash, validatePlan } from '../src/server/workflows/index.js';
import type { GitRepository, TaskCreateInput, TaskRepository } from '../src/server/repositories.js';

class MemoryTasks implements TaskRepository {
  values=new Map<string,Task>();creations=0;loseReceipt=false;
  async validate(){}
  async list(){return [...this.values.values()];}
  async get(_project:Project,id:string){const task=this.values.get(id);if(!task)throw new Error('not found');return task;}
  async create(project:Project,input:TaskCreateInput){this.creations++;const task:Task={id:input.id??`task-${this.creations}`,projectId:project.id,title:input.title,description:input.description??'',acceptance:input.acceptance??'',dependencies:input.dependencies??[],status:'open'};this.values.set(task.id,task);if(this.loseReceipt){this.loseReceipt=false;throw new Error('write succeeded, response lost');}return task;}
  async update(project:Project,id:string,fields:{status?:string;owner?:string;reason?:string}){const task=await this.get(project,id);Object.assign(task,fields);return task;}
}
class NoGit implements GitRepository {
  async validate(path:string){return path;}
  async createWorktree():Promise<TaskBinding>{throw new Error('office must not create a git worktree');}
  async inspect(){return {commit:'a'.repeat(40),dirty:false,diff:''};}
  async resolveCommit(_project:Project,ref:string){return ref;}
}
const cleanup:(()=>void)[]=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'awb-workflows-'));cleanup.push(()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true,maxRetries:3});});
  const original=join(root,'original');mkdirSync(original);const store=new Store(':memory:');cleanup.push(()=>store.close());const tasks=new MemoryTasks();
  const project:Project={id:'office',name:'Office',kind:'office',path:original,createdAt:new Date().toISOString()};
  const agent:Agent={id:'analyst',projectId:project.id,name:'Analyst',role:'data',runtime:'codex',model:'',instructions:'',permissionMode:'workspace-write',controlMode:'auto',state:'idle',createdAt:new Date().toISOString()};
  const reviewer:Agent={...agent,id:'reviewer',name:'Reviewer',permissionMode:'read-only'};const agents=new Map([[agent.id,agent],[reviewer.id,reviewer]]);
  const sent:WorkflowDispatchInput[]=[],notices:string[]=[],events:string[]=[];let failDispatch=false;
  const options={store,tasks,git:new NoGit(),dataDir:join(root,'data'),getProject:()=>project,getAgent:(id:string)=>{const value=agents.get(id);if(!value)throw new Error('missing agent');return value;},dispatch:async(input:WorkflowDispatchInput)=>{sent.push(input);if(failDispatch)throw new Error('unknown delivery');return {messageId:`message-${input.roundId}`};},notifyController:async(_id:string,text:string)=>{notices.push(text);},event:(type:string)=>{events.push(type);}};
  return {root,original,project,agent,reviewer,store,tasks,manager:new WorkflowManager(options),options,sent,notices,events,fail:()=>{failDispatch=true;}};
}
const node=(id='analysis',extra:Partial<WorkflowNode>={}):WorkflowNode=>({id,title:id,description:'分析原始数据',acceptance:'输出可复核报告',agentId:'analyst',kind:'task',dependencies:[],requiredCapabilities:[],inputs:[],checks:[{id:'open',label:'可打开',kind:'file'}],...extra});
async function completeFiles(f:ReturnType<typeof fixture>,workflowId:string,nodeId='analysis',text='report'){await f.manager.advance(workflowId);const round=(await f.manager.detail(workflowId)).nodes.find(view=>view.node.id===nodeId)!.round!;const sent=f.sent.find(item=>item.roundId===round.id)!;const path=join(sent.workspace!,'outputs','result.txt');writeFileSync(path,text);await f.manager.completeRound(round.id,{messageId:`message-${round.id}`,worktree:sent.workspace,files:[path],output:text});return (await f.manager.detail(workflowId)).nodes.find(view=>view.node.id===nodeId)!.bundle!;}

describe('workflow plans and durable dispatch',()=>{
  it('rejects cyclic plans, undeclared dependencies and candidate edges on ordinary work',()=>{
    expect(()=>validatePlan([node('a',{dependencies:[{nodeId:'b',kind:'accepted'}]}),node('b',{dependencies:[{nodeId:'a',kind:'accepted'}]})])).toThrow('循环');
    expect(()=>validatePlan([node('a',{dependencies:[{nodeId:'missing',kind:'accepted'}]})])).toThrow('依赖');
    expect(()=>validatePlan([node('a'),node('b',{dependencies:[{nodeId:'a',kind:'candidate'}]})])).toThrow('独立审查');
  });
  it('requires explicit plan confirmation, reconciles created tasks after lost responses and layout never executes',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});
    await expect(f.manager.advance(workflow.id)).rejects.toThrow('确认');f.tasks.loseReceipt=true;
    await f.manager.confirm(workflow.id,1);await f.manager.confirm(workflow.id,1);expect(f.tasks.creations).toBe(1);expect(f.sent).toHaveLength(0);
    f.manager.saveLayout(workflow.id,{analysis:{x:4,y:5}});expect(f.sent).toHaveLength(0);
    await Promise.all([f.manager.advance(workflow.id),f.manager.advance(workflow.id)]);expect(f.sent).toHaveLength(1);
    expect((await f.manager.detail(workflow.id)).rounds[0]!.state).toBe('running');
    expect(()=>f.manager.assertDispatch(f.project.id,f.sent[0]!.taskId)).toThrow('计划');
  });
  it('keeps unknown delivery blocked through restart and never retries with a new key',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);f.fail();await expect(f.manager.advance(workflow.id)).rejects.toThrow('unknown');
    expect(f.sent).toHaveLength(1);const restarted=new WorkflowManager(f.options);restarted.setPaused(workflow.id,false);await restarted.advance(workflow.id);expect(f.sent).toHaveLength(1);
    const round=restarted.rounds(workflow.id)[0]!;expect(round.state).toBe('unknown');
    await expect(restarted.reconcileRound(round.id,{writerStopped:false,messageId:'original'})).rejects.toThrow('停止');
  });
  it('human takeover and pause stop new sends without changing active rounds',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);f.agent.controlMode='human';await f.manager.advance(workflow.id);expect(f.sent).toHaveLength(0);f.agent.controlMode='auto';await f.manager.advance(workflow.id);f.manager.setPaused(workflow.id,true);expect(f.manager.rounds(workflow.id)[0]!.state).toBe('running');await expect(f.manager.advance(workflow.id)).rejects.toThrow('恢复');
  });
});
describe('office snapshots, evidence and rework',()=>{
  it('does not spend automatic rework allowance on human interruption/correction rounds',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);
    let current=f.manager.rounds(workflow.id)[0]!;
    for(let index=0;index<3;index++){
      await f.manager.completeRound(current.id,{messageId:current.messageId,interrupted:true,output:'Stopped'});
      current=await f.manager.beginHumanRound(workflow.id,'analysis',{messageId:`human-${index}`,reason:'Correct instruction',writerStopped:true});
      expect(current.automaticReworkCount).toBe(0);
    }
    await f.manager.completeRound(current.id,{messageId:current.messageId,failed:true,output:'Failed'});
    for(let count=1;count<=2;count++){
      current=await f.manager.rework(workflow.id,'analysis',{sourceRoundId:current.id,reason:'Automatic correction'});expect(current.automaticReworkCount).toBe(count);
      f.manager.setPaused(workflow.id,false);await f.manager.advance(workflow.id);current=f.manager.rounds(workflow.id).at(-1)!;
      await f.manager.completeRound(current.id,{messageId:current.messageId,failed:true,output:'Failed'});
    }
    await expect(f.manager.rework(workflow.id,'analysis',{sourceRoundId:current.id,reason:'Third automatic correction'})).rejects.toThrow('上限');
    const human=await f.manager.rework(workflow.id,'analysis',{sourceRoundId:current.id,reason:'Explicit human override',humanOverride:true});expect(human.automaticReworkCount).toBe(2);
  });
  it('marks a live writer unknown without inventing a terminal receipt and blocks another dispatch',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);const round=f.manager.rounds(workflow.id)[0]!;
    expect((await f.manager.markUncertain(round.id,'Transport lost')).state).toBe('unknown');expect(f.manager.get(workflow.id).status).toBe('blocked');expect(f.store.get('workflow_run_receipts',round.id)).toBeUndefined();
    f.manager.setPaused(workflow.id,false);await f.manager.advance(workflow.id);expect(f.sent).toHaveLength(1);
    await f.manager.reconcileRound(round.id,{writerStopped:true,messageId:round.messageId!,failed:true,error:'Stopped without success evidence'});expect((await f.manager.markUncertain(round.id,'Late transport error')).state).toBe('failed');
  });
  it('snapshots selected inputs, preserves originals, uses fixed output hashes and requires actual file checks',async()=>{
    const f=fixture(),path=join(f.original,'source.csv');writeFileSync(path,'name,value\na,1\n');const before=fileHash(path),snapshot=f.manager.office.snapshotInputs(f.project,[path]);
    const workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node('analysis',{inputs:[snapshot.id]})]});await f.manager.confirm(workflow.id,1);const bundle=await completeFiles(f,workflow.id);
    expect(fileHash(path)).toBe(before);expect(readFileSync(join(f.sent[0]!.workspace!,'inputs','snapshots',snapshot.id,'source.csv'),'utf8')).toContain('a,1');
    await expect(f.manager.accept(workflow.id,'analysis')).rejects.toThrow('尚未通过');await f.manager.recordFileCheck(bundle.id,'open');await f.manager.accept(workflow.id,'analysis');expect(f.manager.get(workflow.id).status).toBe('completed');expect(f.manager.get(workflow.id).status).not.toBe('delivered');
    writeFileSync(path,'new source');expect(f.manager.office.checkInputs(snapshot.id)).toEqual({unchanged:false,changed:['source.csv']});
  });
  it('actual nonzero checks cannot be claimed successful; terminal receipt survives early candidate registration',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Test',goal:'Verify',nodes:[node('analysis',{checks:[{id:'test',label:'test',kind:'test'}]})]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);const round=f.manager.rounds(workflow.id)[0]!,workspace=f.sent[0]!.workspace!,path=join(workspace,'outputs','result.txt');writeFileSync(path,'result');
    const bundle=await f.manager.recordBundle(round.id,{worktree:workspace,files:[path]});await f.manager.completeRound(round.id,{messageId:`message-${round.id}`,worktree:workspace,output:'real native terminal'});
    expect(f.store.get<{output:string}>('workflow_run_receipts',round.id)?.output).toBe('real native terminal');
    const evidence=await f.manager.runCheck(bundle.id,{requirementId:'test',command:process.execPath,args:['-e','process.exit(7)']});expect(evidence.exitCode).toBe(7);expect(evidence.result).toBe('failed');await expect(f.manager.accept(workflow.id,'analysis')).rejects.toThrow('尚未通过');
  });
  it('rework preserves versioned evidence, actually notifies controller and sends correction next round',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);const first=await completeFiles(f,workflow.id);await f.manager.recordFileCheck(first.id,'open');
    const next=await f.manager.rework(workflow.id,'analysis',{sourceBundleId:first.id,reason:'必须修正总计'});expect(next.number).toBe(2);expect(f.notices[0]).toContain('必须修正总计');await expect(f.manager.assertBundleCurrent(first)).rejects.toThrow('过期');const second=await completeFiles(f,workflow.id,'analysis','fixed');
    expect(f.sent[1]!.instructions).toContain('必须修正总计');expect(second.id).not.toBe(first.id);await expect(f.manager.accept(workflow.id,'analysis')).rejects.toThrow('尚未通过');expect(f.manager.evidence(first.id)).toHaveLength(1);
  });
  it('restarts failed stopped work only through an explicit new round referring to its receipt',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);const first=f.manager.rounds(workflow.id)[0]!;await f.manager.completeRound(first.id,{messageId:`message-${first.id}`,failed:true,error:'model unavailable',output:'failure'});expect(f.manager.get(workflow.id).status).toBe('blocked');await expect(f.manager.rework(workflow.id,'analysis',{reason:'retry'})).rejects.toThrow('回执');const retry=await f.manager.rework(workflow.id,'analysis',{sourceRoundId:first.id,reason:'配置已经修复'});expect(retry.number).toBe(2);await f.manager.advance(workflow.id);expect(f.sent).toHaveLength(2);
  });
  it('keeps a successful native receipt when missing output makes candidate registration fail, then allows tracked rework',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Missing output',goal:'Produce a report',nodes:[node()]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);
    const original=f.manager.rounds(workflow.id)[0]!,workspace=f.sent[0]!.workspace!,kept=join(workspace,'outputs','draft.txt');writeFileSync(kept,'unfinished draft');
    const receipt={messageId:original.messageId,worktree:workspace,files:[join(workspace,'outputs','missing.txt')],output:'Native finished successfully'};
    await expect(f.manager.completeRound(original.id,receipt)).rejects.toThrow('候选成果登记失败');
    const failed=f.manager.rounds(workflow.id)[0]!;expect(failed.state).toBe('failed');expect(failed.candidateBundleId).toBeUndefined();expect(failed.error).toContain('候选成果登记失败');expect(failed.completedAt).toBeTruthy();expect(f.manager.get(workflow.id).status).toBe('blocked');expect(f.events).toContain('workflow.attention');
    expect(f.store.get('workflow_run_receipts',original.id)).toMatchObject({messageId:original.messageId,output:receipt.output,failed:false,interrupted:false});expect(readFileSync(kept,'utf8')).toBe('unfinished draft');
    expect((await f.manager.completeRound(original.id,receipt)).state).toBe('failed');await expect(f.manager.accept(workflow.id,'analysis')).rejects.toThrow('不能验收');
    const retry=await f.manager.rework(workflow.id,'analysis',{sourceRoundId:original.id,reason:'补齐缺失文件'});expect(retry.sourceRoundId).toBe(original.id);expect(retry.worktree).toBe(workspace);await f.manager.advance(workflow.id);expect(f.sent[1]!.roundId).toBe(retry.id);expect(f.sent[1]!.instructions).toContain('补齐缺失文件');expect(readFileSync(kept,'utf8')).toBe('unfinished draft');
  });
  it('independent review is pinned to real structured receipt and gets a new round after rework',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node('analysis',{checks:[{id:'review',label:'独立复核',kind:'review'}]}),node('review',{kind:'review',agentId:'reviewer',dependencies:[{nodeId:'analysis',kind:'candidate'}],checks:[]})]});await f.manager.confirm(workflow.id,1);const bundle=await completeFiles(f,workflow.id);await f.manager.advance(workflow.id);const round=f.manager.rounds(workflow.id).find(item=>item.nodeId==='review')!;
    const output=`WORKBENCH_REVIEW_RESULT: ${JSON.stringify({version:bundle.version,result:'failed',conclusion:'总计有误'})}`;await f.manager.completeRound(round.id,{messageId:`message-${round.id}`,worktree:f.sent[1]!.workspace,output});
    await expect(f.manager.recordReview(bundle.id,{requirementId:'review',reviewRoundId:round.id,result:'passed',conclusion:'总计有误'})).rejects.toThrow('一致');
    await f.manager.recordReview(bundle.id,{requirementId:'review',reviewRoundId:round.id,result:'failed',conclusion:'总计有误'});await f.manager.acceptReviewRound(workflow.id,'review');await f.manager.rework(workflow.id,'analysis',{sourceBundleId:bundle.id,reason:'修正总计'});const second=await completeFiles(f,workflow.id,'analysis','correct');
    const detail=await f.manager.detail(workflow.id),review=detail.nodes.find(item=>item.node.id==='review')!;expect(review.round!.number).toBe(2);expect(review.round!.state).toBe('prepared');expect(review.round!.sourceBundleId).toBe(second.id);expect(review.accepted).toBe(false);
  });
  it('preserves the pinned candidate when a reviewer receives a human correction',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Review',goal:'Review exact candidate',nodes:[node('analysis',{checks:[{id:'review',label:'Review',kind:'review'}]}),node('review',{kind:'review',agentId:'reviewer',dependencies:[{nodeId:'analysis',kind:'candidate'}],checks:[]})]});await f.manager.confirm(workflow.id,1);const bundle=await completeFiles(f,workflow.id);await f.manager.advance(workflow.id);const original=f.manager.rounds(workflow.id).find(item=>item.nodeId==='review')!;
    await f.manager.completeRound(original.id,{messageId:original.messageId,interrupted:true,output:'Stopped'});
    const corrected=await f.manager.beginHumanRound(workflow.id,'review',{messageId:'review-correction',reason:'Check the exact data formula',writerStopped:true});expect(corrected.sourceBundleId).toBe(bundle.id);expect(corrected.worktree).toBe(original.worktree);
    await f.manager.completeRound(corrected.id,{messageId:corrected.messageId,worktree:corrected.worktree,output:`WORKBENCH_REVIEW_RESULT: ${JSON.stringify({version:bundle.version,result:'passed',conclusion:'Checked exact data formula'})}`});
    await expect(f.manager.recordReview(bundle.id,{requirementId:'review',reviewRoundId:corrected.id,result:'passed',conclusion:'Checked exact data formula'})).resolves.toMatchObject({reviewRoundId:corrected.id,version:bundle.version});
  });
  it('makes a stopped-task reassignment a new unconfirmed plan and preserves completed nodes',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Reassign',goal:'Preserve handoff',nodes:[node(),node('done',{agentId:'reviewer'})]});await f.manager.confirm(workflow.id,1);
    const prior=await completeFiles(f,workflow.id),finished=await completeFiles(f,workflow.id,'done');await f.manager.recordFileCheck(finished.id,'open');await f.manager.accept(workflow.id,'done');const before=f.sent.length;
    const next=await f.manager.rework(workflow.id,'analysis',{sourceBundleId:prior.id,agentId:f.reviewer.id,reason:'New specialist',humanOverride:true});expect(next.planVersion).toBe(2);expect(next.sourceBundleId).toBe(prior.id);
    const draft=await f.manager.detail(workflow.id);expect(draft.workflow.status).toBe('draft');expect(draft.workflow.confirmedVersion).toBe(1);expect(draft.plan.nodes[0]!.agentId).toBe(f.reviewer.id);expect(draft.nodes[0]!.owner).toBe(f.agent.id);expect(draft.nodes.find(view=>view.node.id==='done')!.accepted).toBe(true);
    await expect(f.manager.advance(workflow.id)).rejects.toThrow('确认');await expect(f.manager.beginHumanRound(workflow.id,'analysis',{messageId:'bypass',reason:'Bypass',writerStopped:true})).rejects.toThrow('已确认');expect(f.sent).toHaveLength(before);
    await f.manager.confirm(workflow.id,2);expect((await f.manager.detail(workflow.id)).nodes[0]!.owner).toBe(f.reviewer.id);await f.manager.advance(workflow.id);expect(f.sent).toHaveLength(before+1);expect(f.sent.at(-1)!.agentId).toBe(f.reviewer.id);expect(f.manager.bundles(workflow.id)).toContainEqual(prior);
  });
  it('rejects corrupted Office files instead of claiming any nonempty file can open',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Report',goal:'Analyse',nodes:[node()]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);const round=f.manager.rounds(workflow.id)[0]!,path=join(f.sent[0]!.workspace!,'outputs','bad.xlsx');writeFileSync(path,'not a workbook');await f.manager.completeRound(round.id,{worktree:f.sent[0]!.workspace,files:[path]});const bundle=f.manager.bundles(workflow.id)[0]!;await expect(f.manager.recordFileCheck(bundle.id,'open')).rejects.toThrow();expect(f.manager.evidence(bundle.id)).toHaveLength(0);
  });
});
describe('server executed checks',()=>{
  it('redacts secrets in actual command output',async()=>{const f=fixture();const result=await executeCheck(f.root,process.execPath,['-e','console.log("API_KEY=should-not-leak")']);expect(result.log).not.toContain('should-not-leak');expect(result.log).toContain('REDACTED');});
  it('confirms a timed out owned process tree has stopped before releasing a descendant write gate',async()=>{
    const f=fixture(),marker=join(f.root,'orphan.txt'),gate=join(f.root,'after-stop.txt');
    const childScript=`const fs=require('fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){fs.writeFileSync(${JSON.stringify(marker)},'orphan');process.exit();}},25);setTimeout(()=>process.exit(),5000);`;
    const script=`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});console.log('OWNED_PIDS:'+JSON.stringify([process.pid,child.pid]));setTimeout(()=>{},5000);`;
    const result=await executeCheck(f.root,process.execPath,['-e',script],150);expect(result.exitCode).toBe(124);
    // Windows taskkill /T may take more than a second under parallel test load.
    // Writes before its completion are not proof of an orphan; check the stop
    // acknowledgement boundary and every PID that the child actually reported.
    const pids=result.log.match(/OWNED_PIDS:(\[[\d,]+\])/);
    if(pids)for(const pid of JSON.parse(pids[1]!) as number[])expect(()=>process.kill(pid,0),`owned PID ${pid} survives the stop acknowledgement`).toThrow();
    writeFileSync(gate,'stopping has completed');await new Promise(done=>setTimeout(done,150));
    expect(existsSync(marker)).toBe(false);
  });
});

describe('workflow acceptance and correction invariants',()=>{
  it.each(['analysis','human'])('rechecks the reopened %s task before office delivery can create any output or receipt',async reopenedNode=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Reopened',goal:'Do not deliver old acceptance',nodes:[node(),node('human',{kind:'manual',agentId:undefined,dependencies:[{nodeId:'analysis',kind:'accepted'}],checks:[{id:'approve',label:'Approve',kind:'manual'}]})]});
    await f.manager.confirm(workflow.id,1);const bundle=await completeFiles(f,workflow.id);
    await f.manager.recordFileCheck(bundle.id,'open');await f.manager.accept(workflow.id,'analysis');await f.manager.resolveManual(workflow.id,'human','Checked current files');
    expect(f.manager.get(workflow.id).status).toBe('completed');
    await f.tasks.update(f.project,f.manager.get(workflow.id).taskIds[reopenedNode]!,{status:'open',reason:'Acceptance must be repeated'});
    await expect(f.manager.deliverOffice(workflow.id,[bundle.id])).rejects.toThrow('重新打开');
    expect(existsSync(join(f.options.dataDir,'deliveries'))).toBe(false);
    expect(f.store.all('file_deliveries')).toEqual([]);expect(f.manager.get(workflow.id).status).toBe('completed');
  });
  it('carries a nested HTML prototype through downstream input and delivery without flattening assets',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Prototype',goal:'Keep relative resources',nodes:[node(),node('followup',{dependencies:[{nodeId:'analysis',kind:'accepted'}]})]});
    await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);
    const round=f.manager.rounds(workflow.id)[0]!,workspace=f.sent[0]!.workspace!;
    const payloads:Record<string,string|Buffer>={
      'pages/index.html':'<link rel="stylesheet" href="../assets/style.css"><img src="../left/icon.png"><img src="../right/icon.png"><script type="module" src="../assets/app.js"></script>',
      'assets/style.css':'body { color: #fff; }',
      'assets/app.js':'document.body.dataset.ready = "yes";',
      'left/icon.png':Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a63sAAAAASUVORK5CYII=','base64'),
      'right/icon.png':Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a63sAAAAASUVORK5CYII=','base64'),
    };
    const paths=Object.entries(payloads).map(([relative,bytes])=>{const path=join(workspace,'outputs',relative);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return path;});
    await f.manager.completeRound(round.id,{messageId:round.messageId,worktree:workspace,files:paths,output:'Prototype complete'});
    const bundle=f.manager.bundles(workflow.id)[0]!,before=JSON.stringify(bundle);
    const check=await f.manager.recordFileCheck(bundle.id,'open');expect(check.conclusion).toContain('未解码或验证显示效果');expect(check.conclusion).toContain('视觉结果需通过其他验收项');
    await f.manager.accept(workflow.id,'analysis');await f.manager.advance(workflow.id);
    const downstream=f.sent.find(item=>item.nodeId==='followup')!;
    for(const [relative,bytes] of Object.entries(payloads))expect(readFileSync(join(downstream.workspace!,'inputs','bundles',bundle.id,relative)).equals(Buffer.from(bytes))).toBe(true);
    const second=await completeFiles(f,workflow.id,'followup');await f.manager.recordFileCheck(second.id,'open');await f.manager.accept(workflow.id,'followup');
    const delivery=await f.manager.deliverOffice(workflow.id,[bundle.id,second.id]);
    for(const [relative,bytes] of Object.entries(payloads)){
      const delivered=delivery.files.find(file=>file.relativePath===`analysis/${bundle.id}/${relative}`)!;
      expect(readFileSync(delivered.path).equals(Buffer.from(bytes))).toBe(true);
    }
    expect(JSON.stringify(f.manager.bundles(workflow.id).find(item=>item.id===bundle.id))).toBe(before);
    const manifest=JSON.parse(readFileSync(join(delivery.directory,'manifest.json'),'utf8'));
    expect(manifest.files.map((file:{fileName:string})=>file.fileName)).toContain(`analysis/${bundle.id}/assets/app.js`);
    expect((await f.manager.deliverOffice(workflow.id,[bundle.id,second.id])).id).toBe(delivery.id);
  });
  it('versions a renamed output path even when its bytes are identical',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Versioned paths',goal:'Pin filenames as well as bytes',nodes:[node()]});
    await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);
    const round=f.manager.rounds(workflow.id)[0]!,workspace=f.sent[0]!.workspace!;
    const first=join(workspace,'outputs','first.css'),second=join(workspace,'outputs','second.css');writeFileSync(first,'body{}');writeFileSync(second,'body{}');
    const a=await f.manager.recordBundle(round.id,{worktree:workspace,files:[first]});
    const b=await f.manager.recordBundle(round.id,{worktree:workspace,files:[second]});
    expect(a.files[0]!.sha256).toBe(b.files[0]!.sha256);expect(a.version).not.toBe(b.version);
    expect(f.manager.bundles(workflow.id).find(bundle=>bundle.id===a.id)).toEqual(a);
  });
  it('does not accept an early candidate while the writer is still running, and repeated completion is immutable',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Early candidate',goal:'Verify terminal proof',nodes:[node()]});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);
    const round=f.manager.rounds(workflow.id)[0]!,workspace=f.sent[0]!.workspace!,path=join(workspace,'outputs','result.txt');writeFileSync(path,'report');
    await f.manager.recordBundle(round.id,{worktree:workspace,files:[path]});expect(f.manager.rounds(workflow.id)[0]!.state).toBe('running');await expect(f.manager.accept(workflow.id,'analysis',{manualExceptions:[{requirementId:'open',reason:'checked'}]})).rejects.toThrow('执行');
    const receipt={messageId:`message-${round.id}`,worktree:workspace,files:[path],output:'native terminal'};await f.manager.completeRound(round.id,receipt);const count=f.manager.bundles(workflow.id).length;await f.manager.completeRound(round.id,receipt);expect(f.manager.bundles(workflow.id)).toHaveLength(count);await expect(f.manager.completeRound(round.id,{...receipt,output:'different'})).rejects.toThrow('不能');
  });
  it('limits new writers across workflows and keeps a manual gate blocked until prerequisites are accepted',async()=>{
    const f=fixture(),workflows=[];for(let index=0;index<4;index++){const agent={...f.agent,id:`analyst-${index}`};const old=f.options.getAgent;f.options.getAgent=id=>id===agent.id?agent:old(id);const workflow=f.manager.createDraft({projectId:f.project.id,name:`Report ${index}`,goal:'Capacity',nodes:[node('analysis',{agentId:agent.id})]});await f.manager.confirm(workflow.id,1);workflows.push(workflow);}
    const results=await Promise.allSettled(workflows.map(workflow=>f.manager.startRound(workflow.id,'analysis')));expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(3);expect(f.sent).toHaveLength(3);
    const isolated=fixture(),workflow=isolated.manager.createDraft({projectId:isolated.project.id,name:'Gate',goal:'Manual check',nodes:[node(),node('human',{kind:'manual',agentId:undefined,dependencies:[{nodeId:'analysis',kind:'accepted'}],checks:[{id:'approve',label:'Approve',kind:'manual'}]})]});await isolated.manager.confirm(workflow.id,1);await expect(isolated.manager.resolveManual(workflow.id,'human','approved')).rejects.toThrow('前置');const bundle=await completeFiles(isolated,workflow.id);await isolated.manager.recordFileCheck(bundle.id,'open');await isolated.manager.accept(workflow.id,'analysis');await isolated.manager.resolveManual(workflow.id,'human','reviewed exact result');expect(isolated.manager.get(workflow.id).status).toBe('completed');
  });
  it('starts a tracked human correction only after terminal acknowledgement and preserves the old workspace',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Correction',goal:'Interrupt then fix',nodes:[node()],maxReworkRounds:0});await f.manager.confirm(workflow.id,1);await f.manager.advance(workflow.id);const original=f.manager.rounds(workflow.id)[0]!;
    await expect(f.manager.beginHumanRound(workflow.id,'analysis',{messageId:'human-message',reason:'correct total',writerStopped:true})).rejects.toThrow('停止');await f.manager.completeRound(original.id,{messageId:`message-${original.id}`,worktree:f.sent[0]!.workspace,interrupted:true,output:'stopped'});
    await expect(f.manager.beginHumanRound(workflow.id,'analysis',{messageId:'wrong-member',reason:'correct total',writerStopped:true,agentId:f.reviewer.id})).rejects.toThrow('负责人');
    const corrected=await f.manager.beginHumanRound(workflow.id,'analysis',{messageId:'human-message',reason:'correct total',writerStopped:true,agentId:f.agent.id});expect(corrected.number).toBe(2);expect(corrected.worktree).toBe(f.sent[0]!.workspace);expect(corrected.sourceRoundId).toBe(original.id);expect(f.manager.get(workflow.id).status).toBe('paused');expect((await f.manager.beginHumanRound(workflow.id,'analysis',{messageId:'human-message',reason:'correct total',writerStopped:true,agentId:f.agent.id})).id).toBe(corrected.id);
  });
  it('enforces automatic rework limit and carries prior output and all snapshots into the next office round',async()=>{
    const f=fixture(),one=join(f.original,'one.csv'),two=join(f.original,'two.csv');writeFileSync(one,'one');writeFileSync(two,'two');const firstInput=f.manager.office.snapshotInputs(f.project,[one]),secondInput=f.manager.office.snapshotInputs(f.project,[two]);const workflow=f.manager.createDraft({projectId:f.project.id,name:'Multiple inputs',goal:'Rework bounded',nodes:[node('analysis',{inputs:[firstInput.id,secondInput.id]})]});await f.manager.confirm(workflow.id,1);
    let bundle=await completeFiles(f,workflow.id);const firstBundleId=bundle.id;expect(bundle.inputSnapshotIds).toEqual([firstInput.id,secondInput.id]);await f.manager.rework(workflow.id,'analysis',{sourceBundleId:bundle.id,reason:'round two'});bundle=await completeFiles(f,workflow.id,'analysis','second');expect(readFileSync(join(f.sent[1]!.workspace!,'inputs','bundles',firstBundleId,'result.txt'),'utf8')).toBe('report');await f.manager.rework(workflow.id,'analysis',{sourceBundleId:bundle.id,reason:'round three'});bundle=await completeFiles(f,workflow.id,'analysis','third');await expect(f.manager.rework(workflow.id,'analysis',{sourceBundleId:bundle.id,reason:'round four'})).rejects.toThrow('上限');expect(f.events).toContain('workflow.attention');
    await f.manager.recordFileCheck(bundle.id,'open');await f.manager.accept(workflow.id,'analysis');await expect(f.manager.deliverOffice(workflow.id,[])).rejects.toThrow('所有');writeFileSync(two,'changed');await expect(f.manager.deliverOffice(workflow.id,[bundle.id])).rejects.toThrow('原始输入');writeFileSync(two,'two');const delivered=await f.manager.deliverOffice(workflow.id,[bundle.id]);expect(delivered.files.map(file=>fileHash(file.path))).toEqual(delivered.files.map(file=>file.sha256));expect(readFileSync(one,'utf8')).toBe('one');expect(readFileSync(two,'utf8')).toBe('two');
  });
  it('only revises unexecuted nodes and does not rerun an accepted node when confirming a new plan',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Revision',goal:'Keep completed result',nodes:[node(),node('future',{dependencies:[{nodeId:'analysis',kind:'accepted'}]})]});await f.manager.confirm(workflow.id,1);const bundle=await completeFiles(f,workflow.id);await f.manager.recordFileCheck(bundle.id,'open');await f.manager.accept(workflow.id,'analysis');const nodes=(await f.manager.detail(workflow.id)).plan.nodes;
    expect(()=>f.manager.revise(workflow.id,{nodes:nodes.map(value=>value.id==='analysis'?{...value,description:'replace completed work'}:value)})).toThrow('执行轮次');f.manager.revise(workflow.id,{nodes:nodes.map(value=>value.id==='future'?{...value,description:'additional checked requirement'}:value)});await expect(f.manager.advance(workflow.id)).rejects.toThrow('确认');await f.manager.confirm(workflow.id,2);await f.manager.advance(workflow.id);expect(f.sent.map(item=>item.nodeId)).toEqual(['analysis','future']);
  });
  it('marks evidence stale when fixed bytes change and does not show or deliver that candidate as accepted',async()=>{
    const f=fixture(),workflow=f.manager.createDraft({projectId:f.project.id,name:'Evidence freshness',goal:'Exact bytes',nodes:[node()]});await f.manager.confirm(workflow.id,1);const bundle=await completeFiles(f,workflow.id);await f.manager.recordFileCheck(bundle.id,'open');await f.manager.accept(workflow.id,'analysis');writeFileSync(bundle.files[0]!.path,'unreviewed replacement');const detail=await f.manager.detail(workflow.id);expect(detail.evidence[0]!.stale).toBe(true);expect(detail.evidence[0]!.staleReason).toContain('过期');expect(detail.nodes[0]!.accepted).toBe(false);await expect(f.manager.deliverOffice(workflow.id,[bundle.id])).rejects.toThrow('过期');
  });
});
