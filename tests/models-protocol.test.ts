import { beforeEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ processes: [] as any[], queryOptions: undefined as any,
  request: vi.fn(), supportedModels: vi.fn(), closeQuery: vi.fn(), executable: vi.fn() }));
vi.mock('../src/server/runtime/process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/runtime/process.js')>(),
  executableFor: probe.executable,
  JsonProcess: class {
    frames: any[] = []; closed = false;
    constructor(readonly command: string, readonly args: string[], readonly cwd: string) { probe.processes.push(this); }
    async request(_id: string, frame: any) { this.frames.push(frame); return probe.request(frame); }
    async write(frame: any) { this.frames.push(frame); }
    async close() { this.closed = true; }
  },
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (args: any) => {
  probe.queryOptions = args;
  return { supportedModels: probe.supportedModels, close: probe.closeQuery };
} }));
import { discoverRuntimeModels } from '../src/server/runtime/models.js';

beforeEach(() => {
  probe.processes.length = 0; probe.queryOptions = undefined; vi.clearAllMocks();
  probe.executable.mockResolvedValue('/native/runtime');
  probe.request.mockResolvedValue({}); probe.supportedModels.mockResolvedValue([]);
});

describe('metadata-only model discovery', () => {
  it('reads every Codex page without starting a thread and filters hidden models', async () => {
    probe.request.mockImplementation(async frame => frame.method === 'initialize' ? {} : frame.params.cursor
      ? { data: [{ id: 'row-b', model: 'model-b', displayName: 'B', description: 'second', isDefault: false }], nextCursor: null }
      : { data: [{ id: 'row-a', model: 'model-a', displayName: 'A', isDefault: true }, { id: 'hidden', model: 'hidden', hidden: true }], nextCursor: 'next' });
    const catalog = await discoverRuntimeModels('codex', '/synthetic');
    expect(catalog.models).toEqual([{ id: 'model-a', name: 'A', isDefault: true }, { id: 'model-b', name: 'B', description: 'second', isDefault: false }]);
    expect(probe.processes[0].frames.map((frame: any) => frame.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(probe.processes[0].frames[2].params).toMatchObject({ includeHidden: false });
    expect(probe.processes[0].closed).toBe(true);
  });
  it('rejects broken pagination and still closes the owned Codex process', async () => {
    probe.request.mockImplementation(async frame => frame.method === 'initialize' ? {} : { data: [], nextCursor: 'repeated' });
    await expect(discoverRuntimeModels('codex', '/synthetic')).rejects.toThrow('分页游标');
    expect(probe.processes[0].closed).toBe(true);
  });
  it('maps WorkBuddy native identifiers, filters disabled models, and never exposes raw account or model fields', async () => {
    probe.request.mockImplementation(async frame => frame.request.subtype === 'initialize'
      ? { currentModelId: 'selected', models: [{ id: 'legacy', name: 'legacy' }], account: { token: 'private-account' } }
      : { availableModels: [{ modelId: 'selected', name: 'Chosen', description: 'Description' }, { modelId: 'blocked', name: 'Blocked' }, { modelId: 'hidden', name: 'Hidden' }],
        rawModels: [{ id: 'selected', apiKey: 'private-model', url: 'private-url' }, { id: 'blocked', disabled: true }, { id: 'hidden', hidden: true }] });
    const catalog = await discoverRuntimeModels('workbuddy', '/synthetic');
    expect(catalog.models).toEqual([{ id: 'selected', name: 'Chosen', description: 'Description', isDefault: true }]);
    expect(JSON.stringify(catalog)).not.toContain('private-');
    expect(probe.processes[0].frames.map((frame: any) => frame.request?.subtype)).toEqual(['initialize', 'get_available_models']);
    expect(probe.processes[0].frames[0].request.hasPrompt).toBe(true);
    expect(probe.processes[0].args).toContain('--no-session-persistence');
    expect(probe.processes[0].args).toContain('--strict-mcp-config');
    expect(probe.processes[0].closed).toBe(true);
  });
  it('uses Claude cached initialization models with no user input and closes its query', async () => {
    probe.supportedModels.mockResolvedValue([{ value: 'sonnet', displayName: 'Sonnet', description: 'Native alias', resolvedModel: 'internal-canonical', account: 'private' }]);
    const catalog = await discoverRuntimeModels('claude', '/synthetic');
    expect(catalog.models).toEqual([{ id: 'sonnet', name: 'Sonnet', description: 'Native alias' }]);
    expect(catalog.detail).toContain('兼容路由');
    expect(probe.queryOptions.options).toMatchObject({ permissionMode: 'plan', persistSession: false, settingSources: ['user', 'project', 'local'], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, tools: [] });
    expect(await probe.queryOptions.prompt[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
    expect(probe.closeQuery).toHaveBeenCalledOnce();
  });
  it('closes Claude on metadata failure without calling a model', async () => {
    probe.supportedModels.mockRejectedValue(new Error('metadata unavailable'));
    await expect(discoverRuntimeModels('claude', '/synthetic')).rejects.toThrow('metadata unavailable');
    expect(probe.closeQuery).toHaveBeenCalledOnce();
  });
  it('bounds stalled metadata and closes the owned process on timeout', async () => {
    vi.useFakeTimers();
    try {
      probe.request.mockImplementation(() => new Promise(() => {}));
      const failed = expect(discoverRuntimeModels('workbuddy', '/synthetic')).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(45_001); await failed;
      expect(probe.processes[0].closed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
