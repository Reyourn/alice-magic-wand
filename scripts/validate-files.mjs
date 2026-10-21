// Real desktop browser, HTTP, SQLite and file extraction; isolated simulated Agent.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../dist/server/index.js';
import { createPptxFixture } from './fixtures/pptx.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, '.workbench', 'file-validation', randomUUID());
await mkdir(evidence, { recursive: true });
const fixture = join(evidence, 'requirements.md');
const contents = '# 文件验收\n\n请检查附件是否到达。唯一标记：FILE-5831。\n';
await writeFile(fixture, contents);
const presentationName = '2022年12月客户运营报告.pptx';
const presentationBytes = await createPptxFixture('PPTX-BROWSER-8624');
const presentationPath = join(evidence, presentationName);
await writeFile(presentationPath, presentationBytes);
const imagePath = join(evidence, 'sample.png');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGMAAAAASUVORK5CYII=', 'base64');
await writeFile(imagePath, png);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sent = [], mutations = [], errors = [], checks = [];
let emit, interrupts = 0, app;
const adapter = {
  kind: 'codex',
  async discover() { return { kind: this.kind, available: true, detail: '隔离文件验收模拟执行器', capabilities: { steer: false, interrupt: true, resume: true, approvals: true } }; },
  async connect(_options, callback) {
    emit = callback;
    return { nativeSessionId: 'file-test-session', async send(text, messageId, images = []) { sent.push({ text, messageId, images }); }, async interrupt() { interrupts++; emit({ type: 'result', data: { interrupted: true } }); }, async respondApproval() {}, async close() {} };
  },
};
const tasks = { async validate() {}, async list() { return []; }, async get() { throw new Error('Unexpected task'); }, async create() { throw new Error('Unexpected task'); }, async update() { throw new Error('Unexpected task'); } };
const git = { async validate(path) { return path; }, async createWorktree() { throw new Error('Unexpected worktree'); }, async inspect() { return { commit: 'a'.repeat(40), dirty: false, diff: '' }; }, async resolveCommit(_p, ref) { return ref; } };
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  app = await buildApp({ dataDir: join(evidence, 'data'), adapters: [adapter], tasks, git, staticRoot: join(root, 'dist', 'public') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const project = await app.workbench.createProject({ name: '文件交互验收', path: evidence });
  await app.workbench.createAgent({ name: '附件验收主控', role: 'controller', memberKind: 'controller', projectId: project.id, runtime: 'codex', permissionMode: 'read-only' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(new URL(request.url()).pathname); });
  await page.goto(base);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  const input = page.locator('.composer textarea'), files = page.getByLabel('选择附件', { exact: true });
  await files.setInputFiles([presentationPath, imagePath]);
  await expect(page.getByTestId('composer-file')).toHaveCount(1);
  await expect(page.getByTestId('composer-images').locator('img')).toHaveCount(1);
  await expect(page.getByTestId('composer-file')).toContainText(presentationName);
  expect(mutations).toHaveLength(0);
  await page.screenshot({ path: join(evidence, 'mixed-draft.png') });
  await page.locator('.composer-action').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].text).toContain('PPTX-BROWSER-8624'); expect(sent[0].images).toHaveLength(1);
  expect(sent[0].text).toContain('客户总数'); expect(sent[0].text).toContain('2689'); expect(sent[0].text).toContain('NOTE-4716');
  expect(sent[0].text).toContain('SLIDE2-9057');
  expect(sent[0].text.indexOf('PPTX-BROWSER-8624')).toBeLessThan(sent[0].text.indexOf('SLIDE2-9057'));
  expect(digest(await readFile(sent[0].images[0].path))).toBe(digest(png));
  await expect(page.getByTestId('composer-file')).toHaveCount(0);
  await expect(page.getByTestId('message-file')).toHaveCount(1);
  await expect(page.getByTestId('message-file')).toContainText('已提取文字');
  await expect(page.getByTestId('message-images').locator('img')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: `下载附件：${presentationName}`, exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(presentationName);
  expect(await readFile(await download.path())).toEqual(presentationBytes);
  checks.push('Chinese-named PPTX and image preview locally; attachment-only send delivers slide text, Chinese table cells and notes, preserves image bytes and downloads byte-identical PPTX');

  await input.evaluate(element => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['export const code = "CODE-9264";'], 'sample.ts', { type: '' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByTestId('composer-file')).toContainText('sample.ts');
  await input.press('Control+Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].text).toContain('CODE-9264');expect(sent[1].images).toEqual([]);expect(interrupts).toBe(1);
  await files.setInputFiles(fixture);
  await page.getByRole('button', { name: '移除附件：requirements.md', exact: true }).click();
  await expect(page.getByTestId('composer-file')).toHaveCount(0);
  checks.push('Dropped code with empty browser MIME sends without typed text; correcting an active turn interrupts it; file removal works');

  await files.setInputFiles(fixture);
  await input.fill('失败后保留文件与文字');
  const uploadsBefore = mutations.filter(path => path.endsWith('/attachments')).length;
  await page.route('**/api/agents/*/messages', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '模拟发送被拒绝' }) }));
  await page.locator('.composer-action').click();
  await expect(page.getByRole('alert').filter({ hasText: '模拟发送被拒绝' }).first()).toBeVisible();
  await expect(input).toHaveValue('失败后保留文件与文字');
  await expect(page.getByTestId('composer-file')).toHaveCount(1);
  await expect(page.getByTestId('composer-file')).toContainText(/文字|字符|文本/);
  expect(mutations.filter(path => path.endsWith('/attachments'))).toHaveLength(uploadsBefore + 1);
  await page.unroute('**/api/agents/*/messages');
  await page.locator('.composer-action').click();
  await expect.poll(() => sent.length).toBe(3);
  expect(mutations.filter(path => path.endsWith('/attachments'))).toHaveLength(uploadsBefore + 1);
  await expect(page.getByTestId('composer-file')).toHaveCount(0);
  await expect(input).toHaveValue('');
  await page.reload();
  await expect(page.getByTestId('message-file')).toHaveCount(3);
  await expect(page.getByTestId('message-images').locator('img')).toHaveCount(1);
  await page.screenshot({ path: join(evidence, 'file-history.png') });
  checks.push('Failed message retains text, file and extraction result; retry reuses uploaded ID; file history survives reload');

  await input.evaluate((element, file) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(file.base64), value => value.charCodeAt(0))], file.name, { type: '' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name: presentationName, base64: presentationBytes.toString('base64') });
  await expect(page.getByTestId('composer-file')).toContainText(presentationName);
  await input.press('Control+Enter');
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[3].text).toContain('PPTX-BROWSER-8624'); expect(sent[3].images).toEqual([]);
  await expect(page.getByTestId('message-file')).toHaveCount(4);
  checks.push('Chinese-named PPTX dropped with empty MIME sends successfully and appears as a downloadable history attachment');

  const badFile = { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') };
  await files.setInputFiles(badFile);
  const sendsBefore = sent.length;
  await page.locator('.composer-action').click();
  await expect(page.getByRole('alert').filter({ hasText: /PDF|文件/ }).first()).toBeVisible();
  await expect(page.getByTestId('composer-file')).toContainText('broken.pdf');
  expect(sent.length).toBe(sendsBefore);
  await page.getByRole('button', { name: '移除附件：broken.pdf', exact: true }).click();
  checks.push('Invalid document produces a visible upload error and remains removable in the draft without sending a message');

  await page.goto(`${base}/universe.html`);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  const beforePreview = mutations.length;
  await page.getByLabel('选择附件', { exact: true }).setInputFiles(fixture);
  await page.locator('.composer-action').click();
  await expect(page.getByRole('alert').filter({ hasText: '只读外观预览' }).first()).toBeVisible();
  await expect(page.getByTestId('composer-file')).toHaveCount(1);
  expect(mutations.length).toBe(beforePreview);expect(errors).toEqual([]);
  checks.push('Read-only preview permits local selection but prevents upload and message submission');
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, errors, nativeRuntime: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, evidence }, null, 2));
} finally { await browser.close(); await app?.close(); }
