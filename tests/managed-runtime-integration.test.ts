import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Project, RuntimeAdapter, RuntimeAuthenticationControl, RuntimeAuthenticationSession, RuntimeConnection, RuntimeEvent, RuntimeOptions, Task, TaskBinding } from '../src/shared/types.js';
import type { GitRepository, TaskCreateInput, TaskRepository } from '../src/server/repositories.js';
import type { QueuedMessage, RunRecord } from '../src/server/store.js';
import { buildApp } from '../src/server/index.js';

// Controlled in-process transports only: no CLI, model, login or real child process.
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type Session = { options: RuntimeOptions; emit: (event: RuntimeEvent) => void; messageId?: string };

class ManagedAdapter implements RuntimeAdapter {
  kind = 'workbuddy' as const;
  readonly pid = 2_147_000_001;
  rows: RuntimeAuthenticationSession[] = [];
  private authorizationUrls = new Map<string, string>();
  connectMode: 'ready' | 'pending' | 'stop-failure' = 'ready';
  connecting = gate();
  sessions = new Map<string, Session>();
  onInterrupt: (session: Session) => Promise<void> = async () => {};
  order: string[] = [];
  sends = vi.fn(async (_text: string, _messageId: string) => {});
  connectionClose = vi.fn(async () => { this.order.push('connection.close'); });
  authentication: RuntimeAuthenticationControl = {
    list: () => structuredClone(this.rows),
    url: vi.fn(id => this.authorizationUrls.get(id)),
    cancel: vi.fn(async id => {
      const row = this.rows.find(item => item.id === id);
      if (row) { row.state = 'stopped'; this.connecting.release(); }
    }),
    close: vi.fn(async () => {
      this.order.push('authentication.close');
      this.connecting.release();
    }),
  };
  async discover() {
    return { kind: this.kind, available: true, detail: 'Controlled managed transport; no native invocation', capabilities: { interrupt: true, approvals: true, resume: true, steer: false } };
  }
  addAuthentication(state: RuntimeAuthenticationSession['state'] = 'waiting') {
    const row: RuntimeAuthenticationSession = {
      id: randomUUID(), agentId: 'controlled-member', connectionId: 'native-workbuddy', connectionRevision: 1,
      edition: 'china', cwd: '.', state, pid: this.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      detail: 'Controlled authorization status', canAuthorize: state === 'waiting',
    };
    this.rows.push(row);
    this.authorizationUrls.set(row.id, 'https://auth.example.test/authorize?state=PRIVATE_AUTH_STATE');
    return row;
  }
  async connect(options: RuntimeOptions, emit: (event: RuntimeEvent) => void): Promise<RuntimeConnection> {
    const session: Session = { options, emit }; this.sessions.set(options.agentId, session);
    const row = this.addAuthentication(this.connectMode === 'ready' ? 'authenticated' : 'waiting');
    row.agentId = options.agentId; row.cwd = options.cwd;
    emit({ type: 'ready', data: { pid: this.pid } });
    if (this.connectMode !== 'ready') await this.connecting.promise;
    if (row.state === 'stopped') {
      throw Object.assign(new Error('Controlled pending process stopped'), { code: 'WORKBUDDY_AUTHENTICATION_CANCELLED', stopConfirmed: true, pid: this.pid });
    }
    if (this.connectMode === 'stop-failure') {
      row.state = 'unknown';
      throw Object.assign(new Error('Controlled startup stop is unconfirmed'), { stopConfirmed: false, pid: this.pid });
    }
    return {
      nativeSessionId: `controlled-${row.id}`, pid: this.pid,
      send: async (text, messageId) => { session.messageId = messageId; await this.sends(text, messageId); },
      interrupt: async () => this.onInterrupt(session), respondApproval: async () => {}, close: this.connectionClose,
    };
  }
}

class Git implements GitRepository {
  async validate(path: string) { return path; }
  async createWorktree(project: Project, taskId: string, agentId: string): Promise<TaskBinding> {
    return { projectId: project.id, taskId, agentId, worktree: project.path, branch: `controlled-${taskId}`, startCommit: 'a'.repeat(40) };
  }
  async inspect() { return { commit: 'a'.repeat(40), dirty: false, diff: '' }; }
  async resolveCommit(_project: Project, ref: string) { return ref; }
}
class Tasks implements TaskRepository {
  private rows = new Map<string, Task>();
  async validate() {}
  async list(project: Project) { return [...this.rows.values()].filter(row => row.projectId === project.id); }
  async get(project: Project, id: string) {
    const row = this.rows.get(id); if (!row || row.projectId !== project.id) throw new Error('Missing controlled task'); return row;
  }
  async create(project: Project, input: TaskCreateInput) {
    const row: Task = { id: input.id ?? randomUUID(), projectId: project.id, title: input.title, description: input.description ?? '', acceptance: input.acceptance ?? '', dependencies: input.dependencies ?? [], status: 'open' };
    this.rows.set(row.id, row); return row;
  }
  async update(project: Project, id: string, fields: { status?: string; owner?: string }) { const row = await this.get(project, id); Object.assign(row, fields); return row; }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'awb-managed-integration-'));
  const adapter = new ManagedAdapter();
  const app = await buildApp({ dataDir: directory, adapters: [adapter], tasks: new Tasks(), git: new Git(), token: 'controlled-browser-token', staticRoot: false, authenticationMonitorIntervalMs: false });
  const service = app.workbench;
  cleanup.push(async () => {
    // Ensure a failing regression assertion cannot leave this synthetic connect pending.
    adapter.connecting.release();
    await app.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  // Isolate lifecycle behavior from native configuration/proof tests. Human input
  // does not pass the automatic dispatch proof gate, and no native config is read.
  vi.spyOn(service.connectionManager, 'resolveRuntime').mockResolvedValue({ connectionId: 'native-workbuddy', revision: 1, env: {} });
  const project: Project = { id: randomUUID(), name: 'Managed lifecycle fixture', path: directory, kind: 'code', createdAt: new Date().toISOString() };
  service.store.put('projects', project.id, project);
  const member = await service.createAgent({ projectId: project.id, name: 'Controlled member', role: 'developer', runtime: 'workbuddy' });
  service.store.put('agents', member.id, { ...member, worktree: directory });
  const headers = { 'x-workbench-token': 'controlled-browser-token' };
  return { app, service, adapter, member, headers, project, directory };
}

async function flush() { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); }

describe('managed native runtime HTTP and service lifecycle', () => {
  it('projects safe authorization status and exposes the native URL only through a no-store redirect', async () => {
    const f = await setup(), row = f.adapter.addAuthentication();
    // An adapter bug or future extension must not expand the HTTP projection.
    Object.assign(row, { authUrl: 'https://private.example.test/PRIVATE_AUTH_URL', token: 'PRIVATE_ACCOUNT_TOKEN', userinfo: { nickname: 'PRIVATE_USERINFO' } });
    const response = await f.app.inject('/api/runtime-auth');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toEqual([expect.objectContaining({ id: row.id, state: 'waiting', canAuthorize: true })]);
    expect(response.body).not.toMatch(/PRIVATE_|https?:\/\//);
    expect(response.json()[0]).not.toHaveProperty('authUrl');
    expect(response.json()[0]).not.toHaveProperty('token');
    expect(response.json()[0]).not.toHaveProperty('userinfo');
    expect(f.adapter.authentication.url).not.toHaveBeenCalled();
    const opened = await f.app.inject(`/api/runtime-auth/${row.id}/open`);
    expect(opened.statusCode).toBe(302);
    expect(opened.headers.location).toBe('https://auth.example.test/authorize?state=PRIVATE_AUTH_STATE');
    expect(opened.headers['cache-control']).toContain('no-store');
    expect(opened.body).not.toContain('PRIVATE_AUTH_STATE');
  });

  it('returns 404 for unknown authorization IDs without forwarding cancellation', async () => {
    const f = await setup();
    const opened = await f.app.inject('/api/runtime-auth/not-owned/open');
    const cancelled = await f.app.inject({ method: 'POST', url: '/api/runtime-auth/not-owned/cancel', headers: f.headers, payload: {} });
    expect(opened.statusCode).toBe(404); expect(cancelled.statusCode).toBe(404);
    expect(f.adapter.authentication.cancel).not.toHaveBeenCalled();
  });

  it('does not cancel an authenticated process but forwards pending and unknown stop requests', async () => {
    const f = await setup(), authenticated = f.adapter.addAuthentication('authenticated');
    const response = await f.app.inject({ method: 'POST', url: `/api/runtime-auth/${authenticated.id}/cancel`, headers: f.headers, payload: {} });
    expect(response.statusCode).toBe(409); expect(f.adapter.authentication.cancel).not.toHaveBeenCalled();
    for (const state of ['waiting', 'unknown'] as const) {
      const row = f.adapter.addAuthentication(state);
      const cancelled = await f.app.inject({ method: 'POST', url: `/api/runtime-auth/${row.id}/cancel`, headers: f.headers, payload: {} });
      expect(cancelled.statusCode).toBe(200);
      expect(f.adapter.authentication.cancel).toHaveBeenCalledWith(row.id);
    }
  });

  it('closes pending adapter authentication before waiting for connect and never sends the cancelled message', async () => {
    const f = await setup(); f.adapter.connectMode = 'pending';
    await f.service.message(f.member.id, { text: 'Controlled unsent instruction' }, 'managed-pending-close');
    await vi.waitFor(() => expect(f.adapter.rows.some(row => row.agentId === f.member.id)).toBe(true));
    const closing = f.service.close();
    try {
      await vi.waitFor(() => expect(f.adapter.authentication.close).toHaveBeenCalledOnce(), { timeout: 800 });
    } finally {
      f.adapter.connecting.release();
      await closing;
    }
    expect(f.adapter.order[0]).toBe('authentication.close');
    expect(f.adapter.connectionClose).toHaveBeenCalledOnce();
    expect(f.adapter.sends).not.toHaveBeenCalled();
  });

  it('records startup PID before connect resolves and preserves unknown if stopping fails before a user message is sent', async () => {
    const f = await setup(); f.adapter.connectMode = 'stop-failure';
    const receipt = await f.service.message(f.member.id, { text: 'Controlled startup only' }, 'managed-unknown-startup') as { messageId: string };
    await vi.waitFor(() => expect(f.adapter.rows.some(row => row.agentId === f.member.id)).toBe(true));
    expect(f.service.store.get<RunRecord>('runs', f.member.id)).toMatchObject({ pid: f.adapter.pid, state: 'active' });
    expect(f.service.store.get<QueuedMessage>('messages', receipt.messageId)?.state).toBe('queued');
    f.adapter.connecting.release();
    await vi.waitFor(() => expect(f.service.getAgent(f.member.id).state).toBe('unknown'));
    expect(f.service.store.get<RunRecord>('runs', f.member.id)).toMatchObject({ pid: f.adapter.pid, state: 'unknown' });
    expect(f.adapter.sends).not.toHaveBeenCalled();
    await expect(f.service.message(f.member.id, { text: 'Must not create a second writer' }, 'managed-forbidden-retry')).rejects.toThrow(/未知|未确认停止/);
    expect(f.adapter.rows).toHaveLength(1);
  });

  it('stops an authenticated process still finishing connect without allowing public authorization cancellation or sending input', async () => {
    const f = await setup(); f.adapter.connectMode = 'pending';
    const receipt = await f.service.message(f.member.id, { text: 'Must remain unsent during optional initialization' }, 'managed-authenticated-initializing') as { messageId: string };
    await vi.waitFor(() => expect(f.adapter.rows.some(row => row.agentId === f.member.id)).toBe(true));
    // Native authorization has succeeded, but the adapter still owns optional
    // initialization and has not returned its RuntimeConnection to the service.
    const row = f.adapter.rows.find(row => row.agentId === f.member.id)!;
    row.state = 'authenticated'; row.canAuthorize = false;
    const denied = await f.app.inject({ method: 'POST', url: `/api/runtime-auth/${row.id}/cancel`, headers: f.headers, payload: {} });
    expect(denied.statusCode).toBe(409); expect(f.adapter.authentication.cancel).not.toHaveBeenCalled();
    const stopped = await f.service.interrupt(f.member.id);
    expect(f.adapter.authentication.cancel).toHaveBeenCalledOnce();
    expect(f.adapter.authentication.cancel).toHaveBeenCalledWith(row.id);
    expect(stopped.state).toBe('stopped'); expect(row.state).toBe('stopped');
    expect(f.service.store.get<RunRecord>('runs', f.member.id)).toMatchObject({ state: 'terminal', pid: f.adapter.pid });
    expect(f.service.store.get<QueuedMessage>('messages', receipt.messageId)?.state).toBe('cancelled');
    expect(f.adapter.sends).not.toHaveBeenCalled(); expect(f.adapter.connectionClose).not.toHaveBeenCalled();
  });

  it.each([false, true])('holds queued system corrections until the interrupt promise settles (failure: %s)', async failure => {
    const f = await setup(), acknowledgement = gate(), requested = gate();
    // This suite supplies a controlled proof result to isolate scheduling from
    // the separate connection verification suites; no inference is performed.
    vi.spyOn(f.service.connectionManager, 'assertReady').mockResolvedValue({} as never);
    const lead = await f.service.createAgent({ projectId: f.project.id, name: 'Controlled lead', role: 'controller', memberKind: 'controller', runtime: 'workbuddy' });
    const original = await f.service.message(lead.id, { text: 'Controlled original goal' }, 'managed-interrupt-original') as { messageId: string };
    await vi.waitFor(() => expect(f.adapter.sends).toHaveBeenCalledOnce());
    f.adapter.onInterrupt = async session => {
      // The native result can precede the cancellation RPC acknowledgement.
      session.emit({ type: 'result', messageId: session.messageId, data: { interrupted: true } });
      requested.release(); await acknowledgement.promise;
      if (failure) throw new Error('Controlled cancellation acknowledgement missing');
    };
    const interrupted = f.service.interrupt(lead.id).then(() => ({ error: undefined }), error => ({ error }));
    try {
      await requested.promise;
      await vi.waitFor(() => expect(f.service.store.events().some(event => event.type === 'agent.turn_completed' && event.data?.messageId === original.messageId)).toBe(true));
      // A public task-return action creates a real system correction while the
      // human interrupt endpoint still owns the member's command lock.
      const task = await f.service.createTask({ projectId: f.project.id, title: 'Controlled return notice' });
      await f.service.setTaskStatus(task.id, { projectId: f.project.id, status: 'open', reason: 'Correction arriving during native stop' });
      await flush();
      expect(f.adapter.sends).toHaveBeenCalledOnce();
      const notice = f.service.store.all<QueuedMessage>('messages').find(message => message.agentId === lead.id && message.source === 'system');
      expect(notice).toMatchObject({ state: 'queued' });
      acknowledgement.release(); const outcome = await interrupted;
      if (failure) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(f.service.getAgent(lead.id).state).toBe('unknown');
        await flush(); expect(f.adapter.sends).toHaveBeenCalledOnce();
        expect(f.service.store.get<QueuedMessage>('messages', notice!.id)?.state).toBe('queued');
      } else {
        expect(outcome.error).toBeUndefined();
        await vi.waitFor(() => expect(f.adapter.sends).toHaveBeenCalledTimes(2));
        expect(f.adapter.sends.mock.calls[1]![0]).toContain('Correction arriving during native stop');
      }
    } finally { acknowledgement.release(); await interrupted; }
  });

  it('reuses the same member session for task rework and closes it when the task changes even with the same workspace', async () => {
    const f = await setup();
    // Plan admission is independently tested; this case exercises real public
    // dispatch, bindings, native receipts and session lifetime with fake Git/Beads.
    vi.spyOn(f.service.workflows, 'assertDispatch').mockImplementation(() => {});
    const first = await f.service.createTask({ projectId: f.project.id, title: 'Controlled first task' });
    const dispatch = async (taskId: string, key: string) => f.service.dispatch(taskId, { projectId: f.project.id, agentId: f.member.id }, key) as Promise<{ messageId: string }>;
    const finish = async (messageId: string) => {
      f.adapter.sessions.get(f.member.id)!.emit({ type: 'result', messageId, text: 'Controlled task result', data: { status: 'completed' } });
      await vi.waitFor(() => expect(f.service.store.events().some(event => event.type === 'agent.turn_completed' && event.data?.messageId === messageId)).toBe(true));
    };
    const original = await dispatch(first.id, 'managed-rework-original');
    await vi.waitFor(() => expect(f.adapter.sends).toHaveBeenCalledOnce());
    const nativeSessionId = f.service.getAgent(f.member.id).nativeSessionId;
    await finish(original.messageId);
    const rework = await dispatch(first.id, 'managed-rework-again');
    await vi.waitFor(() => expect(f.adapter.sends).toHaveBeenCalledTimes(2));
    expect(f.adapter.rows).toHaveLength(1); expect(f.adapter.connectionClose).not.toHaveBeenCalled();
    expect(f.service.getAgent(f.member.id)).toMatchObject({ nativeSessionId, currentTaskId: first.id, worktree: f.directory });
    await finish(rework.messageId);
    const next = await f.service.createTask({ projectId: f.project.id, title: 'Controlled next task' });
    await dispatch(next.id, 'managed-new-task');
    await vi.waitFor(() => expect(f.adapter.sends).toHaveBeenCalledTimes(3));
    expect(f.adapter.connectionClose).toHaveBeenCalledOnce(); expect(f.adapter.rows).toHaveLength(2);
    expect(f.service.getAgent(f.member.id)).toMatchObject({ currentTaskId: next.id, worktree: f.directory });
    expect(f.service.getAgent(f.member.id).nativeSessionId).not.toBe(nativeSessionId);
  });
});
