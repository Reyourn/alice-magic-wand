import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchService } from '../src/server/service.js';
import type { ServiceOptions } from '../src/server/service.js';
import type { GitRepository, TaskRepository } from '../src/server/repositories.js';
import type { Agent, ConnectionStatus, Project, RuntimeAdapter, RuntimeKind } from '../src/shared/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const work of cleanup.splice(0).reverse()) await work(); }
  finally { vi.useRealTimers(); }
});
const observed = (): ConnectionStatus => ({ state: 'authentication-observed', checkedAt: new Date().toISOString(), detail: 'Injected metadata observation only' });
async function setup(options: { read?: NonNullable<ServiceOptions['connectionOptions']>['nativeAuthentication']; login?: NonNullable<ServiceOptions['connectionOptions']>['nativeLogin']; kinds?: RuntimeKind[]; interval?: number | false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'awb-auth-service-monitor-'));
  const connect = vi.fn(async () => { throw new Error('Authentication monitoring must not start inference'); });
  const adapters: RuntimeAdapter[] = (options.kinds ?? ['codex']).map(kind => ({ kind, connect, discover: async () => ({ kind, available: true, detail: 'Controlled adapter', capabilities: { steer: false, interrupt: true, resume: true, approvals: true } }) }));
  const read = options.read ?? vi.fn(async () => observed());
  const tasks = { list: async () => [], get: async () => { throw new Error('Unexpected task read'); }, validate: async () => {}, create: async () => { throw new Error('Unexpected task creation'); }, update: async () => { throw new Error('Unexpected task change'); } } as TaskRepository;
  const git = { validate: async (path: string) => path, createWorktree: async () => { throw new Error('Unexpected worktree'); }, inspect: async () => ({ commit: 'a'.repeat(40), dirty: false, diff: '' }), resolveCommit: async (_project: Project, ref: string) => ref } as GitRepository;
  const service = new WorkbenchService({ dataDir: directory, adapters, tasks, git, authenticationMonitorIntervalMs: options.interval ?? 1000, connectionOptions: { nativeAuthentication: read, nativeLogin: options.login } });
  cleanup.push(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const addAgent = async () => {
    const project: Project = { id: randomUUID(), name: 'Controlled monitor project', kind: 'code', path: directory, createdAt: new Date().toISOString() };
    service.store.put('projects', project.id, project);
    return service.createAgent({ projectId: project.id, name: 'Metadata test member', role: 'worker', runtime: 'codex' });
  };
  return { service, read, connect, directory, addAgent };
}

describe('service authentication monitoring independent of browser views', () => {
  it('checks native connections without any project, member or browser and stops scheduling on close', async () => {
    const read = vi.fn(async () => observed()), f = await setup({ read, interval: 2000 });
    vi.useFakeTimers();
    expect(f.service.agents()).toHaveLength(0);
    f.service.startAuthenticationMonitoring(); f.service.startAuthenticationMonitoring();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.service.connectionManager.get('native-codex').authenticationStatus?.state).toBe('authentication-observed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    await f.service.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('skips executing and uncertain members while checking idle native connections', async () => {
    const read = vi.fn(async () => observed()), f = await setup({ read }), agent = await f.addAgent();
    for (const state of ['starting', 'running', 'waiting_approval', 'interrupting', 'unknown'] as Agent['state'][]) {
      f.service.store.put('agents', agent.id, { ...agent, state });
      await f.service.refreshAuthenticationStatuses();
    }
    expect(read).not.toHaveBeenCalled();
    for (const state of ['offline', 'idle', 'stopped'] as Agent['state'][]) {
      f.service.store.put('agents', agent.id, { ...agent, state });
      await f.service.refreshAuthenticationStatuses();
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('does not probe during a login but consumes a finished login without a browser GET/login', async () => {
    let loginFinished = false;
    const read = vi.fn(async () => observed()), closed = vi.fn(async () => {});
    const f = await setup({ read, login: { launch: async () => ({ poll: async () => loginFinished ? { state: 'completed', detail: 'Injected authorization completed' } : undefined, close: closed }) } });
    const attempt = await f.service.startNativeLogin('native-codex', {}) as { state: string };
    expect(attempt.state).toBe('waiting');
    await f.service.refreshAuthenticationStatuses();
    expect(read).not.toHaveBeenCalled();
    loginFinished = true;
    await f.service.refreshAuthenticationStatuses();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.service.connectionManager.get('native-codex').authenticationStatus?.state).toBe('authentication-observed');
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('coalesces overlapping periodic reads and waits for their result before closing the store', async () => {
    let release!: (state: ConnectionStatus) => void;
    const read = vi.fn(() => new Promise<ConnectionStatus>(resolve => { release = resolve; })), f = await setup({ read, kinds: ['codex', 'claude'] });
    vi.useFakeTimers(); f.service.startAuthenticationMonitoring();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = f.service.close().then(() => { closed = true; });
    try {
      await Promise.resolve(); expect(closed).toBe(false);
      release(observed()); await closing; expect(closed).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledTimes(1); // Do not advance to the next native runtime during shutdown.
      expect(f.connect).not.toHaveBeenCalled();
    } finally { release?.(observed()); await closing; }
  });

  it('honors an explicit monitoring opt-out without disabling manual refresh', async () => {
    const read = vi.fn(async () => observed()), f = await setup({ read, interval: false });
    vi.useFakeTimers(); f.service.startAuthenticationMonitoring();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).not.toHaveBeenCalled();
    await f.service.refreshAuthenticationStatuses();
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
  });
});
