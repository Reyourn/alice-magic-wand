import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Agent, Project, Task } from '../../shared/types.js';
import type { ArtifactBundle, ExecutionRound, FileDelivery, VerificationEvidence, Workflow, WorkflowDetail, WorkflowDispatchInput, WorkflowDraftInput, WorkflowLayout, WorkflowNode, WorkflowNodeView, WorkflowPlan } from '../../shared/workflows.js';
import { Store } from '../store.js';
import { WorkbenchError, type GitRepository, type TaskRepository } from '../repositories.js';
import { assertUniqueRelativePaths, copyVerifiedFiles, fileHash, OfficeWorkspaceManager, safeRelativePath, snapshotFiles } from './files.js';
import { executeCheck, IntegrationManager } from './integration.js';
import { extractDocument } from '../documents.js';
import { safeText } from '../runtime/process.js';

const now=()=>new Date().toISOString();
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeStates=['prepared','dispatching','running','unknown'];
export interface WorkflowManagerOptions {
  store:Store; tasks:TaskRepository; git:GitRepository; dataDir:string;
  getProject:(id:string)=>Project; getAgent:(id:string)=>Agent;
  dispatch:(input:WorkflowDispatchInput)=>Promise<{messageId?:string}|void>;
  notifyController?:(projectId:string,text:string)=>Promise<void>;
  event?:(type:string,data:Record<string,unknown>,projectId:string)=>void;
  preflight?:(agent:Agent,node:WorkflowNode)=>Promise<string[]>;
  isAgentActive?:(agentId:string)=>boolean;
}
export interface RoundCompletion { messageId?:string; worktree?:string; startCommit?:string; candidateCommit?:string; output?:string; failed?:boolean; interrupted?:boolean; error?:string; files?:string[]; }
export class WorkflowManager {
  readonly office:OfficeWorkspaceManager;
  readonly integration:IntegrationManager;
  private locks=new Map<string,Promise<unknown>>();
  constructor(readonly options:WorkflowManagerOptions){
    this.office=new OfficeWorkspaceManager(options.dataDir,options.store,options.tasks);
    this.integration=new IntegrationManager(options.store,options.git);
    for(const round of this.rounds())if(['dispatching','running'].includes(round.state))this.saveRound({...round,state:'unknown',error:'服务重启后等待核对原执行回执。'});
    for(const workflow of this.list())if(workflow.status==='running')this.save({...workflow,status:'paused',lastError:'服务重启后已暂停新派发，请核对执行轮次。'});
  }
  private serial<T>(id:string,fn:()=>Promise<T>):Promise<T>{const previous=this.locks.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(fn);this.locks.set(id,next);void next.finally(()=>{if(this.locks.get(id)===next)this.locks.delete(id);}).catch(()=>{});return next;}
  private save(workflow:Workflow):Workflow {const value={...workflow,updatedAt:now()};this.options.store.put('workflows',value.id,value);this.options.event?.('workflow.changed',{workflowId:value.id,status:value.status},value.projectId);return value;}
  private saveRound(round:ExecutionRound):ExecutionRound {this.options.store.put('execution_rounds',round.id,round);return round;}
  private plan(id:string,version:number):WorkflowPlan {const plan=this.options.store.get<WorkflowPlan>('workflow_plans',`${id}:${version}`);if(!plan)throw new WorkbenchError('计划版本不存在。',404);return plan;}
  get(id:string):Workflow {const value=this.options.store.get<Workflow>('workflows',id);if(!value)throw new WorkbenchError('工作流不存在。',404);return value;}
  list(projectId?:string):Workflow[]{return this.options.store.all<Workflow>('workflows').filter(item=>!projectId||item.projectId===projectId);}
  rounds(workflowId?:string):ExecutionRound[]{return this.options.store.all<ExecutionRound>('execution_rounds').filter(item=>!workflowId||item.workflowId===workflowId);}
  bundles(workflowId?:string):ArtifactBundle[]{return this.options.store.all<ArtifactBundle>('artifact_bundles').filter(item=>!workflowId||item.workflowId===workflowId);}
  evidence(bundleId?:string):VerificationEvidence[]{return this.options.store.all<VerificationEvidence>('verification_evidence').filter(item=>!bundleId||item.bundleId===bundleId);}
  private latestRound(workflowId:string,nodeId:string):ExecutionRound|undefined {return this.rounds(workflowId).filter(item=>item.nodeId===nodeId).sort((a,b)=>b.number-a.number)[0];}
  private bundle(id:string):ArtifactBundle {const bundle=this.options.store.get<ArtifactBundle>('artifact_bundles',id);if(!bundle)throw new WorkbenchError('成果包不存在。',404);return bundle;}
  private roundNode(round:ExecutionRound):WorkflowNode {
    const node=round.purpose?this.options.store.get<WorkflowNode>('integration_review_nodes',round.id):this.plan(round.workflowId,round.planVersion).nodes.find(node=>node.id===round.nodeId);
    if(!node)throw new WorkbenchError('执行轮次的任务定义不存在。',409);return node;
  }
  createDraft(input:WorkflowDraftInput):Workflow {
    const project=this.options.getProject(input.projectId);validatePlan(input.nodes);
    if(!input.name?.trim()||!input.goal?.trim())throw new WorkbenchError('工作流名称和目标不能为空。');
    if(input.maxReworkRounds!==undefined&&(!Number.isInteger(input.maxReworkRounds)||input.maxReworkRounds<0||input.maxReworkRounds>10))throw new WorkbenchError('自动返工上限应为 0 至 10。');
    this.validateMembers(project,input.nodes);
    const id=randomUUID(),workflow:Workflow={id,projectId:project.id,name:input.name.trim(),goal:input.goal.trim(),status:'draft',currentVersion:1,taskIds:{},layout:{},maxReworkRounds:input.maxReworkRounds??2,targetBranch:input.targetBranch,createdAt:now(),updatedAt:now()};
    this.options.store.put('workflow_plans',`${id}:1`,{version:1,nodes:input.nodes,createdAt:now()} satisfies WorkflowPlan);return this.save(workflow);
  }
  private validateMembers(project:Project,nodes:WorkflowNode[]):void {for(const node of nodes)if(node.agentId){const agent=this.options.getAgent(node.agentId);if(agent.projectId!==project.id)throw new WorkbenchError('负责人不属于当前项目。');if(node.kind==='review'){if(agent.permissionMode!=='read-only')throw new WorkbenchError('独立审查成员必须使用只读权限。');if(node.dependencies.some(dep=>dep.kind==='candidate'&&nodes.find(candidate=>candidate.id===dep.nodeId)?.agentId===agent.id))throw new WorkbenchError('候选成果必须由另一名成员独立审查。');}}}
  revise(id:string,input:{nodes:WorkflowNode[];name?:string;goal?:string;maxReworkRounds?:number}):Workflow {
    const workflow=this.get(id);if(workflow.status==='delivered')throw new WorkbenchError('已交付工作流不可直接修改，请创建新工作流。',409);
    validatePlan(input.nodes);this.validateMembers(this.options.getProject(workflow.projectId),input.nodes);
    if(input.maxReworkRounds!==undefined&&(!Number.isInteger(input.maxReworkRounds)||input.maxReworkRounds<0||input.maxReworkRounds>10))throw new WorkbenchError('自动返工上限应为 0 至 10。');
    const old=this.plan(id,workflow.currentVersion);
    for(const node of old.nodes){const next=input.nodes.find(item=>item.id===node.id),round=this.latestRound(id,node.id);if(round&&(!next||fingerprint(next)!==fingerprint(node)))throw new WorkbenchError(`任务「${node.title}」已有执行轮次；请通过返工或新增任务改变已执行内容。`,409);}
    const version=workflow.currentVersion+1;this.options.store.put('workflow_plans',`${id}:${version}`,{version,nodes:input.nodes,createdAt:now()} satisfies WorkflowPlan);
    return this.save({...workflow,currentVersion:version,status:'draft',name:input.name?.trim()||workflow.name,goal:input.goal?.trim()||workflow.goal,maxReworkRounds:input.maxReworkRounds??workflow.maxReworkRounds});
  }
  async confirm(id:string,version:number):Promise<WorkflowDetail>{return this.serial(id,async()=>{
    let workflow=this.get(id);if(version!==workflow.currentVersion)throw new WorkbenchError('计划已被修改，请确认最新版本。',409);
    if(workflow.confirmedVersion===version&&['ready','running','paused','completed','delivered'].includes(workflow.status))return this.detail(id);
    const plan=this.plan(id,version),project=this.options.getProject(workflow.projectId);validatePlan(plan.nodes);
    const failures:string[]=[];
    for(const node of plan.nodes)if(node.kind!=='manual'){
      if(!node.agentId){failures.push(`${node.title}：尚未指定负责人`);continue;}
      const agent=this.options.getAgent(node.agentId);if(agent.controlMode==='human')failures.push(`${node.title}：成员处于人工接管`);
      for(const reference of node.inputs){const snapshot=this.options.store.get<{projectId:string}>('input_snapshots',reference);if(snapshot&&snapshot.projectId!==project.id)failures.push(`${node.title}：输入快照不属于本项目`);}
      failures.push(...(await this.options.preflight?.(agent,node)??[]).map(reason=>`${node.title}：${reason}`));
    }
    if(failures.length)throw new WorkbenchError(`计划尚不能确认：\n${failures.join('\n')}`,409,true);
    workflow=this.save({...workflow,status:'confirming',lastError:undefined});
    try{
      for(const node of topological(plan.nodes)){
        const ref=`workbench:${id}:${node.id}`,stableId=`awb-w${fingerprint(ref).slice(0,16)}`;
        let existing:Task|undefined;
        if(workflow.taskIds[node.id])existing=await this.options.tasks.get(project,workflow.taskIds[node.id]!);
        else {existing=await this.options.tasks.findByExternalRef?.(project,ref);if(!existing)existing=await this.options.tasks.get(project,stableId).catch(()=>undefined);}
        // Candidate edges remain review context, not blocking Beads dependencies: their producer is intentionally still open.
        const definition={id:stableId,externalRef:ref,title:node.title,description:node.description,acceptance:node.acceptance,dependencies:node.dependencies.filter(dep=>dep.kind==='accepted').map(dep=>workflow.taskIds[dep.nodeId]!)};
        if(!existing){try{existing=await this.options.tasks.create(project,definition);}catch(error){existing=await this.options.tasks.get(project,stableId).catch(()=>undefined);if(!existing)throw error;}}
        else if(this.options.tasks.replaceDefinition&&!this.latestRound(id,node.id))existing=await this.options.tasks.replaceDefinition(project,existing.id,definition);
        workflow=this.save({...workflow,taskIds:{...workflow.taskIds,[node.id]:existing.id}});
        const pending=this.latestRound(id,node.id);
        if(node.agentId&&(!pending||pending.state==='prepared')){
          if(pending&&pending.agentId!==node.agentId)throw new WorkbenchError('待执行轮次负责人与当前计划不一致，请核对改派计划。',409);
          await this.options.tasks.update(project,existing.id,{owner:node.agentId});
          if(pending)this.saveRound({...pending,planVersion:version});
        }
      }
      if(project.kind!=='office'){
        const integration=await this.integration.initialize(id,project,workflow.targetBranch);
        workflow={...workflow,targetBranch:integration.targetBranch,baselineCommit:integration.baselineCommit};
      }
      this.options.store.put('workflow_plans',`${id}:${version}`,{...plan,confirmedAt:now()});this.save({...workflow,confirmedVersion:version,status:'ready'});
      return this.detail(id);
    }catch(error){this.save({...this.get(id),status:'blocked',lastError:String(error)});throw error;}
  });}
  saveLayout(id:string,layout:WorkflowLayout):Workflow {
    const workflow=this.get(id),ids=new Set(this.plan(id,workflow.currentVersion).nodes.map(node=>node.id));
    for(const [key,position]of Object.entries(layout))if(!ids.has(key)||!Number.isFinite(position.x)||!Number.isFinite(position.y))throw new WorkbenchError('画布坐标不合法。');
    return this.save({...workflow,layout});
  }
  setPaused(id:string,paused:boolean):Workflow {
    const workflow=this.get(id);if(workflow.confirmedVersion!==workflow.currentVersion)throw new WorkbenchError('请先确认当前计划。',409);
    if(['completed','delivered'].includes(workflow.status))return workflow;
    return this.save({...workflow,status:paused?'paused':'ready'});
  }
  async detail(id:string):Promise<WorkflowDetail> {
    const workflow=this.get(id),plan=this.plan(id,workflow.currentVersion),project=this.options.getProject(workflow.projectId),tasks=await this.options.tasks.list(project),rounds=this.rounds(id),bundles=this.bundles(id);
    const staleBundles=new Map<string,string>();
    for(let offset=0;offset<bundles.length;offset+=4)await Promise.all(bundles.slice(offset,offset+4).map(async bundle=>{try{await this.assertBundleCurrent(bundle);}catch(error){staleBundles.set(bundle.id,error instanceof Error?error.message:String(error));}}));
    const nodes:WorkflowNodeView[]=plan.nodes.map(node=>{
      const round=this.latestRound(id,node.id),task=tasks.find(item=>item.id===workflow.taskIds[node.id]),bundle=round?.candidateBundleId?bundles.find(item=>item.id===round.candidateBundleId):undefined;
      const blockedReasons:string[]=[];
      if(workflow.confirmedVersion!==workflow.currentVersion)blockedReasons.push('计划尚未确认');
      if(workflow.status==='paused')blockedReasons.push('工作流已暂停');
      if(node.kind==='manual'&&task?.status!=='closed')blockedReasons.push('等待人工确认');
      if(round?.state==='unknown')blockedReasons.push('原执行回执未核对，禁止重复派发');
      if(bundle&&staleBundles.has(bundle.id))blockedReasons.push(staleBundles.get(bundle.id)!);
      const staleReview=node.kind==='review'&&!!round?.sourceBundleId&&staleBundles.has(round.sourceBundleId);
      if(staleReview)blockedReasons.push('独立审查目标已经变化，原审查证据已过期');
      if(node.agentId&&this.options.getAgent(node.agentId).controlMode==='human')blockedReasons.push('成员由人工接管');
      for(const dep of node.dependencies){const dependencyRound=this.latestRound(id,dep.nodeId),depTask=tasks.find(item=>item.id===workflow.taskIds[dep.nodeId]);
        if(dep.kind==='candidate'&&(!dependencyRound?.candidateBundleId||staleBundles.has(dependencyRound.candidateBundleId)||!dependencyRound.completedAt||!['candidate','accepted'].includes(dependencyRound.state)||this.options.isAgentActive?.(dependencyRound.agentId)))blockedReasons.push(`等待候选成果：${dep.nodeId}`);
        if(dep.kind==='accepted'&&(depTask?.status!=='closed'||dependencyRound?.state!=='accepted'||dependencyRound.candidateBundleId&&staleBundles.has(dependencyRound.candidateBundleId)))blockedReasons.push(`等待前置验收：${dep.nodeId}`);
      }
      return {node,taskId:workflow.taskIds[node.id],taskStatus:task?.status,owner:task?.owner,round,bundle,accepted:round?.state==='accepted'&&task?.status==='closed'&&!staleReview&&(!bundle||!staleBundles.has(bundle.id)),blockedReasons};
    });
    return {workflow,plan,plans:Array.from({length:workflow.currentVersion},(_,index)=>this.plan(id,index+1)),nodes,rounds,bundles,evidence:this.evidence().filter(item=>bundles.some(bundle=>bundle.id===item.bundleId)).map(item=>({...item,stale:staleBundles.has(item.bundleId),staleReason:staleBundles.get(item.bundleId)})),integration:this.integration.get(id)};
  }
  getDispatchContext(projectId:string,taskId:string):{workflow:Workflow;node:WorkflowNode;round?:ExecutionRound}|undefined {
    const integrationReview=this.rounds().filter(round=>round.purpose&&round.taskId===taskId&&this.get(round.workflowId).projectId===projectId).at(-1);
    if(integrationReview)return {workflow:this.get(integrationReview.workflowId),node:this.roundNode(integrationReview),round:integrationReview};
    const workflow=this.list(projectId).find(item=>Object.values(item.taskIds).includes(taskId));if(!workflow)return undefined;
    const node=this.plan(workflow.id,workflow.currentVersion).nodes.find(item=>workflow.taskIds[item.id]===taskId);if(!node)throw new WorkbenchError('该任务已从当前计划移除。',409);
    return {workflow,node,round:this.latestRound(workflow.id,node.id)};
  }
  assertDispatch(projectId:string,taskId:string,roundId?:string):void {
    const context=this.getDispatchContext(projectId,taskId);if(!context)return;
    if(context.round?.purpose&&context.round.id===roundId&&context.round.state==='dispatching'&&context.workflow.confirmedVersion===context.workflow.currentVersion&&context.workflow.status!=='delivered')return;
    if(context.workflow.confirmedVersion!==context.workflow.currentVersion||!['ready','running'].includes(context.workflow.status)||!context.round||context.round.id!==roundId||context.round.state!=='dispatching')throw new WorkbenchError('工作流任务只能通过已确认计划派发，当前轮次不允许直接启动。',409);
  }
  async advance(id:string):Promise<WorkflowDetail>{return this.serial(id,async()=>{
    const workflow=this.get(id);if(!['ready','running'].includes(workflow.status)||workflow.confirmedVersion!==workflow.currentVersion)throw new WorkbenchError('工作流必须确认且恢复运行后才能派发。',409);
    const detail=await this.detail(id);let capacity=3-this.rounds().filter(round=>['dispatching','running','unknown'].includes(round.state)).length;
    for(const view of detail.nodes){if(capacity<=0)break;if(view.accepted||view.blockedReasons.length||view.node.kind==='manual'||!view.node.agentId)continue;
      if(view.round&&view.round.state!=='prepared')continue;
      if(this.options.isAgentActive?.(view.node.agentId)||this.rounds().some(round=>round.agentId===view.node.agentId&&['dispatching','running','unknown'].includes(round.state)))continue;
      await this.startRoundInternal(id,view.node.id);capacity--;
    }
    return this.detail(id);
  });}
  startRound(id:string,nodeId:string):Promise<ExecutionRound>{return this.serial(id,()=>this.startRoundInternal(id,nodeId));}
  private startRoundInternal(id:string,nodeId:string):Promise<ExecutionRound>{return this.serial('dispatch-capacity',()=>this.dispatchRound(id,nodeId));}
  private async dispatchRound(id:string,nodeId:string):Promise<ExecutionRound>{
    const detail=await this.detail(id),view=detail.nodes.find(item=>item.node.id===nodeId);if(!view)throw new WorkbenchError('计划节点不存在。',404);
    const {workflow}=detail;
    if(workflow.confirmedVersion!==workflow.currentVersion||!['ready','running'].includes(workflow.status)||view.blockedReasons.length||view.accepted||!view.node.agentId||!view.taskId||view.node.kind==='manual')throw new WorkbenchError(`任务尚不能派发：${view.blockedReasons.join('；')}`,409);
    if(view.round&&view.round.state!=='prepared')throw new WorkbenchError('此任务已有执行轮次，请核对或明确退回修改。',409);
    if(this.rounds().filter(round=>['dispatching','running','unknown'].includes(round.state)).length>=3)throw new WorkbenchError('已达到三个并行执行成员上限。',409);
    const agent=this.options.getAgent(view.round?.agentId??view.node.agentId),problems=await this.options.preflight?.(agent,view.node)??[];if(problems.length)throw new WorkbenchError(problems.join('；'),409);
    if(view.node.kind==='review'&&agent.permissionMode!=='read-only')throw new WorkbenchError('独立审查成员必须使用只读权限。',409);
    if(this.options.isAgentActive?.(agent.id)||this.rounds().some(round=>round.agentId===agent.id&&['dispatching','running','unknown'].includes(round.state)))throw new WorkbenchError('成员已有执行中的任务。',409);
    let round:ExecutionRound=view.round??{id:randomUUID(),workflowId:id,planVersion:workflow.currentVersion,nodeId,taskId:view.taskId,agentId:agent.id,number:1,automaticReworkCount:0,state:'prepared',idempotencyKey:randomUUID(),createdAt:now()};
    const project=this.options.getProject(workflow.projectId),dependencies=view.node.dependencies.map(dep=>detail.nodes.find(item=>item.node.id===dep.nodeId)!).filter(Boolean);
    const candidate=dependencies.find(dep=>view.node.dependencies.some(edge=>edge.nodeId===dep.node.id&&edge.kind==='candidate'));
    const priorBundle=round.sourceBundleId?this.bundle(round.sourceBundleId):undefined;
    const inputSnapshotIds=[...new Set([...view.node.inputs.filter(input=>this.options.store.get('input_snapshots',input)),...dependencies.flatMap(dep=>dep.bundle?.inputSnapshotIds??(dep.bundle?.inputSnapshotId?[dep.bundle.inputSnapshotId]:[])),...(priorBundle?.inputSnapshotIds??(priorBundle?.inputSnapshotId?[priorBundle.inputSnapshotId]:[]))])];
    if(project.kind!=='office')for(const dependency of dependencies)if(dependency.accepted&&dependency.bundle){const integration=await this.integrate(id,dependency.bundle.id);if(!['ready','verified'].includes(integration.state))throw new WorkbenchError('前置成果的整合冲突尚未处理。',409);}
    if(project.kind!=='office'&&['conflict','integrating','unknown'].includes(this.integration.get(id)?.state??''))throw new WorkbenchError('整合工作区尚未核对，不能派发后续写者。',409);
    for(const dependency of dependencies)if(dependency.bundle)await this.assertBundleCurrent(dependency.bundle);
    const inputBundles=[...new Map([...dependencies.flatMap(dep=>dep.bundle?[dep.bundle]:[]),...(priorBundle?[priorBundle]:[])].map(bundle=>[bundle.id,bundle])).values()];
    const workspace=project.kind==='office'?this.office.createTaskDirectory(project.id,round.id,inputSnapshotIds,inputBundles):round.sourceRoundId?round.worktree:undefined;
    round=this.saveRound({...round,state:'dispatching',worktree:workspace,inputSnapshotId:inputSnapshotIds[0],inputSnapshotIds,...(candidate?.bundle?{sourceBundleId:candidate.bundle.id}:{})});this.save({...workflow,status:'running'});
    const instructions=[`工作流 ${workflow.name}，计划版本 ${workflow.currentVersion}，执行轮次 ${round.number}。`,view.node.description,view.node.inputs.length?`计划输入引用：${view.node.inputs.join('，')}`:'',`验收要求：${view.node.acceptance}`,round.reworkReason?`本轮退回修改要求（必须处理）：${round.reworkReason}\n上一轮成果或回执：${round.sourceBundleId??round.sourceRoundId}`:'',candidate?.bundle?`独立审查固定成果 ${candidate.bundle.id}，版本 ${candidate.bundle.version}。不得审查另一个版本。最后输出单行结构化结论：WORKBENCH_REVIEW_RESULT: {"version":"${candidate.bundle.version}","result":"passed 或 failed","conclusion":"结论与问题说明"}。`:'',project.kind==='office'?'输入只从 inputs 目录及其子目录读取：新快照位于 snapshots/<快照 ID>/，前置成果位于 bundles/<成果包 ID>/，内部相对路径保持不变；历史输入可能仍在根目录。输出写入 outputs，保留 HTML 原型与 CSS、脚本、图片之间的相对路径；不得修改原始业务文件。':''].filter(Boolean).join('\n\n');
    try{
      const result=await this.options.dispatch({workflowId:id,nodeId,taskId:view.taskId,agentId:agent.id,roundId:round.id,idempotencyKey:round.idempotencyKey,instructions,baseCommit:candidate?.bundle?.candidateCommit??priorBundle?.candidateCommit??this.integration.get(id)?.headCommit,reviewTaskId:candidate?.taskId,workspace});
      const latest=this.options.store.get<ExecutionRound>('execution_rounds',round.id)!;
      return this.saveRound({...latest,state:latest.state==='dispatching'?'running':latest.state,messageId:result?.messageId??latest.messageId});
    }catch(error){const unknown=this.saveRound({...round,state:'unknown',error:String(error)});this.save({...this.get(id),status:'blocked',lastError:'派发回执未确认，需核对原轮次。'});this.options.event?.('workflow.attention',{workflowId:id,roundId:round.id,reason:unknown.error},project.id);throw error;}
  }
  async completeRound(roundId:string,input:RoundCompletion):Promise<ExecutionRound>{return this.serial(`round:${roundId}`,async()=>{
    const round=this.options.store.get<ExecutionRound>('execution_rounds',roundId);if(!round)throw new WorkbenchError('执行轮次不存在。',404);
    if(round.messageId&&input.messageId&&round.messageId!==input.messageId)throw new WorkbenchError('执行回执不属于当前轮次。',409);
    const previousReceipt=this.options.store.get<{messageId?:string;output:string;failed:boolean;interrupted:boolean}>('workflow_run_receipts',round.id);
    if(previousReceipt){
      if(previousReceipt.messageId!==input.messageId||previousReceipt.output!==safeText(input.output??'')||previousReceipt.failed!==!!input.failed||previousReceipt.interrupted!==!!input.interrupted)throw new WorkbenchError('原执行回执已经记录，不能用不同结果覆盖。',409);
      if(round.completedAt&&(round.candidateBundleId||['accepted','returned','failed'].includes(round.state)||this.roundNode(round).kind==='review'))return round;
    }
    this.options.store.put('workflow_run_receipts',round.id,{roundId,messageId:input.messageId,output:safeText(input.output??''),completedAt:now(),failed:!!input.failed,interrupted:!!input.interrupted});
    if(['accepted','returned','failed'].includes(round.state))return round;
    let completed=this.saveRound({...round,messageId:input.messageId??round.messageId,worktree:input.worktree??round.worktree,startCommit:input.startCommit??round.startCommit,candidateCommit:input.candidateCommit??round.candidateCommit,state:input.failed||input.interrupted?'failed':'candidate',completedAt:now(),error:input.error});
    if(!input.failed&&!input.interrupted){
      try{
        const node=this.roundNode(round);
        if(!round.purpose&&node.kind!=='review'){
          const existing=round.candidateBundleId?this.bundle(round.candidateBundleId):undefined;
          if(!completed.worktree)throw new WorkbenchError('执行结果缺少可核对的工作区。',409);
          if((input.candidateCommit||input.files?.length)&&(!existing||existing.candidateCommit!==input.candidateCommit||input.files?.length)){
            await this.recordBundle(roundId,{worktree:completed.worktree,startCommit:completed.startCommit,candidateCommit:completed.candidateCommit,files:input.files});completed=this.options.store.get<ExecutionRound>('execution_rounds',roundId)!;
          }else if(existing)await this.assertBundleCurrent(existing);
          else throw new WorkbenchError('执行结果没有可登记的候选提交或输出文件。',409);
        }
      }catch(error){
        // Native success and deliverable validation are separate facts. Keep the
        // original receipt and workspace, but allow a new round to fix its output.
        const reason=`原生执行已结束，但候选成果登记失败：${safeText(error instanceof Error?error.message:String(error))}`;
        completed=this.saveRound({...this.options.store.get<ExecutionRound>('execution_rounds',roundId)!,state:'failed',error:reason});
        const workflow=this.get(round.workflowId);this.save({...workflow,status:'blocked',lastError:reason});
        this.options.event?.('workflow.attention',{workflowId:workflow.id,roundId:round.id,reason},workflow.projectId);
        throw new WorkbenchError(reason,409);
      }
    }
    if(input.failed||input.interrupted){const workflow=this.get(round.workflowId);this.save({...workflow,status:'blocked',lastError:input.error??'当前轮次未正常完成，等待核对或人工处理。'});this.options.event?.('workflow.attention',{workflowId:workflow.id,roundId:round.id,reason:completed.error??'执行失败或中断'},workflow.projectId);}
    return completed;
  });}
  async markUncertain(roundId:string,reason:string):Promise<ExecutionRound>{return this.serial(`round:${roundId}`,async()=>{
    const round=this.options.store.get<ExecutionRound>('execution_rounds',roundId);if(!round)throw new WorkbenchError('执行轮次不存在。',404);
    if(!['running','dispatching','unknown'].includes(round.state))return round;
    const unknown=this.saveRound({...round,state:'unknown',error:safeText(reason)}),workflow=this.get(round.workflowId);
    this.save({...workflow,status:'blocked',lastError:'原写者状态未知，请核对原会话后恢复；不会重复派发。'});
    this.options.event?.('workflow.attention',{workflowId:workflow.id,roundId:round.id,reason:unknown.error},workflow.projectId);return unknown;
  });}
  async reconcileRound(roundId:string,input:RoundCompletion&{writerStopped:boolean}):Promise<ExecutionRound>{
    const round=this.options.store.get<ExecutionRound>('execution_rounds',roundId);if(!round||round.state!=='unknown')throw new WorkbenchError('该轮次不处于待核对状态。');
    if(!input.writerStopped||!input.messageId||this.options.isAgentActive?.(round.agentId))throw new WorkbenchError('必须先确认原写者停止并提供原投递回执。',409);
    const recovered=await this.completeRound(roundId,input);const workflow=this.get(round.workflowId);
    if(!this.rounds(workflow.id).some(item=>item.state==='unknown'))this.save({...workflow,status:'paused',lastError:undefined});
    return recovered;
  }
  async recordBundle(roundId:string,input:{worktree:string;startCommit?:string;candidateCommit?:string;files?:string[]}):Promise<ArtifactBundle>{
    const round=this.options.store.get<ExecutionRound>('execution_rounds',roundId);if(!round||!['candidate','running'].includes(round.state))throw new WorkbenchError('当前轮次不能登记候选成果。',409);
    if(round.purpose)throw new WorkbenchError('整合修复与审查轮次由后台核对终态和整合提交，不能登记普通任务候选。',409);
    if(round.worktree&&resolve(round.worktree)!==resolve(input.worktree))throw new WorkbenchError('成果工作区与执行轮次不符。');
    const workflow=this.get(round.workflowId),project=this.options.getProject(workflow.projectId),id=randomUUID();let bundle:ArtifactBundle;
    if(project.kind!=='office'){
      if(!input.candidateCommit||!input.startCommit)throw new WorkbenchError('代码成果必须提供起点和候选 SHA。');
      const state=await this.options.git.inspect(input.worktree),candidate=await this.options.git.resolveCommit(project,input.candidateCommit),start=await this.options.git.resolveCommit(project,input.startCommit);
      if(state.dirty||state.commit!==candidate)throw new WorkbenchError('候选代码必须是工作树当前干净提交。',409);
      const prior=round.sourceBundleId?this.bundle(round.sourceBundleId):undefined;
      const integrationBaseCommit=prior?this.integration.get(workflow.id)?.integratedBundleIds.includes(prior.id)?prior.candidateCommit:prior.integrationBaseCommit??prior.startCommit:start;
      bundle={id,workflowId:round.workflowId,nodeId:round.nodeId,taskId:round.taskId,roundId,agentId:round.agentId,version:candidate,kind:'code',createdAt:now(),worktree:input.worktree,startCommit:start,integrationBaseCommit,candidateCommit:candidate,files:[]};
    }else{
      const files=snapshotFiles(resolve(input.worktree,'outputs'),input.files??[],resolve(this.options.dataDir,'bundles',id));
      bundle={id,workflowId:round.workflowId,nodeId:round.nodeId,taskId:round.taskId,roundId,agentId:round.agentId,version:fingerprint(files.map(file=>({relativePath:file.relativePath!,sha256:file.sha256})).sort((a,b)=>a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0)),kind:'files',createdAt:now(),worktree:input.worktree,inputSnapshotId:round.inputSnapshotId,inputSnapshotIds:round.inputSnapshotIds,files};
    }
    this.options.store.put('artifact_bundles',id,bundle);this.saveRound({...round,state:round.completedAt?'candidate':round.state,candidateBundleId:id,worktree:input.worktree,startCommit:bundle.startCommit,candidateCommit:bundle.candidateCommit});
    await this.prepareReviewRounds(bundle);return bundle;
  }
  private async prepareReviewRounds(bundle:ArtifactBundle):Promise<void>{
    const workflow=this.get(bundle.workflowId),plan=this.plan(workflow.id,workflow.currentVersion);
    for(const node of plan.nodes.filter(item=>item.kind==='review'&&item.dependencies.some(dep=>dep.kind==='candidate'&&dep.nodeId===bundle.nodeId))){
      const prior=this.latestRound(workflow.id,node.id);if(!prior||prior.sourceBundleId===bundle.id)continue;
      const next:ExecutionRound={id:randomUUID(),workflowId:workflow.id,planVersion:workflow.currentVersion,nodeId:node.id,taskId:workflow.taskIds[node.id]!,agentId:node.agentId!,number:prior.number+1,state:'prepared',idempotencyKey:randomUUID(),createdAt:now(),sourceBundleId:bundle.id,reworkReason:`上游候选成果已更新为 ${bundle.version}；旧审查仅适用于旧版本，请重新独立审查。`};
      if(!activeStates.includes(prior.state))this.saveRound({...prior,state:'returned'});
      this.saveRound(next);await this.options.tasks.update(this.options.getProject(workflow.projectId),next.taskId,{status:'open',reason:next.reworkReason});
    }
  }
  async assertBundleCurrent(bundle:ArtifactBundle):Promise<void>{
    const round=this.latestRound(bundle.workflowId,bundle.nodeId);if(!round||round.id!==bundle.roundId||round.candidateBundleId!==bundle.id||round.state==='returned')throw new WorkbenchError('成果已被后续轮次替代，原证据已过期。',409);
    if(bundle.kind==='code'){const state=await this.options.git.inspect(bundle.worktree);if(state.dirty||state.commit!==bundle.candidateCommit)throw new WorkbenchError('代码候选发生变化，原证据已过期。',409);}
    else for(const file of bundle.files)if(!existsSync(file.path)||fileHash(file.path)!==file.sha256)throw new WorkbenchError('版本文件已变化，原证据已过期。',409);
  }
  private requirement(bundle:ArtifactBundle,requirementId:string,kind:VerificationEvidence['kind']):void {
    const round=this.options.store.get<ExecutionRound>('execution_rounds',bundle.roundId)!;
    const node=this.plan(bundle.workflowId,round.planVersion).nodes.find(item=>item.id===bundle.nodeId)!;
    if(!node.checks.some(check=>check.id===requirementId&&check.kind===kind))throw new WorkbenchError('证据与声明的验收项不匹配。');
  }
  private appendEvidence(evidence:Omit<VerificationEvidence,'id'|'createdAt'>):VerificationEvidence {const value={...evidence,id:randomUUID(),createdAt:now()};this.options.store.put('verification_evidence',value.id,value);return value;}
  async runCheck(bundleId:string,input:{requirementId:string;command:string;args:string[];agentId?:string}):Promise<VerificationEvidence>{
    const bundle=this.bundle(bundleId);this.requirement(bundle,input.requirementId,'test');await this.assertBundleCurrent(bundle);
    const round=this.options.store.get<ExecutionRound>('execution_rounds',bundle.roundId)!,check=this.plan(bundle.workflowId,round.planVersion).nodes.find(node=>node.id===bundle.nodeId)!.checks.find(check=>check.id===input.requirementId)!;
    if(check.command&&(check.command!==input.command||fingerprint(check.args??[])!==fingerprint(input.args)))throw new WorkbenchError('检查命令必须与已确认计划声明一致。',409);
    if(!round.completedAt||this.options.isAgentActive?.(round.agentId))throw new WorkbenchError('请等待当前写者停止后再验证成果。',409);
    const result=await executeCheck(bundle.worktree,input.command,input.args);await this.assertBundleCurrent(bundle);
    return this.appendEvidence({bundleId,version:bundle.version,requirementId:input.requirementId,kind:'test',result:result.exitCode===0?'passed':'failed',command:input.command,args:input.args,exitCode:result.exitCode,log:result.log,agentId:input.agentId});
  }
  async recordReview(bundleId:string,input:{requirementId:string;reviewRoundId:string;result:'passed'|'failed';conclusion:string}):Promise<VerificationEvidence>{
    const bundle=this.bundle(bundleId);this.requirement(bundle,input.requirementId,'review');await this.assertBundleCurrent(bundle);
    const review=this.options.store.get<ExecutionRound>('execution_rounds',input.reviewRoundId),receipt=this.options.store.get<{output:string;failed:boolean;interrupted:boolean}>('workflow_run_receipts',input.reviewRoundId);
    if(!review||review.workflowId!==bundle.workflowId||review.agentId===bundle.agentId||this.options.getAgent(review.agentId).permissionMode!=='read-only'||!['candidate','accepted'].includes(review.state)||!review.completedAt||this.options.isAgentActive?.(review.agentId)||!receipt?.output||receipt.failed||receipt.interrupted)throw new WorkbenchError('独立审查必须来自另一只读成员的实际完成回执。');
    const node=this.plan(review.workflowId,review.planVersion).nodes.find(item=>item.id===review.nodeId)!;
    if(node.kind!=='review'||review.sourceBundleId!==bundle.id||!node.dependencies.some(dep=>dep.kind==='candidate'&&dep.nodeId===bundle.nodeId)||(bundle.kind==='code'&&review.startCommit!==bundle.candidateCommit))throw new WorkbenchError('审查工作区未固定在这个候选版本。');
    let actual:{version?:string;result?:string;conclusion?:string}|undefined;
    for(const line of receipt.output.split(/\r?\n/)){const match=line.match(/WORKBENCH_REVIEW_RESULT:\s*(\{.*\})/);if(match){try{actual=JSON.parse(match[1]!);}catch{}}}
    if(actual?.version!==bundle.version||actual.result!==input.result||actual.conclusion!==input.conclusion||!input.conclusion.trim())throw new WorkbenchError('审查结论必须与原生实际回执中的结构化版本、结论和结果一致。');
    return this.appendEvidence({bundleId,version:bundle.version,requirementId:input.requirementId,kind:'review',result:input.result,conclusion:input.conclusion,reviewerId:review.agentId,reviewRoundId:review.id,agentId:review.agentId,log:receipt.output});
  }
  async recordFileCheck(bundleId:string,requirementId:string):Promise<VerificationEvidence>{
    const bundle=this.bundle(bundleId);this.requirement(bundle,requirementId,'file');await this.assertBundleCurrent(bundle);
    if(bundle.kind!=='files'||!bundle.files.length)throw new WorkbenchError('没有可验证的文件。');
    const reports:string[]=[];
    for(const file of bundle.files){const bytes=readFileSync(file.path);if(!bytes.length)throw new WorkbenchError(`成果文件为空：${file.name}`);const extension=extname(file.name).toLowerCase(),label=file.relativePath??file.name;
      if(['.pdf','.docx','.xlsx','.pptx'].includes(extension)){const parsed=await extractDocument({name:file.name,bytes});reports.push(`${file.name}：${parsed.detail}`);}
      else if(['.txt','.md','.csv','.json','.html','.htm','.svg','.mmd','.css','.js','.mjs','.map'].includes(extension)){const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(['.json','.map'].includes(extension))JSON.parse(text);reports.push(`${label}：UTF-8 内容可读取`);}
      else if(['.png','.jpg','.jpeg','.gif','.webp'].includes(extension)){if(!imageHeaderMatches(extension,bytes))throw new WorkbenchError(`图片头或容器不完整：${label}`);reports.push(`${label}：图片头与容器边界可读取（未解码或验证显示效果）`);}
      else throw new WorkbenchError(`尚无 ${extension||'此格式'} 的可打开性验证器，请增加人工验收项并明确记录例外。`);
    }
    return this.appendEvidence({bundleId,version:bundle.version,requirementId,kind:'file',result:'passed',conclusion:`${reports.join('\n')}\n仅验证解析和内容哈希；数据口径、公式正确性和视觉结果需通过其他验收项。`});
  }
  async accept(id:string,nodeId:string,input:{manualExceptions?:{requirementId:string;reason:string}[]}={}):Promise<WorkflowDetail>{return this.serial(id,async()=>{
    const workflow=this.get(id),plan=this.plan(id,workflow.currentVersion),node=plan.nodes.find(item=>item.id===nodeId),round=this.latestRound(id,nodeId);
    if(!node||!round)throw new WorkbenchError('任务尚未执行。');
    if(workflow.confirmedVersion!==workflow.currentVersion)throw new WorkbenchError('当前计划尚未确认。',409);
    if(!['candidate','accepted'].includes(round.state)||!round.completedAt||this.options.isAgentActive?.(round.agentId))throw new WorkbenchError('当前写者仍在执行或执行状态尚未核对，不能验收。',409);
    if(!round.candidateBundleId)throw new WorkbenchError('任务缺少可核验的候选成果包。');
    const bundle=this.bundle(round.candidateBundleId);await this.assertBundleCurrent(bundle);
    if(round.state==='accepted')return this.detail(id);
    for(const exception of input.manualExceptions??[])if(!exception.reason.trim()||!node.checks.some(check=>check.id===exception.requirementId))throw new WorkbenchError('人工例外必须指明验收项和理由。');
    for(const exception of input.manualExceptions??[])this.appendEvidence({bundleId:bundle.id,version:bundle.version,requirementId:exception.requirementId,kind:'manual',result:'passed',reason:exception.reason});
    const evidence=this.evidence(bundle.id);
    for(const check of node.checks){const current=evidence.filter(item=>item.requirementId===check.id&&item.version===bundle.version).at(-1);if(!current||current.result!=='passed')throw new WorkbenchError(`验收项尚未通过：${check.label}`,409);}
    if(!node.checks.length)throw new WorkbenchError('计划必须声明至少一个验收项，才能关闭任务。');
    await this.options.tasks.update(this.options.getProject(workflow.projectId),round.taskId,{status:'closed',reason:`验收版本 ${bundle.version}，成果包 ${bundle.id}`});this.saveRound({...round,state:'accepted'});
    if(bundle.kind==='code'){
      const integrated=await this.integrate(id,bundle.id);
      if(!['ready','verified'].includes(integrated.state)){this.save({...this.get(id),status:'blocked',lastError:'整合出现冲突，需要独占工作区修复后重新检查和审查。'});this.options.event?.('workflow.attention',{workflowId:id,reason:'已验收成果整合冲突，后续任务暂停'},workflow.projectId);return this.detail(id);}
    }
    await this.updateCompletion(id);return this.detail(id);
  });}
  async resolveManual(id:string,nodeId:string,reason:string):Promise<WorkflowDetail>{return this.serial(id,async()=>{
    const detail=await this.detail(id),view=detail.nodes.find(item=>item.node.id===nodeId);if(!view||view.node.kind!=='manual'||!reason.trim()||detail.workflow.confirmedVersion!==detail.workflow.currentVersion)throw new WorkbenchError('请确认人工节点并填写确认说明。');
    if(view.accepted)return detail;
    if(view.blockedReasons.some(item=>item!=='等待人工确认'))throw new WorkbenchError('人工节点的前置条件尚未满足。',409);
    const round:ExecutionRound={id:randomUUID(),workflowId:id,planVersion:detail.workflow.currentVersion,nodeId,taskId:view.taskId!,agentId:'human',number:1,state:'accepted',idempotencyKey:randomUUID(),createdAt:now(),completedAt:now()};
    await this.options.tasks.update(this.options.getProject(detail.workflow.projectId),view.taskId!,{status:'closed',reason});this.saveRound(round);this.options.store.put('workflow_manual_confirmations',round.id,{roundId:round.id,reason,dependencyVersions:Object.fromEntries(view.node.dependencies.map(dependency=>{const source=detail.nodes.find(node=>node.node.id===dependency.nodeId);return [dependency.nodeId,source?.bundle?.version??source?.round?.id];})),createdAt:now()});await this.updateCompletion(id);return this.detail(id);
  });}
  async acceptReviewRound(id:string,nodeId:string):Promise<WorkflowDetail>{return this.serial(id,async()=>{
    const workflow=this.get(id),node=this.plan(id,workflow.currentVersion).nodes.find(item=>item.id===nodeId),round=this.latestRound(id,nodeId);
    if(!node||node.kind!=='review'||!round||round.state!=='candidate'||!round.completedAt||this.options.isAgentActive?.(round.agentId))throw new WorkbenchError('审查轮次尚未完成。');
    const produced=this.evidence().filter(item=>item.reviewRoundId===round.id&&item.kind==='review'&&node.dependencies.some(dep=>this.bundle(item.bundleId).nodeId===dep.nodeId));
    if(!produced.length)throw new WorkbenchError('审查轮次尚未登记版本化审查结论。');
    for(const item of produced)await this.assertBundleCurrent(this.bundle(item.bundleId));
    for(const dependency of node.dependencies.filter(dep=>dep.kind==='candidate'))if(!produced.some(item=>this.bundle(item.bundleId).nodeId===dependency.nodeId))throw new WorkbenchError('尚有候选成果未完成独立审查。',409);
    await this.options.tasks.update(this.options.getProject(workflow.projectId),round.taskId,{status:'closed',reason:`已登记独立审查结论 ${produced.map(item=>item.id).join(', ')}`});this.saveRound({...round,state:'accepted'});await this.updateCompletion(id);return this.detail(id);
  });}
  /** Service calls this only after the original native turn has acknowledged interruption/completion. */
  async beginHumanRound(id:string,nodeId:string,input:{messageId:string;reason:string;writerStopped:boolean;agentId?:string}):Promise<ExecutionRound>{return this.serial(id,async()=>{
    const workflow=this.get(id),previous=this.latestRound(id,nodeId);
    if(!previous||!input.messageId||!input.reason.trim()||!input.writerStopped||workflow.status==='delivered'||workflow.confirmedVersion!==workflow.currentVersion)throw new WorkbenchError('人工纠正须引用已确认计划中的现有任务并确认原写者已经停止。',409);
    if(input.agentId&&input.agentId!==previous.agentId)throw new WorkbenchError('人工指令成员不是当前任务轮次的负责人，请核对改派后的会话。',409);
    const duplicate=this.rounds(id).find(round=>round.messageId===input.messageId);if(duplicate)return duplicate;
    if(['prepared','dispatching','running','unknown'].includes(previous.state)||!previous.completedAt)throw new WorkbenchError('原执行轮次尚未确认停止。',409);
    if(previous.purpose==='integration-repair'){
      const integration=this.integration.get(id);if(!integration||integration.state!=='conflict'||integration.worktree!==previous.worktree||integration.conflictBundleId!==previous.sourceBundleId)throw new WorkbenchError('原整合冲突已变化或已经完成，不能继续写入旧修复工作区。',409);
    }
    const dependent=this.plan(id,workflow.currentVersion).nodes.find(node=>node.dependencies.some(dep=>dep.nodeId===nodeId&&dep.kind==='accepted')&&this.latestRound(id,node.id));
    if(dependent)throw new WorkbenchError(`后续任务「${dependent.title}」已经使用此成果，请先核对影响范围。`,409);
    const round:ExecutionRound={...previous,id:randomUUID(),number:previous.number+1,automaticReworkCount:this.automaticReworks(previous),state:'running',idempotencyKey:input.messageId,messageId:input.messageId,createdAt:now(),completedAt:undefined,candidateBundleId:undefined,candidateCommit:undefined,sourceBundleId:previous.purpose||this.roundNode(previous).kind==='review'?previous.sourceBundleId:previous.candidateBundleId,sourceRoundId:previous.id,reworkReason:input.reason.trim(),error:undefined};
    await this.options.tasks.update(this.options.getProject(workflow.projectId),round.taskId,{status:'in_progress',reason:`人工纠正第 ${round.number} 轮：${input.reason.trim()}`});
    this.saveRound({...previous,state:'returned'});this.saveRound(round);if(round.purpose)this.options.store.put('integration_review_nodes',round.id,this.roundNode(previous));
    this.save({...workflow,status:'paused',lastError:undefined});return round;
  });}
  async startIntegrationReview(id:string,agentId:string):Promise<ExecutionRound>{return this.serial(id,()=>this.serial('dispatch-capacity',async()=>{
    const workflow=this.get(id),integration=this.integration.get(id),agent=this.options.getAgent(agentId);
    if(!integration||!['ready','verified'].includes(integration.state)||workflow.confirmedVersion!==workflow.currentVersion||workflow.status==='delivered')throw new WorkbenchError('请先完成当前整合修复并核对干净提交。',409);
    if(agent.projectId!==workflow.projectId||agent.permissionMode!=='read-only'||agent.controlMode==='human')throw new WorkbenchError('整合审查需要本项目未被接管的独立只读成员。',409);
    if(this.bundles(id).some(bundle=>bundle.agentId===agentId)||this.rounds(id).some(round=>round.purpose==='integration-repair'&&round.agentId===agentId))throw new WorkbenchError('整合审查成员不能是候选代码或冲突修复的作者。',409);
    if(this.options.isAgentActive?.(agentId)||this.rounds().filter(round=>['dispatching','running','unknown'].includes(round.state)).length>=3)throw new WorkbenchError('成员繁忙或已达到并发上限。',409);
    const state=await this.options.git.inspect(integration.worktree);if(state.dirty||state.commit!==integration.headCommit)throw new WorkbenchError('整合工作区尚不是固定干净版本。',409);
    const nodeId=`integration-review-${state.commit.slice(0,16)}`,previous=this.latestRound(id,nodeId);
    if(previous&&previous.state!=='failed')throw new WorkbenchError('此整合版本已有审查轮次，请核对原回执。',409);
    const node:WorkflowNode={id:nodeId,title:'整合修复独立审查',description:`独立审查整合提交 ${state.commit}，重点核对冲突处理是否丢失双方变更。`,acceptance:'对固定整合 SHA 给出结构化真实审查结论。',agentId,kind:'review',dependencies:[],inputs:[],requiredCapabilities:[],checks:[]};
    const problems=await this.options.preflight?.(agent,node)??[];if(problems.length)throw new WorkbenchError(problems.join('；'),409);
    const project=this.options.getProject(workflow.projectId),ref=`workbench:${id}:${nodeId}`,taskId=`awb-w${fingerprint(ref).slice(0,16)}`;
    let task=await this.options.tasks.get(project,taskId).catch(()=>undefined);
    if(!task){try{task=await this.options.tasks.create(project,{id:taskId,externalRef:ref,title:node.title,description:node.description,acceptance:node.acceptance});}catch(error){task=await this.options.tasks.get(project,taskId).catch(()=>undefined);if(!task)throw error;}}
    await this.options.tasks.update(project,task.id,{status:'open',owner:agentId});
    let round:ExecutionRound={id:randomUUID(),workflowId:id,planVersion:workflow.currentVersion,nodeId,taskId:task.id,agentId,number:(previous?.number??0)+1,state:'dispatching',idempotencyKey:randomUUID(),createdAt:now(),startCommit:state.commit,purpose:'integration-review'};
    this.options.store.put('integration_review_nodes',round.id,node);this.saveRound(round);
    try{
      const result=await this.options.dispatch({workflowId:id,nodeId,taskId:task.id,agentId,roundId:round.id,idempotencyKey:round.idempotencyKey,baseCommit:state.commit,instructions:`${node.description}\n不得修改文件。输出单行：WORKBENCH_REVIEW_RESULT: {"version":"${state.commit}","result":"passed 或 failed","conclusion":"结论与问题说明"}`});
      round=this.options.store.get<ExecutionRound>('execution_rounds',round.id)!;return this.saveRound({...round,state:round.state==='dispatching'?'running':round.state,messageId:result?.messageId??round.messageId});
    }catch(error){this.saveRound({...round,state:'unknown',error:String(error)});throw error;}
  }));}
  async startIntegrationRepair(id:string,agentId:string):Promise<ExecutionRound>{return this.serial(id,()=>this.serial('dispatch-capacity',async()=>{
    const workflow=this.get(id),integration=this.integration.get(id),agent=this.options.getAgent(agentId);
    if(!integration||integration.state!=='conflict'||!integration.conflictBundleId||workflow.confirmedVersion!==workflow.currentVersion||workflow.status==='delivered')throw new WorkbenchError('仅已确认计划中的当前整合冲突可以派发修复。',409);
    if(agent.projectId!==workflow.projectId||agent.permissionMode!=='workspace-write'||agent.controlMode==='human')throw new WorkbenchError('冲突修复需要本项目可写且未被人工接管的成员。',409);
    if(this.options.isAgentActive?.(agent.id)||this.rounds().some(round=>round.worktree===integration.worktree&&['dispatching','running','unknown'].includes(round.state)))throw new WorkbenchError('整合工作区已有写者或原执行未核对，禁止第二个写者。',409);
    if(this.rounds().filter(round=>['dispatching','running','unknown'].includes(round.state)).length>=3)throw new WorkbenchError('已达到三个并行执行成员上限。',409);
    const nodeId=`integration-repair-${integration.conflictBundleId.slice(0,24)}`,previous=this.latestRound(id,nodeId);
    if(previous&&previous.state!=='failed')throw new WorkbenchError('此冲突已有修复轮次，请核对原执行结果。',409);
    const node:WorkflowNode={id:nodeId,title:'整合冲突修复',description:`修复整合工作区 ${integration.worktree} 的当前冲突，保留双方已验收成果。只修改本工作区内的冲突内容并 git add；不要执行 commit、reset、cherry-pick --continue、推送或部署。后台将在终态回执后继续原 cherry-pick 并安排独立审查。`,acceptance:'冲突标记消除，双方变更保留，后台完成原整合，随后新测试和独立审查。',agentId,kind:'task',dependencies:[],requiredCapabilities:[],inputs:[],checks:[]};
    const problems=await this.options.preflight?.(agent,node)??[];if(problems.length)throw new WorkbenchError(problems.join('；'),409);
    const project=this.options.getProject(workflow.projectId),ref=`workbench:${id}:${nodeId}`,taskId=`awb-w${fingerprint(ref).slice(0,16)}`;
    let task=await this.options.tasks.get(project,taskId).catch(()=>undefined);if(!task){try{task=await this.options.tasks.create(project,{id:taskId,externalRef:ref,title:node.title,description:node.description,acceptance:node.acceptance});}catch(error){task=await this.options.tasks.get(project,taskId).catch(()=>undefined);if(!task)throw error;}}
    await this.options.tasks.update(project,task.id,{status:'open',owner:agent.id});
    let round:ExecutionRound={id:randomUUID(),workflowId:id,planVersion:workflow.currentVersion,nodeId,taskId:task.id,agentId,number:(previous?.number??0)+1,state:'dispatching',idempotencyKey:randomUUID(),createdAt:now(),worktree:integration.worktree,startCommit:(await this.options.git.inspect(integration.worktree)).commit,purpose:'integration-repair',sourceBundleId:integration.conflictBundleId};
    this.options.store.put('integration_review_nodes',round.id,node);this.saveRound(round);
    try{const result=await this.options.dispatch({workflowId:id,nodeId,taskId:task.id,agentId,roundId:round.id,idempotencyKey:round.idempotencyKey,workspace:integration.worktree,integrationRepair:true,instructions:node.description});round=this.options.store.get<ExecutionRound>('execution_rounds',round.id)!;return this.saveRound({...round,state:round.state==='dispatching'?'running':round.state,messageId:result?.messageId??round.messageId});}
    catch(error){this.saveRound({...round,state:'unknown',error:String(error)});throw error;}
  }));}
  async resolveIntegrationConflict(id:string){return this.serial(id,async()=>{
    const integration=this.integration.get(id);if(!integration)throw new WorkbenchError('整合工作区不存在。',404);
    if(this.rounds(id).some(round=>round.purpose==='integration-repair'&&(activeStates.includes(round.state)||this.options.isAgentActive?.(round.agentId))))throw new WorkbenchError('修复成员尚未确认停止，禁止同时继续整合。',409);
    return this.integration.resolveConflict(id);
  });}
  async finishIntegrationRepair(id:string,roundId:string){return this.serial(id,async()=>{
    const workflow=this.get(id),round=this.options.store.get<ExecutionRound>('execution_rounds',roundId),receipt=this.options.store.get<{failed:boolean;interrupted:boolean}>('workflow_run_receipts',roundId),integration=this.integration.get(id);
    if(!round||round.workflowId!==id||round.purpose!=='integration-repair'||round.state!=='candidate'||!round.completedAt||this.options.isAgentActive?.(round.agentId)||!receipt||receipt.failed||receipt.interrupted||!integration||integration.state!=='conflict'||round.worktree!==integration.worktree||round.sourceBundleId!==integration.conflictBundleId)throw new WorkbenchError('修复完成须核对同一工作区的实际成功终态，原写者必须停止。',409);
    try{const result=await this.integration.resolveConflict(id);this.saveRound({...round,state:'accepted',candidateCommit:result.headCommit});await this.options.tasks.update(this.options.getProject(workflow.projectId),round.taskId,{status:'closed',reason:`冲突修复并继续原整合，候选 ${result.headCommit}；等待独立审查和新测试`});this.options.event?.('workflow.attention',{workflowId:id,roundId,reason:'冲突修复完成，请对新的整合提交运行测试并独立审查。'},workflow.projectId);return result;}
    catch(error){this.saveRound({...round,state:'failed',error:String(error)});throw error;}
  });}
  async recordIntegrationReview(id:string,roundId:string){return this.serial(id,async()=>{
    const workflow=this.get(id),round=this.options.store.get<ExecutionRound>('execution_rounds',roundId),integration=this.integration.get(id);
    const receipt=this.options.store.get<{output:string;failed:boolean;interrupted:boolean}>('workflow_run_receipts',roundId);
    if(!round||round.workflowId!==id||round.purpose!=='integration-review'||round.state!=='candidate'||!round.completedAt||this.options.isAgentActive?.(round.agentId)||!integration||round.startCommit!==integration.headCommit||!receipt||receipt.failed||receipt.interrupted||this.options.getAgent(round.agentId).permissionMode!=='read-only')throw new WorkbenchError('整合审查须提供独立只读成员对当前提交的完成回执。',409);
    let actual:{version?:string;result?:string;conclusion?:string}|undefined;for(const line of receipt.output.split(/\r?\n/)){const match=line.match(/WORKBENCH_REVIEW_RESULT:\s*(\{.*\})/);if(match){try{actual=JSON.parse(match[1]!);}catch{}}}
    if(actual?.version!==integration.headCommit||!['passed','failed'].includes(actual.result??'')||!actual.conclusion?.trim())throw new WorkbenchError('整合审查回执缺少匹配版本的结构化结论。',409);
    if(actual.result==='failed'){this.saveRound({...round,state:'failed',error:actual.conclusion});this.options.event?.('workflow.attention',{workflowId:id,roundId,reason:`整合审查未通过：${actual.conclusion}`},workflow.projectId);throw new WorkbenchError('整合审查未通过，保留该结论并处理问题后重新审查。',409);}
    const result=await this.integration.recordReview(id,{commit:integration.headCommit,reviewerId:round.agentId,reviewRoundId:round.id,conclusion:actual.conclusion,createdAt:now()});
    this.saveRound({...round,state:'accepted'});await this.options.tasks.update(this.options.getProject(workflow.projectId),round.taskId,{status:'closed',reason:`独立审查整合版本 ${result.headCommit}`});await this.updateCompletion(id);return result;
  });}
  private automaticReworks(round:ExecutionRound):number {
    if(round.automaticReworkCount!==undefined)return round.automaticReworkCount;
    // Older human corrections used their message ID as the round idempotency key.
    // Count identifiable automatic returns, not every interruption/new native turn.
    return this.rounds(round.workflowId).filter(item=>item.nodeId===round.nodeId&&item.number<=round.number&&!item.purpose&&!!item.reworkReason&&!!(item.sourceBundleId||item.sourceRoundId)&&item.idempotencyKey!==item.messageId&&!item.reworkReason.startsWith('上游候选成果已更新')).length;
  }
  async rework(id:string,nodeId:string,input:{reason:string;sourceBundleId?:string;sourceRoundId?:string;agentId?:string;humanOverride?:boolean}):Promise<ExecutionRound>{return this.serial(id,async()=>{
    const workflow=this.get(id),round=this.latestRound(id,nodeId);if(!round||!input.reason?.trim())throw new WorkbenchError('退回修改必须填写原因并引用原轮次。');
    if(workflow.status==='delivered'||workflow.confirmedVersion!==workflow.currentVersion)throw new WorkbenchError('已交付或未确认的新计划不能直接返工。',409);
    const dependent=this.plan(id,workflow.currentVersion).nodes.find(node=>node.dependencies.some(dep=>dep.nodeId===nodeId&&dep.kind==='accepted')&&this.latestRound(id,node.id));
    if(dependent)throw new WorkbenchError(`后续任务「${dependent.title}」已经使用此版本；请修订计划新增修复任务并核对影响范围。`,409);
    if(['prepared','dispatching','running','unknown'].includes(round.state)||this.options.isAgentActive?.(round.agentId))throw new WorkbenchError('必须先确认原写者已停止。',409);
    if(round.state==='returned')throw new WorkbenchError('此轮已退回，请使用已有下一轮。',409);
    if(round.candidateBundleId?round.candidateBundleId!==input.sourceBundleId:round.state!=='failed'||input.sourceRoundId!==round.id)throw new WorkbenchError('退回修改必须引用本轮成果，或引用已停止失败轮次的回执。');
    const automaticReworkCount=this.automaticReworks(round);
    if(automaticReworkCount>=workflow.maxReworkRounds&&!input.humanOverride){this.options.event?.('workflow.attention',{workflowId:id,nodeId,reason:'已达到自动返工上限'},workflow.projectId);throw new WorkbenchError('已达到自动返工上限，请人工决定。',409);}
    const agentId=input.agentId??round.agentId,agent=this.options.getAgent(agentId);if(agent.projectId!==workflow.projectId)throw new WorkbenchError('改派成员不属于项目。');
    const reassign=agentId!==round.agentId,version=workflow.currentVersion+(reassign?1:0),plan=this.plan(id,workflow.currentVersion),nodes=plan.nodes.map(node=>node.id===nodeId?{...node,agentId}:node);
    if(reassign)this.validateMembers(this.options.getProject(workflow.projectId),nodes);
    const next:ExecutionRound={id:randomUUID(),workflowId:id,planVersion:version,nodeId,taskId:round.taskId,agentId,number:round.number+1,automaticReworkCount:automaticReworkCount+(input.humanOverride?0:1),state:'prepared',idempotencyKey:randomUUID(),createdAt:now(),sourceBundleId:input.sourceBundleId,sourceRoundId:input.sourceRoundId,worktree:input.sourceRoundId?round.worktree:undefined,startCommit:input.sourceRoundId?round.startCommit:undefined,reworkReason:input.reason.trim()};
    await this.options.tasks.update(this.options.getProject(workflow.projectId),round.taskId,{status:'open',...(reassign?{}:{owner:agentId}),reason:`退回版本 ${input.sourceBundleId??input.sourceRoundId}：${input.reason}${reassign?'；改派提案等待计划确认':''}`});
    this.saveRound({...round,state:'returned'});this.saveRound(next);
    if(reassign)this.options.store.put('workflow_plans',`${id}:${version}`,{version,nodes,createdAt:now()} satisfies WorkflowPlan);
    this.save({...workflow,currentVersion:version,status:reassign?'draft':workflow.status==='paused'?'paused':'ready'});
    await this.options.notifyController?.(workflow.projectId,`任务 ${round.taskId} 已退回修改；第 ${next.number} 轮，原因：${input.reason}。引用成果或回执 ${input.sourceBundleId??input.sourceRoundId}。${reassign?`负责人改派为 ${agent.name}，计划 v${version} 等待用户确认，确认前不得派发。`:'请继续已确认计划。'}`);return next;
  });}
  private async updateCompletion(id:string):Promise<void>{const detail=await this.detail(id);if(detail.nodes.length&&detail.nodes.every(node=>node.accepted))this.save({...detail.workflow,status:'completed'});}
  async integrate(id:string,bundleId:string){const bundle=this.bundle(bundleId);if(bundle.workflowId!==id||this.latestRound(id,bundle.nodeId)?.state!=='accepted')throw new WorkbenchError('只有已经验收的本工作流成果才能整合。');await this.assertBundleCurrent(bundle);return this.integration.integrate(id,bundle);}
  async deliver(id:string,confirmedCommit:string){
    const workflow=this.get(id);if(workflow.status!=='completed')throw new WorkbenchError('工作流任务尚未全部验收。',409);
    const integration=this.integration.get(id),detail=await this.detail(id);
    if(detail.nodes.some(view=>!view.accepted))throw new WorkbenchError('已有成果或证据发生变化，交付前须重新核对。',409);
    for(const view of detail.nodes)if(view.bundle?.kind==='code'&&!integration?.integratedBundleIds.includes(view.bundle.id))throw new WorkbenchError(`成果尚未整合：${view.node.title}`,409);
    const result=await this.integration.deliver(id,this.options.getProject(workflow.projectId),confirmedCommit);this.save({...workflow,status:'delivered'});return result;
  }
  async deliverOffice(id:string,confirmedBundleIds:string[]):Promise<FileDelivery>{return this.serial(id,async()=>{
    const workflow=this.get(id),project=this.options.getProject(workflow.projectId);if(project.kind!=='office')throw new WorkbenchError('只有办公项目使用文件交付。');
    const previous=this.options.store.all<FileDelivery>('file_deliveries').find(item=>item.workflowId===id);
    if(workflow.status==='delivered'&&previous&&fingerprint([...confirmedBundleIds].sort())===fingerprint([...previous.bundleIds].sort()))return previous;
    if(workflow.status!=='completed')throw new WorkbenchError('工作流任务尚未全部验收。',409);
    const detail=await this.detail(id),bundles=detail.nodes.flatMap(node=>node.bundle?.kind==='files'?[node.bundle]:[]);
    if(detail.nodes.some(view=>!view.accepted))throw new WorkbenchError('任务已重新打开，或已有成果与证据过期；交付前须重新核对并验收全部任务。',409);
    if(!bundles.length||fingerprint(bundles.map(bundle=>bundle.id).sort())!==fingerprint([...confirmedBundleIds].sort()))throw new WorkbenchError('请确认当前所有候选文件版本。',409);
    for(const bundle of bundles)await this.assertBundleCurrent(bundle);
    const snapshotIds=[...new Set(bundles.flatMap(bundle=>bundle.inputSnapshotIds??(bundle.inputSnapshotId?[bundle.inputSnapshotId]:[])))];
    for(const snapshotId of snapshotIds)if(!this.office.checkInputs(snapshotId).unchanged)throw new WorkbenchError('原始输入文件已变化，请核对新旧输入后重新生成交付版本。',409);
    const entries=bundles.flatMap(bundle=>bundle.files.map((file,index)=>({file,relativePath:file.relativePath?`${safeRelativePath(bundle.nodeId)}/${safeRelativePath(bundle.id)}/${safeRelativePath(file.relativePath)}`:`${safeRelativePath(bundle.nodeId)}-${index}-${safeRelativePath(file.name)}`})));
    assertUniqueRelativePaths(entries.map(entry=>entry.relativePath));
    const deliveryId=randomUUID(),directory=resolve(this.options.dataDir,'deliveries',id,deliveryId);
    if(existsSync(directory))throw new WorkbenchError('交付目标已存在，拒绝覆盖。',409);
    const files=copyVerifiedFiles(entries,directory);
    for(const snapshotId of snapshotIds)if(!this.office.checkInputs(snapshotId).unchanged)throw new WorkbenchError('原始输入在交付期间发生变化，未完成交付。',409);
    const delivery:FileDelivery={id:deliveryId,workflowId:id,createdAt:now(),directory,bundleIds:bundles.map(bundle=>bundle.id),files,inputSnapshots:snapshotIds};
    writeFileSync(resolve(directory,'manifest.json'),JSON.stringify({...delivery,files:files.map(({path,...file})=>({...file,fileName:file.relativePath??path.slice(directory.length+1)}))},null,2),{flag:'wx'});
    this.options.store.put('file_deliveries',deliveryId,delivery);this.save({...workflow,status:'delivered'});return delivery;
  });}
}
function imageHeaderMatches(extension:string,bytes:Buffer):boolean {
  if(extension==='.png')return bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&bytes.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]));
  if(extension==='.jpg'||extension==='.jpeg')return bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
  if(extension==='.gif')return bytes.length>=14&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(8)>0&&bytes[bytes.length-1]===59;
  return bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16))&&bytes.readUInt32LE(4)===bytes.length-8;
}
export function validatePlan(nodes:WorkflowNode[]):void {
  if(!Array.isArray(nodes)||!nodes.length||nodes.length>200)throw new WorkbenchError('计划应包含 1 至 200 个任务。');
  const ids=new Set<string>();for(const node of nodes){if(!/^[a-zA-Z0-9][\w.-]{0,80}$/.test(node.id)||ids.has(node.id)||!node.title?.trim()||!['task','review','manual'].includes(node.kind))throw new WorkbenchError('任务节点编号、名称或类型不合法。');ids.add(node.id);if(!Array.isArray(node.dependencies)||!Array.isArray(node.checks)||!Array.isArray(node.inputs)||!Array.isArray(node.requiredCapabilities))throw new WorkbenchError('任务依赖、能力、输入和验收项必须为数组。');const checks=new Set<string>();for(const check of node.checks){if(!check.id||checks.has(check.id)||!check.label||!['test','review','file','manual'].includes(check.kind)||check.command!==undefined&&typeof check.command!=='string'||check.args!==undefined&&(!Array.isArray(check.args)||check.args.some(arg=>typeof arg!=='string')))throw new WorkbenchError('验收项无效或重复。');checks.add(check.id);}}
  for(const node of nodes){const seen=new Set<string>();for(const dep of node.dependencies){if(!ids.has(dep.nodeId)||dep.nodeId===node.id||seen.has(dep.nodeId)||!['accepted','candidate'].includes(dep.kind))throw new WorkbenchError('依赖不存在、重复或指向自身。');if(dep.kind==='candidate'&&node.kind!=='review')throw new WorkbenchError('候选成果依赖仅用于独立审查节点。');seen.add(dep.nodeId);}if(node.kind==='review'&&!node.dependencies.some(dep=>dep.kind==='candidate'))throw new WorkbenchError('审查节点必须引用一个候选成果。');}
  for(const node of nodes){
    if(node.kind==='manual'&&node.checks.some(check=>check.kind!=='manual'))throw new WorkbenchError('人工检查点只能声明人工确认项；测试、文件和独立审查应使用对应任务。');
    if(node.kind==='review'&&node.dependencies.filter(dep=>dep.kind==='candidate').length!==1)throw new WorkbenchError('一个独立审查节点必须固定一个候选成果；请为多个成果分别创建审查节点。');
    if(node.inputs.some(input=>typeof input!=='string')||node.requiredCapabilities.some(capability=>typeof capability!=='string'))throw new WorkbenchError('任务输入和能力编号必须为文本。');
  }
  topological(nodes);
}
function topological(nodes:WorkflowNode[]):WorkflowNode[]{const result:WorkflowNode[]=[],pending=new Set(nodes.map(node=>node.id));while(pending.size){const ready=nodes.filter(node=>pending.has(node.id)&&node.dependencies.every(dep=>!pending.has(dep.nodeId)));if(!ready.length)throw new WorkbenchError('任务依赖形成循环；返工请使用新的执行轮次。');for(const node of ready){pending.delete(node.id);result.push(node);}}return result;}
