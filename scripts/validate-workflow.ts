import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { Snapshot, WorkbenchEvent } from '../src/shared/types.js';

// Read-only acceptance collector. No native calls, task mutations or permission replies.
const origin = process.env.WORKBENCH_URL ?? 'http://127.0.0.1:4310';
const url = new URL(origin);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Use a local workbench URL');
const snapshot = await fetch(`${origin}/api/state`).then(async response => {
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  return response.json() as Promise<Snapshot>;
});
const project = snapshot.projects.find(p => process.argv[2] ? p.id === process.argv[2] : p.path === resolve('.workbench/sandbox/collaboration-demo'));
if (!project) throw new Error('Synthetic project not found; pass its project ID');
const db = new DatabaseSync(join(process.env.WORKBENCH_DATA_DIR ?? join(homedir(), '.agent-workbench'), 'workbench.sqlite'), { readOnly: true });
const allEvents = (db.prepare('SELECT id,json FROM events ORDER BY id').all() as { id: number; json: string }[])
  .map(row => ({ ...JSON.parse(row.json), id: row.id }) as WorkbenchEvent).filter(e => e.projectId === project.id);
db.close();
const agents = snapshot.agents.filter(a => a.projectId === project.id);
const tasks = snapshot.tasks.filter(t => t.projectId === project.id);
const bindings = snapshot.bindings.filter(b => b.projectId === project.id);
const artifacts = snapshot.artifacts.filter(a => a.projectId === project.id);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const inspected = bindings.map(binding => ({ ...binding, actualCommit: git(binding.worktree, 'rev-parse', 'HEAD'), clean: git(binding.worktree, 'status', '--porcelain') === '' }));
const evidence = agents.map(agent => ({
  id: agent.id, name: agent.name, runtime: agent.runtime, model: agent.observedModel,
  nativeSessionId: agent.nativeSessionId, state: agent.state, controlMode: agent.controlMode,
  dispatched: allEvents.filter(e => e.agentId === agent.id && e.type === 'task.dispatched').map(e => ({ eventId: e.id, ...e.data })),
  controlChanges: allEvents.filter(e => e.agentId === agent.id && e.type === 'agent.control').map(e => ({ eventId: e.id, at: e.createdAt, ...e.data })),
  humanMessages: allEvents.filter(e => e.agentId === agent.id && e.type === 'message.queued' && e.data?.source === 'human').map(e => ({ eventId: e.id, messageId: e.data?.messageId, taskId: e.data?.taskId })),
  results: allEvents.filter(e => e.agentId === agent.id && e.type === 'agent.turn_completed').map(e => ({ eventId: e.id, ...e.data })),
  permissions: allEvents.filter(e => e.agentId === agent.id && e.type === 'runtime.approval').map(e => ({ eventId: e.id, tool: e.data?.tool })),
}));
const checks = {
  threeNativeTools: ['codex', 'claude', 'workbuddy'].every(kind => evidence.some(a => a.runtime === kind && a.nativeSessionId && a.results.length)),
  workerDispatchAndIntervention: ['claude', 'workbuddy'].every(kind => evidence.some(a => a.runtime === kind && a.dispatched.length && a.humanMessages.length && a.controlChanges.length)),
  tasksAccepted: tasks.length >= 2 && tasks.every(task => task.status === 'closed'),
  independentFixedCommitReview: inspected.some(review => agents.find(a => a.id === review.agentId)?.runtime === 'claude' && inspected.some(implementation => agents.find(a => a.id === implementation.agentId)?.runtime === 'workbuddy' && implementation.candidateCommit === review.startCommit && implementation.worktree !== review.worktree)),
  cleanWorktrees: inspected.length >= 2 && inspected.every(b => b.clean && b.actualCommit === b.candidateCommit),
  commitTestReviewEvidence: ['commit', 'test', 'review'].every(kind => artifacts.some(a => a.kind === kind && a.taskId)),
};
const controller = agents.find(a=>a.role==='controller');
const latestControllerFailure=allEvents.filter(e=>e.agentId===controller?.id&&e.type==='runtime.failure').at(-1);
const controllerQuotaBlocked = !!controller?.lastError?.includes('usage limit') || controller?.state==='unknown' && !!latestControllerFailure?.text?.includes('usage limit');
const controllerAcceptanceEvents=allEvents.filter(e=>e.agentId===controller?.id&&e.type==='runtime.tool'&&e.data?.phase==='completed'&&e.data?.tool==='set_task_status');
const deliveryPassed=Object.values(checks).every(Boolean);
const automaticAcceptancePassed=deliveryPassed&&!controllerQuotaBlocked&&controllerAcceptanceEvents.length>=2;
const report = { checkedAt: new Date().toISOString(), project, passed: automaticAcceptancePassed, deliveryPassed, automaticAcceptancePassed, controllerQuotaBlocked, latestControllerFailure, controllerAcceptanceEventIds:controllerAcceptanceEvents.map(e=>e.id), checks, agents: evidence, tasks, bindings: inspected, artifacts, usage: snapshot.usage, usageSummaries: snapshot.usageSummaries };
await mkdir('.workbench/validation', { recursive: true });
await writeFile('.workbench/validation/workflow.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, deliveryPassed, automaticAcceptancePassed, controllerQuotaBlocked, checks, report: resolve('.workbench/validation/workflow.json') }, null, 2));
if (!report.passed) process.exitCode = 1;
