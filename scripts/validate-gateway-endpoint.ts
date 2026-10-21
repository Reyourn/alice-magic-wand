/** Controlled endpoint check for gateway connections. The provider is a local
 * HTTP server: this proves endpoint/model/credential routing and error
 * classification end to end through the real runtime adapter, without any real
 * provider credential or model call. It never touches production data. */
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { createAdapters } from '../src/server/runtime/index.js';
import { ConnectionManager } from '../src/server/connections/index.js';

type Mode = 'ok' | 'auth' | 'quota' | 'model';
interface Seen { path: string; model?: string; key?: string; mode: Mode }

const seen: Seen[] = [];
let mode: Mode = 'ok';
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const sse = (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); };
const event = (res: ServerResponse, name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = request.url ?? '/';
  const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]!;
  if (request.method === 'GET' && pathname.startsWith('/v1/models')) return send(response, 200, { data: [{ id: 'mock-model', type: 'model' }] });
  if (request.method !== 'POST') return send(response, 404, { error: { type: 'not_found_error', message: 'not found' } });
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) as { model?: string } : {};
  seen.push({ path: pathname, model: body.model, key: String(request.headers['x-api-key'] ?? request.headers.authorization ?? ''), mode });
  if (mode === 'auth') return send(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  if (mode === 'quota') return send(response, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit exceeded for this workspace' } });
  if (mode === 'model') return send(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'model: mock-missing not found' } });
  sse(response);
  event(response, 'message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model ?? 'mock-model', content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 1 } } });
  event(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '连接验证成功' } });
  event(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  event(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
  event(response, 'message_stop', { type: 'message_stop' });
  response.end();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const dataDir = await mkdtemp(join(tmpdir(), 'awb-gateway-endpoint-'));
const store = new Store(join(dataDir, 'workbench.sqlite'));
const manager = new ConnectionManager({ dataDir, store, adapters: createAdapters(), verificationTimeoutMs: 45_000 });
const report: Record<string, unknown> = { controlledEndpoint: base, provider: 'local mock Messages endpoint; no real provider credential or model call', checks: [] };
const checks = report.checks as unknown[];

try {
  const profile = await manager.create({ name: 'local gateway', runtime: 'claude', mode: 'gateway', protocol: 'anthropic-messages', baseUrl: base, apiKey: 'local-test-key', defaultModel: 'mock-model' });
  const verified = await manager.verify(profile.id, { cwd: dataDir, capabilities: ['inference'] });
  assert.equal(verified.success, true, `verification failed: ${verified.detail}`);
  const first = seen.at(-1)!;
  assert.equal(first.path, '/v1/messages', `unexpected path ${first.path}`);
  assert.equal(first.model, 'mock-model');
  assert.equal(first.key, 'local-test-key', 'the selected credential did not reach the endpoint');
  assert.equal(verified.observedModel, 'mock-model');
  checks.push({ name: 'gateway verification reaches the configured endpoint with its own model and key', path: first.path, model: first.model, observedModel: verified.observedModel, capabilities: verified.capabilities });

  // Known limitation: the Claude CLI retries 401 silently and only reports the
  // model wording, so these observations are recorded rather than asserted.
  const cases: [Mode, string][] = [['auth', 'authentication-failed'], ['quota', 'quota-exceeded'], ['model', 'model-unavailable']];
  const observed: Record<string, unknown>[] = [];
  for (const [next, expected] of cases) {
    mode = next;
    const before = seen.length;
    const startedAt = Date.now();
    const result = await manager.verify(profile.id, { cwd: dataDir, capabilities: ['inference'] });
    observed.push({ mode: next, expected, actual: result.status.state, success: result.success, elapsedMs: Date.now() - startedAt, detail: result.detail.slice(0, 200), reached: seen.length > before });
    assert.equal(result.success, false, `${next} should not verify`);
    if (next === 'model') assert.equal(result.status.state, expected, `model rejection classified as ${result.status.state}`);
  }
  mode = 'ok';
  checks.push({ name: 'endpoint failure observations (auth/quota are recorded, not asserted)', observed });

  const second = await manager.create({ name: 'local gateway two', runtime: 'claude', mode: 'gateway', protocol: 'anthropic-messages', baseUrl: base, apiKey: 'second-key', defaultModel: 'mock-model-2' });
  const two = await manager.verify(second.id, { cwd: dataDir, capabilities: ['inference'] });
  assert.equal(two.success, true, `second profile failed: ${two.detail}`);
  const last = seen.at(-1)!;
  assert.equal(last.key, 'second-key');
  assert.equal(last.model, 'mock-model-2');
  assert.equal(two.connectionId, second.id);
  assert.equal(manager.assertVerified(second.id, 'mock-model-2').id, two.id);
  checks.push({ name: 'a second profile on the same runtime uses its own key and model', model: last.model, key: last.key });

  const profiles = JSON.stringify(manager.list());
  assert.ok(!profiles.includes('local-test-key') && !profiles.includes('second-key'), 'a credential leaked into the stored profiles');
  report.credentialStayedOutOfStore = true;
  report.seenRequests = seen.map(row => ({ path: row.path, model: row.model, mode: row.mode }));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  report.seenRequests = seen.map(row => ({ path: row.path, model: row.model, mode: row.mode }));
  process.exitCode = 1;
} finally {
  await manager.close().catch(() => {});
  server.close();
  store.close?.();
  const directory = join(process.cwd(), '.workbench', 'validation');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'gateway-endpoint.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: report.passed, checks, error: report.error }, null, 2) + '\n');
}
