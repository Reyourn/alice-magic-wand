import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, ArtifactBundle, Project, RuntimeAdapter, RuntimeEvent, RuntimeOptions, Task, TaskBinding, Workflow, WorkflowNode } from '../src/shared/types.js';
import type { GitRepository, TaskCreateInput, TaskRepository } from '../src/server/repositories.js';
import { WorkbenchService } from '../src/server/service.js';
import { scopedTool } from '../src/server/scoped-tools.js';
import { controllerTools, memberTools } from '../src/server/mcp-definitions.js';

// Real service/MCP dispatch with simulated native transports; no paid/native call occurs.
class Tasks implements TaskRepository {
  values = new Map<string, Task>();
  async validate() {}
  async list(project: Project) { return [...this.values.values()].filter(task => task.projectId === project.id); }
  async get(project: Project, id: string) { const task = this.values.get(id); if (!task || task.projectId !== project.id) throw new Error('Missing task'); return task; }
  async create(project: Project, input: TaskCreateInput) { const task: Task = { id: input.id ?? randomUUID(), projectId: project.id, title: input.title, description: input.description ?? '', acceptance: input.acceptance ?? '', dependencies: input.dependencies ?? [], status: 'open' }; this.values.set(task.id, task); return task; }
  async update(project: Project, id: string, fields: { status?: string; owner?: string; reason?: string }) { const task = await this.get(project, id); Object.assign(task, fields); return task; }
}
class Git implements GitRepository {
  async validate(path: string) { return path; }
  async createWorktree(project: Project, taskId: string, agentId: string): Promise<TaskBinding> { return { projectId: project.id, taskId, agentId, worktree: project.path, branch: 'test', startCommit: 'a'.repeat(40) }; }
  async inspect() { return { commit: 'a'.repeat(40), dirty: false, diff: '' }; }
  async resolveCommit(_project: Project, ref: string) { return ref; }
}
class Adapter implements RuntimeAdapter {
  kind = 'codex' as const;
  sessions = new Map<string, (event: RuntimeEvent) => void>();
  launches: RuntimeOptions[] = [];
  async discover() { return { kind: this.kind, available: true, detail: 'simulated', capabilities: { interrupt: true, approvals: true, resume: true, steer: false } }; }
  async connect(options: RuntimeOptions, emit: (event: RuntimeEvent) => void) {
    this.sessions.set(options.agentId, emit); this.launches.push(options);
    return { nativeSessionId: randomUUID(), pid: undefined, send: async () => {
      if (options.agentId.startsWith('verify-')) { const probe = options.mcpServers?.workbench_probe; if (probe) writeFileSync(probe.args[1]!, JSON.stringify({ nonce: probe.args[2] })); emit({ type: 'delta', text: '验证' }); emit({ type: 'result', text: '完成' }); }
    }, interrupt: async () => { emit({ type: 'result', data: { interrupted: true } }); }, respondApproval: async () => {}, close: async () => {} };
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'awb-scoped-')), adapter = new Adapter(), tasks = new Tasks();
  const service = new WorkbenchService({ dataDir: directory, adapters: [adapter], tasks, git: new Git() });
  cleanups.push(async () => { await service.close(); if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup'); rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); });
  // An isolated office fixture exercises file rounds without requiring Git/Beads setup here.
  const project: Project = { id: randomUUID(), name: 'MCP fixture', kind: 'office', path: directory, controlPath: directory, createdAt: new Date().toISOString() }; service.store.put('projects', project.id, project);
  const lead = await service.createAgent({ projectId: project.id, name: 'Controller', role: 'orchestrator', memberKind: 'controller', runtime: 'codex', model: 'test-model' });
  const worker = await service.createAgent({ projectId: project.id, name: 'Worker', role: 'fullstack', memberKind: 'worker', runtime: 'codex', model: 'test-model' });
  return { directory, service, adapter, tasks, project, lead, worker };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function node(agentId: string, extra: Partial<WorkflowNode> = {}): WorkflowNode { return { id: 'work', title: 'Prepare report', description: 'Produce output', acceptance: 'Openable report', kind: 'task', agentId, dependencies: [], inputs: [], requiredCapabilities: [], checks: [{ id: 'file', kind: 'file', label: 'Can open' }], ...extra }; }
async function propose(f: Fixture, nodes = [node(f.worker.id)], extra: Record<string, unknown> = {}) { return await f.service.controllerTool(f.lead.id, 'propose_plan', { idempotencyKey: randomUUID(), name: 'Plan', goal: 'Deliver a report', nodes, ...extra }) as Workflow; }
async function start(f: Fixture, workflow: Workflow) {
  await f.service.connectionManager.verify('native-codex', { cwd: f.directory, model: 'test-model', capabilities: ['inference', 'streaming', 'tools'] });
  await f.service.workflows.confirm(workflow.id, 1); await f.service.workflows.advance(workflow.id);
  await vi.waitFor(() => expect(f.adapter.sessions.has(f.worker.id), JSON.stringify({agent:f.service.getAgent(f.worker.id),messages:f.service.store.all('messages')})).toBe(true));
  return (await f.service.workflows.detail(workflow.id)).nodes.find(view => view.node.id === 'work')!.round!;
}
async function finish(f: Fixture, workflow: Workflow) {
  const round = (await f.service.workflows.detail(workflow.id)).nodes.find(view => view.node.id === 'work')!.round!;
  const binding = f.service.store.get<TaskBinding>('bindings', `${f.project.id}:${round.taskId}`)!;
  writeFileSync(join(binding.worktree, 'outputs', 'report.txt'), 'fixed report');
  f.adapter.sessions.get(f.worker.id)!({ type: 'result', text: 'Produced report' });
  await vi.waitFor(() => expect(f.service.workflows.rounds(workflow.id).find(value => value.id === round.id)?.candidateBundleId).toBeTruthy());
  await vi.waitFor(() => expect(f.service.getAgent(f.worker.id).state).toBe('idle'));
  return (await f.service.workflows.detail(workflow.id)).nodes.find(view => view.node.id === 'work')!.bundle!;
}

describe('MCP authority and confirmed plan gates', () => {
  it('uses explicit member authority; a controller-like name or role never grants scheduling tools', async () => {
    const f = await fixture(); const named = await f.service.createAgent({ projectId: f.project.id, name: '主控', role: 'controller', runtime: 'codex' });
    expect(named.memberKind).toBe('worker'); await expect(f.service.controllerTool(named.id, 'list_workflows', {})).rejects.toThrow('不是主控');
    await expect(scopedTool(f.service, named, 'propose_plan', { idempotencyKey: 'not-controller' })).rejects.toThrow('调度权限');
    await expect(f.service.memberTool(f.worker.id, 'get_task_context', {})).rejects.toThrow('执行轮次');
    await expect(f.service.memberTool(f.lead.id, 'get_task_context', {})).rejects.toThrow('普通成员入口');
    expect(memberTools.some(tool => tool.name === 'propose_plan')).toBe(false); expect(controllerTools.some(tool => /confirm|deliver|approve/.test(tool.name))).toBe(false);
  });
  it('requires stable idempotency keys and user confirmation before automatic dispatch', async () => {
    const f = await fixture(), input = { idempotencyKey: 'one-plan', name: 'Plan', goal: 'Goal', nodes: [node(f.worker.id)] };
    const [first, second] = await Promise.all([f.service.controllerTool(f.lead.id, 'propose_plan', input), f.service.controllerTool(f.lead.id, 'propose_plan', input)]) as Workflow[];
    expect(first!.id).toBe(second!.id); expect(f.service.workflows.list(f.project.id)).toHaveLength(1); expect(f.tasks.values.size).toBe(0);
    await expect(f.service.controllerTool(f.lead.id, 'propose_plan', { ...input, goal: 'Changed' })).rejects.toThrow();
    await expect(f.service.controllerTool(f.lead.id, 'propose_plan', { ...input, idempotencyKey: undefined })).rejects.toThrow();
    await expect(f.service.controllerTool(f.lead.id, 'advance_workflow', { workflowId: first!.id, idempotencyKey: 'advance-draft' })).rejects.toThrow('确认');
    await expect(f.service.controllerTool(f.lead.id, 'confirm_plan', { workflowId: first!.id, idempotencyKey: 'confirm' })).rejects.toThrow('未知');
    const legacy = await f.service.createTask({ projectId: f.project.id, title: 'Unplanned task' });
    await expect(f.service.controllerTool(f.lead.id, 'dispatch_task', { taskId: legacy.id, agentId: f.worker.id, idempotencyKey: 'unplanned' })).rejects.toThrow('计划');
    expect(f.adapter.launches).toHaveLength(0);
  });
  it('isolates workflow and member access by project', async () => {
    const a = await fixture(), b = await fixture(), foreign = await propose(b);
    a.service.store.put('workflows', foreign.id, foreign); a.service.store.put('agents', b.worker.id, b.worker);
    await expect(a.service.controllerTool(a.lead.id, 'get_workflow', { workflowId: foreign.id })).rejects.toThrow('本项目');
    await expect(a.service.controllerTool(a.lead.id, 'get_task_context', { agentId: b.worker.id })).rejects.toThrow('本项目');
    await expect(a.service.controllerTool(a.lead.id, 'list_workflows', { projectId: b.project.id })).rejects.toThrow('自己的项目');
  });
});

describe('MCP task scope and evidence', () => {
  it('rejects late writes from an earlier turn even when human correction reuses the native session', async () => {
    const f = await fixture(), workflow = await propose(f); await start(f, workflow);
    const before = await f.service.memberTool(f.worker.id, 'get_task_context', {}) as { messageId: string; binding: TaskBinding };
    const nativeId = f.service.getAgent(f.worker.id).nativeSessionId;
    const reply = await f.service.message(f.worker.id, { text: 'Correct the report', mode: 'interrupt' }, 'correct-once') as { messageId: string };
    await vi.waitFor(() => expect(f.service.store.get<{messageId:string;state:string}>('runs',f.worker.id)).toMatchObject({messageId:reply.messageId,state:'active'}));
    const after = await f.service.memberTool(f.worker.id, 'get_task_context', {}) as { messageId: string; binding: TaskBinding };
    expect(after.messageId).toBe(reply.messageId); expect(after.binding.worktree).toBe(before.binding.worktree);
    expect(f.service.getAgent(f.worker.id).nativeSessionId).toBe(nativeId);
    for(const name of ['request_clarification','record_artifact','register_candidate','run_declared_check']) {
      await expect(f.service.memberTool(f.worker.id,name,{idempotencyKey:`late-${name}`,messageId:before.messageId,question:'old question',kind:'summary',title:'old',value:'old'})).rejects.toThrow('当前执行轮次');
      await expect(f.service.memberTool(f.worker.id,name,{idempotencyKey:`missing-${name}`})).rejects.toThrow('当前执行轮次');
    }
    const result=await f.service.memberTool(f.worker.id,'request_clarification',{idempotencyKey:'current-question',messageId:after.messageId,question:'Which output?'}) as {taskId:string};
    expect(result.taskId).toBe(after.binding.taskId);
    expect(memberTools.filter(tool=>tool.name!=='get_task_context').every(tool=>tool.required.includes('messageId'))).toBe(true);
  });
  it('binds member artifacts/candidates to its actual running task and rejects paths from another task', async () => {
    const f = await fixture(), workflow = await propose(f); const round = await start(f, workflow);
    const context = await f.service.memberTool(f.worker.id, 'get_task_context', {}) as { binding: TaskBinding; messageId: string };
    const file = join(context.binding.worktree, 'outputs', 'candidate.txt'); writeFileSync(file, 'candidate');
    const recorded = await f.service.memberTool(f.worker.id, 'record_artifact', { messageId: context.messageId, idempotencyKey: 'artifact', projectId: 'foreign', taskId: 'foreign', agentId: f.lead.id, kind: 'summary', title: 'Evidence', value: 'Actual text' }) as { projectId: string; taskId: string; agentId: string };
    expect(recorded).toMatchObject({ projectId: f.project.id, taskId: round.taskId, agentId: f.worker.id });
    const bundle = await f.service.memberTool(f.worker.id, 'register_candidate', { messageId: context.messageId, idempotencyKey: 'candidate', files: [file] }) as ArtifactBundle; expect(bundle.taskId).toBe(round.taskId);
    await expect(f.service.memberTool(f.worker.id, 'register_candidate', { messageId: context.messageId, idempotencyKey: 'outside', files: [join(f.directory, 'other.txt')] })).rejects.toThrow();
    const other = { ...bundle, id: randomUUID(), taskId: 'different-task' }; f.service.store.put('artifact_bundles', other.id, other);
    await expect(f.service.memberTool(f.worker.id, 'run_declared_check', { messageId: context.messageId, idempotencyKey: 'foreign-check', bundleId: other.id, requirementId: 'test' })).rejects.toThrow('当前任务');
  });
  it('executes only the declared command against a stopped candidate and prevents readonly backend writes', async () => {
    const f = await fixture(), marker = join(f.directory, 'unapproved-command.txt');
    const workflow = await propose(f, [node(f.worker.id, { checks: [{ id: 'test', kind: 'test', label: 'Declared command', command: process.execPath, args: ['-e', 'process.stdout.write("approved-check")'] }] })]);
    await start(f, workflow); const context = await f.service.memberTool(f.worker.id, 'get_task_context', {}) as { binding: TaskBinding; messageId: string }; const path = join(context.binding.worktree, 'outputs', 'candidate.txt'); writeFileSync(path, 'candidate');
    const early = await f.service.memberTool(f.worker.id, 'register_candidate', { messageId: context.messageId, idempotencyKey: 'early', files: [path] }) as ArtifactBundle;
    await expect(f.service.memberTool(f.worker.id, 'run_declared_check', { messageId: context.messageId, idempotencyKey: 'active-check', bundleId: early.id, requirementId: 'test' })).rejects.toThrow('停止');
    const readonly: Agent = { ...f.service.getAgent(f.worker.id), permissionMode: 'read-only' };
    await expect(scopedTool(f.service, readonly, 'run_declared_check', { messageId: context.messageId, idempotencyKey: 'readonly-check', bundleId: early.id, requirementId: 'test' })).rejects.toThrow('只读');
    const bundle = await finish(f, workflow);
    const evidence = await f.service.controllerTool(f.lead.id, 'run_declared_check', { idempotencyKey: 'approved-check', bundleId: bundle.id, requirementId: 'test', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }) as { exitCode: number; log: string };
    expect(evidence.exitCode).toBe(0); expect(evidence.log).toBe('approved-check'); expect(existsSync(marker)).toBe(false);
  });
  it('does not let a controller approve manual checkpoints, invent exceptions, or bypass rework limits', async () => {
    const f = await fixture(); const manual = node(f.worker.id, { id: 'approval', kind: 'manual', agentId: undefined, checks: [{ id: 'human', kind: 'manual', label: 'Human decision' }], dependencies: [{ nodeId: 'work', kind: 'accepted' }] });
    const workflow = await propose(f, [node(f.worker.id), manual], { maxReworkRounds: 0 }); await start(f, workflow); const bundle = await finish(f, workflow); const round = f.service.workflows.rounds(workflow.id).find(value => value.nodeId === 'work')!;
    await expect(f.service.controllerTool(f.lead.id, 'accept_task', { idempotencyKey: 'manual', workflowId: workflow.id, nodeId: 'approval', roundId: 'human' })).rejects.toThrow('用户');
    await expect(f.service.controllerTool(f.lead.id, 'accept_task', { idempotencyKey: 'exception', workflowId: workflow.id, nodeId: 'work', roundId: round.id, bundleId: bundle.id, manualExceptions: [{ requirementId: 'file', reason: 'Pretend approved' }] })).rejects.toThrow('尚未通过');
    expect(f.service.workflows.evidence(bundle.id)).toHaveLength(0);
    await expect(f.service.controllerTool(f.lead.id, 'return_task', { idempotencyKey: 'limit', workflowId: workflow.id, nodeId: 'work', sourceBundleId: bundle.id, reason: 'Fix', humanOverride: true })).rejects.toThrow('上限');
    expect(f.service.workflows.rounds(workflow.id)).toHaveLength(1);
  });
});
