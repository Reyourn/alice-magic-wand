import type { WorkbenchService } from './service.js';
import type { Agent, ArtifactBundle, ExecutionRound, WorkflowDraftInput, WorkflowNode } from '../shared/types.js';
import { WorkbenchError } from './repositories.js';

function required(input:unknown,label:string):string {if(typeof input!=='string'||!input.trim())throw new WorkbenchError(`${label}不能为空`);return input.trim();}
export function taskContext(service:WorkbenchService,agent:Agent) {
  const binding=agent.currentTaskId?service.store.get<import('../shared/types.js').TaskBinding>('bindings',`${agent.projectId}:${agent.currentTaskId}`):undefined;
  const context=agent.currentTaskId?service.workflows.getDispatchContext(agent.projectId,agent.currentTaskId):undefined;
  const run=service.store.get<import('./store.js').RunRecord>('runs',agent.id);
  return {agent,binding,...context,messageId:run?.state==='active'?run.messageId:undefined,capabilities:(agent.capabilityIds??[]).map(id=>service.capabilities.get(id))};
}
export async function scopedTool(service:WorkbenchService,agent:Agent,name:string,args:Record<string,unknown>):Promise<unknown> {
  const lead=agent.memberKind==='controller';
  const workflow=()=>{const value=service.workflows.get(required(args.workflowId,'工作流 ID'));if(value.projectId!==agent.projectId)throw new WorkbenchError('工作流不属于本项目',403);return value;};
  const bundle=()=>{const value=service.store.get<ArtifactBundle>('artifact_bundles',required(args.bundleId,'成果包 ID'));if(!value||service.workflows.get(value.workflowId).projectId!==agent.projectId)throw new WorkbenchError('成果包不属于本项目',403);if(!lead&&value.taskId!==agent.currentTaskId)throw new WorkbenchError('只能操作当前任务成果',403);return value;};
  const ownContext=()=>{const value=taskContext(service,agent);if(!value.round||!value.binding||value.round.agentId!==agent.id)throw new WorkbenchError('尚未绑定当前任务执行轮次',409);return value;};
  const controllerOnly=()=>{if(!lead)throw new WorkbenchError('成员没有团队调度权限',403);};
  const stable=<T>(work:()=>Promise<T>|T)=>service.idempotent(`mcp:${agent.id}:${name}`,args.idempotencyKey,args,async()=>work());
  if(name==='get_task_context') {
    if(!lead)return taskContext(service,agent);
    const member=service.getAgent(required(args.agentId,'成员 ID'));if(member.projectId!==agent.projectId)throw new WorkbenchError('成员不属于本项目',403);return taskContext(service,member);
  }
  if(!lead){
    if(!['request_clarification','run_declared_check','register_candidate','record_artifact'].includes(name))controllerOnly();
    const run=service.store.get<import('./store.js').RunRecord>('runs',agent.id);
    if(!run||run.state!=='active'||typeof args.messageId!=='string'||args.messageId!==run.messageId)throw new WorkbenchError('成员工具请求不属于当前执行轮次，请重新读取任务上下文。',409);
  }
  if(name==='request_clarification')return stable(()=>service.addInbox({projectId:agent.projectId,agentId:agent.id,taskId:agent.currentTaskId,kind:'question',title:required(args.question,'问题'),detail:typeof args.context==='string'?args.context:''}));
  if(name==='run_declared_check')return stable(async()=>{
    const candidate=bundle();const detail=await service.workflows.detail(candidate.workflowId),node=detail.plan.nodes.find(n=>n.id===candidate.nodeId)!;
    if(!lead&&agent.permissionMode==='read-only')throw new WorkbenchError('只读成员不能通过后端检查入口执行可写命令',403);
    const requirement=node.checks.find(check=>check.id===args.requirementId&&check.kind==='test');
    if(!requirement?.command)throw new WorkbenchError('该验收项未在确认计划中声明检查命令，请由用户补充并确认',409);
    return service.workflows.runCheck(candidate.id,{requirementId:requirement.id,command:requirement.command,args:requirement.args??[],agentId:agent.id});
  });
  if(name==='register_candidate')return stable(async()=>{
    if(lead)throw new WorkbenchError('候选成果由当前任务成员登记',403);
    const context=ownContext(),binding=context.binding!;
    if(context.node?.kind==='review')throw new WorkbenchError('审查成员应返回版本化审查结论，不能登记实施候选');
    const state=service.getProject(agent.projectId).kind==='office'?undefined:await service.git.inspect(binding.worktree);
    const files=args.files;if(files!==undefined&&(!Array.isArray(files)||files.some(file=>typeof file!=='string')))throw new WorkbenchError('文件清单必须为路径数组');
    return service.workflows.recordBundle(context.round!.id,{worktree:binding.worktree,startCommit:binding.startCommit||undefined,candidateCommit:state?.commit,files:files as string[]|undefined});
  });
  if(name==='record_artifact'&&!lead)return stable(()=>service.recordArtifact({...args,agentId:agent.id,projectId:agent.projectId,taskId:agent.currentTaskId}));
  controllerOnly();
  switch(name) {
    case 'list_workflows':return service.workflows.list(agent.projectId);
    case 'get_workflow':return service.workflows.detail(workflow().id);
    case 'propose_plan':return stable(()=>service.workflows.createDraft({...args,projectId:agent.projectId} as unknown as WorkflowDraftInput));
    case 'revise_plan':return stable(()=>{const current=workflow();if(current.currentVersion!==args.baseVersion)throw new WorkbenchError('计划版本已变化，请重新读取',409);return service.workflows.revise(current.id,{nodes:args.nodes as WorkflowNode[],name:args.name as string|undefined,goal:args.goal as string|undefined});});
    case 'request_expert':return stable(()=>service.addInbox({projectId:agent.projectId,kind:'question',title:`请求专业成员：${required(args.roleTemplateId,'角色模板')}`,detail:required(args.reason,'所需能力和任务说明')}));
    case 'advance_workflow':return stable(()=>service.workflows.advance(workflow().id));
    case 'record_review':return stable(()=>{const candidate=bundle();return service.workflows.recordReview(candidate.id,{requirementId:required(args.requirementId,'验收项'),reviewRoundId:required(args.reviewRoundId,'审查轮次'),result:args.result as 'passed'|'failed',conclusion:required(args.conclusion,'原生审查结论')});});
    case 'accept_task':return stable(async()=>{
      const current=workflow(),detail=await service.workflows.detail(current.id),view=detail.nodes.find(n=>n.node.id===args.nodeId);if(!view)throw new WorkbenchError('节点不存在',404);
      if(view.node.kind==='manual')throw new WorkbenchError('人工确认节点只能由用户确认',403);
      if(!args.roundId||view.round?.id!==args.roundId||view.node.kind!=='review'&&view.bundle?.id!==args.bundleId)throw new WorkbenchError('请指定当前轮次和准确成果包后再验收',409);
      const result=view.node.kind==='review'?await service.workflows.acceptReviewRound(current.id,view.node.id):await service.workflows.accept(current.id,view.node.id);
      service.advanceWorkflows();return result;
    });
    case 'return_task':return stable(async()=>{const current=workflow();const result=await service.workflows.rework(current.id,required(args.nodeId,'节点 ID'),{reason:required(args.reason,'返工原因'),sourceBundleId:args.sourceBundleId as string|undefined,sourceRoundId:args.sourceRoundId as string|undefined});service.advanceWorkflows();return result;});
    case 'integrate_bundle':return stable(()=>service.workflows.integrate(workflow().id,bundle().id));
    default:throw new WorkbenchError('未知工作台工具',404);
  }
}

export function reviewRecords(service:WorkbenchService,workflowId:string) {
  const results:{roundId:string;bundleId:string;version:string;result:'passed'|'failed';conclusion:string}[]=[];
  for(const round of service.workflows.rounds(workflowId)) {
    const receipt=service.store.get<{output:string;failed:boolean;interrupted:boolean}>('workflow_run_receipts',round.id);if(!receipt||receipt.failed||receipt.interrupted)continue;
    for(const line of receipt.output.split(/\r?\n/)){const match=line.match(/WORKBENCH_REVIEW_RESULT:\s*(\{.*\})/);if(!match)continue;
      try{const actual=JSON.parse(match[1]!) as {version:string;result:'passed'|'failed';conclusion:string};if(!['passed','failed'].includes(actual.result)||typeof actual.conclusion!=='string')continue;for(const bundle of service.workflows.bundles(workflowId).filter(b=>b.version===actual.version&&b.agentId!==round.agentId))results.push({roundId:round.id,bundleId:bundle.id,...actual});}catch{/* malformed output is not review evidence */}
    }
  }
  return results;
}
