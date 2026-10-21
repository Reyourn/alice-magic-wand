import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { access, readFile, readdir } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { RuntimeKind, RuntimeInfo } from '../../shared/types.js';
import type { WorkbuddyEdition } from '../../shared/connections.js';
export type { WorkbuddyEdition } from '../../shared/connections.js';
import { isTokenCountField } from './usage.js';

export const exec = promisify(execFile);
export type Json = Record<string, any>;
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时；未确认执行已停止`)), ms); })]).finally(() => clearTimeout(timer));
}

// Native initialize/configuration frames can contain account credentials. Never forward them.
export function safeText(value: unknown): string {
  return String(value ?? '')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[IMAGE DATA OMITTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;"'}]+)/gi, (_match, prefix: string, credential: string) => {
      // Preserve JSON/diagnostic quoting while removing the entire quoted value.
      const quote = credential.startsWith('"') ? '"' : credential.startsWith("'") ? "'" : '';
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(/(bearer\s+)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]');
}
export function safeData(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(safeData);
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const imageData = row.type === 'base64' && typeof row.media_type === 'string' && row.media_type.startsWith('image/') || row.type === 'image' && typeof row.mimeType === 'string' && row.mimeType.startsWith('image/');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, imageData && key === 'data' ? '[IMAGE DATA OMITTED]' : isTokenCountField(key, item) ? item : /token|secret|password|authorization|api.?key|^env$/i.test(key) ? '[REDACTED]' : safeData(item)]));
  }
  return value;
}

export class JsonLines {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private receive: (frame: Json) => void, private malformed: () => void) {}
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    // Native replay can echo four 5 MiB images as base64 in a single user frame.
    if (this.buffer.length > 40 * 1024 * 1024) { this.buffer = ''; this.malformed(); return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try { const frame: unknown = JSON.parse(line); if (frame && typeof frame === 'object') this.receive(frame as Json); else this.malformed(); }
      catch { this.malformed(); }
    }
  }
}

/** Only launches an executable or a Node script: shell quoting never processes user text. */
export class JsonProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private requests = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ended = false;
  private closing = false;
  constructor(command: string, args: string[], cwd: string, private environment: NodeJS.ProcessEnv = process.env) {
    super();
    this.child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment });
    const parser = new JsonLines(frame => this.receive(frame), () => this.emit('protocolWarning', '运行程序输出了无法解析的协议帧'));
    this.child.stdout.on('data', data => parser.push(data));
    // Drain stderr without persisting it: vendor diagnostics can include credentials or entire requests.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => { if (!this.child.pid) this.ended = true; this.fail(error); });
    this.child.on('exit', (code, signal) => {
      this.ended = true;
      this.fail(new Error(`运行程序退出 (${code ?? signal ?? 'unknown'})`));
      this.emit('exit', { code, signal, expected: this.closing });
    });
  }
  get pid(): number | undefined { return this.child.pid; }
  get exited(): boolean { return this.ended; }
  private fail(error: Error): void {
    error = new Error(this.diagnostic(error.message));
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
    if (!this.closing) this.emit('failure', error);
  }
  private diagnostic(message: unknown): string {
    let result = String(message ?? '');
    for (const [key, value] of Object.entries(this.environment)) if (value && /key|token|secret|password|authorization/i.test(key)) result = result.replaceAll(value, '[REDACTED]');
    return safeText(result);
  }
  private receive(frame: Json): void {
    const key = frame.type === 'control_response' ? frame.response?.request_id : (!frame.method && frame.id !== undefined ? String(frame.id) : undefined);
    const pending = key === undefined ? undefined : this.requests.get(String(key));
    if (pending) {
      this.requests.delete(String(key)); clearTimeout(pending.timer);
      const err = frame.error ?? (frame.response?.subtype === 'error' ? frame.response.error : undefined);
      if (err) pending.reject(new Error(this.diagnostic(typeof err === 'string' ? err : err.message ?? '运行请求失败')));
      else pending.resolve(frame.type === 'control_response' ? frame.response.response ?? {} : frame.result ?? {});
      return;
    }
    this.emit('frame', frame);
  }
  async write(frame: Json): Promise<void> {
    if (this.ended || this.child.stdin.destroyed) throw new Error('运行会话已经关闭');
    await new Promise<void>((resolve, reject) => this.child.stdin.write(`${JSON.stringify(frame)}\n`, 'utf8', error => error ? reject(error) : resolve()));
  }
  request(key: string, frame: Json, ms = 60_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(key); reject(new Error('运行程序未返回控制请求回执')); }, ms);
      this.requests.set(key, { resolve, reject, timer });
      void this.write(frame).catch(error => { clearTimeout(timer); this.requests.delete(key); reject(error); });
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    this.fail(new Error('运行会话已关闭'));
    if (this.ended) return;
    // Kill the owned process tree before its root can exit and orphan tools/MCP children.
    await terminateTree(this.child);
    await timeout(new Promise<void>(resolve => { if (this.ended) resolve(); else this.child.once('exit', () => resolve()); }), 5_000, '关闭运行程序');
  }
}

export async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }); }
    catch { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  } else child.kill('SIGTERM');
}

async function existing(paths: string[]): Promise<string | undefined> {
  for (const path of paths) { try { await access(path); return path; } catch {} }
}
export interface WorkbuddyInstallation {
  edition: WorkbuddyEdition; executable: string; productId: 'workbuddy-desktop' | 'workbuddy-desktop-ai';
  desktopPath?: string; desktopVersion?: string; cliVersion?: string; executionPackage?: 'lite' | 'full';
}

/** Read vendor identity, never infer an account or distribution from a directory name. */
async function workbuddyInstallation(executable: string): Promise<WorkbuddyInstallation | undefined> {
  try {
    await access(executable);
    const cliDirectory = dirname(dirname(resolve(executable)));
    const product = JSON.parse(await readFile(join(cliDirectory, 'product.json'), 'utf8'));
    const productId = product?.authentication?.id;
    if (productId !== 'workbuddy-desktop' && productId !== 'workbuddy-desktop-ai') return;
    const edition = productId === 'workbuddy-desktop-ai' ? 'international' : 'china';
    const desktopDirectory = resolve(cliDirectory, '../../..');
    const desktopPath = await existing([join(desktopDirectory, edition === 'international' ? 'WorkBuddyAI.exe' : 'WorkBuddy.exe')]);
    let desktopVersion: string | undefined, cliVersion: string | undefined;
    try {
      const manifest = JSON.parse(await readFile(join(desktopDirectory, 'resources/install-manifest.json'), 'utf8'));
      if (typeof manifest.appVersion === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(manifest.appVersion)) desktopVersion = manifest.appVersion;
    } catch { /* Older packages need not include a desktop manifest. */ }
    try {
      const manifest = JSON.parse(await readFile(join(cliDirectory, 'package.json'), 'utf8'));
      const version = manifest.publishConfig?.customPackage?.version;
      if (typeof version === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(version)) cliVersion = version;
    } catch { /* Missing public package metadata does not invalidate vendor identity. */ }
    // Reflect the published entry selected by our lite launch preference, without running it.
    const executionPackage = await existing([join(cliDirectory, 'dist/codebuddy-lite-wb.mjs')]) ? 'lite'
      : await existing([join(cliDirectory, 'dist/codebuddy.js')]) ? 'full' : undefined;
    return { edition, executable: resolve(executable), productId, ...(desktopPath ? { desktopPath } : {}), ...(desktopVersion ? { desktopVersion } : {}), ...(cliVersion ? { cliVersion } : {}), ...(executionPackage ? { executionPackage } : {}) };
  } catch { return; }
}

function workbuddyCandidates(environment: NodeJS.ProcessEnv): string[] {
  const local = environment.LOCALAPPDATA ?? '';
  return [environment.AWB_WORKBUDDY_PATH, environment.AWB_WORKBUDDY_CHINA_PATH, environment.AWB_WORKBUDDY_INTERNATIONAL_PATH,
    join(local, 'Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy'),
    join(local, 'Programs/WorkBuddyAI/resources/app.asar.unpacked/cli/bin/codebuddy')].filter((value): value is string => !!value);
}

/** Metadata only: no prompt, login, account file or authentication response is read. */
export async function discoverWorkbuddyInstallations(options: { candidates?: string[]; environment?: NodeJS.ProcessEnv } = {}): Promise<WorkbuddyInstallation[]> {
  const candidates = options.candidates ?? workbuddyCandidates(options.environment ?? process.env);
  const installations: WorkbuddyInstallation[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? resolve(candidate).toLowerCase() : resolve(candidate);
    if (seen.has(key)) continue; seen.add(key);
    const installation = await workbuddyInstallation(candidate);
    if (installation) installations.push(installation);
  }
  return installations;
}

/** Bind the unchanged vendor product through the native V3 configuration entry point.
 * Callers must still verify the product reported by the native process; binding a
 * file alone does not prove that native configuration overlays honored it.
 * Never synthesize an endpoint/account config or copy values from another installation.
 */
export async function bindWorkbuddyProduct(executable: string, environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...environment };
  const installation = (await discoverWorkbuddyInstallations({ candidates:[executable] }))[0];
  // Older wrappers may manage their own product configuration. Preserve their behavior.
  if (!installation) return env;
  const productPath = join(dirname(dirname(installation.executable)), 'product.json');
  const vendorProduct = await readFile(productPath, 'utf8');
  for (const name of ['ACC_PRODUCT_CONFIG_V2','ACC_PRODUCT_CONFIG']) {
    if (env[name]) throw new Error(`原生产品配置冲突：${name}；请处理后重新检测`);
  }
  if (env.ACC_PRODUCT_CONFIG_V3 && env.ACC_PRODUCT_CONFIG_V3 !== vendorProduct) throw new Error('原生产品配置冲突：ACC_PRODUCT_CONFIG_V3；请处理后重新检测');
  const current = env.ACC_PRODUCT_CONFIG_PATH;
  const comparable = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (current && comparable(current) !== comparable(productPath)) throw new Error('原生产品配置冲突：ACC_PRODUCT_CONFIG_PATH；请处理后重新检测');
  // Use the unchanged public vendor configuration and skip the native product
  // cache's early snapshot. Background overlays still require runtime identity checks.
  env.ACC_PRODUCT_CONFIG_V3 = vendorProduct;
  env.CODEBUDDY_DISABLE_PRODUCT_CACHE = '1';
  return env;
}

/** Omitted edition preserves legacy precedence; explicit selection never falls back to another edition. */
export async function resolveWorkbuddyExecutable(executable?: string, edition?: WorkbuddyEdition): Promise<string | undefined> {
  const override = executable ?? process.env.AWB_WORKBUDDY_PATH;
  if (override) {
    const path = await existing([override]);
    if (!path) throw new Error('所选 WorkBuddy 执行程序路径不存在');
    if (edition && (await workbuddyInstallation(path))?.edition !== edition) throw new Error('所选 WorkBuddy 执行程序与国内／国际版本不匹配；请检查安装路径和 product.json');
    return path;
  }
  // Legacy native-workbuddy connections historically selected the China desktop.
  // Discovering an international install must not silently change that login scope.
  if (!edition) return existing([
    join(process.env.LOCALAPPDATA ?? '', 'Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy')]);
  const editionOverride = process.env[edition === 'china' ? 'AWB_WORKBUDDY_CHINA_PATH' : 'AWB_WORKBUDDY_INTERNATIONAL_PATH'];
  if (editionOverride) return resolveWorkbuddyExecutable(editionOverride, edition);
  const selected = (await discoverWorkbuddyInstallations()).find(installation => installation.edition === edition);
  if (!selected) throw new Error(`未找到 WorkBuddy ${edition === 'china' ? '国内版' : '国际版'}；请指定该版本的执行程序`);
  return selected.executable;
}

/** Lite bundle selection belongs to this child only; it never changes authentication or global settings. */
export function workbuddyEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' };
}

export async function executableFor(kind: RuntimeKind): Promise<string | undefined> {
  const override = process.env[`AWB_${kind.toUpperCase()}_PATH`];
  if (override) return existing([override]);
  const local = process.env.LOCALAPPDATA ?? '';
  if (kind === 'workbuddy') return resolveWorkbuddyExecutable();
  const name = process.platform === 'win32' ? `${kind === 'claude' ? 'claude' : 'codex'}.exe` : kind;
  const pathMatch = await existing((process.env.PATH ?? '').split(delimiter).map(path => join(path, name)));
  if (pathMatch) return pathMatch;
  if (kind === 'claude') return existing([join(local, 'Programs/node-v24.21.0-win-x64/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), join(process.env.USERPROFILE ?? '', '.local/bin/claude.exe')]);
  const bins = join(local, 'OpenAI/Codex/bin');
  try { const entries = await readdir(bins, { withFileTypes: true }); return existing(entries.filter(e => e.isDirectory()).map(e => join(bins, e.name, 'codex.exe'))); } catch { return undefined; }
}

export async function discoverRuntime(kind: RuntimeKind, configuredExecutable?: string): Promise<RuntimeInfo> {
  const executable = configuredExecutable ?? await executableFor(kind);
  const capabilities = { steer: false, interrupt: true, resume: true, approvals: true };
  if (!executable) return { kind, available: false, detail: `未找到 ${kind}；可设置 AWB_${kind.toUpperCase()}_PATH`, capabilities };
  try {
    const command = kind === 'workbuddy' ? process.execPath : executable;
    const args = kind === 'workbuddy' ? [executable, '--version'] : ['--version'];
    const { stdout } = await exec(command, args, { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, ...(kind === 'workbuddy' ? { env: workbuddyEnvironment() } : {}) });
    return { kind, available: true, executable, version: safeText(stdout.trim()).slice(0, 120), detail: '已找到本机执行程序；登录和模型可用性在连接时验证', capabilities };
  } catch { return { kind, available: false, executable, detail: '本机执行程序版本检查失败；请在原生工具中检查安装', capabilities }; }
}
