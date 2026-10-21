import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Query, Options } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeEvent, RuntimeOptions } from '../src/shared/types.js';
import { JsonLines, JsonProcess, safeData, type Json } from '../src/server/runtime/process.js';
import { CodexConnection } from '../src/server/runtime/codex.js';
import { WorkbuddyConnection, workbuddyArguments, workbuddyLaunch } from '../src/server/runtime/workbuddy.js';
import { ClaudeConnection, InputQueue } from '../src/server/runtime/claude.js';
import { normalizeUsage } from '../src/server/runtime/usage.js';
import { classifyConnectionError } from '../src/server/connections/manager.js';

const options: RuntimeOptions = { agentId: 'test', cwd: process.cwd(), permissionMode: 'workspace-write', instructions: '用中文回答。', mcpServers: { workbench: { command: process.execPath, args: ['bridge.js'], env: { WORKBENCH_CONTROLLER_TOKEN: 'do-not-expose-this' } } } };
const flush = () => new Promise(resolve => setImmediate(resolve));

/** A protocol peer verifies wire contracts; this is deliberately not a model/runtime acceptance test. */
class Peer extends EventEmitter {
  pid = 123;
  frames: Json[] = [];
  result: (frame: Json) => Json = frame => {
    if (frame.method === 'thread/start' || frame.method === 'thread/resume') return { thread: { id: 'native-id' }, model: 'configured-model' };
    if (frame.method === 'turn/start') return { turn: { id: 'turn-1' } };
    if (frame.request?.subtype === 'initialize') return { currentModelId: 'configured-model', account: { token: 'never-forward-this' } };
    return {};
  };
  async request(_id: string, frame: Json): Promise<Json> { this.frames.push(frame); return this.result(frame); }
  async write(frame: Json): Promise<void> { this.frames.push(frame); }
  async close(): Promise<void> {}
  process(): JsonProcess { return this as unknown as JsonProcess; }
}

describe('runtime transport contracts', () => {
  it('decodes split UTF-8 and concatenated JSON lines without exposing malformed input', () => {
    const frames: Json[] = []; let malformed = 0;
    const lines = new JsonLines(frame => frames.push(frame), () => malformed++);
    const bytes = Buffer.from('{"text":"中文消息"}\r\n{"type":"result"}\n');
    for (const byte of bytes) lines.push(Buffer.from([byte]));
    lines.push('not-json-containing-secret\n');
    expect(frames).toEqual([{ text: '中文消息' }, { type: 'result' }]); expect(malformed).toBe(1);
  });
  it('redacts sensitive structured fields and textual bearer credentials', () => {
    expect(safeData({ env: { SECRET: 'foo' }, account: { accessToken: 'secret' }, text: 'Authorization: Bearer abc.def.ghi' })).toEqual({ env: '[REDACTED]', account: { accessToken: '[REDACTED]' }, text: 'Authorization: [REDACTED]' });
  });
  it('matches actual child process responses and rejects pending calls when child exits', async () => {
    const script = `const r=require('readline').createInterface({input:process.stdin});r.on('line',line=>{const f=JSON.parse(line);if(f.method==='die')process.exit(3);else process.stdout.write(JSON.stringify({id:f.id,result:{text:f.params.text}})+'\\n')});`;
    const child = new JsonProcess(process.execPath, ['-e', script], process.cwd());
    try {
      await expect(child.request('a', { id: 'a', method: 'echo', params: { text: '中文不丢失' } })).resolves.toEqual({ text: '中文不丢失' });
      await expect(child.request('b', { id: 'b', method: 'die' })).rejects.toThrow('运行程序退出');
    } finally { await child.close(); }
  });
});

describe('native token accounting', () => {
  it('preserves only valid token counters through redaction and leaves missing counts absent', () => {
    expect(safeData({ inputTokens: 12, output_tokens: 0, cache_read_input_tokens: 8, accessToken: 123, totalTokens: 'private', cachedInputTokens: -1 })).toEqual({ inputTokens: 12, output_tokens: 0, cache_read_input_tokens: 8, accessToken: '[REDACTED]', totalTokens: '[REDACTED]', cachedInputTokens: '[REDACTED]' });
    expect(normalizeUsage({ input_tokens: 'unknown', output_tokens: null }, 'workbuddy', { scope: 'session', source: 'test' })).toBeUndefined();
    expect(normalizeUsage({ output_tokens: 0 }, 'workbuddy', { scope: 'session', source: 'test' })).toEqual({ scope: 'session', source: 'test', outputTokens: 0 });
  });
  it.each([undefined, 'native-id'])('uses Codex cumulative totals, associates exact turns and preserves resume baseline uncertainty (%s)', async resumeSessionId => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new CodexConnection({ ...options, resumeSessionId }, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('计数', 'usage-turn');
    const total = { inputTokens: 120, outputTokens: 30, cachedInputTokens: 70, cacheWriteInputTokens: 10, reasoningOutputTokens: 12, totalTokens: 150 };
    peer.emit('frame', { method: 'thread/tokenUsage/updated', params: { threadId: 'native-id', turnId: 'old-turn', tokenUsage: { total, last: { inputTokens: 3, outputTokens: 1 } } } });
    peer.emit('frame', { method: 'thread/tokenUsage/updated', params: { threadId: 'native-id', turnId: 'turn-1', tokenUsage: { total, last: { inputTokens: 3, outputTokens: 1 } } } });
    peer.emit('frame', { method: 'thread/tokenUsage/updated', params: { threadId: 'other-thread', turnId: 'turn-1', tokenUsage: { total } } });
    const usage = events.filter(event => event.type === 'usage');
    expect(usage).toHaveLength(2); expect(usage[0].messageId).toBeUndefined();
    expect(usage[1]).toMatchObject({ nativeSessionId: 'native-id', messageId: 'usage-turn', data: { scope: 'session', source: 'codex.thread.tokenUsage.total', inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 70, cacheCreationInputTokens: 10, reasoningOutputTokens: 12 } });
    expect(usage[1].data?.baselineKnownZero).toBe(resumeSessionId ? undefined : true);
    await conn.close();
  });
  it('emits WorkBuddy result session snapshots once, without adding cache subsets or assistant usage', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await conn.initialize();
    for (const [index, input, output] of [[1, 100, 20], [2, 250, 45]]) {
      await conn.send('计数', `wb-${index}`);
      peer.emit('frame', { type: 'assistant', session_id: 'wb-session', message: { content: [], usage: { input_tokens: 1000, output_tokens: 1000 } } });
      const result = { type: 'result', session_id: 'wb-session', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 60, cache_creation_input_tokens: null } };
      peer.emit('frame', { ...result, agent_id: 'child' });
      peer.emit('frame', result); peer.emit('frame', result);
    }
    const usage = events.filter(event => event.type === 'usage');
    expect(usage).toHaveLength(2);
    expect(usage.map(event => event.data?.totalTokens)).toEqual([120, 295]);
    expect(usage[1]).toMatchObject({ messageId: 'wb-2', nativeSessionId: 'wb-session', data: { scope: 'session', source: 'workbuddy.result.usage', inputTokens: 250, cachedInputTokens: 60, baselineKnownZero: true } });
    expect(usage[1].data).not.toHaveProperty('cacheCreationInputTokens');
    await conn.close();
  });
  it('uses only Claude root result per-turn usage and includes reported cache counts in total input', async () => {
    const output = new InputQueue<Json>();
    const fakeQuery = { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), initializationResult: async () => ({}), close: () => output.close() };
    const events: RuntimeEvent[] = [];
    const conn = new ClaudeConnection(options, event => events.push(event), 'claude.exe', (() => fakeQuery as unknown as Query) as any);
    await conn.initialize(); await conn.send('计数', 'claude-turn');
    output.push({ type: 'assistant', session_id: 'claude-session', message: { content: [], usage: { input_tokens: 500, output_tokens: 500 } } });
    output.push({ type: 'result', session_id: 'child-session', agent_id: 'child', usage: { input_tokens: 500, output_tokens: 500 } });
    const result = { type: 'result', session_id: 'claude-session', usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }, modelUsage: { model: { inputTokens: 900, outputTokens: 100 } } };
    output.push(result); output.push(result); await flush();
    const usage = events.filter(event => event.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ messageId: 'claude-turn', nativeSessionId: 'claude-session', data: { scope: 'turn', source: 'claude.result.usage', partial: true, inputTokens: 110, outputTokens: 7, totalTokens: 117, cachedInputTokens: 80, cacheCreationInputTokens: 20 } });
    await conn.close();
  });
});

describe('Codex App Server adapter', () => {
  it.each([true, false])('waits for user consent on native empty MCP approval forms (allow=%s)', async allow => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new CodexConnection({ ...options, permissionMode: 'read-only' }, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('查看团队', 'mcp-message');
    // Shape captured from Codex 0.160.0's native workbench/list_team approval;
    // metadata values here are test data, never copied account/runtime credentials.
    peer.emit('frame', { id: 48, method: 'mcpServer/elicitation/request', params: {
      threadId: 'native-id', turnId: 'turn-1', serverName: 'workbench', mode: 'form',
      message: 'Allow the workbench MCP server to run tool "list_team"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'native-tool-consent', persist: true, tool_description: 'List team',
        tool_params: { projectId: 'project-1', nested: { accessToken: 'private-value' } },
        tool_params_display: 'password=private-display', privateContext: 'private-metadata' },
    } });
    await flush();
    const approval = events.find(e => e.type === 'approval');
    expect(approval).toMatchObject({ approvalId: '48', data: { tool: 'MCP 工具调用', input: {
      serverName: 'workbench', toolParameters: { projectId: 'project-1', nested: { accessToken: '[REDACTED]' } },
    } } });
    expect(peer.frames.find(f => f.id === 48)).toBeUndefined();
    expect(events.at(-2)?.state).toBe('waiting_approval');
    expect(JSON.stringify(events)).not.toContain('private-value'); expect(JSON.stringify(events)).not.toContain('private-display');
    expect(JSON.stringify(events)).not.toContain('private-metadata');
    await conn.respondApproval('48', allow);
    expect(peer.frames.find(f => f.id === 48)?.result).toEqual(allow ? { action: 'accept', content: {} } : { action: 'decline' });
    expect(peer.frames.find(f => f.id === 48)?.result).not.toHaveProperty('_meta');
    await expect(conn.respondApproval('48', true)).rejects.toThrow('已结束或不存在');
    await conn.close();
  });
  it.each([
    { mode: 'form', requestedSchema: { type: 'object', properties: {} } },
    { mode: 'form', requestedSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['once', 'always'] } } }, _meta: { codex_approval_kind: 'native-tool-consent' } },
    { mode: 'url', url: 'https://example.test/authorize?private=do-not-forward', elicitationId: 'external-auth' },
    { mode: 'openai/userVerification', challenge: 'private-challenge', title: 'Verify', description: 'Device verification required' },
  ])('does not turn unsupported or unmarked elicitation into blanket approval ($mode)', async request => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new CodexConnection(options, event => events.push(event), peer.process());
    await conn.initialize();
    peer.emit('frame', { id: 'unsupported', method: 'mcpServer/elicitation/request', params: {
      threadId: 'native-id', serverName: 'example', message: 'Additional input needed', ...request,
    } });
    await flush();
    expect(peer.frames.find(f => f.id === 'unsupported')?.result).toEqual({ action: 'decline' });
    expect(events.some(e => e.type === 'approval')).toBe(false);
    expect(events.some(e => e.text?.includes('当前界面只支持本次工具调用'))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('do-not-forward'); expect(JSON.stringify(events)).not.toContain('private-challenge');
    await conn.close();
  });
  it('declines unsupported elicitation forms without exposing defaults or metadata values', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new CodexConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('检查 MCP 表单', 'form-message');
    peer.emit('frame', { id: 'form-1', method: 'mcpServer/elicitation/request', params: {
      threadId: 'native-id', serverName: 'example', mode: 'form', message: '请输入客户名称',
      requestedSchema: { type: 'object', properties: { name: { type: 'string', default: 'private-default' } }, required: ['name'] },
      _meta: { privateContext: 'private-metadata' },
    } });
    await flush();
    expect(peer.frames.find(f => f.id === 'form-1')?.result).toEqual({ action: 'decline' });
    expect(events.some(e => e.type === 'approval')).toBe(false);
    expect(events.find(e => e.data?.elicitation)?.data?.elicitation).toMatchObject({ mode: 'form', serverName: 'example', metadataKeys: ['privateContext'] });
    expect(JSON.stringify(events)).not.toContain('private-default'); expect(JSON.stringify(events)).not.toContain('private-metadata');
    await conn.close();
  });
  it('resumes the exact native thread with sandbox and MCP settings, correlates approvals, waits for terminal interrupt', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new CodexConnection({ ...options, resumeSessionId: 'native-id' }, event => events.push(event), peer.process());
    await conn.initialize();
    expect(peer.frames.find(f => f.method === 'thread/resume')?.params).toMatchObject({ threadId: 'native-id', sandbox: 'workspace-write', approvalPolicy: 'on-request', config: { mcp_servers: options.mcpServers } });
    await conn.send('请检查', 'message-1');
    peer.emit('frame', { id: 47, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-id', command: 'git status' } });
    await flush();
    expect(events.find(e => e.type === 'approval')?.approvalId).toBe('47');
    expect(peer.frames.find(f => f.id === 47)).toBeUndefined();
    await conn.respondApproval('47', true);
    expect(peer.frames.find(f => f.id === 47)?.result).toEqual({ decision: 'accept' });
    let finished = false; const interrupted = conn.interrupt().then(() => { finished = true; });
    await flush(); expect(finished).toBe(false);
    peer.emit('frame', { method: 'thread/tokenUsage/updated', params: { threadId: 'native-id', turnId: 'turn-1', tokenUsage: { total: { inputTokens: 100, outputTokens: 10 } } } });
    expect(events.find(e => e.type === 'usage')).toMatchObject({ messageId: 'message-1', data: { partial: true, totalTokens: 110 } });
    peer.emit('frame', { method: 'turn/completed', params: { threadId: 'native-id', turn: { id: 'turn-1', status: 'interrupted' } } });
    await interrupted; expect(events.find(e => e.type === 'result')?.data?.interrupted).toBe(true);
    await conn.send('继续', 'message-2'); await conn.close();
  });
  it('rejects a second send before result and preserves unknown when interrupt is unconfirmed', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new CodexConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('运行任务', 'one');
    await expect(conn.send('重复任务', 'two')).rejects.toThrow('当前轮次未结束');
    vi.useFakeTimers();
    try {
      const promise = conn.interrupt(); const rejection = expect(promise).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(20_100); await rejection;
      expect(events.at(-1)?.state).toBe('unknown');
      await expect(conn.send('不能再写', 'three')).rejects.toThrow('会话不可用');
    } finally { vi.useRealTimers(); await conn.close(); }
  });
});

describe('WorkBuddy headless adapter', () => {
  it.each([['Authentication required', 'authentication-failed'], ['429 quota exceeded', 'quota-exceeded']])('preserves native errors[] for accurate connection status: %s', async (message,state) => {
    const peer=new Peer(),events:RuntimeEvent[]=[];
    const conn=new WorkbuddyConnection(options,event=>events.push(event),peer.process());
    await conn.initialize();await conn.send('只验证连接','error-turn');
    peer.emit('frame',{type:'result',session_id:'native-error',subtype:'error_during_execution',is_error:true,errors:[message,'Authorization: Bearer PRIVATE-CREDENTIAL'],errors_info:{account:{token:'NEVER-FORWARD'}}});
    const result=events.find(event=>event.type==='result');
    expect(result?.data?.isError).toBe(true);
    expect(classifyConnectionError(new Error(result?.text)).state).toBe(state);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE-CREDENTIAL|NEVER-FORWARD/);
    await conn.close();
  });
  it('cancels pending permission with native interrupt denial and waits for its write and terminal', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('等待工具批准', 'pending-turn');
    peer.emit('frame', { type: 'control_request', request_id: 'pending-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git status' } } });
    let releaseDenial!: () => void;
    const denialWritten = new Promise<void>(resolve => { releaseDenial = resolve; });
    peer.write = async frame => {
      peer.frames.push(frame);
      if (frame.response?.request_id !== 'pending-permission') return;
      expect(peer.frames.some(f => f.request?.subtype === 'interrupt')).toBe(false);
      expect(frame.response.response).toMatchObject({ allowed: false, interrupt: true });
      // Native permission cancellation produces a terminal execution error;
      // plain denial or a preceding global interrupt does not prove cancellation.
      peer.emit('frame', { type: 'result', result: 'cancelled', subtype: 'error_during_execution', usage: { input_tokens: 100, output_tokens: 10 } });
      await denialWritten;
    };
    let stopped = false; const stop = conn.interrupt().then(() => { stopped = true; });
    await flush(); expect(stopped).toBe(false);
    await expect(conn.send('还不能继续', 'too-early')).rejects.toThrow('当前轮次未结束');
    releaseDenial(); await stop;
    expect(events.find(e => e.type === 'result')?.data?.interrupted).toBe(true);
    expect(events.find(e => e.type === 'usage')).toMatchObject({ messageId: 'pending-turn', data: { partial: true, totalTokens: 110 } });
    await expect(conn.respondApproval('pending-permission', true)).rejects.toThrow('已结束或不存在');
    await conn.send('确认中断后继续', 'next-turn'); await conn.close();
  });
  it('denies permission arriving during interruption without leaving interrupting state', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('运行中', 'late-permission-turn');
    let releaseDenial!: () => void;
    const denialWritten = new Promise<void>(resolve => { releaseDenial = resolve; });
    peer.write = async frame => {
      peer.frames.push(frame);
      if (frame.response?.request_id === 'late-permission') await denialWritten;
    };
    let stopped = false; const stop = conn.interrupt().then(() => { stopped = true; });
    await flush();
    peer.emit('frame', { type: 'control_request', request_id: 'late-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git diff' } } });
    await flush();
    expect(peer.frames.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'late-permission', response: { allowed: false, interrupt: true } } });
    expect(events.filter(e => e.type === 'state').at(-1)?.state).toBe('interrupting');
    expect(events.some(e => e.type === 'approval' && e.approvalId === 'late-permission')).toBe(false);
    peer.emit('frame', { type: 'result', result: 'cancelled' }); await flush(); expect(stopped).toBe(false);
    releaseDenial(); await stop; await conn.close();
  });
  it('does not treat a written cancellation denial as terminal evidence', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('等待停止', 'no-terminal');
    peer.emit('frame', { type: 'control_request', request_id: 'pending-permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
    vi.useFakeTimers();
    try {
      const stop = conn.interrupt(); const rejection = expect(stop).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(20_100); await rejection;
      expect(peer.frames.find(f => f.response?.request_id === 'pending-permission')?.response.response.allowed).toBe(false);
      expect(events.at(-1)?.state).toBe('unknown');
      await expect(conn.send('不能继续', 'unsafe')).rejects.toThrow('会话不可用');
      await expect(conn.respondApproval('pending-permission', true)).rejects.toThrow('会话状态未确认');
    } finally { vi.useRealTimers(); await conn.close(); }
  });
  it('does not emit running when an earlier permission reply completes during interruption', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); await conn.send('运行中', 'permission-race');
    peer.emit('frame', { type: 'control_request', request_id: 'permission-race', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } });
    let release!: () => void;
    const written = new Promise<void>(resolve => { release = resolve; });
    peer.write = async frame => { peer.frames.push(frame); if (frame.response?.request_id === 'permission-race') await written; };
    const deny = conn.respondApproval('permission-race', false);
    const stop = conn.interrupt(); await flush(); release(); await deny;
    expect(events.filter(e => e.type === 'state').at(-1)?.state).toBe('interrupting');
    peer.emit('frame', { type: 'result', result: 'cancelled' }); await stop; await conn.close();
  });
  it('passes unicode arguments directly, uses persistent stdin, and never uses background resume', () => {
    const args = workbuddyArguments('D:/Tools/codebuddy', { ...options, resumeSessionId: 'saved-session' });
    expect(args).toContain('用中文回答。'); expect(args).toContain('--resume');
    expect(args).not.toContain('--bg'); expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.join(' ')).not.toContain('do-not-expose-this');
    expect(workbuddyLaunch('codebuddy', options).env.AWB_MCP_ENV_0).toBe('do-not-expose-this');
  });
  it('whitelists initialization metadata, handles native allowed permission reply, and continues same session', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const conn = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await conn.initialize(); expect(JSON.stringify(events)).not.toContain('never-forward-this');
    await conn.send('请修改', 'first');
    peer.emit('frame', { type: 'system', subtype: 'init', session_id: 'wb-id', model: 'configured-model' });
    peer.emit('frame', { type: 'control_request', request_id: 'perm_1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'test.txt', content: '你好' } } });
    await flush(); await conn.respondApproval('perm_1', false);
    expect(peer.frames.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'perm_1', response: { allowed: false } } });
    expect(peer.frames.at(-1)?.response.response.interrupt).toBeUndefined();
    const stop = conn.interrupt(); await flush();
    expect(peer.frames.at(-1)?.request).toMatchObject({ subtype: 'interrupt', session_id: 'wb-id' });
    peer.emit('frame', { type: 'result', session_id: 'wb-id', subtype: 'success', result: '停止' }); await stop;
    await conn.send('继续', 'second');
    expect(peer.frames.at(-1)).toMatchObject({ type: 'user', session_id: 'wb-id', message: { content: '继续' } });
    peer.emit('frame', { type: 'result', session_id: 'wb-id', result: '完成' }); await conn.close();
  });
});

describe('Claude SDK adapter', () => {
  it('keeps an AsyncIterable input open across turns, awaits approval and resumes using native session', async () => {
    const output = new InputQueue<Json>(); let sdkOptions!: Options; let input!: AsyncIterable<unknown>;
    const fakeQuery = { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), initializationResult: async () => ({}), interrupt: async () => { output.push({ type: 'result', session_id: 'claude-id', result: '中断' }); }, close: () => output.close() };
    const events: RuntimeEvent[] = [];
    const conn = new ClaudeConnection({ ...options, resumeSessionId: 'claude-id' }, event => events.push(event), 'claude.exe', ((args: { prompt: AsyncIterable<unknown>; options: Options }) => { input = args.prompt; sdkOptions = args.options; return fakeQuery as unknown as Query; }) as any);
    await conn.initialize(); expect(sdkOptions.resume).toBe('claude-id'); expect(sdkOptions.mcpServers).toEqual(options.mcpServers);
    expect(sdkOptions.permissionMode).toBe('default'); expect(sdkOptions.pathToClaudeCodeExecutable).toBe('claude.exe');
    await conn.send('第一轮', '00000000-0000-4000-8000-000000000001');
    const iterator = input[Symbol.asyncIterator](); expect((await iterator.next()).value).toMatchObject({ type: 'user', message: { content: '第一轮' } });
    const permission = sdkOptions.canUseTool!('Bash', { command: 'git status' }, { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'request-1' });
    const approval = events.find(e => e.type === 'approval'); expect(approval).toBeDefined();
    await conn.respondApproval(approval!.approvalId!, true); await expect(permission).resolves.toMatchObject({ behavior: 'allow' });
    await conn.interrupt(); await conn.send('第二轮', '00000000-0000-4000-8000-000000000002');
    expect((await iterator.next()).value).toMatchObject({ session_id: 'claude-id', message: { content: '第二轮' } });
    output.push({ type: 'result', result: '完成', session_id: 'claude-id' }); await flush(); await conn.close();
  });
});
