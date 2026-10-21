const str={type:'string'},list={type:'array',items:str};
const check={type:'object',properties:{id:str,label:str,kind:{type:'string',enum:['test','review','file','manual']},command:str,args:list},required:['id','label','kind'],additionalProperties:false};
const node={type:'object',properties:{id:str,title:str,description:str,acceptance:str,agentId:str,kind:{type:'string',enum:['task','review','manual']},dependencies:{type:'array',items:{type:'object',properties:{nodeId:str,kind:{type:'string',enum:['accepted','candidate']}},required:['nodeId','kind'],additionalProperties:false}},requiredCapabilities:list,inputs:list,checks:{type:'array',items:check}},required:['id','title','description','acceptance','kind','dependencies','requiredCapabilities','inputs','checks'],additionalProperties:false};
interface Definition {name:string;description:string;properties:Record<string,unknown>;required:string[];}
const define=(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):Definition=>({name,description,properties,required});
const op={idempotencyKey:str};
const shared=[
  define('get_task_context','Read the assigned task, approved plan, current round, worktree, current messageId and capabilities. Members must include this messageId in every write tool call. Controllers must specify agentId.',{agentId:str}),
  define('request_clarification','Ask the user a blocking question. Wait for the reply rather than guessing approval.',{...op,question:str,context:str},['idempotencyKey','question']),
  define('run_declared_check','Execute only the test command already declared in the confirmed plan for this bundle. Actual exit code and output become version-bound evidence. Use after the producing turn stops.',{...op,bundleId:str,requirementId:str},['idempotencyKey','bundleId','requirementId']),
];
export const memberTools:Definition[]=[...shared,
  define('record_artifact','Register current-task evidence. This does not accept the task or execute a delivery.',{...op,kind:{type:'string',enum:['commit','test','review','pr','file','summary']},title:str,value:str},['idempotencyKey','kind','title','value']),
  define('register_candidate','Register the current task clean code commit or output files as an immutable candidate. Do not claim final acceptance.',{...op,files:list},['idempotencyKey']),
].map(tool=>tool.name==='get_task_context'?tool:{...tool,properties:{...tool.properties,messageId:str},required:[...tool.required,'messageId']});
export const controllerTools:Definition[]=[...shared,
  define('list_team','Read members, explicit scheduling identity, capabilities, control modes and runtime states.'),
  define('list_tasks','Read this project authoritative Beads tasks.'),
  define('list_workflows','Read project plan and workflow state.'),
  define('get_workflow','Read full plan, tasks, rounds, immutable bundles and validation evidence.',{workflowId:str},['workflowId']),
  define('propose_plan','Propose a complete DAG plan. The user must confirm it before automatic dispatch. Include test commands and version-bound independent review requirements; do not create a new plan on a retry.',{...op,name:str,goal:str,targetBranch:str,maxReworkRounds:{type:'integer',minimum:0,maximum:10},nodes:{type:'array',items:node}},['idempotencyKey','name','goal','nodes']),
  define('revise_plan','Propose a revision of unexecuted tasks. User reconfirmation is required; layout never changes execution authority.',{...op,workflowId:str,baseVersion:{type:'integer'},nodes:{type:'array',items:node}},['idempotencyKey','workflowId','baseVersion','nodes']),
  define('request_expert','Request a missing professional member or capability from the user.',{...op,roleTemplateId:str,reason:str},['idempotencyKey','roleTemplateId','reason']),
  define('advance_workflow','Advance only a user-confirmed ready workflow. The backend respects dependencies, capacity, takeover and prior-writer stops.',{...op,workflowId:str},['idempotencyKey','workflowId']),
  define('get_agent_events','Read bounded complete messages and tool results. Do not poll repeatedly while a worker is running; finish this turn and await its notification.',{agentId:str,after:{type:'integer'},limit:{type:'integer',minimum:1,maximum:300}},['agentId']),
  define('record_review','Register an independent completed reviewer exact WORKBENCH_REVIEW_RESULT. Version/result/conclusion must match its native receipt.',{...op,bundleId:str,requirementId:str,reviewRoundId:str,result:{type:'string',enum:['passed','failed']},conclusion:str},['idempotencyKey','bundleId','requirementId','reviewRoundId','result','conclusion']),
  define('accept_task','Accept the exact current round and candidate after declared evidence passes. Cannot bypass checks, approve manual checkpoints, or deliver to original targets.',{...op,workflowId:str,nodeId:str,roundId:str,bundleId:str},['idempotencyKey','workflowId','nodeId','roundId']),
  define('return_task','Return the current candidate or a confirmed failed round with concrete corrections. Creates one new round; retain the same key on retries. Default automatic rework limit is two.',{...op,workflowId:str,nodeId:str,sourceBundleId:str,sourceRoundId:str,reason:str},['idempotencyKey','workflowId','nodeId','reason']),
  define('integrate_bundle','Integrate an accepted exact candidate into the isolated integration branch. This never updates the user target branch.',{...op,workflowId:str,bundleId:str},['idempotencyKey','workflowId','bundleId']),
];
