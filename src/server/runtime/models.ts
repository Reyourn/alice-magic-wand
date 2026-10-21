import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeKind, RuntimeModel, RuntimeModelCatalog } from '../../shared/types.js';
import type { RuntimeOverrides } from '../../shared/connections.js';
import { executableFor, resolveWorkbuddyExecutable, workbuddyEnvironment, JsonProcess, safeText, terminateTree, timeout, type Json } from './process.js';

const discoveryTimeout = 45_000;
function model(row: Json, id: unknown, name: unknown, isDefault?: boolean): RuntimeModel | undefined {
  if (typeof id !== 'string' || !id.trim() || row.hidden === true || row.disabled === true) return;
  return { id: safeText(id), name: safeText(typeof name === 'string' && name ? name : id),
    ...(typeof row.description === 'string' ? { description: safeText(row.description) } : {}),
    ...(isDefault !== undefined ? { isDefault } : {}) };
}
function unique(rows: (RuntimeModel | undefined)[]): RuntimeModel[] {
  return [...new Map(rows.filter((row): row is RuntimeModel => !!row).map(row => [row.id, row])).values()];
}
async function codexModels(executable: string, cwd: string, connection?: RuntimeOverrides): Promise<RuntimeModel[]> {
  const child = new JsonProcess(executable, ['app-server', '--stdio'], cwd, connection?.env);
  const rpc = (method: string, params: Json) => { const id = randomUUID(); return child.request(id, { id, method, params }); };
  try {
    return await timeout((async () => {
      await rpc('initialize', { clientInfo: { name: 'agent_workbench_models', version: '0.1.0' }, capabilities: {} });
      await child.write({ method: 'initialized' });
      const rows: (RuntimeModel | undefined)[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const response = await rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(response.data)) throw new Error('Codex 未返回有效模型目录');
        rows.push(...response.data.map((row: Json) => model(row, row.model ?? row.id, row.displayName, typeof row.isDefault === 'boolean' ? row.isDefault : undefined)));
        if (!response.nextCursor) return unique(rows);
        if (typeof response.nextCursor !== 'string' || cursors.has(response.nextCursor)) throw new Error('Codex 模型目录分页游标无效');
        cursors.add(response.nextCursor); cursor = response.nextCursor;
      }
      throw new Error('Codex 模型目录分页超出限制');
    })(), discoveryTimeout, 'Codex 模型检测');
  } finally { await child.close(); }
}
async function workbuddyModels(executable: string, cwd: string, connection?: RuntimeOverrides): Promise<RuntimeModel[]> {
  // Verified in the installed 2.137.1 --help. No prompt or session resume is sent.
  const child = new JsonProcess(process.execPath, [executable, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--no-session-persistence', '--permission-mode', 'plan', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', connection?.settingSources?.join(',') ?? 'user,project,local'], cwd, workbuddyEnvironment(connection?.env));
  const control = (subtype: string, params: Json = {}) => { const id = randomUUID(); return child.request(id, { type: 'control_request', request_id: id, request: { subtype, ...params } }); };
  try {
    return await timeout((async () => {
      // Do not expose the initialize response: it also contains account credentials.
      const initialized = await control('initialize', { hasPrompt: true, capabilities: {} });
      const response = await control('get_available_models');
      const blocked = new Set((Array.isArray(response.rawModels) ? response.rawModels : [])
        .filter((row: Json) => row.hidden === true || row.disabled === true).map((row: Json) => row.id));
      const rows = Array.isArray(response.availableModels) ? response.availableModels : initialized.models;
      if (!Array.isArray(rows)) throw new Error('WorkBuddy 未返回有效模型目录');
      return unique(rows.map((row: Json) => {
        const id = row.modelId ?? row.id;
        return blocked.has(id) ? undefined : model(row, id, row.name, typeof initialized.currentModelId === 'string' ? id === initialized.currentModelId : undefined);
      }));
    })(), discoveryTimeout, 'WorkBuddy 模型检测');
  } finally { await child.close(); }
}
async function claudeModels(executable: string, cwd: string, connection?: RuntimeOverrides): Promise<RuntimeModel[]> {
  let child: ChildProcessWithoutNullStreams | undefined; let nativeQuery: Query | undefined; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prompt: AsyncIterable<SDKUserMessage> = { async *[Symbol.asyncIterator]() { await held; } };
  try {
    nativeQuery = query({ prompt, options: {
      cwd, pathToClaudeCodeExecutable: executable, permissionMode: 'plan', persistSession: false,
      settingSources: connection?.settingSources ?? ['user', 'project', 'local'], settings: { disableAllHooks: true },
      ...(connection ? { env: connection.env } : {}),
      tools: [], strictMcpConfig: true, mcpServers: {},
      canUseTool: async () => ({ behavior: 'deny', message: '模型目录检测不执行工具', interrupt: true }),
      spawnClaudeCodeProcess: options => {
        child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr.on('data', () => {}); return child;
      },
    } });
    const rows = await timeout(nativeQuery.supportedModels(), discoveryTimeout, 'Claude 模型检测');
    if (!Array.isArray(rows)) throw new Error('Claude 未返回有效模型目录');
    return unique(rows.map(row => model(row, row.value, row.displayName)));
  } finally {
    // Kill the owned tree before SDK close can orphan descendants on Windows.
    try { if (child?.pid) await terminateTree(child); }
    finally { nativeQuery?.close(); release(); }
    if (child?.pid) await timeout(new Promise<void>(resolve => {
      if (child!.exitCode !== null || child!.signalCode !== null) resolve(); else child!.once('exit', () => resolve());
    }), 5_000, '关闭 Claude 模型检测进程');
  }
}

/** A fresh metadata-only process; never attaches to a member or sends a prompt. */
export async function discoverRuntimeModels(kind: RuntimeKind, cwd: string, connection?: RuntimeOverrides): Promise<RuntimeModelCatalog> {
  const executable = kind === 'workbuddy' && connection?.workbuddyEdition
    ? await resolveWorkbuddyExecutable(connection.executable, connection.workbuddyEdition)
    : connection?.executable ?? await executableFor(kind);
  if (!executable) throw new Error(`未找到 ${kind} 本机运行程序`);
  const models = await (kind === 'codex' ? codexModels(executable, cwd, connection) : kind === 'workbuddy' ? workbuddyModels(executable, cwd, connection) : claudeModels(executable, cwd, connection));
  if (!models.length) throw new Error(`${kind} 当前未报告可选模型`);
  const source = { codex: 'codex.app-server.model/list', claude: 'claude.sdk.supportedModels', workbuddy: 'workbuddy.control.get_available_models' }[kind];
  return { runtime: kind, models, source, status: 'ready', checkedAt: new Date().toISOString(),
    detail: kind === 'claude' ? '工具报告的可选模型；兼容路由可能仍显示原生别名，不代表后端实际模型或账号余额、调用授权已验证。' : '工具报告的可选模型；来自本次独立原生进程的目录，不代表账号余额或调用授权已验证。' };
}
