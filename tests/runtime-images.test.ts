import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { RuntimeEvent, RuntimeImageAttachment, RuntimeOptions } from '../src/shared/types.js';
import { CodexConnection } from '../src/server/runtime/codex.js';
import { ClaudeConnection, InputQueue } from '../src/server/runtime/claude.js';
import { WorkbuddyConnection } from '../src/server/runtime/workbuddy.js';
import { JsonProcess, type Json } from '../src/server/runtime/process.js';
import { RuntimeInputError } from '../src/server/runtime/base.js';

const options: RuntimeOptions = { agentId: 'image-test', cwd: process.cwd(), permissionMode: 'read-only', instructions: '测试协议，不执行工具。' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function attachment(bytes = png, mimeType: RuntimeImageAttachment['mimeType'] = 'image/png'): Promise<RuntimeImageAttachment> {
  const folder = await mkdtemp(join(tmpdir(), 'awb-runtime-image-'));
  const path = join(folder, 'image.png'); await writeFile(path, bytes);
  return { id: randomUUID(), name: '中文图片.png', mimeType, size: bytes.length, url: '/api/attachments/test', path };
}

/** Controlled peers assert real encodings, not successful native inference. */
class Peer extends EventEmitter {
  pid = 1; frames: Json[] = []; supportsImages: boolean | undefined = true;
  async request(_id: string, frame: Json): Promise<Json> {
    this.frames.push(frame);
    if (frame.method === 'thread/start') return { thread: { id: 'image-thread' }, model: 'image-model' };
    if (frame.method === 'turn/start') return { turn: { id: 'image-turn' } };
    if (frame.request?.subtype === 'initialize') return { currentModelId: 'image-model' };
    if (frame.request?.subtype === 'get_available_models') return { rawModels: [{ id: 'image-model', supportsImages: this.supportsImages }], privateAccount: 'must-stay-private' };
    return {};
  }
  async write(frame: Json): Promise<void> { this.frames.push(frame); }
  async close(): Promise<void> {}
  process(): JsonProcess { return this as unknown as JsonProcess; }
}
function claudePeer(events: RuntimeEvent[]) {
  const output = new InputQueue<Json>(); let prompt!: AsyncIterable<SDKUserMessage>;
  const fakeQuery = { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), initializationResult: async () => ({}), close: () => output.close(), interrupt: async () => {} };
  const connection = new ClaudeConnection(options, event => events.push(event), 'unused', ((args: { prompt: AsyncIterable<SDKUserMessage> }) => { prompt = args.prompt; return fakeQuery as unknown as Query; }) as any);
  return { connection, output, next: () => prompt[Symbol.asyncIterator]().next() };
}

describe('runtime image transmission', () => {
  it('sends Codex localImage blocks using trusted absolute paths, supports image-only and preserves text-only frames', async () => {
    const image = await attachment(); const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new CodexConnection(options, event => events.push(event), peer.process());
    await connection.initialize();
    for (const [text, images] of [['请看截图', [image]], ['', [image]], ['仅文本', []]] as const) {
      await connection.send(text, randomUUID(), [...images]);
      const frame = peer.frames.filter(frame => frame.method === 'turn/start').at(-1)!;
      expect(frame.params.input).toEqual([...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'localImage', path: image.path }))]);
      peer.emit('frame', { method: 'turn/completed', params: { threadId: 'image-thread', turn: { id: 'image-turn', status: 'completed' } } });
    }
    expect(JSON.stringify(events)).not.toContain(png.toString('base64'));
    await connection.close();
  });

  it('sends Claude image bytes as SDK blocks with UUID and session, without leaking echoed payloads', async () => {
    const images = [await attachment(), await attachment(png, 'image/webp')]; const events: RuntimeEvent[] = [];
    const peer = claudePeer(events); await peer.connection.initialize();
    peer.output.push({ type: 'system', subtype: 'init', session_id: 'claude-image-session', model: 'image-model' }); await flush();
    const id = randomUUID(); await peer.connection.send('比较图片', id, images);
    expect((await peer.next()).value).toEqual({ type: 'user', uuid: id, session_id: 'claude-image-session', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '比较图片' }, ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: png.toString('base64') } }))] } });
    peer.output.push({ type: 'result', session_id: 'claude-image-session', result: `invalid image: ${png.toString('base64')}`, is_error: true }); await flush();
    expect(JSON.stringify(events)).not.toContain(png.toString('base64'));
    expect(events.find(event => event.type === 'result')?.data?.isError).toBe(true);
    await peer.connection.send('仅文本', randomUUID()); expect((await peer.next()).value.message.content).toBe('仅文本');
    await peer.connection.close();
  });

  it('sends WorkBuddy native base64 blocks only after model metadata confirms image support', async () => {
    const image = await attachment(); const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new WorkbuddyConnection(options, event => events.push(event), peer.process()); await connection.initialize();
    for (const text of ['查看图', '']) {
      const id = randomUUID(); await connection.send(text, id, [image]);
      const frame = peer.frames.filter(frame => frame.type === 'user').at(-1)!;
      expect(frame.uuid).toBe(id);
      expect(frame.message.content).toEqual([...(text ? [{ type: 'text', text }] : []), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }]);
      peer.emit('frame', { type: 'user', isReplay: true, session_id: 'wb-image-session', message: frame.message });
      peer.emit('frame', { type: 'result', session_id: 'wb-image-session', result: '收到图片' });
    }
    await connection.send('仅文本', randomUUID()); expect(peer.frames.at(-1)?.message.content).toBe('仅文本');
    expect(JSON.stringify(events)).not.toContain(png.toString('base64'));
    expect(JSON.stringify(events)).not.toContain('must-stay-private');
    await connection.close();
  });

  it.each([false, undefined])('blocks unsupported/unknown WorkBuddy vision without submitting text alone (%s)', async supportsImages => {
    const image = await attachment(); const peer = new Peer(); peer.supportsImages = supportsImages;
    const connection = new WorkbuddyConnection(options, () => {}, peer.process()); await connection.initialize();
    await expect(connection.send('有图片', 'blocked', [image])).rejects.toBeInstanceOf(RuntimeInputError);
    expect(peer.frames.some(frame => frame.type === 'user')).toBe(false);
    await connection.send('继续纯文本', 'text'); expect(peer.frames.at(-1)?.message.content).toBe('继续纯文本'); await connection.close();
  });

  it('does not treat an explicitly configured unknown WorkBuddy model as the default image-capable model', async () => {
    const image = await attachment(); const peer = new Peer();
    const connection = new WorkbuddyConnection({ ...options, model: 'unknown-custom-route' }, () => {}, peer.process()); await connection.initialize();
    await expect(connection.send('不能丢图', 'blocked', [image])).rejects.toThrow('未确认当前模型');
    expect(peer.frames.some(frame => frame.type === 'user')).toBe(false); await connection.close();
  });

  it('keeps WorkBuddy text-only usable when optional model discovery fails', async () => {
    const peer = new Peer(); const original = peer.request.bind(peer);
    peer.request = async (id, frame) => { if (frame.request?.subtype === 'get_available_models') throw new Error('metadata unavailable'); return original(id, frame); };
    const connection = new WorkbuddyConnection(options, () => {}, peer.process()); await connection.initialize();
    await connection.send('仅文本', 'text'); expect(peer.frames.at(-1)?.message.content).toBe('仅文本'); await connection.close();
  });

  it.each(['missing', 'changed', 'oversize', 'too-many'] as const)('rejects invalid attachments before beginning any native turn (%s)', async failure => {
    let image = await attachment();
    if (failure === 'missing') image = { ...image, path: join(image.path, 'missing.png') };
    if (failure === 'changed') image = { ...image, size: image.size + 1 };
    if (failure === 'oversize') image = await attachment(Buffer.alloc(5 * 1024 * 1024 + 1));
    const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new CodexConnection(options, event => events.push(event), peer.process()); await connection.initialize();
    await expect(connection.send('不应投递', 'invalid', failure === 'too-many' ? Array(5).fill(image) : [image])).rejects.toBeInstanceOf(RuntimeInputError);
    expect(peer.frames.some(frame => frame.method === 'turn/start')).toBe(false);
    expect(events.some(event => event.state === 'running')).toBe(false);
    await connection.send('可继续文本', 'valid'); await connection.close();
  });

  it('preserves terminal-confirmed WorkBuddy interruption and image resubmission in the same session', async () => {
    const image = await attachment(); const peer = new Peer(); const events: RuntimeEvent[] = [];
    const connection = new WorkbuddyConnection(options, event => events.push(event), peer.process()); await connection.initialize();
    await connection.send('看错了请修正', 'first', [image]);
    let stopped = false; const stopping = connection.interrupt().then(() => { stopped = true; }); await flush(); expect(stopped).toBe(false);
    peer.emit('frame', { type: 'result', session_id: 'same-image-session', result: 'interrupted' }); await stopping;
    await connection.send('重新看图', 'second', [image]);
    expect(peer.frames.filter(frame => frame.type === 'user').at(-1)?.session_id).toBe('same-image-session');
    expect(events.find(event => event.type === 'result')?.data?.interrupted).toBe(true); await connection.close();
  });
});
