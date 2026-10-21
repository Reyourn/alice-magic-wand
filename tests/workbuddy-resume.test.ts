import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { RuntimeEvent, RuntimeOptions } from '../src/shared/types.js';
import { WorkbuddyConnection } from '../src/server/runtime/workbuddy.js';
import type { Json, JsonProcess } from '../src/server/runtime/process.js';

const options: RuntimeOptions = { agentId: 'resume-test', cwd: process.cwd(), permissionMode: 'read-only', instructions: '合成协议验证。', resumeSessionId: 'existing-session' };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Peer extends EventEmitter {
  pid = 123;
  frames: Json[] = [];
  async request(_id: string, frame: Json): Promise<Json> {
    this.frames.push(frame);
    if (frame.request?.subtype === 'initialize' && !frame.request.hasPrompt) {
      // CodeBuddy 2.137.1 executeStreamMode starts an unsolicited history request
      // when resume initialize says that the SDK will not send a prompt.
      setImmediate(() => {
        this.emit('frame', { type: 'assistant', session_id: 'existing-session', message: { content: [{ type: 'text', text: '历史回答' }] } });
        this.emit('frame', { type: 'result', session_id: 'existing-session', result: '' });
      });
    }
    return { currentModelId: 'native-model' };
  }
  async write(frame: Json): Promise<void> { this.frames.push(frame); }
  async close(): Promise<void> {}
  process(): JsonProcess { return this as unknown as JsonProcess; }
}

describe('WorkBuddy resumed persistent stream', () => {
  it('announces a pending prompt so native resume never races history result with the submitted turn', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await connection.initialize();
    expect(peer.frames[0].request).toMatchObject({ subtype: 'initialize', hasPrompt: true });
    await connection.send('请回答刚才的口令', 'resumed-request');
    await flush();
    expect(events.filter(event => event.type === 'result' || event.type === 'message')).toEqual([]);
    await expect(connection.send('不能提前发下一轮', 'wrong-next')).rejects.toThrow('当前轮次未结束');
    peer.emit('frame', { type: 'assistant', session_id: 'existing-session', message: { content: [{ type: 'text', text: '青松' }] } });
    peer.emit('frame', { type: 'result', session_id: 'existing-session', result: '青松' });
    expect(events.find(event => event.type === 'result')).toMatchObject({ text: '青松', messageId: 'resumed-request' });
    await connection.close();
  });

  it('ignores replay frames, idle history and nested agent completion', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await connection.initialize();
    peer.emit('frame', { type: 'assistant', message: { content: [{ type: 'text', text: '未请求的历史' }] } });
    await connection.send('新的问题', 'current');
    peer.emit('frame', { type: 'assistant', isReplay: true, message: { content: [{ type: 'text', text: '历史回放' }] } });
    peer.emit('frame', { type: 'result', isReplay: true, result: '' });
    peer.emit('frame', { type: 'result', parent_tool_use_id: 'child-tool', result: '子代理结束' });
    peer.emit('frame', { type: 'result', agent_id: 'nested', result: '子代理结束' });
    expect(events.filter(event => event.type === 'result' || event.type === 'message')).toEqual([]);
    peer.emit('frame', { type: 'result', result: '当前轮次真正结束' });
    expect(events.find(event => event.type === 'result')?.text).toBe('当前轮次真正结束');
    await connection.close();
  });

  it('preserves a native string error instead of replacing it with an unrelated generic failure', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await connection.initialize(); await connection.send('验证失败', 'request');
    peer.emit('frame', { type: 'error', error: '指定会话不存在' });
    expect(events.find(event => event.type === 'error')?.text).toBe('指定会话不存在');
    await connection.close();
  });

  it('uses terminal cancellation as evidence without attributing the previous answer to the interrupted turn', async () => {
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new WorkbuddyConnection(options, event => events.push(event), peer.process());
    await connection.initialize(); await connection.send('很长的回答', 'interrupted');
    const stopped = connection.interrupt(); await flush();
    peer.emit('frame', { type: 'result', result: '上一轮的答案', subtype: 'success' });
    await stopped;
    expect(events.find(event => event.type === 'result')).toMatchObject({ text: undefined, messageId: 'interrupted', data: { interrupted: true } });
    await connection.send('继续下一轮', 'next');
    peer.emit('frame', { type: 'result', result: '新答案' });
    await connection.close();
  });
});
