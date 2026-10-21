// Real browser + built HTTP service, with an isolated database and simulated runtime.
// No native Agent, live project, or production message is touched.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildApp } from '../dist/server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, '.workbench', 'composer-validation', randomUUID());
await mkdir(evidence, { recursive: true });
const sent = [], interrupts = [], requests = [], pageErrors = [];
let emit, connectCount = 0, failInterrupt = false;
const adapter = {
  kind: 'codex',
  async discover() { return { kind: this.kind, available: true, detail: '隔离验收模拟执行器', capabilities: { steer: false, interrupt: true, resume: true, approvals: true } }; },
  async listModels() { return { runtime: this.kind, models: [{ id: 'fixture-model', name: '验收模型' }], source: 'isolated-test', status: 'ready', checkedAt: new Date().toISOString(), attemptedAt: new Date().toISOString(), detail: '仅供交互验收，不连接原生工具' }; },
  async connect(_options, callback) {
    connectCount++;
    emit = callback;
    return {
      nativeSessionId: 'composer-test-session', pid: undefined,
      async send(text, messageId) { sent.push({ text, messageId }); },
      async interrupt() {
        interrupts.push(sent.length);
        if (failInterrupt) throw new Error('模拟中断失败，未确认停止');
        // The test explicitly supplies the terminal result after checking no early send.
      },
      async respondApproval() {}, async close() {},
    };
  },
};
const tasks = {
  async validate() {}, async list() { return []; },
  async get() { throw new Error('No task in composer test'); },
  async create() { throw new Error('Unexpected task creation'); },
  async update() { throw new Error('Unexpected task update'); },
};
const git = {
  async validate(path) { return path; },
  async createWorktree() { throw new Error('Unexpected writer worktree'); },
  async inspect() { return { commit: 'a'.repeat(40), dirty: false, diff: '' }; },
  async resolveCommit(_project, ref) { return ref; },
};
const app = await buildApp({ dataDir: join(evidence, 'data'), adapters: [adapter], tasks, git, interruptTimeoutMs: 15000, staticRoot: join(root, 'dist', 'public') });
let browser;
const checks = [];
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const project = await app.workbench.createProject({ name: '隔离交互验收', path: evidence });
  const agent = await app.workbench.createAgent({ name: '验收主控', role: 'controller', memberKind: 'controller', permissionMode: 'read-only', projectId: project.id, runtime: 'codex' });
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/agents/${agent.id}/messages`) requests.push(request.postDataJSON());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  const input = page.locator('.composer textarea');
  const action = page.locator('.composer-action');
  await expect(action).toHaveCount(1);
  await expect(action).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '指令发送方式' })).toHaveCount(0);
  await expect(page.locator('.conversation-tools .model-settings-button')).toHaveCount(0);
  await page.locator('.composer .model-settings-button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '检测到的模型', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭对话框' }).click();
  expect(requests).toHaveLength(0);
  checks.push('Model settings opens from composer without submitting; no mode dropdown; one disabled action while idle and empty');

  await input.fill('第一轮：开始检查');
  await page.getByRole('button', { name: '发送指令', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(interrupts).toHaveLength(0);
  await expect(input).toHaveValue('');
  await expect(action).toHaveAttribute('aria-label', '中断当前执行');
  await page.screenshot({ path: join(evidence, 'running-stop.png') });
  checks.push('Idle button sends directly; running with empty input changes the same action to Stop');

  await input.fill('第二轮：先纠正方向');
  await expect(action).toHaveAttribute('aria-label', '发送并纠正');
  await page.screenshot({ path: join(evidence, 'running-correction.png') });
  await action.click();
  await expect.poll(() => interrupts.length).toBe(1);
  await expect(action).toBeDisabled();
  expect(sent).toHaveLength(1);
  await input.press('Control+Enter');
  expect(requests).toHaveLength(2);
  emit({ type: 'result', data: { interrupted: true } });
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].text).toBe('第二轮：先纠正方向');
  expect(connectCount).toBe(1);
  await expect(input).toHaveValue('');
  checks.push('Correction requests interruption, waits for terminal evidence, then sends once in the same session; keyboard during pending does not duplicate');

  await expect(action).toHaveAttribute('aria-label', '中断当前执行');
  await action.click();
  await expect.poll(() => interrupts.length).toBe(2);
  emit({ type: 'result', data: { interrupted: true } });
  await expect(action).toHaveAttribute('aria-label', '发送指令');
  await expect(action).toBeDisabled();
  expect(sent).toHaveLength(2);
  expect(requests).toHaveLength(2);
  checks.push('Stop-only action interrupts without posting a new message');

  await input.fill('第三轮：快捷键开始');
  await input.press('Control+Enter');
  await expect.poll(() => sent.length).toBe(3);
  await expect(input).toHaveValue('');
  await input.fill('第四轮：快捷键纠正');
  await input.press('Control+Enter');
  await expect.poll(() => interrupts.length).toBe(3);
  expect(sent).toHaveLength(3);
  emit({ type: 'result', data: { interrupted: true } });
  await expect.poll(() => sent.length).toBe(4);
  await expect(input).toHaveValue('');
  expect(sent[3].text).toBe('第四轮：快捷键纠正');
  checks.push('Ctrl+Enter uses identical idle and running correction behavior');

  failInterrupt = true;
  await input.fill('停止未确认时保留这份草稿');
  await action.click();
  await expect(page.getByRole('alert')).toContainText('模拟中断失败');
  await expect(input).toHaveValue('停止未确认时保留这份草稿');
  await expect(action).toHaveAttribute('aria-label', '中断当前执行');
  expect(app.workbench.getAgent(agent.id).state).toBe('unknown');
  const count = requests.length;
  await input.press('Control+Enter');
  expect(requests).toHaveLength(count);
  expect(sent).toHaveLength(4);
  expect(requests.every(request => request.mode === 'interrupt' && request.source === 'human')).toBe(true);
  expect(pageErrors).toEqual([]);
  checks.push('Uncertain stop retains the draft, does not send correction, and unknown state blocks keyboard delivery');
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, messages: sent.length, interruptions: interrupts.length, connections: connectCount, pageErrors, validation: 'Built client + real HTTP service + simulated runtime; isolated state' }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, evidence }, null, 2));
} finally {
  await browser?.close();
  await app.close();
}
