export type WorkflowStatus = 'draft'|'confirming'|'ready'|'running'|'paused'|'blocked'|'completed'|'delivered';
export type WorkflowNodeKind = 'task'|'review'|'manual';
export interface WorkflowDependency { nodeId:string; kind:'accepted'|'candidate'; }
export interface WorkflowNode {
  id:string; title:string; description:string; acceptance:string; agentId?:string;
  kind:WorkflowNodeKind; dependencies:WorkflowDependency[]; requiredCapabilities:string[];
  inputs:string[]; checks:AcceptanceRequirement[];
}
export interface AcceptanceRequirement { id:string; label:string; kind:'test'|'review'|'file'|'manual'; command?:string; args?:string[]; }
export interface WorkflowPlan { version:number; nodes:WorkflowNode[]; createdAt:string; confirmedAt?:string; }
export interface WorkflowLayout { [nodeId:string]:{x:number;y:number}; }
export interface Workflow {
  id:string; projectId:string; name:string; goal:string; status:WorkflowStatus; currentVersion:number;
  confirmedVersion?:number; taskIds:Record<string,string>; layout:WorkflowLayout; maxReworkRounds:number;
  targetBranch?:string; baselineCommit?:string; createdAt:string; updatedAt:string; lastError?:string;
}
export interface WorkflowDraftInput { projectId:string; name:string; goal:string; nodes:WorkflowNode[]; targetBranch?:string; maxReworkRounds?:number; }
export type ExecutionRoundState = 'prepared'|'dispatching'|'running'|'candidate'|'accepted'|'failed'|'unknown'|'returned';
export interface ExecutionRound {
  id:string; workflowId:string; planVersion:number; nodeId:string; taskId:string; agentId:string; number:number;
  automaticReworkCount?:number;
  state:ExecutionRoundState; idempotencyKey:string; createdAt:string; completedAt?:string; messageId?:string;
  sourceBundleId?:string; sourceRoundId?:string; reworkReason?:string; candidateBundleId?:string; error?:string;
  worktree?:string; startCommit?:string; candidateCommit?:string; inputSnapshotId?:string; inputSnapshotIds?:string[];
  purpose?:'integration-review'|'integration-repair';
}
export interface BundleFile {
  name:string; path:string; sha256:string; size:number;
  /** Portable path within a new snapshot or bundle. Historical records omit this field. */
  relativePath?:string;
}
/** Bundle metadata and evidence are append-only; a new version creates a new record. */
export interface ArtifactBundle {
  id:string; workflowId:string; nodeId:string; taskId:string; roundId:string; agentId:string;
  version:string; kind:'code'|'files'; createdAt:string; worktree:string; startCommit?:string;
  candidateCommit?:string; integrationBaseCommit?:string; inputSnapshotId?:string; inputSnapshotIds?:string[]; files:BundleFile[];
}
export interface VerificationEvidence {
  id:string; bundleId:string; version:string; requirementId:string; kind:'test'|'review'|'file'|'manual';
  result:'passed'|'failed'; createdAt:string; agentId?:string; reviewRoundId?:string; command?:string; args?:string[];
  exitCode?:number; log?:string; conclusion?:string; reviewerId?:string; reason?:string;
  stale?:boolean; staleReason?:string;
}
export interface WorkflowNodeView { node:WorkflowNode; taskId?:string; taskStatus?:string; owner?:string; round?:ExecutionRound; bundle?:ArtifactBundle; accepted:boolean; blockedReasons:string[]; }
export interface WorkflowDetail { workflow:Workflow; plan:WorkflowPlan; plans:WorkflowPlan[]; nodes:WorkflowNodeView[]; rounds:ExecutionRound[]; bundles:ArtifactBundle[]; evidence:VerificationEvidence[]; integration?:IntegrationRecord; }
export interface InputSnapshot { id:string; projectId:string; createdAt:string; directory:string; files:(BundleFile&{sourcePath:string;sourceHash:string})[]; }
export interface IntegrationRecord {
  id:string; workflowId:string; projectId:string; targetBranch:string; baselineCommit:string; branch:string;
  worktree:string; headCommit:string; state:'ready'|'integrating'|'conflict'|'testing'|'verified'|'delivered'|'unknown';
  integratedBundleIds:string[]; integratedCommits:string[]; conflictBundleId?:string; checks:IntegrationCheck[];
  pendingCommits?:string[];
  deliveredCommit?:string; deliveredAt?:string; lastError?:string;
  conflictReviewRequired?:boolean; conflictReview?:{commit:string;reviewerId:string;reviewRoundId:string;conclusion:string;createdAt:string};
}
export interface IntegrationCheck { id:string; commit:string; command:string; args:string[]; exitCode:number; log:string; createdAt:string; }
export interface FileDelivery { id:string; workflowId:string; createdAt:string; directory:string; bundleIds:string[]; files:BundleFile[]; inputSnapshots:string[]; }
export interface WorkflowDispatchInput { workflowId:string; nodeId:string; taskId:string; agentId:string; roundId:string; idempotencyKey:string; instructions:string; baseCommit?:string; reviewTaskId?:string; workspace?:string; integrationRepair?:boolean; }
