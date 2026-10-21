/** Bounded native check: creates a fresh isolated session, never resumes user work. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeAdapter, RuntimeConnection, RuntimeEvent, RuntimeImageAttachment, RuntimeKind } from '../src/shared/types.js';
import { codexAdapter } from '../src/server/runtime/codex.js';
import { claudeAdapter } from '../src/server/runtime/claude.js';
import { workbuddyAdapter } from '../src/server/runtime/workbuddy.js';
import { executableFor, JsonProcess, safeText, timeout } from '../src/server/runtime/process.js';

const args = process.argv.slice(2);
const arg = (name: string) => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
const root = arg('cwd'); const out = arg('out');
if (!root || !out) throw new Error('用法：--runtime codex|claude|workbuddy --image PATH --cwd ISOLATED_ROOT --out JSON [--model ID]；或 --list-workbuddy-models --cwd ISOLATED_ROOT --out JSON');
await mkdir(resolve(root), { recursive: true }); await mkdir(dirname(resolve(out)), { recursive: true });
const cwd = await mkdtemp(join(resolve(root), 'native-image-'));
if (args.includes('--list-workbuddy-models')) {
  const executable = await executableFor('workbuddy'); if (!executable) throw new Error('未找到 WorkBuddy');
  const child = new JsonProcess(process.execPath, [executable, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--permission-mode', 'plan', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], cwd);
  const control = (subtype: string, params = {}) => { const id = randomUUID(); return child.request(id, { type: 'control_request', request_id: id, request: { subtype, ...params } }); };
  try {
    const initialized = await control('initialize', { hasPrompt: true, capabilities: {} }); const response = await control('get_available_models');
    const result = { kind: 'metadata-only', currentModelId: initialized.currentModelId, models: (Array.isArray(response.rawModels) ? response.rawModels : []).map((row: Record<string, unknown>) => ({ id: row.id, name: row.name, supportsImages: row.supportsImages })) };
    await writeFile(resolve(out), JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify(result));
  } finally { await child.close(); }
} else {
  const kind = arg('runtime') as RuntimeKind; const imagePath = arg('image'); const model = arg('model');
  if (!['codex', 'claude', 'workbuddy'].includes(kind) || !imagePath) throw new Error('缺少有效 --runtime 或 --image');
  const adapter: RuntimeAdapter = { codex: codexAdapter, claude: claudeAdapter, workbuddy: workbuddyAdapter }[kind];
  const path = resolve(imagePath); const size = (await stat(path)).size;
  const image: RuntimeImageAttachment = { id: randomUUID(), name: '合成识图验收.png', mimeType: 'image/png', size, url: '', path };
  const events: RuntimeEvent[] = []; let connection: RuntimeConnection | undefined; let complete!: () => void;
  const terminal = new Promise<void>(done => { complete = done; }); let approvalsDenied = 0; let failure: string | undefined;
  try {
    // Each adapter bounds its own initialize calls and closes on failure. Wrapping
    // connect in a detached Promise.race could leave a late native process alive.
    connection = await adapter.connect({ agentId: `vision-validation-${randomUUID()}`, cwd, model, permissionMode: 'read-only', instructions: '这是隔离的图片输入验收。直接根据提供的图片作答，不调用任何工具，不读取文件，不修改代码。' }, event => {
      events.push(event);
      if (event.type === 'approval' && event.approvalId) { approvalsDenied++; void connection?.respondApproval(event.approvalId, false); }
      if (event.type === 'result' || event.type === 'error') complete();
    });
    await connection.send('请直接观察所附图片：写出图中的所有英文大写文字或数字，并按从左到右顺序说明几何图形的颜色和形状。用中文简短回答。不要猜测，不使用工具。', randomUUID(), [image]);
    await timeout(terminal, 90_000, '等待识图回答');
  } catch (error) { failure = safeText(error instanceof Error ? error.message : String(error)); }
  finally { if (connection) await connection.close().catch(error => { failure ??= safeText(String(error)); }); }
  const results = events.filter(event => event.type === 'result');
  const report = { runtime: kind, configuredModel: model ?? 'native-default', cwd, nativeSessionId: connection?.nativeSessionId, check: 'Fresh native session; supplied synthetic PNG; tools discouraged by instructions and approval requests denied. Answer must be manually compared with fixture.', imageBytes: size, approvalsDenied, toolEvents: events.filter(event => event.type === 'tool').length, failure, observed: events.filter(event => event.type === 'ready').map(event => ({ model: event.data?.model, provider: event.data?.provider })), answer: events.filter(event => event.type === 'message').map(event => event.text).filter(Boolean), results: results.map(event => ({ text: event.text, isError: event.data?.isError, interrupted: event.data?.interrupted })), errors: events.filter(event => event.type === 'error').map(event => event.text), usage: events.filter(event => event.type === 'usage').map(event => event.data) };
  await writeFile(resolve(out), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report));
  if (failure || report.errors.length || results.some(event => event.data?.isError === true)) process.exitCode = 1;
}
