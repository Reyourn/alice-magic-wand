import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeAdapter, RuntimeEvent, RuntimeImageAttachment, RuntimeOptions } from '../../shared/types.js';
import { ConnectionBase, RuntimeInputError } from './base.js';
import { discoverRuntime, resolveWorkbuddyExecutable, workbuddyEnvironment, JsonProcess, timeout, type Json } from './process.js';
import { normalizeUsage } from './usage.js';
import { discoverRuntimeModels } from './models.js';
import { WorkbuddySessionRegistry } from './workbuddy-sessions.js';

export function workbuddyLaunch(executable: string, options: RuntimeOptions): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [executable, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--replay-user-messages', '--permission-mode', options.permissionMode === 'read-only' ? 'plan' : 'default'];
  const model = typeof options.connection?.config?.workbuddyModelId === 'string' ? options.connection.config.workbuddyModelId : options.model;
  if (model) args.push('--model', model);
  if (options.instructions) args.push('--append-system-prompt', options.instructions);
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
  const env = workbuddyEnvironment(options.connection?.env);
  if(options.verificationTools)args.push('--tools','','--strict-mcp-config');
  if(options.connection?.nativeMemoryAuthentication){
    const edition=options.connection.workbuddyEdition;
    if(edition!=='china'&&edition!=='international')throw new RuntimeInputError('WorkBuddy 内存认证需要明确绑定国内或国际版');
    if(env.CODEBUDDY_API_KEY||env.CODEBUDDY_AUTH_TOKEN)throw new RuntimeInputError('当前连接存在其他原生认证环境配置，不能同时启用内存账号授权');
    env.CODEBUDDY_CREDENTIALS_IN_MEMORY='1';
    env.CODEBUDDY_INTERNET_ENVIRONMENT=edition==='china'?'internal':'external';
  }
  if (options.connection?.settingSources) args.push('--setting-sources', options.connection.settingSources.join(','));
  if (options.mcpServers) {
    // CodeBuddy expands ${VAR} in MCP config. Keep scoped credentials out of argv.
    let index = 0;
    const servers = Object.fromEntries(Object.entries(options.mcpServers).map(([name, server]) => [name, {
      ...server,
      // Verification disables built-in ToolSearch. Native deferred MCP filtering
      // still sees its registered name, so explicitly load only our bound servers.
      ...(options.verificationTools?{alwaysLoad:true}:{}),
      env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => {
        const variable = `AWB_MCP_ENV_${index++}`; env[variable] = value; return [key, `\${${variable}}`];
      })),
    }]));
    args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
  }
  return { args, env };
}
export function workbuddyArguments(executable: string, options: RuntimeOptions): string[] { return workbuddyLaunch(executable, options).args; }

export class WorkbuddyConnection extends ConnectionBase {
  private currentModel?: string;
  private imageModels = new Set<string>();
  private nonImageModels = new Set<string>();
  private nativeTerminal?:{promise:Promise<void>;resolve:()=>void};
  private nativeInterruption?:Promise<void>;
  private nativeApprovalReplies:Promise<void>[]=[];
  get pid(): number | undefined { return this.process.pid; }
  constructor(options: RuntimeOptions, emit: (event: RuntimeEvent) => void, private process: JsonProcess, private interruptCooldownMs=options.connection?.nativeMemoryAuthentication?6500:0) {
    super(options, emit);
    process.on('frame', frame => { void this.frame(frame).catch(error => this.fail(error)); });
    process.on('failure', error => this.fail(error));
  }
  private control(subtype: string, params: Json = {}): Promise<Json> {
    const id = randomUUID(); return this.process.request(id, { type: 'control_request', request_id: id, request: { subtype, ...params } });
  }
  async initialize(initialized?:Json): Promise<void> {
    this.state('starting');
    // A persistent workbench connection will send prompts after this handshake.
    // false tells the native --resume path to replay history with an empty result;
    // that terminal replay can otherwise race and falsely complete the first new turn.
    const response = initialized??await this.control('initialize', { hasPrompt: true, capabilities: {} });
    const selectedCustomModel = this.options.connection?.config?.workbuddyModelId;
    if (typeof selectedCustomModel === 'string' && response.currentModelId !== selectedCustomModel)
      throw new Error('WorkBuddy 未采用当前连接的自定义模型；已阻止发送，不能回退到原生模型或其他计费来源');
    this.currentModel = typeof this.options.connection?.config?.workbuddyModelId === 'string' ? this.options.connection.config.workbuddyModelId : this.options.model || response.currentModelId;
    // Installed CLI 2.137.1 silently filters user images when supportsImages is false.
    // Its metadata-only control returns the raw boolean; unknown must not imply vision.
    try {
      const models = await this.control('get_available_models');
      for (const row of Array.isArray(models.rawModels) ? models.rawModels : []) {
        if (typeof row.id !== 'string') continue;
        if (row.supportsImages === true) this.imageModels.add(row.id);
        else if (row.supportsImages === false) this.nonImageModels.add(row.id);
      }
    } catch { /* Text sessions still work when optional model metadata is unavailable. */ }
    // The native response includes account.token: only these explicit safe fields leave the adapter.
    this.event({ type: 'ready', nativeSessionId: this.nativeSessionId, data: { model: response.currentModelId } }); this.state('idle');
  }
  async send(text: string, messageId: string, images: RuntimeImageAttachment[] = []): Promise<void> {
    if(this.nativeInterruption)throw new Error('当前轮次未结束，请等待原生中断清理完成');
    if (images.length && (!this.currentModel || !this.imageModels.has(this.currentModel))) {
      throw new RuntimeInputError(this.currentModel && this.nonImageModels.has(this.currentModel)
        ? 'WorkBuddy 当前模型不支持识图，请在模型设置中选择支持图片的模型后重新发送'
        : 'WorkBuddy 未确认当前模型支持图片，已阻止发送以免图片被忽略；请切换支持图片的模型后重试');
    }
    // Installed StreamJsonUtils converts this base64 source to native input_image.
    const blocks = this.imageBlocks(images);
    this.begin(messageId);
    this.nativeApprovalReplies=[];
    let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});this.nativeTerminal={promise,resolve};
    try { await this.process.write({ type: 'user', uuid: messageId, session_id: this.nativeSessionId ?? '', message: { role: 'user', content: blocks.length ? [...(text ? [{ type: 'text', text }] : []), ...blocks] : text }, parent_tool_use_id: null }); }
    catch (error) { this.fail(error); throw error; }
  }
  private async frame(frame: Json): Promise<void> {
    if (!frame.parent_tool_use_id && !frame.agent_id) this.session(frame.session_id);
    if (frame.type === 'control_request') {
      const req = frame.request ?? {};
      if (req.subtype === 'can_use_tool') {
        if(this.options.verificationTools&&!this.options.verificationTools.includes(req.tool_name)){
          await this.process.write({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{allowed:false,reason:'当前验证仅允许显式绑定的 MCP 工具'}}});return;
        }
        this.approval(req.tool_name ?? 'tool', req.input, async allow => {
          const reply=this.process.write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { allowed: allow, interrupt: !allow && this.stopping ? true : undefined, reason: allow ? '用户批准本次操作' : this.stopping ? '用户中断当前轮次' : '用户拒绝本次操作', updatedInput: allow ? req.input : undefined } } });
          if(this.stopping&&this.interruptCooldownMs){this.nativeApprovalReplies.push(reply);void reply.catch(()=>{});}await reply;
        }, frame.request_id);
      } else await this.process.write({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: '当前工作台不支持此输入类型，请在会话中补充指令' } });
      return;
    }
    if (frame.type === 'control_cancel_request') { this.approvals.delete(frame.request_id); return; }
    if (frame.type === 'system' && frame.subtype === 'init') {
      if (typeof frame.model === 'string') this.currentModel = frame.model;
      this.event({ type: 'ready', nativeSessionId: this.nativeSessionId, data: { model: frame.model, tools: frame.tools } }); return;
    }
    // History frames and idle/background output do not belong to a submitted turn.
    // Native --replay-user-messages also marks live user echoes isReplay=true;
    // they carry no assistant output or turn completion and must not be forwarded.
    if (frame.isReplay === true || frame.is_replay === true) return;
    if (!this.activeMessage && ['assistant', 'user', 'stream_event', 'result'].includes(frame.type)) return;
    if (frame.type === 'stream_event') {
      const event = frame.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') this.event({ type: 'delta', text: event.delta.text });
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') this.event({ type: 'tool', data: { phase: 'started', ...event.content_block } });
    }
    if (frame.type === 'assistant') {
      for (const part of frame.message?.content ?? []) {
        if (part.type === 'text') this.event({ type: 'message', text: part.text });
        if (part.type === 'tool_use') this.event({ type: 'tool', data: { phase: 'started', name: part.name, id: part.id, input: part.input } });
      }
    }
    if (frame.type === 'user' && Array.isArray(frame.message?.content)) {
      for (const part of frame.message.content) if (part.type === 'tool_result') this.event({ type: 'tool', data: { phase: 'completed', id: part.tool_use_id, content: part.content, isError: part.is_error } });
    }
    // Native cancellation may repeat the last completed assistant answer. Keep
    // its terminal evidence but never label that old text as the interrupted turn.
    if (frame.type === 'result' && !frame.parent_tool_use_id && !frame.agent_id) {
      // The bundled CLI builds result.usage from session.usage and aggregates
      // cache counters over session history: this is a cumulative snapshot.
      const usage = normalizeUsage(frame.usage, 'workbuddy', { scope: 'session', source: 'workbuddy.result.usage', baselineKnownZero: this.options.resumeSessionId ? undefined : true, partial: this.stopping || undefined });
      if (usage) this.event({ type: 'usage', nativeSessionId: this.nativeSessionId, messageId: this.activeMessage, data: { ...usage } });
      // Recent lite bundles place failures in errors[] with no result/error text.
      const errorText = typeof frame.error === 'string' ? frame.error : frame.error?.message;
      const errors = Array.isArray(frame.errors) ? frame.errors.filter((value:unknown):value is string=>typeof value==='string').slice(0,3).join('\n').slice(0,2000) : undefined;
      const resultText = typeof frame.result === 'string' && frame.result.trim() ? frame.result : errorText || errors;
      this.finish(this.stopping ? undefined : resultText, { subtype: frame.subtype, isError: frame.is_error, usage: frame.usage, durationMs: frame.duration_ms });
      this.nativeTerminal?.resolve();
    }
    if (frame.type === 'error') {
      const message = typeof frame.error === 'string' ? frame.error : frame.error?.message ?? frame.message ?? 'WorkBuddy 执行失败';
      // Bundled 2.137.1 throws this AbortError from assertRunStartupActive.
      // executeStreamMode catches the terminated sendRequest and emits error,
      // instead of result. It is cancellation evidence only during our stop.
      if (this.stopping && message === 'Agent run startup was cancelled') {
        this.finish(undefined, { interrupted: true, subtype: 'startup_cancelled', nativeError: message });
        this.nativeTerminal?.resolve();
      } else this.fail(new Error(message));
    }
  }
  private async nativeCleanup(terminal:Promise<void>|undefined):Promise<void>{
    if(!this.interruptCooldownMs||!terminal)return;
    await timeout(terminal,20_000,'等待原生中断终态');
    let replies:number;
    do{replies=this.nativeApprovalReplies.length;await Promise.all(this.nativeApprovalReplies);await delay(this.interruptCooldownMs);}while(replies!==this.nativeApprovalReplies.length);
  }
  interrupt(): Promise<void> {
    if(this.nativeInterruption)return this.nativeInterruption;
    // Native 2.137.1 routes a denied permission with interrupt:true through
    // SdkPermissionDeniedError to its terminal result. Sending global interrupt
    // first clears session runtime state and can strand that permission wait.
    // stopWith sends every pending denial and still requires a terminal result.
    let cleanup:Promise<void>|undefined;
    const stopped=this.stopWith(() => {
      cleanup=(async()=>{
      const terminal=this.nativeTerminal?.promise;
      if(this.approvals.size){
        await this.nativeCleanup(terminal);
        return;
      }
      // A fresh CLI acknowledges initialize before its first user input creates
      // the native session. Interrupting "current" during that gap is rejected.
      // Keep the turn stopping (including late permission denials) until the
      // real session identity arrives; never resend the user prompt.
      const deadline = Date.now() + 10_000;
      while (this.activeMessage && !this.nativeSessionId && Date.now() < deadline) await delay(25);
      if (!this.activeMessage){await this.nativeCleanup(terminal);return;}
      if (!this.nativeSessionId) throw new Error('WorkBuddy 尚未确认原生会话编号，无法确认中断');
      await this.control('interrupt', { session_id: this.nativeSessionId, reason: '用户在 Agent Workbench 中断当前轮次' });
      await this.nativeCleanup(terminal);
      })().catch(error=>{if(this.interruptCooldownMs){this.broken=true;this.state('unknown');}throw error;});
      return cleanup;
    }, { rejectPendingApprovals: true });
    if(!this.interruptCooldownMs)return stopped;
    // ConnectionBase permits a natural terminal to race its stop RPC. This
    // memory runtime additionally needs that RPC's ACK and cleanup interval;
    // retain its send barrier even if the shared turn timeout has elapsed.
    const work=(async()=>{try{await stopped;await cleanup;}catch(error){this.broken=true;this.state('unknown');throw error;}})();
    this.nativeInterruption=work;void work.finally(()=>{if(this.nativeInterruption===work)this.nativeInterruption=undefined;}).catch(()=>{});return work;
  }
  async close(): Promise<void> { this.closing = true; await this.process.close(); this.finish(undefined, { interrupted: true }); this.state('stopped'); }
}

export interface WorkbuddyAdapterDependencies {
  executable?:typeof resolveWorkbuddyExecutable;
  process?:(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv)=>JsonProcess;
  authenticationTimeoutMs?:number;
  interruptCooldownMs?:number;
}
export function createWorkbuddyAdapter(dependencies:WorkbuddyAdapterDependencies={}):RuntimeAdapter {
  const sessions=new WorkbuddySessionRegistry({authenticationTimeoutMs:dependencies.authenticationTimeoutMs});
  const open=dependencies.process??((command,args,cwd,env)=>new JsonProcess(command,args,cwd,env));
  return {
  kind: 'workbuddy', discover: () => discoverRuntime('workbuddy'),
  authentication:sessions,
  listModels: (cwd, connection) => discoverRuntimeModels('workbuddy', cwd, connection),
  async connect(options, emit) {
    const executable = await (dependencies.executable??resolveWorkbuddyExecutable)(options.connection?.executable, options.connection?.workbuddyEdition); if (!executable) throw new Error('未找到 WorkBuddy 内置 CodeBuddy CLI');
    const launch = workbuddyLaunch(executable, options);
    if(options.connection?.nativeMemoryAuthentication){
      const owned=await sessions.authorize(options,()=>open(globalThis.process.execPath,launch.args,options.cwd,launch.env),pid=>emit({type:'ready',data:{pid,authenticationPending:true}}));
      const connection=new WorkbuddyConnection(options,emit,owned.child,dependencies.interruptCooldownMs);
      try{
        sessions.attach(owned.id,connection.close.bind(connection));
        connection.close=()=>sessions.cancel(owned.id);
        await connection.initialize(owned.initialization);sessions.assertActive(owned.id);return connection;
      }catch(error){await sessions.cancel(owned.id);throw error;}
    }
    const process = open(globalThis.process.execPath, launch.args, options.cwd, launch.env);
    const connection = new WorkbuddyConnection(options, emit, process,dependencies.interruptCooldownMs);
    try { await connection.initialize(); return connection; } catch (error) { await connection.close(); throw error; }
  },
  };
}
export const workbuddyAdapter:RuntimeAdapter=createWorkbuddyAdapter();
