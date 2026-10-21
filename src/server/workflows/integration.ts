import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ArtifactBundle, IntegrationCheck, IntegrationRecord } from '../../shared/workflows.js';
import type { Project } from '../../shared/types.js';
import type { Store } from '../store.js';
import { runCommand, WorkbenchError, type GitRepository } from '../repositories.js';
import { safeText } from '../runtime/process.js';

function redact(value:string):string {let text=value;for(const [key,secret]of Object.entries(process.env))if(secret&&secret.length>3&&/token|secret|password|authorization|api.?key/i.test(key))text=text.replaceAll(secret,'[REDACTED]');return safeText(text);}

/** This runs the supplied executable directly. Exit status comes from the child, never an agent assertion. */
export async function executeCheck(cwd:string,command:string,args:string[],timeoutMs=120000):Promise<{exitCode:number;log:string}> {
  if(!command||command.length>1000||args.some(arg=>typeof arg!=='string')||args.length>100)throw new WorkbenchError('检查命令不合法。');
  return new Promise((resolveResult,reject)=>{
    const env={...process.env,NO_COLOR:'1'};
    for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','BEADS_DIR','BEADS_DB','BEADS_DATABASE'])delete (env as NodeJS.ProcessEnv)[key];
    const child=spawn(command,args,{cwd,shell:false,windowsHide:true,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let log='',settled=false,timedOut=false;
    const finish=(exitCode:number)=>{if(settled)return;settled=true;clearTimeout(timer);resolveResult({exitCode,log:redact(log)});};
    const append=(chunk:Buffer)=>{log=(log+chunk.toString()).slice(-100000);};child.stdout.on('data',append);child.stderr.on('data',append);
    const timer=setTimeout(()=>{
      timedOut=true;log+='\n检查超时，已请求终止本次检查进程树。';
      if(process.platform==='win32'&&child.pid){execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000},error=>{if(error&&child.exitCode===null){log+='\n未确认进程树停止，需人工核对。';child.kill();}finish(124);});}
      else {try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}finish(124);}
    },Math.max(100,Math.min(timeoutMs,600000)));
    child.once('error',error=>{clearTimeout(timer);if(!settled){settled=true;reject(new Error(redact(error.message)));}});child.once('close',code=>{if(!timedOut)finish(code??1);});
  });
}
export class IntegrationManager {
  private locks=new Map<string,Promise<unknown>>();
  constructor(private readonly store:Store,private readonly git:GitRepository){
    for(const record of store.all<IntegrationRecord>('workflow_integrations'))if(['integrating','testing'].includes(record.state))this.save({...record,state:'unknown',lastError:'服务重启发生在整合或检查期间；请核对工作区和原进程，禁止重复整合。'});
  }
  get(workflowId:string):IntegrationRecord|undefined{return this.store.get('workflow_integrations',workflowId);}
  private save(value:IntegrationRecord):IntegrationRecord {this.store.put('workflow_integrations',value.id,value);return value;}
  private serial<T>(id:string,work:()=>Promise<T>):Promise<T>{const previous=this.locks.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(work);this.locks.set(id,next);void next.finally(()=>{if(this.locks.get(id)===next)this.locks.delete(id);}).catch(()=>{});return next;}
  async initialize(workflowId:string,project:Project,targetBranch?:string):Promise<IntegrationRecord> {
    return this.serial(workflowId,async()=>{
      const existing=this.get(workflowId);if(existing)return existing;
      if(project.kind==='office')throw new WorkbenchError('办公项目使用版本文件交付。');
      const branch=targetBranch||await runCommand('git',['branch','--show-current'],project.path);
      if(!branch||branch.startsWith('-'))throw new WorkbenchError('请选择一个已有目标分支。');
      await runCommand('git',['check-ref-format','--branch',branch],project.path);
      const baselineCommit=await runCommand('git',['rev-parse','--verify',`refs/heads/${branch}^{commit}`],project.path);
      const binding=await this.git.createWorktree(project,`integration-${workflowId.slice(0,8)}`,'integrator',baselineCommit);
      return this.save({id:workflowId,workflowId,projectId:project.id,targetBranch:branch,baselineCommit,branch:binding.branch,worktree:binding.worktree,headCommit:baselineCommit,state:'ready',integratedBundleIds:[],integratedCommits:[],checks:[]});
    });
  }
  integrate(workflowId:string,bundle:ArtifactBundle):Promise<IntegrationRecord> {
    return this.serial(workflowId,async()=>{
      const record=this.get(workflowId);if(!record)throw new WorkbenchError('尚未创建整合工作区。');
      if(record.integratedBundleIds.includes(bundle.id))return record;
      if(['conflict','unknown','integrating','delivered'].includes(record.state))throw new WorkbenchError('整合工作区需要先处理冲突、恢复或交付状态。',409);
      if(bundle.kind!=='code'||!bundle.candidateCommit||!bundle.startCommit)throw new WorkbenchError('成果缺少代码起点与候选提交。');
      if(bundle.workflowId!==workflowId)throw new WorkbenchError('成果不属于当前工作流。');
      const current=await this.git.inspect(record.worktree);if(current.dirty||current.commit!==record.headCommit)throw new WorkbenchError('整合工作区发生未核对变化。',409);
      try{await runCommand('git',['merge-base','--is-ancestor',bundle.integrationBaseCommit??bundle.startCommit,bundle.candidateCommit],record.worktree);await runCommand('git',['merge-base','--is-ancestor',record.baselineCommit,bundle.candidateCommit],record.worktree);}catch{throw new WorkbenchError('候选提交与已声明起点或工作流基线不一致，不能整合。',409);}
      const commits=(await runCommand('git',['rev-list','--reverse','--topo-order',`${bundle.integrationBaseCommit??bundle.startCommit}..${bundle.candidateCommit}`],record.worktree)).split(/\r?\n/).filter(Boolean);
      this.save({...record,state:'integrating',conflictBundleId:bundle.id,pendingCommits:commits});
      try{
        if(commits.length)await runCommand('git',['-c','user.name=Agent Workbench','-c','user.email=workbench@localhost','cherry-pick',...commits],record.worktree,120000);
        const headCommit=(await this.git.inspect(record.worktree)).commit;
        return this.save({...record,state:'ready',headCommit,integratedBundleIds:[...record.integratedBundleIds,bundle.id],integratedCommits:[...record.integratedCommits,...commits],conflictBundleId:undefined,pendingCommits:undefined,checks:record.checks});
      }catch(error){
        const unresolved=await runCommand('git',['diff','--name-only','--diff-filter=U'],record.worktree).catch(()=>'');
        return this.save({...record,state:unresolved?'conflict':'unknown',conflictBundleId:bundle.id,pendingCommits:commits,lastError:error instanceof Error?error.message:String(error)});
      }
    });
  }
  resolveConflict(workflowId:string):Promise<IntegrationRecord>{
    return this.serial(workflowId,async()=>{
      const record=this.get(workflowId);if(!record||record.state!=='conflict')throw new WorkbenchError('当前没有可继续的整合冲突。');
      const unresolved=await runCommand('git',['diff','--name-only','--diff-filter=U'],record.worktree);if(unresolved)throw new WorkbenchError('仍有未解决的冲突。',409);
      await runCommand('git',['-c','user.name=Agent Workbench','-c','user.email=workbench@localhost','cherry-pick','--continue'],record.worktree,120000);
      const current=await this.git.inspect(record.worktree);if(current.dirty)throw new WorkbenchError('冲突修复后工作区仍有未提交更改。');
      return this.save({...record,state:'ready',headCommit:current.commit,integratedBundleIds:[...record.integratedBundleIds,...(record.conflictBundleId?[record.conflictBundleId]:[])],integratedCommits:[...record.integratedCommits,...(record.pendingCommits??[])],conflictBundleId:undefined,pendingCommits:undefined,lastError:undefined,checks:[],conflictReviewRequired:true,conflictReview:undefined});
    });
  }
  check(workflowId:string,command:string,args:string[]):Promise<IntegrationRecord>{
    return this.serial(workflowId,async()=>{
      const record=this.get(workflowId);if(!record||!['ready','verified'].includes(record.state))throw new WorkbenchError('整合工作区尚不能执行最终检查。',409);
      const before=await this.git.inspect(record.worktree);if(before.dirty||before.commit!==record.headCommit)throw new WorkbenchError('整合版本已变化，请先核对。',409);
      this.save({...record,state:'testing'});
      try{
        const result=await executeCheck(record.worktree,command,args),after=await this.git.inspect(record.worktree);
        const check:IntegrationCheck={id:randomUUID(),commit:before.commit,command,args,...result,createdAt:new Date().toISOString()};
        const checks=[...record.checks,check], valid=result.exitCode===0&&!after.dirty&&after.commit===before.commit;
        return this.save({...record,state:valid?'verified':'ready',checks,lastError:valid?undefined:'检查失败或检查期间版本发生变化。'});
      }catch(error){this.save({...record,state:'ready',lastError:String(error)});throw error;}
    });
  }
  deliver(workflowId:string,project:Project,confirmedCommit:string):Promise<IntegrationRecord>{
    return this.serial(workflowId,async()=>{
      const record=this.get(workflowId);if(!record)throw new WorkbenchError('整合记录不存在。',404);
      if(record.state==='delivered'&&record.deliveredCommit===confirmedCommit)return record;
      if(record.state!=='verified'||confirmedCommit!==record.headCommit)throw new WorkbenchError('请确认当前通过整合测试的确切提交。',409);
      if(record.conflictReviewRequired&&record.conflictReview?.commit!==confirmedCommit)throw new WorkbenchError('冲突修复版本还需要独立审查，原候选审查不能用于交付。',409);
      const [source,target,branch]=await Promise.all([this.git.inspect(record.worktree),this.git.inspect(project.path),runCommand('git',['branch','--show-current'],project.path)]);
      if(source.dirty||source.commit!==confirmedCommit)throw new WorkbenchError('整合候选已变化，原测试和交付确认已失效。',409);
      if(target.dirty||branch!==record.targetBranch||target.commit!==record.baselineCommit)throw new WorkbenchError('目标分支或工作区已变化，请重新核对，未更新原分支。',409);
      await runCommand('git',['merge','--ff-only',confirmedCommit],project.path);
      const delivered=await this.git.inspect(project.path);if(delivered.dirty||delivered.commit!==confirmedCommit)throw new WorkbenchError('交付后的目标分支状态与确认提交不一致，请核对，未标记为已交付。',409);
      return this.save({...record,state:'delivered',deliveredCommit:confirmedCommit,deliveredAt:new Date().toISOString()});
    });
  }
  reconcile(workflowId:string,input:{confirmedCommit:string;reason:string}):Promise<IntegrationRecord>{return this.serial(workflowId,async()=>{
    const record=this.get(workflowId);if(!record||record.state!=='unknown'||!input.reason.trim())throw new WorkbenchError('仅待核对整合可以恢复，且须填写核对说明。',409);
    const current=await this.git.inspect(record.worktree);if(current.dirty||current.commit!==input.confirmedCommit||current.commit!==record.headCommit)throw new WorkbenchError('整合工作区已有变化，必须保留并独立核对修复，不能直接重试。',409);
    const pending=await runCommand('git',['rev-parse','--verify','CHERRY_PICK_HEAD'],record.worktree).then(()=>true,()=>false);if(pending)throw new WorkbenchError('原 cherry-pick 尚未结束，请先处理原整合。',409);
    this.store.put('integration_reconciliations',randomUUID(),{workflowId,commit:current.commit,reason:input.reason,createdAt:new Date().toISOString()});return this.save({...record,state:'ready',checks:[],lastError:undefined});
  });}
  recordReview(workflowId:string,input:NonNullable<IntegrationRecord['conflictReview']>):Promise<IntegrationRecord>{return this.serial(workflowId,async()=>{
    const record=this.get(workflowId);if(!record||!['ready','verified'].includes(record.state)||input.commit!==record.headCommit)throw new WorkbenchError('整合版本已经变化，审查已过期。',409);
    const current=await this.git.inspect(record.worktree);if(current.dirty||current.commit!==input.commit)throw new WorkbenchError('整合工作区在审查期间发生变化，需重新核对。',409);
    return this.save({...record,conflictReview:input});
  });}
}
