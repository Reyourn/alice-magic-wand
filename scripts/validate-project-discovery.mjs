// Built browser + HTTP service + real temporary Git repositories, with a fake task repository.
// Never registers production projects or invokes native Agents.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildApp } from '../dist/server/index.js';
import { runCommand } from '../dist/server/repositories.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, '.workbench', 'project-discovery-validation', randomUUID());
const workspace = join(evidence, 'workspace');
const repo = join(workspace, 'sample-project');
const manual = join(evidence, 'manual-project');
const ordinary = join(workspace, 'ordinary-folder');
const empty = join(workspace, 'empty-repo');
const codexStateFile = join(evidence, 'codex-state.json');
await mkdir(ordinary, { recursive: true });
for (const path of [repo, manual, empty]) {
  await mkdir(path, { recursive: true });
  await runCommand('git', ['init', '-b', 'main'], path);
  if (path !== empty) {
    await writeFile(join(path, 'README.md'), '# Isolated browser fixture\n');
    await runCommand('git', ['add', 'README.md'], path);
    await runCommand('git', ['-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture'], path);
  }
}
const codexContents = JSON.stringify({ 'local-projects': {
  sample: { name: '发现项目示例', rootPaths: [repo] },
  ordinary: { name: '普通文件夹示例', rootPaths: [ordinary] },
  empty: { name: '尚无提交示例', rootPaths: [empty] },
} });
await writeFile(codexStateFile, codexContents);
const validations = [], mutations = [], errors = [], checks = [];
const tasks = {
  async validate(path, initialize) { validations.push({ path, initialize }); },
  async list() { return []; },
  async get() { throw new Error('Unexpected task read'); },
  async create() { throw new Error('Unexpected task creation'); },
  async update() { throw new Error('Unexpected task update'); },
};
const app = await buildApp({ dataDir: join(evidence, 'data'), adapters: [], tasks,
  projectDiscovery: { codexStateFile, cwd: workspace, workspaceRoots: [workspace] },
  staticRoot: join(root, 'dist', 'public') });
let browser;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(new URL(request.url()).pathname); });
  await page.goto(base);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('发现项目示例', { exact: true })).toBeVisible();
  await expect(dialog.getByText('普通文件夹示例', { exact: true })).toBeVisible();
  await expect(dialog.getByText('尚无提交示例', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: '普通文件夹示例', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: '尚无提交示例', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '接入项目', exact: true })).toBeDisabled();
  expect(app.workbench.projects()).toHaveLength(0);
  expect(validations).toHaveLength(0);
  expect(mutations).toHaveLength(0);
  expect(await readFile(codexStateFile, 'utf8')).toBe(codexContents);
  expect(await access(join(repo, '.beads')).then(() => true, () => false)).toBe(false);
  checks.push('Opening automatically discovers native saved projects and shallow workspace roots without registering, initializing Beads or changing native metadata');
  await page.screenshot({ path: join(evidence, 'candidates.png') });

  await dialog.getByRole('radio', { name: /发现项目示例/ }).check();
  await expect(dialog.getByRole('textbox', { name: '项目名称', exact: true })).toHaveValue('发现项目示例');
  await dialog.getByRole('button', { name: '接入项目', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => app.workbench.projects().length).toBe(1);
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toHaveValue(app.workbench.projects()[0].id);
  expect(validations).toEqual([{ path: repo, initialize: true }]);
  checks.push('Select and import uses the existing registration path and switches to the imported project');

  await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
  await expect(dialog.getByText('已接入', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /发现项目示例/ })).toBeDisabled();
  await dialog.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(dialog.getByText('已接入', { exact: true })).toBeVisible();
  expect(app.workbench.projects()).toHaveLength(1);
  expect(validations).toHaveLength(1);
  checks.push('Reopening and refreshing mark already registered projects and prevent duplicate import');

  await page.route('**/api/projects/discovery', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟发现失败，请手动添加或重试' }) }));
  await dialog.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('模拟发现失败');
  await dialog.getByRole('tab', { name: '手动添加', exact: true }).click();
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('手动路径示例');
  await dialog.getByRole('textbox', { name: '仓库绝对路径', exact: true }).fill(manual);
  await dialog.getByRole('button', { name: '接入项目', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => app.workbench.projects().length).toBe(2);
  const manualProject = app.workbench.projects().find(item => item.path === manual);
  await expect(page.getByRole('combobox', { name: '当前项目', exact: true })).toHaveValue(manualProject.id);
  checks.push('Discovery failure keeps manual absolute path fallback usable; newly registered project becomes selected');
  await page.unroute('**/api/projects/discovery');

  await page.goto(`${base}/universe.html`);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加项目', exact: true }).first().click();
  await dialog.getByRole('tab', { name: '手动添加', exact: true }).click();
  await dialog.getByRole('textbox', { name: '项目名称', exact: true }).fill('只读预览不会注册');
  await dialog.getByRole('textbox', { name: '仓库绝对路径', exact: true }).fill(join(evidence, 'preview-only'));
  const beforePreview = mutations.length;
  await dialog.getByRole('button', { name: '接入项目', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('只读外观预览');
  expect(mutations.length).toBe(beforePreview);
  expect(app.workbench.projects()).toHaveLength(2);
  expect(errors).toEqual([]);
  checks.push('Read-only preview blocks import without clearing the form or issuing a mutation');
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, errors, mutations, validation: 'Real browser, HTTP and temporary Git; simulated Beads repository; no native Agent' }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, evidence }, null, 2));
} finally { await browser?.close(); await app.close(); }
