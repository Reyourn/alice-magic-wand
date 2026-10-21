import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, type UUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeAdapter, RuntimeEvent, RuntimeImageAttachment, RuntimeOptions } from '../../shared/types.js';
import { ConnectionBase } from './base.js';
import { discoverRuntime, executableFor, terminateTree, timeout, type Json } from './process.js';
import { normalizeUsage } from './usage.js';
import { discoverRuntimeModels } from './models.js';

export class InputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter?: (result: IteratorResult<T>) => void;
  private ended = false;
  push(value: T): void {
    if (this.ended) throw new Error('输入通道已关闭');
    if (this.waiter) { const next = this.waiter; this.waiter = undefined; next({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void { this.ended = true; this.values = []; this.waiter?.({ value: undefined, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => { this.waiter = resolve; });
    } };
  }
}

/**
 * The CLI retries provider failures for a long time and only reports them on
 * stderr, so a wrong key otherwise surfaces as a verification timeout. Only
 * explicit provider signals are normalized, and the text carries no payload.
 */
export function providerFailureFromStderr(text: string): string | undefined {
  if (/invalid\s+(?:x-)?api[-_ ]?key|authentication_error|invalid_api_key|\b401\b|unauthorized/i.test(text)) return '原生调用失败：401 unauthorized（认证失败，请检查该连接的密钥或登录）';
  if (/\b429\b|rate_limit|usage limit|quota|insufficient (?:quota|credit)/i.test(text)) return '原生调用失败：429 usage limit（额度或速率受限）';
  if (/model[^\n]{0,40}(?:not found|unavailable|not supported|invalid)/i.test(text)) return '原生调用失败：model not found（模型不可用）';
  return undefined;
}

export class ClaudeConnection extends ConnectionBase {
  private input = new InputQueue<SDKUserMessage>();
  private query!: Query;
  private reader?: Promise<void>;
  private child?: ChildProcessWithoutNullStreams;
  private providerFailureReported = false;
  private permissionWaiters = new Map<string, (result: PermissionResult) => void>();
  get pid(): number | undefined { return this.child?.pid; }
  constructor(options: RuntimeOptions, emit: (event: RuntimeEvent) => void, private executable: string, private queryFn: typeof query = query) { super(options, emit); }
  async initialize(): Promise<void> {
    this.state('starting');
    this.query = this.queryFn({ prompt: this.input, options: {
      cwd: this.options.cwd, pathToClaudeCodeExecutable: this.executable,
      model: this.options.model || undefined, resume: this.options.resumeSessionId,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.options.instructions },
      permissionMode: this.options.verificationTools ? 'default' : this.options.permissionMode === 'read-only' ? 'plan' : 'default',
      // A verification probe is not a planning task: disable every built-in
      // tool, expose its supplied MCP server, and still require exact approval.
      ...(this.options.verificationTools ? { tools: [] } : {}),
      settingSources: this.options.connection?.settingSources ?? ['user', 'project', 'local'], mcpServers: this.options.mcpServers,
      ...(this.options.connection ? { env: this.options.connection.env } : {}),
      includePartialMessages: true,
      spawnClaudeCodeProcess: options => {
        this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stderr.on('data', chunk => {
          if (this.providerFailureReported) return;
          const failure = providerFailureFromStderr(String(chunk));
          if (!failure) return;
          this.providerFailureReported = true;
          this.event({ type: 'error', text: failure });
        });
        return this.child;
      },
      canUseTool: async (tool, input, context) => {
        if(this.options.verificationTools&&!this.options.verificationTools.includes(tool))
          return {behavior:'deny',message:'当前验证仅允许显式绑定的 MCP 工具'};
        const id = randomUUID();
        return new Promise<PermissionResult>(resolve => {
          const done = (result: PermissionResult) => { this.permissionWaiters.delete(id); this.approvals.delete(id); context.signal.removeEventListener('abort', abort); resolve(result); };
          const abort = () => done({ behavior: 'deny', message: '操作已中断', interrupt: true });
          this.permissionWaiters.set(id, done);
          this.approval(tool, input, async allow => { done(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '用户拒绝本次操作' }); }, id);
          if (context.signal.aborted) abort(); else context.signal.addEventListener('abort', abort, { once: true });
        });
      },
    } });
    this.reader = this.consume();
    await timeout(this.query.initializationResult(), 60_000, 'Claude 初始化');
    if (this.broken) throw new Error('Claude 初始化时退出');
    // Account metadata comes from this process, with the same per-member env.
    // Emails, organizations and raw auth responses never leave the adapter.
    try {
      if (typeof this.query.accountInfo === 'function') {
        const account = await timeout(this.query.accountInfo(), 15_000, 'Claude 认证来源');
        this.event({ type: 'ready', data: { provider: account.apiProvider, credentialSource: account.apiKeySource || account.tokenSource } });
      }
    } catch { /* Unknown provenance stays unknown; a turn is still needed for validation. */ }
    this.event({ type: 'ready', nativeSessionId: this.nativeSessionId }); this.state('idle');
  }
  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.frame(message as unknown as Json);
      if (!this.closing) this.fail(new Error('Claude 会话流已关闭，请恢复连接'));
    } catch (error) { this.fail(error); }
  }
  private frame(frame: Json): void {
    // Subagent sessions must not overwrite the main conversation identity.
    if (!frame.parent_tool_use_id && !frame.agent_id) this.session(frame.session_id);
    if (frame.type === 'system' && frame.subtype === 'init')
      this.event({ type: 'ready', nativeSessionId: this.nativeSessionId, data: { model: frame.model, tools: frame.tools, permissionMode: frame.permissionMode } });
    if (frame.type === 'stream_event') {
      const part = frame.event;
      if (part?.type === 'content_block_delta' && part.delta?.type === 'text_delta') this.event({ type: 'delta', text: part.delta.text });
      if (part?.type === 'content_block_start' && part.content_block?.type === 'tool_use') this.event({ type: 'tool', data: { phase: 'started', ...part.content_block } });
    }
    if (frame.type === 'assistant') for (const part of frame.message?.content ?? []) {
      if (part.type === 'text') this.event({ type: 'message', text: part.text, data: { id: frame.uuid } });
      if (part.type === 'tool_use') this.event({ type: 'tool', data: { phase: 'started', name: part.name, id: part.id, input: part.input } });
    }
    if (frame.type === 'user' && Array.isArray(frame.message?.content)) for (const part of frame.message.content) {
      if (part.type === 'tool_result') this.event({ type: 'tool', data: { phase: 'completed', id: part.tool_use_id, content: part.content, isError: part.is_error } });
    }
    if (frame.type === 'tool_progress') this.event({ type: 'tool', data: { phase: 'progress', name: frame.tool_name, id: frame.tool_use_id, elapsedSeconds: frame.elapsed_time_seconds } });
    if (frame.type === 'result' && !frame.parent_tool_use_id && !frame.agent_id && this.activeMessage) {
      // SDK result.usage is per-turn main-loop usage. Do not add assistant.usage
      // or cumulative modelUsage again; auxiliary calls are outside this scope.
      const usage = normalizeUsage(frame.usage, 'claude', { scope: 'turn', source: 'claude.result.usage', partial: true });
      if (usage) this.event({ type: 'usage', nativeSessionId: this.nativeSessionId, messageId: this.activeMessage, data: { ...usage } });
      this.finish(frame.result ?? frame.errors?.join('\n'), { subtype: frame.subtype, isError: frame.is_error, usage: frame.usage, durationMs: frame.duration_ms });
    }
  }
  async send(text: string, messageId: string, images: RuntimeImageAttachment[] = []): Promise<void> {
    // SDKUserMessage.message is an Anthropic MessageParam, including image blocks.
    const blocks = this.imageBlocks(images);
    this.begin(messageId);
    this.input.push({ type: 'user', uuid: messageId as UUID, session_id: this.nativeSessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: blocks.length ? [...(text ? [{ type: 'text' as const, text }] : []), ...blocks] : text } });
  }
  interrupt(): Promise<void> { return this.stopWith(() => this.query.interrupt()); }
  async close(): Promise<void> {
    this.closing = true;
    for (const done of [...this.permissionWaiters.values()]) done({ behavior: 'deny', message: '会话已关闭', interrupt: true });
    this.input.close();
    // Stop owned descendants before the SDK terminates the root on Windows.
    if (this.child) await terminateTree(this.child);
    this.query?.close();
    if (this.reader) await timeout(this.reader, 5_000, '关闭 Claude');
    this.finish(undefined, { interrupted: true }); this.state('stopped');
  }
}

export const claudeAdapter: RuntimeAdapter = {
  kind: 'claude', discover: () => discoverRuntime('claude'),
  listModels: (cwd, connection) => discoverRuntimeModels('claude', cwd, connection),
  async connect(options, emit) {
    const executable = options.connection?.executable ?? await executableFor('claude'); if (!executable) throw new Error('未找到原生 Claude Code 可执行文件');
    const connection = new ClaudeConnection(options, emit, executable);
    try { await connection.initialize(); return connection; } catch (error) { await connection.close(); throw error; }
  },
};
