import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeAdapter, RuntimeEvent, RuntimeImageAttachment, RuntimeOptions } from '../../shared/types.js';
import { ConnectionBase, readRuntimeImages } from './base.js';
import { discoverRuntime, executableFor, JsonProcess, type Json } from './process.js';
import { normalizeUsage } from './usage.js';
import { discoverRuntimeModels } from './models.js';

export class CodexConnection extends ConnectionBase {
  private turnId?: string;
  private lastAssistantText?: string;
  private startingTurn?: Promise<Json>;
  private turnMessages = new Map<string, string>();
  get pid(): number | undefined { return this.process.pid; }
  constructor(options: RuntimeOptions, emit: (event: RuntimeEvent) => void, private process: JsonProcess) {
    super(options, emit);
    process.on('frame', frame => { void this.frame(frame).catch(error => this.fail(error)); });
    process.on('failure', error => this.fail(error));
  }
  private rpc(method: string, params: Json): Promise<Json> {
    const id = randomUUID(); return this.process.request(id, { id, method, params });
  }
  async initialize(): Promise<void> {
    this.state('starting');
    await this.rpc('initialize', { clientInfo: { name: 'agent_workbench', title: 'Agent Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    await this.process.write({ method: 'initialized' });
    const config: Json = { ...this.options.connection?.config };
    if (this.options.mcpServers) config.mcp_servers = this.options.mcpServers;
    const params = { cwd: this.options.cwd, model: this.options.model || undefined, sandbox: this.options.permissionMode,
      approvalPolicy: 'on-request', approvalsReviewer: 'user', developerInstructions: this.options.instructions || undefined, config };
    const result = this.options.resumeSessionId
      ? await this.rpc('thread/resume', { ...params, threadId: this.options.resumeSessionId, excludeTurns: true })
      : await this.rpc('thread/start', params);
    this.session(result.thread?.id);
    if (!this.nativeSessionId) throw new Error('Codex 未返回 thread.id');
    this.event({ type: 'ready', nativeSessionId: this.nativeSessionId, data: { model: result.model, provider: result.modelProvider } });
    this.state('idle');
  }
  async send(text: string, messageId: string, images: RuntimeImageAttachment[] = []): Promise<void> {
    // Codex 0.160.0 generated TurnStartParams.UserInput schema: localImage has path.
    const localImages = readRuntimeImages(images).map(({ image }) => ({ type: 'localImage', path: image.path }));
    this.begin(messageId);
    this.lastAssistantText = undefined;
    try {
      this.startingTurn = this.rpc('turn/start', { threadId: this.nativeSessionId, clientUserMessageId: messageId, input: [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...localImages] });
      const result = await this.startingTurn;
      if (result.turn?.id) this.turnMessages.set(result.turn.id, messageId);
      if (this.activeMessage === messageId) this.turnId = result.turn?.id;
    } catch (error) { this.fail(error); throw error; }
    finally { this.startingTurn = undefined; }
  }
  private async frame(frame: Json): Promise<void> {
    const p = frame.params ?? {};
    if (p.threadId && this.nativeSessionId && p.threadId !== this.nativeSessionId) return;
    if (frame.id !== undefined && frame.method) { await this.request(frame); return; }
    switch (frame.method) {
      case 'thread/started': this.session(p.thread?.id); break;
      case 'turn/started':
        this.turnId = p.turn?.id;
        if (this.turnId && this.activeMessage) this.turnMessages.set(this.turnId, this.activeMessage);
        break;
      case 'thread/tokenUsage/updated': {
        // `last` is the last model request, not the total of a workbench turn.
        // Keep native session snapshots so the durable ledger can difference
        // them across adapter reconnects without charging resumed history.
        const usage = normalizeUsage(p.tokenUsage?.total, 'codex', { scope: 'session', source: 'codex.thread.tokenUsage.total', baselineKnownZero: this.options.resumeSessionId ? undefined : true, partial: this.stopping || undefined });
        if (usage) this.event({ type: 'usage', nativeSessionId: p.threadId ?? this.nativeSessionId, messageId: this.turnMessages.get(p.turnId), data: { ...usage, turnId: p.turnId } });
        break;
      }
      case 'item/agentMessage/delta': this.event({ type: 'delta', text: p.delta, data: { itemId: p.itemId } }); break;
      case 'item/commandExecution/outputDelta': this.event({ type: 'tool', text: p.delta, data: { phase: 'output', itemId: p.itemId } }); break;
      case 'item/started':
      case 'item/completed': {
        const item = p.item ?? {}; const phase = frame.method === 'item/started' ? 'started' : 'completed';
        if (item.type === 'agentMessage' && phase === 'completed') {
          this.lastAssistantText = item.text;
          this.event({ type: 'message', text: item.text, data: { itemId: item.id, phase: item.phase } });
        }
        else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type))
          this.event({ type: 'tool', data: { phase, ...item } });
        break;
      }
      case 'turn/completed': {
        if (this.turnId && p.turn?.id !== this.turnId) break;
        this.turnId = undefined;
        const turn = p.turn ?? {};
        this.finish(turn.error?.message ?? this.lastAssistantText, { status: turn.status, interrupted: turn.status === 'interrupted', isError: turn.status === 'failed' });
        break;
      }
      case 'error':
        // Recoverable provider retries keep the current turn alive.
        if (!p.willRetry) this.fail(new Error(p.error?.message ?? 'Codex 执行失败'));
        break;
      case 'serverRequest/resolved': {
        const id = String(p.requestId); this.approvals.delete(id); break;
      }
    }
  }
  private async request(frame: Json): Promise<void> {
    const p = frame.params ?? {}; const id = String(frame.id);
    const respond = (result: Json) => this.process.write({ id: frame.id, result });
    if (frame.method === 'item/commandExecution/requestApproval' || frame.method === 'item/fileChange/requestApproval') {
      this.approval(frame.method.includes('commandExecution') ? 'commandExecution' : 'fileChange', p, async allow => {
        const writeAllowed = this.options.permissionMode !== 'read-only' || frame.method.includes('commandExecution');
        await respond({ decision: allow && writeAllowed ? 'accept' : 'decline' });
      }, id);
    } else if (frame.method === 'item/permissions/requestApproval') {
      this.approval('additionalPermissions', p, async allow => {
        // A read-only member cannot expand its filesystem permission profile.
        await respond({ permissions: allow && this.options.permissionMode !== 'read-only' ? p.permissions ?? {} : {}, scope: 'turn' });
      }, id);
    } else if (frame.method === 'item/tool/call') {
      await respond({ success: false, contentItems: [{ type: 'inputText', text: '该动态工具未注册。请使用工作台提供的 MCP 调度工具。' }] });
    } else if (frame.method === 'item/tool/requestUserInput') {
      this.event({ type: 'message', text: 'Codex 请求结构化问题回答；请在会话中直接补充指令。', data: { questions: p.questions } });
      await respond({ answers: {} });
    } else if (frame.method === 'mcpServer/elicitation/request') {
      const schema = p.requestedSchema;
      const metadata = p._meta && typeof p._meta === 'object' && !Array.isArray(p._meta) ? p._meta as Json : {};
      // Verified against Codex 0.160.0's generated request/response schema and
      // a native MCP tool-approval frame. An empty form asks only for consent;
      // accepting it has empty content and deliberately carries no persistence metadata.
      const nativeToolApproval = p.mode === 'form' && Object.hasOwn(metadata, 'codex_approval_kind')
        && schema?.type === 'object' && schema.properties && typeof schema.properties === 'object'
        && !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0
        && (schema.required == null || Array.isArray(schema.required) && schema.required.length === 0);
      if (nativeToolApproval) {
        this.approval('MCP 工具调用', {
          serverName: p.serverName, message: p.message,
          toolDescription: metadata.tool_description,
          toolParameters: metadata.tool_params,
          toolParametersDisplay: metadata.tool_params_display,
          scope: '仅允许本次工具调用，不保存后续授权',
        }, async allow => { await respond(allow ? { action: 'accept', content: {} } : { action: 'decline' }); }, id);
        return;
      }
      const safeSchema = schema && typeof schema === 'object' ? {
        type: schema.type, required: schema.required,
        properties: schema.properties && typeof schema.properties === 'object'
          ? Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
            const field = value && typeof value === 'object' ? value as Json : {};
            return [key, { type: field.type, title: field.title, description: field.description, enum: field.enum, enumNames: field.enumNames, oneOf: field.oneOf }];
          })) : undefined,
      } : undefined;
      this.event({ type: 'message', text: 'MCP 请求需要填写表单、访问授权链接或设备验证；当前界面只支持本次工具调用的允许/拒绝，已拒绝此请求。', data: {
        elicitation: { mode: p.mode, serverName: p.serverName, message: p.message, requestedSchema: safeSchema,
          metadataKeys: Object.keys(metadata) },
      } });
      await respond({ action: 'decline' });
    } else await this.process.write({ id: frame.id, error: { code: -32601, message: 'Unsupported client request' } });
  }
  interrupt(): Promise<void> {
    return this.stopWith(async () => {
      if (this.startingTurn) await this.startingTurn;
      if (!this.activeMessage) return;
      if (!this.turnId) throw new Error('Codex 尚未确认 turn.id，暂不能安全中断');
      const turnId = this.turnId;
      // App Server can acknowledge turn/start before its execution actor has
      // registered the active turn. Retry only cancellation of this same ID;
      // never retry turn/start or infer that a missing actor means it stopped.
      for (let attempt = 0; ; attempt++) {
        if (!this.activeMessage || this.turnId !== turnId) return;
        try { await this.rpc('turn/interrupt', { threadId: this.nativeSessionId, turnId }); return; }
        catch (error) {
          if (attempt >= 5 || !/no active turn to interrupt/i.test(error instanceof Error ? error.message : String(error))) throw error;
          await delay(50 * 2 ** attempt);
        }
      }
    });
  }
  async close(): Promise<void> { this.closing = true; await this.process.close(); this.finish(undefined, { interrupted: true }); this.state('stopped'); }
}

export const codexAdapter: RuntimeAdapter = {
  kind: 'codex', discover: () => discoverRuntime('codex'),
  listModels: (cwd, connection) => discoverRuntimeModels('codex', cwd, connection),
  async connect(options, emit) {
    const executable = options.connection?.executable ?? await executableFor('codex'); if (!executable) throw new Error('未找到 Codex 执行程序');
    const transport = new JsonProcess(executable, ['app-server', '--stdio'], options.cwd, options.connection?.env);
    const connection = new CodexConnection(options, emit, transport);
    try { await connection.initialize(); return connection; } catch (error) { await connection.close(); throw error; }
  },
};
