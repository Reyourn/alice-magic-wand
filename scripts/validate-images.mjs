// Real browser, HTTP, SQLite and image bytes with an isolated simulated Agent.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../dist/server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, '.workbench', 'image-validation', randomUUID());
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const fixture = join(evidence, 'sample.png');
await page.setContent('<body style="margin:0;background:white"><div id="fixture" style="width:480px;height:300px;position:relative;background:white"><div style="position:absolute;top:35px;left:50px;width:0;height:0;border-left:65px solid transparent;border-right:65px solid transparent;border-bottom:110px solid #df2424"></div><div style="position:absolute;left:285px;top:40px;width:105px;height:105px;border-radius:50%;background:#1565df"></div><div style="position:absolute;top:175px;width:100%;text-align:center;font:70px Arial;color:#111">8642</div></div></body>');
await page.locator('#fixture').screenshot({ path: fixture });
const png = await readFile(fixture), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sent = [], mutations = [], errors = [], checks = [];
let emit, interrupts = 0, app;
const adapter = {
  kind: 'codex',
  async discover() { return { kind: this.kind, available: true, detail: '隔离图片验收模拟执行器', capabilities: { steer: false, interrupt: true, resume: true, approvals: true } }; },
  async connect(_options, callback) {
    emit = callback;
    return { nativeSessionId: 'image-test-session', async send(text, messageId, images = []) { sent.push({ text, messageId, images }); }, async interrupt() { interrupts++; emit({ type: 'result', data: { interrupted: true } }); }, async respondApproval() {}, async close() {} };
  },
};
const tasks = { async validate() {}, async list() { return []; }, async get() { throw new Error('Unexpected task'); }, async create() { throw new Error('Unexpected task'); }, async update() { throw new Error('Unexpected task'); } };
const git = { async validate(path) { return path; }, async createWorktree() { throw new Error('Unexpected worktree'); }, async inspect() { return { commit: 'a'.repeat(40), dirty: false, diff: '' }; }, async resolveCommit(_p, ref) { return ref; } };
try {
  app = await buildApp({ dataDir: join(evidence, 'data'), adapters: [adapter], tasks, git, staticRoot: join(root, 'dist', 'public') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const project = await app.workbench.createProject({ name: '图片交互验收', path: evidence });
  await app.workbench.createAgent({ name: '识图验收主控', role: 'controller', memberKind: 'controller', projectId: project.id, runtime: 'codex', permissionMode: 'read-only' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(new URL(request.url()).pathname); });
  await page.goto(base);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  const input = page.locator('.composer textarea'), files = page.getByLabel('选择附件', { exact: true }), draft = page.getByTestId('composer-images');
  await files.setInputFiles(fixture);
  await expect(draft.locator('img')).toHaveCount(1);
  expect(mutations).toHaveLength(0);
  await input.fill('请识别图片中的图形和数字。');
  await page.screenshot({ path: join(evidence, 'draft.png') });
  await page.locator('.composer-action').click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(input).toHaveValue('');
  await expect(draft.locator('img')).toHaveCount(0);
  expect(sent[0].images).toHaveLength(1);
  expect(digest(await readFile(sent[0].images[0].path))).toBe(digest(png));
  await expect(page.getByTestId('message-images').locator('img')).toHaveCount(1);
  await expect.poll(() => page.getByTestId('message-images').locator('img').first().evaluate(img => img.naturalWidth)).toBe(480);
  checks.push('File selection previews locally; image and text are persisted and delivered as the same bytes; history loads the actual attachment');

  const transferImage = async type => input.evaluate((element, { type, data }) => {
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], `${type}.png`, { type: 'image/png' }));
    const event = type === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(event);
  }, { type, data: png.toString('base64') });
  await transferImage('paste');
  await expect(draft.locator('img')).toHaveCount(1);
  await input.press('Control+Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].images).toHaveLength(1); expect(interrupts).toBe(1);
  await expect(draft.locator('img')).toHaveCount(0);
  await transferImage('drop');
  await expect(draft.locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: '移除图片：drop.png', exact: true }).click();
  await expect(draft.locator('img')).toHaveCount(0);
  checks.push('Pasted image-only correction uses Ctrl+Enter and interrupts the old turn; drag-drop and removal work');

  await files.setInputFiles(fixture);
  await input.fill('失败后保留图片与文字');
  const uploadsBefore = mutations.filter(path => path.endsWith('/attachments')).length;
  await page.route('**/api/agents/*/messages', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '模拟发送被拒绝' }) }));
  await page.locator('.composer-action').click();
  await expect(page.getByRole('alert').filter({ hasText: '模拟发送被拒绝' }).first()).toBeVisible();
  await expect(input).toHaveValue('失败后保留图片与文字');
  await expect(draft.locator('img')).toHaveCount(1);
  expect(mutations.filter(path => path.endsWith('/attachments'))).toHaveLength(uploadsBefore + 1);
  await page.unroute('**/api/agents/*/messages');
  await page.locator('.composer-action').click();
  await expect.poll(() => sent.length).toBe(3);
  expect(mutations.filter(path => path.endsWith('/attachments'))).toHaveLength(uploadsBefore + 1);
  await expect(draft.locator('img')).toHaveCount(0);
  await expect(input).toHaveValue('');
  await page.reload();
  await expect(page.getByTestId('message-images').locator('img')).toHaveCount(3);
  await page.screenshot({ path: join(evidence, 'history.png') });
  checks.push('Failed message keeps draft and uploaded image; retry reuses the attachment; history survives reload');

  await page.goto(`${base}/universe.html`);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  const beforePreview = mutations.length;
  await page.getByLabel('选择附件', { exact: true }).setInputFiles(fixture);
  await page.locator('.composer-action').click();
  await expect(page.getByRole('alert').filter({ hasText: '只读外观预览' }).first()).toBeVisible();
  await expect(page.getByTestId('composer-images').locator('img')).toHaveCount(1);
  expect(mutations.length).toBe(beforePreview);
  expect(errors).toEqual([]);
  checks.push('Read-only preview blocks image upload and sending while keeping the local preview');
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, errors, fixture, nativeRuntime: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, evidence, fixture }, null, 2));
} finally { await browser.close(); await app?.close(); }
