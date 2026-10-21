import { randomUUID } from 'node:crypto';
import type { ConnectionStatus, RuntimeOverrides } from '../../shared/connections.js';
import { discoverWorkbuddyInstallations, JsonProcess, resolveWorkbuddyExecutable, workbuddyEnvironment, type Json } from '../runtime/process.js';

/** Only this transport boundary may see native account/userinfo frames. */
export interface WorkbuddyAuthProcess {
  readonly exited: boolean;
  on(event: string, listener: (frame: Json) => void): unknown;
  request(id: string, frame: Json, timeoutMs?: number): Promise<Json>;
  write(frame: Json): Promise<void>;
  close(): Promise<void>;
}
export interface WorkbuddyAuthDependencies {
  executable(config: RuntimeOverrides): Promise<string | undefined>;
  inspectLaunch(executable: string, config: RuntimeOverrides): Promise<'unsupported-2.161-lite' | 'desktop-bundle' | 'standalone-or-unknown'>;
  open(executable: string, cwd: string, config: RuntimeOverrides): WorkbuddyAuthProcess;
}
const dependencies: WorkbuddyAuthDependencies = {
  executable: config => resolveWorkbuddyExecutable(config.executable, config.workbuddyEdition),
  inspectLaunch: async executable => {
    const installation=(await discoverWorkbuddyInstallations({candidates:[executable]}))[0];
    if(!installation)return 'standalone-or-unknown';
    // Only the locally diagnosed 2.161.0 lite distribution is known to require
    // a managed credential bootstrap. A product ID is not a version contract.
    if(installation.cliVersion==='2.161.0'&&installation.executionPackage==='lite')return 'unsupported-2.161-lite';
    return 'desktop-bundle';
  },
  open: (executable, cwd, config) => new JsonProcess(process.execPath, [
    executable, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--no-session-persistence', '--permission-mode', 'plan', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ], cwd, workbuddyEnvironment(config.env)),
};
const now = () => new Date().toISOString();
const control = (child: WorkbuddyAuthProcess, subtype: string, params: Json = {}, timeoutMs = 25_000): Promise<Json> => {
  const id = randomUUID();
  return child.request(id, { type: 'control_request', request_id: id, request: { subtype, ...params } }, timeoutMs);
};
const initialize = (child: WorkbuddyAuthProcess) => control(child, 'initialize', { hasPrompt: true, capabilities: {} });
const provider = (config: RuntimeOverrides) => config.workbuddyEdition === 'china' ? 'WorkBuddy 中国站' : config.workbuddyEdition === 'international' ? 'WorkBuddy 国际站' : 'WorkBuddy / CodeBuddy';
function authenticationSnapshot(response: Json, config: RuntimeOverrides, desktopBundle = false): ConnectionStatus {
  // Identity can exist while session.auth.accessToken is missing. Neither the
  // identity summary nor credential fields leave this transport boundary.
  const identity = response.account;
  const identitySummary = identity && typeof identity.type === 'string' && identity.type.trim().length > 0 && (
    typeof identity.uid === 'string' && identity.uid.trim().length > 0 ||
    typeof identity.userId === 'string' && identity.userId.trim().length > 0
  );
  const nativeAccount = !!(response.account && (
    typeof response.account.token === 'string' && response.account.token.length ||
    typeof response.account.accessToken === 'string' && response.account.accessToken.length ||
    typeof response.account.access_token === 'string' && response.account.access_token.length
  ));
  const nativeEnvironment = !!(config.env.CODEBUDDY_API_KEY || config.env.CODEBUDDY_AUTH_TOKEN);
  if (nativeAccount || nativeEnvironment) return {
    state: 'authentication-observed', checkedAt: now(), provider: provider(config),
    credentialSource: nativeEnvironment ? 'native-environment' : 'native-codebuddy-account',
    detail: nativeEnvironment
      ? '当前 CLI 继承了原生认证环境配置；尚未验证服务接受凭据、模型权限或余额。'
      : '当前版本的内置 CLI 已报告原生认证凭据；尚未验证实际调用、模型权限或余额。',
  };
  if (config.nativeMemoryAuthentication === true) return {
    state: 'unconfigured', checkedAt: now(), provider: provider(config), credentialSource: 'native-memory-authorization-required',
    detail: '本通道需要每个执行进程独立完成原生授权，当前只读检测未报告可用凭据。请在顶部“执行授权”面板完成当前进程的授权，或在接入中心点击“授权并验证CLI”启动授权与真实调用验证（会产生少量 Token）。授权仅保留在执行进程内存中，关闭服务后需重新授权，不会退出桌面客户端账号。',
  };
  if (identitySummary) return {
    state: 'unconfigured', checkedAt: now(), provider: provider(config), credentialSource: 'native-codebuddy-identity',
    detail: desktopBundle
      ? '已检测到桌面账号身份，但当前内置 CLI 缺少桌面父进程的原生凭据引导，未报告执行所需的认证凭据。工作台尚不支持此受管引导，当前不能恢复执行认证，无需重复扫码。'
      : '已检测到账号身份，但当前 CLI 未报告执行所需的认证凭据；该执行通道尚未就绪，请核对其原生认证状态。',
  };
  if (response.account === null) return {
    state: 'unconfigured', checkedAt: now(), provider: provider(config),
    detail: desktopBundle
      ? '当前内置 CLI 未报告可用账号，且缺少桌面父进程的原生凭据引导。工作台尚不支持此受管引导，当前不能恢复执行认证，无需反复扫码。'
      : '当前 CLI 未报告已登录账号；请核对其原生认证状态后重新检测。',
  };
  return { state: 'unknown', checkedAt: now(), provider: provider(config), detail: '当前 CLI 未返回可确认的认证状态；不会根据桌面登录或安装状态推定可调用。' };
}
export class WorkbuddyAuthStopError extends Error {
  constructor(readonly retryStop: () => Promise<void>) { super('未确认 WorkBuddy 认证控制进程停止；相关原生连接继续暂停。'); }
}
/** A known local integration limitation, not an account rejection or a login prompt. */
export class WorkbuddyLoginUnavailableError extends Error {
  readonly statusCode=409;
  readonly code='WORKBUDDY_LOGIN_CHANNEL_UNAVAILABLE';
  constructor() { super('当前选择的是 WorkBuddy 桌面内置执行包，工作台尚不支持其所需的桌面父进程原生凭据引导，当前不能恢复执行认证，已阻止再次无效扫码。桌面客户端登录可保持，工作台不会更改原生凭据保护或保存策略。'); }
}
async function close(child: WorkbuddyAuthProcess): Promise<void> {
  try { await child.close(); } catch { throw new WorkbuddyAuthStopError(() => child.close()); }
}

/** Metadata handshake only: no authenticate request, user prompt, tool call, or credential-file access. */
export async function readWorkbuddyAuthentication(cwd: string, config: RuntimeOverrides, overrides: Partial<WorkbuddyAuthDependencies> = {}): Promise<ConnectionStatus> {
  const deps = { ...dependencies, ...overrides }, executable = await deps.executable(config);
  if (!executable) return { state: 'not-installed', checkedAt: now(), detail: '未找到所选版本的 WorkBuddy 内置 CLI。' };
  const desktopBundle = await deps.inspectLaunch(executable, config) === 'unsupported-2.161-lite';
  const child = deps.open(executable, cwd, config);
  try {
    return authenticationSnapshot(await initialize(child), config, desktopBundle);
  } catch {
    return { state: 'unknown', checkedAt: now(), provider: provider(config), detail: '未能读取当前版本的 CLI 认证状态；可能是网络或原生初始化异常，请稍后重新检测。没有发起模型调用。' };
  } finally { await close(child); }
}

interface LoginOutcome { state: 'completed' | 'failed'; detail: string; }
export interface WorkbuddyLoginHandle {
  detail: string;
  getState(): { authUrl?: string; detail?: string };
  poll(): Promise<LoginOutcome | undefined>;
  close(cancel: boolean): Promise<void>;
}
export interface WorkbuddyLoginPreflight {alreadyAuthenticated?:boolean;detail?:string;authenticationStatus?:ConnectionStatus;}
/** Read-only admission before profile revisions or cached member sessions change. */
export async function preflightWorkbuddyLogin(cwd:string,config:RuntimeOverrides,overrides:Partial<WorkbuddyAuthDependencies>={}):Promise<WorkbuddyLoginPreflight>{
  const deps={...dependencies,...overrides},executable=await deps.executable(config);
  if(!executable)throw new Error('未找到所选版本的 WorkBuddy 内置 CLI');
  const inspection=await deps.inspectLaunch(executable,config);
  const status=await readWorkbuddyAuthentication(cwd,config,deps);
  if(status.state==='authentication-observed')return {alreadyAuthenticated:true,authenticationStatus:status,detail:'只读检测到当前 CLI 原生凭据，无需重复登录；没有发起新授权，也未验证实际调用、模型权限或余额。'};
  if(inspection==='unsupported-2.161-lite')throw new WorkbuddyLoginUnavailableError();
  return {detail:inspection==='desktop-bundle'?'此历史／未知安装版本尚未在本机验收，将保留原生登录流程；实际调用需单独验证。':undefined};
}
function safeAuthUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 8_192) return;
  try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password) return url.toString(); } catch {}
}

/** Native stream-json authorization. Never invent an environment, endpoint, or authentication method. */
export async function launchWorkbuddyLogin(cwd: string, config: RuntimeOverrides, overrides: Partial<WorkbuddyAuthDependencies> = {}): Promise<WorkbuddyLoginHandle> {
  const deps = { ...dependencies, ...overrides }, executable = await deps.executable(config);
  if (!executable) throw new Error('未找到所选版本的 WorkBuddy 内置 CLI');
  // The diagnosed 2.161 lite desktop bundle expects a managed parent bootstrap. Opening its
  // standalone browser flow can succeed without usable credentials in the next
  // process, and can change native persistence behavior. Never attempt it here.
  const inspection=await deps.inspectLaunch(executable,config);
  const child = deps.open(executable, cwd, config);
  let authUrl: string | undefined, requestId: string | undefined, cancelled = false, outcome: LoginOutcome | undefined;
  let detail = inspection==='desktop-bundle'?'此历史／未知安装版本尚未在本机验收；正在读取其原生认证方法，等待浏览器授权链接。':'正在读取原生认证方法，等待浏览器授权链接。';
  let rechecking: Promise<void> | undefined;
  let recheckStop: WorkbuddyAuthStopError | undefined;
  const completed = () => outcome?.state === 'completed';
  const uncertain = (): Promise<void> => rechecking ??= (async () => {
    if (cancelled || completed()) return;
    detail = '原生授权未返回最终回执，正在只读核对登录是否已经保存。';
    // Newer CLI control requests time out after 60 seconds even when the browser
    // flow allows longer. A timeout is not evidence that a late scan was rejected.
    let state: ConnectionStatus;
    try { state = await readWorkbuddyAuthentication(cwd, config, deps); }
    catch (error) {
      if (!(error instanceof WorkbuddyAuthStopError)) throw error;
      recheckStop = error;
      state = { state: 'unknown', checkedAt: now(), detail: '认证核对进程停止未确认。' };
    }
    if (cancelled || completed()) return;
    outcome = state.state === 'authentication-observed'
      ? { state: 'completed', detail: '授权回执中断后，重新检测到当前 CLI 原生认证；实际模型调用仍需单独验证。' }
      : { state: 'failed', detail: '未获得原生授权成功回执，重新检测也未能确认 CLI 登录。原生授权可能已超时，请重新检测后再决定是否登录。' };
  })();
  const acknowledge = (id: unknown) => {
    if (typeof id !== 'string') return;
    void child.write({ type: 'control_response', response: { request_id: id, subtype: 'success', response: {} } }).catch(() => { if (!cancelled) void uncertain().catch(() => {}); });
  };
  child.on('frame', frame => {
    if (frame.type !== 'control_request') return;
    const request = frame.request ?? {};
    if (request.subtype === 'auth_url_callback') {
      const value = safeAuthUrl(request.authState?.authUrl);
      if (value) { authUrl = value; detail = '已收到此版本的原生授权链接，请打开浏览器完成登录；无需在工作台输入密码或令牌。'; }
      else outcome = { state: 'failed', detail: '原生登录未提供安全的 HTTPS 授权链接，已阻止打开。' };
      acknowledge(frame.request_id);
    } else if (request.subtype === 'auth_result_callback') {
      // Native userinfo includes a token. Only the explicit success boolean is read.
      if (request.success === true) outcome = { state: 'completed', detail: '原生授权已返回成功；请重新检测认证并单独验证实际模型调用。' };
      acknowledge(frame.request_id);
    } else if (typeof frame.request_id === 'string') {
      void child.write({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'error', error: '认证控制会话不允许执行其他操作' } }).catch(() => {});
    }
  });
  child.on('failure', () => { if (requestId && !cancelled && !outcome) void uncertain().catch(() => { outcome = { state: 'failed', detail: '原生登录控制中断，且未能确认认证状态；请重新检测。' }; }); });
  try {
    const initialized = authenticationSnapshot(await initialize(child), config);
    if (initialized.state === 'authentication-observed') outcome = { state: 'completed', detail: '已检测到当前 CLI 原生认证，无需重复登录；实际模型调用仍需单独验证。' };
    else {
      if(inspection==='unsupported-2.161-lite')throw new WorkbuddyLoginUnavailableError();
      const response = await control(child, 'get_auth_methods');
      const methods = Array.isArray(response.authMethods) ? response.authMethods : Array.isArray(response.methods) ? response.methods : [];
      const expected = config.workbuddyEdition === 'international' ? 'workbuddy-desktop-ai' : config.workbuddyEdition === 'china' ? 'workbuddy-desktop' : undefined;
      const native = methods.filter(row => row && (row.id === 'workbuddy-desktop' || row.id === 'workbuddy-desktop-ai'));
      const selected = expected ? native.find(row => row.id === expected) : native.length === 1 ? native[0] : undefined;
      if (!selected) throw new Error('所选 WorkBuddy 版本与原生认证方法不一致，请核对版本和连接；没有切换登录站点');
      requestId = randomUUID();
      // Local wait is slightly longer than the native 60s control timeout so its
      // real error/callback is observed rather than locally fabricating failure.
      void child.request(requestId, { type: 'control_request', request_id: requestId, request: { subtype: 'authenticate', methodId: selected.id } }, 75_000)
        .then(async value => {
          if (cancelled || outcome?.state === 'completed') return;
          if (value.success === true) outcome = { state: 'completed', detail: '原生授权已返回成功；请重新检测认证并单独验证实际模型调用。' };
          else await uncertain();
        }).catch(() => { if (!cancelled && !outcome) void uncertain().catch(() => { outcome = { state: 'failed', detail: '原生授权超时或控制中断，尚未确认 CLI 登录，请重新检测。' }; }); });
    }
    return {
      detail,
      getState: () => ({ authUrl, detail }),
      poll: async () => outcome,
      close: async cancel => {
        cancelled = true;
        if (cancel && requestId && !child.exited) {
          try { await child.write({ type: 'control_cancel_request', request_id: requestId }); } catch {}
        }
        // Close all owned control processes before the login gate can be released.
        await close(child);
        if (rechecking) await rechecking;
        if (recheckStop) { await recheckStop.retryStop(); recheckStop = undefined; }
        authUrl = undefined;
      },
    };
  } catch (error) { cancelled = true; await close(child); throw error; }
}
