import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RuntimeConnection, RuntimeEvent, RuntimeImageAttachment, RuntimeOptions, RuntimeState } from '../../shared/types.js';
import { safeData, safeText, timeout } from './process.js';

export interface ImageContentBlock { type: 'image'; source: { type: 'base64'; media_type: RuntimeImageAttachment['mimeType']; data: string }; }

/** Only for validation that completes before begin() and before any native write. */
export class RuntimeInputError extends Error {}

/** Files come only from the backend attachment store, never from browser supplied paths. */
export function readRuntimeImages(images: RuntimeImageAttachment[] = []): { image: RuntimeImageAttachment; bytes: Buffer }[] {
  if (images.length > 4) throw new RuntimeInputError('每条指令最多附加 4 张图片');
  return images.map(image => {
    if (!isAbsolute(image.path) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) throw new RuntimeInputError('图片附件格式无效，请重新上传');
    let fd: number | undefined;
    try {
      fd = openSync(image.path, 'r');
      const info = fstatSync(fd);
      if (!info.isFile() || info.size < 1 || info.size > 5 * 1024 * 1024 || info.size !== image.size) throw new Error('invalid image');
      // Bounded synchronous preparation avoids an interrupt racing an untracked async send.
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
      if (offset !== bytes.length || readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error('changed image');
      return { image, bytes };
    } catch { throw new RuntimeInputError('图片附件无法读取、已改变或超过 5 MiB，请重新上传后发送'); }
    finally { if (fd !== undefined) closeSync(fd); }
  });
}

export abstract class ConnectionBase implements RuntimeConnection {
  nativeSessionId: string | undefined;
  abstract readonly pid: number | undefined;
  protected activeMessage: string | undefined;
  protected closing = false;
  protected broken = false;
  protected stopping = false;
  private imagePayloads: string[] = [];
  private stopApprovalReplies?: Promise<void>[];
  private turnDone?: { promise: Promise<void>; resolve: () => void };
  protected approvals = new Map<string, (allow: boolean) => Promise<void>>();
  constructor(protected options: RuntimeOptions, protected emit: (event: RuntimeEvent) => void) {
    this.nativeSessionId = options.resumeSessionId;
  }
  protected event(event: RuntimeEvent): void {
    this.emit({ ...event, messageId: event.type === 'usage' ? event.messageId : event.messageId ?? this.activeMessage, text: event.text === undefined ? undefined : safeText(this.redactImages(event.text)), data: event.data ? safeData(this.redactImages(event.data)) as Record<string,unknown> : undefined });
  }
  protected imageBlocks(images: RuntimeImageAttachment[] = []): ImageContentBlock[] {
    this.assertSendable();
    const blocks = readRuntimeImages(images).map(({ image, bytes }): ImageContentBlock => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: bytes.toString('base64') } }));
    this.imagePayloads = blocks.map(block => block.source.data); return blocks;
  }
  private redactImages(value: unknown): unknown {
    if (typeof value === 'string') {
      let text = value;
      for (const payload of this.imagePayloads) text = text.replaceAll(payload, '[图片内容已省略]');
      for (const [key, secret] of Object.entries(this.options.connection?.env ?? {})) if (secret && /key|token|secret|password|authorization/i.test(key)) text = text.replaceAll(secret, '[REDACTED]');
      return text;
    }
    if (Array.isArray(value)) return value.map(item => this.redactImages(item));
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, this.redactImages(item)]));
    }
    return value;
  }
  protected state(state: RuntimeState): void { this.event({ type: 'state', state, nativeSessionId: this.nativeSessionId }); }
  protected session(id: unknown): void {
    if (typeof id === 'string' && id && id !== this.nativeSessionId) {
      this.nativeSessionId = id; this.event({ type: 'ready', nativeSessionId: id });
    }
  }
  protected begin(messageId: string): void {
    this.assertSendable();
    this.activeMessage = messageId;
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
    this.turnDone = { promise, resolve }; this.state('running');
  }
  private assertSendable(): void {
    if (this.closing || this.broken) throw new Error('会话不可用，请先恢复连接');
    if (this.activeMessage || this.stopping) throw new Error('当前轮次未结束，请排队或先中断');
  }
  protected finish(text?: string, data: Record<string,unknown> = {}): void {
    if (!this.activeMessage) return;
    this.approvals.clear();
    this.event({ type: 'result', text, data: { ...data, interrupted: this.stopping || data.interrupted === true } });
    this.activeMessage = undefined; this.turnDone?.resolve(); this.turnDone = undefined;
    this.state(this.closing ? 'stopped' : 'idle');
  }
  protected fail(error: unknown): void {
    if (this.closing || this.broken) return;
    this.broken = true; this.event({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    this.state('error'); this.turnDone?.resolve(); this.approvals.clear();
  }
  protected async stopWith(stop: () => Promise<unknown>, options: { rejectPendingApprovals?: boolean } = {}): Promise<void> {
    if (!this.activeMessage) return;
    if (this.broken) throw new Error('运行状态未知，不能确认已停止');
    this.stopping = true; this.state('interrupting');
    const done = this.turnDone!.promise;
    const replies = options.rejectPendingApprovals ? [] as Promise<void>[] : undefined;
    this.stopApprovalReplies = replies;
    try {
      // The adapter chooses its native cancellation route before permission
      // waits are released. A plain denial may otherwise resume model execution.
      const requested = stop();
      if (replies) for (const id of [...this.approvals.keys()]) this.rejectApprovalForStop(id);
      // Do not wait for interrupt acknowledgement before releasing permission
      // waits: the native runtime can defer that acknowledgement until release.
      await timeout(Promise.all([requested, ...(replies ?? [])]), 20_000, '中断请求');
      await timeout(done, 20_000, '等待中断完成');
      // Also await replies to permission requests that arrived during cancellation.
      if (replies) await timeout(Promise.all(replies), 20_000, '等待审批拒绝完成');
      if (this.broken) throw new Error('运行程序退出，未收到中断完成证据');
    }
    catch (error) {
      // A natural terminal result can race the interrupt RPC (e.g. native turn already ended).
      if (!this.activeMessage && !this.broken && !replies?.length) return;
      this.broken = true; this.state('unknown'); throw error;
    }
    finally { this.stopApprovalReplies = undefined; this.stopping = false; }
  }
  private rejectApprovalForStop(id: string): void {
    const respond = this.approvals.get(id);
    if (!respond || !this.stopApprovalReplies) return;
    this.approvals.delete(id);
    const reply = Promise.resolve().then(() => respond(false));
    this.stopApprovalReplies.push(reply);
    // stopWith awaits this promise; attach a handler now for late-arriving replies.
    void reply.catch(() => {});
  }
  protected approval(tool: string, input: unknown, respond: (allow: boolean) => Promise<void>, id: string = randomUUID()): string {
    this.approvals.set(id, respond);
    if (this.stopping && this.stopApprovalReplies) { this.rejectApprovalForStop(id); return id; }
    this.state('waiting_approval');
    this.event({ type: 'approval', approvalId: id, data: { tool, input } }); return id;
  }
  async respondApproval(id: string, allow: boolean): Promise<void> {
    if (this.broken || this.closing) throw new Error('会话状态未确认或已关闭，不能处理审批');
    if (this.stopping && allow) throw new Error('会话正在中断，不能批准新的工具操作');
    const respond = this.approvals.get(id); if (!respond) throw new Error('审批请求已结束或不存在');
    this.approvals.delete(id);
    await respond(allow);
    if (this.activeMessage && !this.stopping && !this.broken && !this.closing)
      this.state(this.approvals.size ? 'waiting_approval' : 'running');
  }
  abstract send(text: string, messageId: string, images?: RuntimeImageAttachment[]): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract close(): Promise<void>;
}
