import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeliveryAction, DeliveryActionInput, DeliveryCommand } from '../shared/delivery.js';
import type { GitRepository } from './repositories.js';
import { WorkbenchError, runCommand } from './repositories.js';
import type { Store } from './store.js';
import type { WorkflowManager } from './workflows/index.js';
import { executeCheck } from './workflows/integration.js';
import { safeText } from './runtime/process.js';

const now=()=>new Date().toISOString();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string=(value:unknown,label:string,max=1000)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\0\r\n]/.test(value))throw new WorkbenchError(`${label}不合法`);return value.trim();};
const publicText=(text:string)=>safeText(text.replace(/(https?:\/\/)[^\s/@]+@/gi,'$1[REDACTED]@'));
function destinationLabel(value:string):string {
  try {const url=new URL(value);if(['http:','https:','ssh:'].includes(url.protocol)){url.username='';url.password='';url.search='';url.hash='';return url.toString();}}catch{/* Local paths and SCP-style Git remotes have no URL query. */}
  return publicText(value.replace(/^[^/@]+@/,'[user]@'));
}

/** Outbound writes have their own immutable preview and explicit user confirmation.
 * A process failure is potentially partial; it is never silently retried. */
export class DeliveryActions {
  private locks=new Map<string,Promise<unknown>>();
  constructor(private readonly store:Store,private readonly workflows:WorkflowManager,private readonly git:GitRepository) {
    for(const action of this.store.all<DeliveryAction>('delivery_actions'))if(action.state==='running')this.save({...action,state:'unknown',detail:'服务在交付动作期间重启。请核对外部结果，禁止重新执行原动作。'});
  }
  list(workflowId:string):DeliveryAction[]{this.workflows.get(workflowId);return this.store.all<DeliveryAction>('delivery_actions').filter(a=>a.workflowId===workflowId);}
  get(id:string):DeliveryAction {const action=this.store.get<DeliveryAction>('delivery_actions',id);if(!action)throw new WorkbenchError('交付动作不存在',404);return action;}
  private save(action:DeliveryAction){this.store.put('delivery_actions',action.id,action);return action;}
  private async ready(workflowId:string) {
    const detail=await this.workflows.detail(workflowId),integration=detail.integration;
    if(!['completed','delivered'].includes(detail.workflow.status)||!integration||!['verified','delivered'].includes(integration.state))throw new WorkbenchError('请先完成任务验收与当前整合版本的实际测试',409);
    if(detail.nodes.some(view=>!view.accepted||view.bundle?.kind==='code'&&!integration.integratedBundleIds.includes(view.bundle.id)))throw new WorkbenchError('任务或候选成果已变化，须重新验收并整合后交付',409);
    if(integration.conflictReviewRequired&&integration.conflictReview?.commit!==integration.headCommit)throw new WorkbenchError('冲突修复后的整合版本尚未独立审查',409);
    const actual=await this.git.inspect(integration.worktree);
    if(actual.dirty||actual.commit!==integration.headCommit)throw new WorkbenchError('整合成果已变化，原验收与交付预览失效',409);
    if(!integration.checks.some(c=>c.commit===actual.commit&&c.exitCode===0))throw new WorkbenchError('当前整合版本缺少实际通过的测试',409);
    return {detail,integration};
  }
  private async remote(worktree:string,name:string) {
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name))throw new WorkbenchError('请选择已配置的 Git 远端名称');
    const urls=(await runCommand('git',['remote','get-url','--push','--all',name],worktree)).split(/\r?\n/).filter(Boolean);
    if(urls.length!==1)throw new WorkbenchError('首版交付仅支持一个明确的推送地址；请在 Git 中为每个目标配置独立远端');
    const url=urls[0]!;
    return {url,fingerprint:digest(url)};
  }
  private async branch(worktree:string,value:unknown) {const name=string(value,'分支名称',200);if(name.startsWith('-'))throw new WorkbenchError('分支名称不合法');await runCommand('git',['check-ref-format','--branch',name],worktree);return name;}
  async prepare(workflowId:string,body:DeliveryActionInput):Promise<DeliveryAction> {
    const {detail,integration}=await this.ready(workflowId);
    if(!['push','pull-request','deploy'].includes(body.kind))throw new WorkbenchError('未知交付动作');
    let input:DeliveryActionInput={kind:body.kind},remoteFingerprint:string|undefined,destination:string|undefined;const commands:DeliveryCommand[]=[];
    if(body.kind==='deploy') {
      const command=string(body.command,'部署执行程序');
      if(!Array.isArray(body.args)||body.args.length>100||body.args.some(a=>typeof a!=='string'||a.length>20000||a.includes('\0')))throw new WorkbenchError('部署参数必须是字符串数组');
      if([command,...body.args].some(a=>/(?:bearer\s|sk-[a-z0-9]{10,}|(?:api[_-]?key|token|password|secret|authorization)=|^--?(?:api[_-]?key|token|password|secret|authorization|credentials?)$|https?:\/\/[^\s/@]+@)/i.test(a)))throw new WorkbenchError('不要把凭据写入部署参数，使用本机工具已有认证');
      input={kind:body.kind,command,args:body.args};commands.push({command,args:body.args});
    } else {
      const remote=string(body.remote,'远端名称',100),target=await this.remote(integration.worktree,remote);
      remoteFingerprint=target.fingerprint;destination=destinationLabel(target.url);
      const branch=await this.branch(integration.worktree,body.branch);
      input={kind:body.kind,remote,branch};
      // A literal SHA refspec and no force option prevent a later branch move from changing the upload.
      commands.push({command:'git',args:[...(process.platform==='win32'?['-c','core.longpaths=true']:[]),'push',remote,`${integration.headCommit}:refs/heads/${branch}`]});
      if(body.kind==='pull-request') {
        const base=await this.branch(integration.worktree,body.base??integration.targetBranch);
        if(base===branch)throw new WorkbenchError('PR 源分支与目标分支不能相同');
        const title=string(body.title,'PR 标题',300);
        if(typeof body.body!=='string'||body.body.length>50000)throw new WorkbenchError('PR 描述必须是文本');
        // Only derive the repository identity, never retain a URL containing auth data.
        const match=target.url.match(/^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^/@]+@)?|[^/@:]+@)([^/:]+)(?::\d+\/|[:/])([^/]+)\/([^/]+?)(?:\.git)?$/);
        if(!match)throw new WorkbenchError('PR 需要可识别的 GitHub HTTPS 或 SSH 远端；本地裸仓库只支持推送');
        const repository=`${match[1]}/${match[2]}/${match[3]}`;
        await runCommand('gh',['--version'],integration.worktree);
        input={...input,base,title,body:body.body,draft:body.draft!==false};
        commands.push({command:'gh',args:['pr','create','--repo',repository,'--head',branch,'--base',base,'--title',title,'--body-file','<reviewed-pr-body.md>',...(input.draft?['--draft']:[])]});
      }
    }
    const fingerprint=digest({workflowId,commit:integration.headCommit,input,commands,remoteFingerprint});
    // Repeated preparation of an identical operation cannot manufacture a fresh execution ID.
    const existing=this.list(workflowId).find(a=>a.fingerprint===fingerprint);if(existing)return existing;
    return this.save({id:randomUUID(),workflowId,projectId:detail.workflow.projectId,kind:body.kind,commit:integration.headCommit,worktree:integration.worktree,fingerprint,createdAt:now(),state:'prepared',input,commands,remoteFingerprint,destination,receipts:[]});
  }
  async execute(id:string,confirmation:{confirmedCommit:string;fingerprint:string}):Promise<DeliveryAction> {
    const action=this.get(id),previous=this.locks.get(action.workflowId)??Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{
      let current=this.get(id);
      if(confirmation.confirmedCommit!==current.commit||confirmation.fingerprint!==current.fingerprint)throw new WorkbenchError('请确认预览中的准确版本与动作',409);
      if(current.state==='succeeded')return current;
      if(current.state!=='prepared')throw new WorkbenchError('该动作已有执行记录；未知或失败结果须先核对，不能重复执行',409);
      if(this.list(current.workflowId).some(a=>a.id!==id&&['running','unknown'].includes(a.state)))throw new WorkbenchError('同一工作流还有未核对的交付动作',409);
      const {integration}=await this.ready(current.workflowId);
      if(integration.headCommit!==current.commit||integration.worktree!==current.worktree)throw new WorkbenchError('交付版本已变化，请生成新预览',409);
      if(current.input.remote&&(await this.remote(current.worktree,current.input.remote)).fingerprint!==current.remoteFingerprint)throw new WorkbenchError('Git 远端地址已变化，请重新核对预览',409);
      current=this.save({...current,state:'running',confirmedAt:now()});
      let directory:string|undefined;
      try {
        for(const command of current.commands) {
          let args=command.args;
          if(args.includes('<reviewed-pr-body.md>')) {
            directory=mkdtempSync(join(tmpdir(),'awb-pr-body-'));const path=join(directory,'body.md');writeFileSync(path,current.input.body??'','utf8');args=args.map(a=>a==='<reviewed-pr-body.md>'?path:a);
          }
          const result=await executeCheck(current.worktree,command.command,args,300000),receipt={...result,log:publicText(result.log)};
          current=this.save({...current,receipts:[...current.receipts,{command,...receipt}]});
          if(receipt.exitCode!==0) return this.save({...current,state:'unknown',completedAt:now(),detail:'命令未成功结束，外部可能已有部分变更；请核对实际结果后记录结论。'});
        }
        const url=current.kind==='pull-request'?current.receipts.at(-1)?.log.match(/https:\/\/[^\s]+\/pull\/\d+/)?.[0]:undefined;
        if(current.kind==='pull-request'&&!url)return this.save({...current,state:'unknown',completedAt:now(),detail:'PR 命令已结束，但未取得可确认的 PR 链接；请核对远端。'});
        return this.save({...current,state:'succeeded',completedAt:now(),url,detail:current.kind==='deploy'?'部署命令退出码为 0；线上业务可用性仍以部署脚本的检查范围为准。':'已收到原生工具成功回执。'});
      }catch(error){return this.save({...current,state:'unknown',completedAt:now(),detail:`交付结果需要核对：${publicText(error instanceof Error?error.message:String(error))}`});}
      finally{if(directory)rmSync(directory,{recursive:true,force:true});}
    });
    this.locks.set(action.workflowId,pending);void pending.finally(()=>{if(this.locks.get(action.workflowId)===pending)this.locks.delete(action.workflowId);}).catch(()=>{});return pending;
  }
  reconcile(id:string,input:{result:'succeeded'|'failed';reason:string}):DeliveryAction {
    const action=this.get(id);if(action.state!=='unknown'||!['succeeded','failed'].includes(input.result)||typeof input.reason!=='string'||!input.reason.trim())throw new WorkbenchError('仅未知动作可以在核对后记录结果与依据',409);
    return this.save({...action,state:input.result,completedAt:now(),reconciliation:{result:input.result,reason:safeText(input.reason).slice(0,10000),at:now()},detail:'人工已核对外部结果；此记录不是新增的自动执行回执。'});
  }
}
