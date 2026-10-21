import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchEvent } from '../src/shared/types.js';
import { conversationEventKey, groupEvents } from '../src/client/workbench.js';

describe('browser API delivery', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('reuses the delivery key after an uncertain connection failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'memory-token' })))
      .mockRejectedValueOnce(new TypeError('disconnected'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'received-once' })));
    vi.stubGlobal('fetch', fetchMock);
    const { mutate } = await import('../src/client/api.js');
    const body = { text: '检查项目', mode: 'queue', source: 'human' };
    await expect(mutate('/api/agents/a/messages', body)).rejects.toThrow('沿用原指令编号');
    await expect(mutate('/api/agents/a/messages', body)).resolves.toEqual({ messageId: 'received-once' });
    const first = fetchMock.mock.calls[1][1] as RequestInit;
    const retry = fetchMock.mock.calls[2][1] as RequestInit;
    expect((first.headers as Record<string, string>)['Idempotency-Key']).toBe((retry.headers as Record<string, string>)['Idempotency-Key']);
    expect((retry.headers as Record<string, string>)['X-Workbench-Token']).toBe('memory-token');
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/bootstrap')).toHaveLength(1);
  });

  it('uses a new operation key for an intentional repeated instruction after success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'memory-token' })))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const { mutate } = await import('../src/client/api.js');
    await mutate('/api/agents/a/messages', { text: '继续' });
    await mutate('/api/agents/a/messages', { text: '继续' });
    const first = fetchMock.mock.calls[1][1] as RequestInit;
    const next = fetchMock.mock.calls[2][1] as RequestInit;
    expect((first.headers as Record<string, string>)['Idempotency-Key']).not.toBe((next.headers as Record<string, string>)['Idempotency-Key']);
  });

  it('surfaces server validation messages instead of reporting a saved form', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'memory-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '仓库不存在' }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const { mutate } = await import('../src/client/api.js');
    await expect(mutate('/api/projects', { path: 'missing' })).rejects.toThrow('仓库不存在');
  });
});

describe('streamed conversation rendering', () => {
  function event(id: number, type: string, text: string, messageId = 'turn1', itemId = 'item1'): WorkbenchEvent {
    return { id, type, text, agentId: 'member1', data: { messageId, itemId }, createdAt: '2026-10-09T08:00:00.000Z' };
  }
  it('replaces accumulated deltas with the final message without duplicate answers', () => {
    const events = [event(1, 'runtime.delta', '你好'), event(2, 'runtime.delta', '，世界'), event(3, 'runtime.message', '你好，世界'), event(4, 'runtime.result', '你好，世界')];
    const result = groupEvents(events);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'runtime.message', text: '你好，世界' });
    expect(result[1].text).toBe('本轮执行结束。');
    expect(events[0].text).toBe('你好');
  });
  it('does not merge different turns or different tool message items', () => {
    const result = groupEvents([event(1, 'runtime.delta', '第一轮'), event(2, 'runtime.delta', '第二轮', 'turn2'), event(3, 'runtime.delta', '另一项', 'turn2', 'item2')]);
    expect(result).toHaveLength(3);
  });

  function tool(id: number, phase: string, itemId: string, text?: string, extra: Record<string, unknown> = {}, messageId = 'turn1'): WorkbenchEvent {
    return { id, type: 'runtime.tool', agentId: 'member1', text, data: { messageId, itemId, phase, ...extra }, createdAt: '2026-10-09T08:00:00.000Z' };
  }

  it('groups a full command lifecycle into one stable card with authoritative final output', () => {
    const events = [tool(1, 'started', 'read-file', undefined, { command: 'Get-Content SKILL.md', type: 'commandExecution', aggregatedOutput: '' }), tool(2, 'output', 'read-file', '第一行'), tool(3, 'output', 'read-file', '\n'), tool(4, 'output', 'read-file', '第二行'), tool(5, 'completed', 'read-file', undefined, { aggregatedOutput: '第一行\n第二行', exitCode: 0 })];
    const result = groupEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, text: '第一行\n第二行', data: { phase: 'completed', command: 'Get-Content SKILL.md', exitCode: 0 } });
    expect(events[0].text).toBeUndefined();
    expect(events[0].data?.phase).toBe('started');
  });

  it('retains separate interleaved calls and groups SDK tools using data.id', () => {
    const sdkStart = { ...tool(2, 'started', 'unused'), data: { messageId: 'turn1', id: 'sdk-tool', phase: 'started', name: 'Read', input: { path: 'README.md' } } };
    const sdkEnd = { ...tool(5, 'completed', 'unused'), data: { messageId: 'turn1', id: 'sdk-tool', phase: 'completed', content: [{ type: 'text', text: 'SDK输出' }] } };
    const result = groupEvents([tool(1, 'started', 'first'), sdkStart, tool(3, 'output', 'first', '并行输出'), tool(4, 'completed', 'first'), sdkEnd]);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('并行输出');
    expect(result[1]).toMatchObject({ text: 'SDK输出', data: { name: 'Read', input: { path: 'README.md' }, phase: 'completed' } });
  });

  it('filters whitespace-only orphan output and preserves whitespace inside a visible stream', () => {
    expect(groupEvents([tool(1, 'output', 'missing', '\n  '), tool(2, 'output', 'missing', '\r\n')])).toEqual([]);
    const result = groupEvents([tool(1, 'output', 'x', 'A'), tool(2, 'output', 'x', '\n'), tool(3, 'output', 'x', 'B')]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('A\nB');
  });

  it('does not append late deltas to a completed aggregate or merge different turns', () => {
    const result = groupEvents([tool(1, 'completed', 'same-id', undefined, { aggregatedOutput: '完整输出' }), tool(2, 'output', 'same-id', '完整输出'), tool(3, 'output', 'same-id', '下一轮', {}, 'turn2')]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ text: '完整输出', data: { phase: 'completed' } });
    expect(result[1].text).toBe('下一轮');
  });

  it('keeps a tool React key stable when early chunks leave the snapshot window', () => {
    const start = tool(1, 'started', 'same-item');
    const output = tool(50, 'output', 'same-item', '日志');
    const end = tool(100, 'completed', 'same-item', undefined, { aggregatedOutput: '日志' });
    expect(conversationEventKey(groupEvents([start, output, end])[0])).toBe(conversationEventKey(groupEvents([output, end])[0]));
    const streamed = groupEvents([event(1, 'runtime.delta', '回答')])[0];
    const finished = groupEvents([event(1, 'runtime.delta', '回答'), event(2, 'runtime.message', '回答')])[0];
    expect(conversationEventKey(streamed)).toBe(conversationEventKey(finished));
  });
});
