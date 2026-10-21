import type { RuntimeOverrides } from './connections.js';
import type { RuntimeAuthenticationControl } from './runtime-auth.js';
export type RuntimeKind = 'codex' | 'claude' | 'workbuddy';
export * from './connections.js';
export * from './workflows.js';
export * from './capabilities.js';
export * from './runtime-auth.js';
export type RuntimeState = 'offline' | 'starting' | 'idle' | 'running' | 'waiting_approval' | 'interrupting' | 'stopped' | 'error' | 'unknown';
export type ControlMode = 'auto' | 'human';
export type PermissionMode = 'read-only' | 'workspace-write';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 4;
export const MAX_MESSAGE_IMAGES = MAX_MESSAGE_ATTACHMENTS;
export interface ImageAttachment { id:string; name:string; mimeType:'image/png'|'image/jpeg'|'image/webp'|'image/gif'; size:number; url:string; }
export interface FileAttachment { kind:'file'; id:string; name:string; mimeType:string; size:number; url:string; extraction:{status:'ready'|'truncated';characters:number;detail:string}; }
export type Attachment = ImageAttachment | FileAttachment;
export function isImageAttachment(attachment:Attachment):attachment is ImageAttachment {return !('kind' in attachment&&attachment.kind==='file');}
/** Server-only file path; never accepted from the browser or included in public events. */
export interface RuntimeImageAttachment extends ImageAttachment { path:string; }
export interface Project { id: string; name: string; path: string; createdAt: string; kind?:'code'|'office'; controlPath?:string; }
export interface ProjectCandidate { name:string; path:string; sources:string[]; status:'ready'|'not_git'|'no_commit'|'unavailable'; detail:string; beadsInitialized:boolean; registeredProjectId?:string; }
export interface ProjectDiscovery { candidates:ProjectCandidate[]; sources:{name:string;available:boolean;detail:string}[]; checkedAt:string; truncated:boolean; }
export interface Agent { id: string; projectId: string; name: string; role: string; runtime: RuntimeKind; model: string; observedModel?: string; observedProvider?: string; instructions: string; permissionMode: PermissionMode; controlMode: ControlMode; state: RuntimeState; nativeSessionId?: string; worktree?: string; currentTaskId?: string; lastError?: string; createdAt: string; memberKind?:'controller'|'worker'; roleTemplateId?:string; connectionId?:string; connectionRevision?:number; capabilityIds?:string[]; }
export interface Task { id: string; projectId: string; title: string; description: string; status: string; owner?: string; dependencies: string[]; acceptance: string; priority?: number; }
export interface TaskBinding { taskId: string; projectId: string; agentId: string; worktree: string; branch: string; startCommit: string; candidateCommit?: string; }
export interface Artifact { id: string; projectId: string; taskId?: string; agentId: string; kind: 'commit'|'test'|'review'|'pr'|'file'|'summary'; title: string; value: string; createdAt: string; }
export interface WorkbenchEvent { id: number; agentId?: string; projectId?: string; type: string; text?: string; data?: Record<string, unknown>; createdAt: string; }
export interface RuntimeInfo { kind: RuntimeKind; available: boolean; executable?: string; version?: string; detail: string; capabilities: { steer: boolean; interrupt: boolean; resume: boolean; approvals: boolean }; }
export interface RuntimeModel { id:string; name:string; description?:string; isDefault?:boolean; }
/** Native selector catalog, not a successful-inference or remaining-quota guarantee. */
export interface RuntimeModelCatalog { runtime:RuntimeKind; models:RuntimeModel[]; source:string; status:'ready'|'unavailable'; checkedAt:string; attemptedAt?:string; stale?:boolean; detail:string; }
export interface Approval { id: string; agentId: string; tool: string; input: unknown; createdAt: string; }
export interface TokenCounts { inputTokens?:number; outputTokens?:number; totalTokens?:number; cachedInputTokens?:number; cacheCreationInputTokens?:number; reasoningOutputTokens?:number; }
/** Counters are cumulative snapshots within their scope, never increments. Input includes cache subsets; output includes reasoning. */
export interface RuntimeTokenUsage extends TokenCounts { scope:'turn'|'session'; source:string; baselineKnownZero?:boolean; partial?:boolean; }
export interface TokenUsageRecord { id:string; projectId:string; agentId:string; runtime:RuntimeKind; nativeSessionId?:string; messageId?:string; taskId?:string; model?:string; provider?:string; configuredModel?:string; connectionId?:string; connectionRevision?:number; workflowId?:string; roundId?:string; source:string; scope:'turn'|'session'; counts:TokenCounts; partial:boolean; updatedAt:string; }
export interface TokenUsageSummary { scope:'agent'|'session'|'task'; projectId:string; agentId?:string; taskId?:string; nativeSessionId?:string; counts:TokenCounts; reportedTurns:number; totalTurns:number; partial:boolean; }
export interface Snapshot { projects: Project[]; agents: Agent[]; tasks: Task[]; bindings: TaskBinding[]; artifacts: Artifact[]; approvals: Approval[]; runtimes: RuntimeInfo[]; events: WorkbenchEvent[]; errors: string[]; usage:TokenUsageRecord[]; usageSummaries:TokenUsageSummary[]; }
export interface McpServerConfig { command: string; args: string[]; env?: Record<string,string>; }
export interface RuntimeOptions { agentId: string; cwd: string; model?: string; permissionMode: PermissionMode; instructions: string; resumeSessionId?: string; mcpServers?: Record<string,McpServerConfig>; connection?:RuntimeOverrides; /** Verification-only exact MCP tool names; never changes ordinary member permissions. */ verificationTools?:string[]; }
export interface RuntimeEvent { type: 'ready'|'state'|'delta'|'message'|'tool'|'approval'|'result'|'error'|'usage'; text?: string; state?: RuntimeState; nativeSessionId?: string; messageId?: string; approvalId?: string; data?: Record<string,unknown>; }
export interface RuntimeConnection { readonly nativeSessionId: string | undefined; readonly pid: number | undefined; send(text: string, messageId: string, images?:RuntimeImageAttachment[]): Promise<void>; interrupt(): Promise<void>; respondApproval(id: string, allow: boolean): Promise<void>; close(): Promise<void>; }
export interface RuntimeAdapter { kind: RuntimeKind; discover(): Promise<RuntimeInfo>; listModels?(cwd:string,connection?:RuntimeOverrides):Promise<RuntimeModelCatalog>; connect(options: RuntimeOptions, emit: (event: RuntimeEvent)=>void): Promise<RuntimeConnection>; authentication?:RuntimeAuthenticationControl; }

// HTTP: GET /api/bootstrap -> {token}; GET /api/state -> Snapshot; GET /api/events -> SSE WorkbenchEvent.
// GET /api/projects/discovery -> ProjectDiscovery (read-only local candidates; registration remains explicit).
// GET /api/agents/:id/models?refresh=1 -> RuntimeModelCatalog (native metadata, no inference).
// All mutations require X-Workbench-Token; pass Idempotency-Key for dispatch/messages.
// POST /api/projects {name,path,initializeBeads?}; POST /api/agents {projectId,name,role,runtime,model?,instructions?,permissionMode?}
// PATCH /api/agents/:id same config fields; POST /api/agents/:id/control {mode:'human'|'auto'}
// POST /api/agents/:id/attachments {name,mimeType,data:base64} -> Attachment; files include extraction status. GET /api/attachments/:id -> original bytes (non-images download).
// POST /api/agents/:id/messages {text,attachmentIds?:string[],mode?:'queue'|'interrupt'}: text or attachments required; human messages default to interrupt; source is server-controlled.
// Controller/system messages default to queue; an explicit queue mode remains supported.
// POST /api/agents/:id/interrupt {}; POST /api/agents/:id/approvals/:approvalId {allow:boolean}
// POST /api/tasks {projectId,title,description?,acceptance?,dependencies?,priority?}
// POST /api/tasks/:id/dispatch {projectId,agentId}; POST /api/tasks/:id/status {projectId,status,reason?}
// POST /api/artifacts {projectId,taskId?,agentId,kind,title,value}
// POST /api/controller/:id/tools {name,arguments} is capability-authenticated and used only by stdio MCP bridge.
