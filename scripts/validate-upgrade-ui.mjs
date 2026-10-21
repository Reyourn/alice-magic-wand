// Real desktop browser + HTTP + SQLite + file snapshots + local MCP.
// Model transport and Beads repository are isolated simulations; no provider billing or native login mutation.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { extname, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildArg = process.argv.find(value => value.startsWith('--build-dir='))?.slice('--build-dir='.length);
const buildDir = resolve(root, buildArg || 'dist');
const { buildApp } = await import(pathToFileURL(join(buildDir, 'server', 'index.js')).href);
const { runCommand } = await import(pathToFileURL(join(buildDir, 'server', 'repositories.js')).href);
const evidence = join(root, '.workbench', 'upgrade-ui-validation', randomUUID());
const office = join(evidence, 'source');
await mkdir(office, { recursive: true });
const source = join(office, '客户数据.csv');
await writeFile(source, '客户,金额\n00123,12\n00456,18\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(await readFile(source));
const checks = [], errors = [], sends = [], requests = [], previewRequests = [];
const taskRows = new Map();
const tasks = {
  async validate() {},
  async list(project) { return [...taskRows.values()].filter(task => task.projectId === project.id); },
  async get(project, id) { const value = taskRows.get(`${project.id}:${id}`); if (!value) throw new Error('Task not found'); return value; },
  async findByExternalRef(project, ref) { return [...taskRows.values()].find(task => task.projectId === project.id && task.externalRef === ref); },
  async create(project, input) { const task = { ...input, id: input.id || randomUUID(), projectId: project.id, description: input.description || '', acceptance: input.acceptance || '', dependencies: input.dependencies || [], status: 'open' }; taskRows.set(`${project.id}:${task.id}`, task); return task; },
  async update(project, id, input) { const task = { ...await this.get(project, id), ...input }; taskRows.set(`${project.id}:${id}`, task); return task; },
  async replaceDefinition(project, id, input) { return this.update(project, id, input); },
};
let app, deliveryServer;
function simulatedAdapter(kind) {
  return {
    kind,
    async discover() { return { kind, available: true, version: 'simulated-ui-1', detail: '隔离浏览器验收模拟执行层', capabilities: { steer: false, interrupt: true, resume: true, approvals: true } }; },
    async listModels() { return { runtime: kind, models: [{ id: 'ui-model', name: 'UI 模拟模型' }], source: 'isolated test adapter', status: 'ready', checkedAt: new Date().toISOString(), detail: '仅用于隔离交互验收，非真实供应商模型目录' }; },
    async connect(options, emit) {
      let closed = false;
      return {
        nativeSessionId: `ui-${randomUUID()}`,
        async send(text, messageId) {
          sends.push({ kind, agentId: options.agentId, messageId, text });
          emit({ type: 'ready', data: { model: 'ui-model', provider: 'simulated-ui' } });
          let output = '已收到当前交接信息。';
          if (options.agentId.startsWith('verify-')) {
            const config = options.mcpServers?.workbench_probe;
            if (config) {
              const client = new Client({ name: 'ui-simulated-agent', version: '1' });
              await client.connect(new StdioClientTransport({ command: config.command, args: config.args, stderr: 'pipe' }));
              try { await client.callTool({ name: 'connection_probe', arguments: {} }); } finally { await client.close(); }
            }
            output = '连接验证成功（模拟 Agent，实际本机 MCP 探针）。';
          } else {
            const message = app.workbench.store.get('messages', messageId);
            const round = message?.roundId && app.workbench.store.get('execution_rounds', message.roundId);
            if (round) {
              const node = app.workbench.workflows.getDispatchContext(app.workbench.getAgent(options.agentId).projectId, round.taskId)?.node;
              if (node?.kind === 'review') {
                const bundle = app.workbench.store.get('artifact_bundles', round.sourceBundleId);
                output = `WORKBENCH_REVIEW_RESULT: ${JSON.stringify({ version: bundle.version, result: 'passed', conclusion: '已核对固定候选中的合计为 30，输出可读取。UI 模拟审查，不代表真实模型审查。' })}`;
              } else if (app.workbench.getProject(app.workbench.getAgent(options.agentId).projectId).kind === 'code') {
                await writeFile(join(options.cwd, 'answer.mjs'), 'export const answer = 42;\n');
                await runCommand('git', ['add', 'answer.mjs'], options.cwd);
                await runCommand('git', ['-c', 'user.name=UI Fixture', '-c', 'user.email=ui-fixture@localhost', 'commit', '-m', 'Simulated agent produces real bounded code candidate'], options.cwd);
                output = 'UI simulated agent produced and committed answer=42 in the real isolated Git worktree.';
              } else {
                await mkdir(join(options.cwd, 'outputs'), { recursive: true });
                await writeFile(join(options.cwd, 'outputs', '分析结果.csv'), '项目,结果\n总额,30\n编号,000123\n');
                await writeFile(join(options.cwd, 'outputs', '报告.md'), '# 客户报告\n\n| 项目 | 结果 |\n| --- | --- |\n| 总额 | 30 |\n\n输入原件未覆盖。');
                await writeFile(join(options.cwd, 'outputs', '流程.mmd'), 'flowchart LR\n  A[固定输入] --> B[分析 30]\n  B --> C[独立复核]');
                for (const folder of ['assets/red', 'assets/blue']) await mkdir(join(options.cwd, 'outputs', folder), { recursive: true });
                await writeFile(join(options.cwd, 'outputs', '原型.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><title>交互原型</title><link rel="stylesheet" href="assets/style.css"><button id="total">加载交互…</button><img alt="红色图标" src="assets/red/icon.svg"><img alt="蓝色图标" src="assets/blue/icon.svg"><script type="module" src="assets/app.js"></script></html>');
                await writeFile(join(options.cwd, 'outputs', 'assets/style.css'), 'button { color: rgb(37, 99, 235); } img { width: 32px; height: 32px; }');
                await writeFile(join(options.cwd, 'outputs', 'assets/value.js'), 'export const total = 30;');
                await writeFile(join(options.cwd, 'outputs', 'assets/app.js'), "import { total } from './value.js'; const button = document.querySelector('#total'); button.textContent = `查看合计 ${total}`; button.addEventListener('click', () => { button.textContent = '已点击'; });");
                for (const color of ['red', 'blue']) await writeFile(join(options.cwd, 'outputs', `assets/${color}/icon.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`);
                output = 'UI-OFFICE-30：固定输入分析完成，合计 30。文件已生成在 outputs。';
              }
            }
          }
          emit({ type: 'delta', text: output });
          // One working connection deliberately has no metering; do not invent a zero or reject inference.
          if (!(kind === 'claude' && options.agentId.startsWith('verify-'))) emit({ type: 'usage', data: { source: 'ui-simulation', scope: 'turn', totalTokens: 50, inputTokens: 40, outputTokens: 10 } });
          setTimeout(() => { if (!closed) emit({ type: 'result', text: output, data: { status: 'completed' } }); }, 30);
        },
        async interrupt() { emit({ type: 'result', data: { interrupted: true } }); }, async respondApproval() {}, async close() { closed = true; },
      };
    },
  };
}
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
try {
  app = await buildApp({ dataDir: join(evidence, 'data'), adapters: ['codex', 'claude', 'workbuddy'].map(simulatedAdapter), tasks, staticRoot: join(buildDir, 'public') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const project = await app.workbench.createProject({ name: '办公升级浏览器验收', path: office, kind: 'office' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') requests.push({ path: new URL(request.url()).pathname, key: request.headers()['idempotency-key'] }); });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/p/')) previewRequests.push({ path: new URL(request.url()).pathname, hasControlToken: !!request.headers()['x-workbench-token'] }); });
  await page.goto(base);
  await expect(page.getByText('本机已连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '补齐核心团队', exact: true }).click();
  await expect(page.locator('.agent-item')).toHaveCount(3);
  await page.getByRole('button', { name: '补齐核心团队', exact: true }).click();
  await expect(page.locator('.agent-item')).toHaveCount(3);
  expect(sends).toHaveLength(0);
  checks.push('Core team creates three distinct role/runtime members; repeat click preserves the same team and does not infer model calls');

  await page.getByRole('button', { name: '设置与接入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '接入与认证', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '读取模型目录', exact: true }).click();
  await expect(page.getByLabel('检测到的模型')).toContainText('UI 模拟模型');
  expect(sends).toHaveLength(0);
  await page.getByRole('button', { name: '打开原生登录', exact: true }).click();
  await expect(page.getByLabel('共享原生账号变更')).toContainText('主控');
  await page.getByLabel('共享原生账号变更').getByRole('button', { name: '取消', exact: true }).click();
  expect(requests.filter(request => request.path.endsWith('/login'))).toHaveLength(0);
  for (const runtime of ['Codex', 'Claude Code', 'WorkBuddy']) {
    await page.getByRole('navigation', { name: '连接配置' }).getByRole('button').filter({ hasText: `${runtime} · 沿用本机配置` }).click();
    await page.getByRole('button', { name: '发起真实调用验证', exact: true }).click();
    await expect(page.locator('.verification-receipt')).toContainText('验证成功');
    if (runtime === 'Claude Code') await expect(page.locator('.verification-receipt')).toContainText('未提供用量回执；不影响已验证的执行能力');
  }
  expect(sends.filter(send => send.agentId.startsWith('verify-'))).toHaveLength(3);
  await page.screenshot({ path: join(evidence, 'connections-1440.png') });
  checks.push('Model metadata/refresh are inference-free; explicit verification uses simulated models and actual local MCP; shared native impact/cancel sends no login mutation');

  let loginState = 'unknown', loginRecovery = 'retry-stop';
  await page.route('**/api/connections/native-claude/login', route => route.fulfill({ json: { id: 'ui-login-only', connectionId: 'native-claude', runtime: 'claude', state: loginState, recoveryAction: loginRecovery, method: 'native-terminal', detail: 'UI 模拟停止状态；没有启动原生登录进程。', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }));
  await page.route('**/api/connections/native-claude/login/cancel', route => { loginState = 'cancelled'; return route.fulfill({ json: { id: 'ui-login-only', connectionId: 'native-claude', runtime: 'claude', state: loginState, method: 'native-terminal', detail: '模拟登录停止已确认。' } }); });
  await page.getByRole('navigation', { name: '连接配置' }).getByRole('button').filter({ hasText: 'Claude Code · 沿用本机配置' }).click();
  await expect(page.getByText('登录：停止待核对', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发起真实调用验证', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '打开原生登录', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重新核对并停止登录', exact: true }).click();
  await expect(page.getByText('登录：已取消', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发起真实调用验证', exact: true })).toBeEnabled();
  checks.push('UI-simulated uncertain native login blocks verification and another login; confirmed cancellation restores controls. A connection with actual local tool output but simulated inference and missing usage still verifies, with metering unknown');
  // A root PID that vanished without a tree receipt must not offer endless retry.
  loginState = 'unknown'; loginRecovery = 'restart-reconcile';
  for (const runtime of ['WorkBuddy', 'Claude Code']) await page.getByRole('navigation', { name: '连接配置' }).getByRole('button').filter({ hasText: `${runtime} · 沿用本机配置` }).click();
  await expect(page.getByRole('heading', { name: '需要重启后核对', exact: true })).toBeVisible();
  await expect(page.getByText('受控方式重启工作台后台', { exact: false })).toBeVisible();
  await expect(page.getByText('不代表原生登录成功', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新核对并停止登录', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发起真实调用验证', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '打开原生登录', exact: true })).toBeDisabled();
  await page.screenshot({ path: join(evidence, 'login-restart-reconcile-1440.png') });
  await expect(page.locator('[aria-label="需要重启后核对"] li')).toHaveCount(4);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(page.getByRole('heading', { name: '需要重启后核对', exact: true })).toBeVisible();
  await expect(page.getByText('重新检查认证，再重新发起调用验证', { exact: false })).toBeVisible();
  await expect(page.locator('[aria-label="需要重启后核对"] li')).toHaveCount(4);
  await page.screenshot({ path: join(evidence, 'login-restart-reconcile-1920.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  loginRecovery = 'retry-stop'; loginState = 'unknown';
  await page.unroute('**/api/connections/native-claude/login');
  await page.unroute('**/api/connections/native-claude/login/cancel');
  checks.push('A vanished root PID without a tree receipt renders the controlled-restart and human-check steps, keeps the shared gate closed and offers no further retry');
  let recoveryPending = true, recoverySubmissions = 0;
  await page.route('**/api/connections/native-claude/login', route => route.fulfill({ json: { id: 'ui-recovered-login', connectionId: 'native-claude', runtime: 'claude', state: recoveryPending ? 'unknown' : 'resolved', recoveryRequired: recoveryPending, method: 'native-terminal', detail: 'UI 模拟服务重启后的登录恢复，无实际原生进程。' } }));
  await page.route('**/api/connections/native-claude/login/reconcile', route => {
    const input = route.request().postDataJSON();
    expect(input.confirmedStopped).toBe(true); expect(input.reason).toBe('UI 隔离测试：已核对示例登录进程退出。');
    recoveryPending = false; recoverySubmissions++;
    return route.fulfill({ json: { id: 'ui-recovered-login', connectionId: 'native-claude', runtime: 'claude', state: 'resolved', method: 'native-terminal', detail: '按人工核对解除，未验证原生认证或调用。' } });
  });
  for (const runtime of ['WorkBuddy', 'Claude Code']) await page.getByRole('navigation', { name: '连接配置' }).getByRole('button').filter({ hasText: `${runtime} · 沿用本机配置` }).click();
  await expect(page.getByRole('heading', { name: '恢复中断的原生流程', exact: true })).toBeVisible();
  const recoverButton = page.getByRole('button', { name: '记录核对并解除原生调用阻塞', exact: true });
  await expect(recoverButton).toBeDisabled();
  await page.getByLabel('原生流程恢复核对依据', { exact: true }).fill('UI 隔离测试：已核对示例登录进程退出。');
  await expect(recoverButton).toBeDisabled();
  await page.getByRole('checkbox', { name: '我已在原生环境确认旧原生流程及相关进程已结束。', exact: true }).check();
  await recoverButton.click();
  await expect(page.getByText('登录：人工核对已结束', { exact: true })).toBeVisible();
  expect(recoverySubmissions).toBe(1);
  await page.unroute('**/api/connections/native-claude/login');
  await page.unroute('**/api/connections/native-claude/login/reconcile');
  checks.push('UI-simulated restart login recovery requires both recorded evidence and explicit stopped-process confirmation; it resolves a gate without claiming native login or model verification');

  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '成果', exact: true }).click();
  await page.getByText('办公项目输入快照 · 0', { exact: true }).click();
  await page.getByLabel('原始文件绝对路径（每行一个）').fill(source);
  let snapshotDropped = false;
  await page.route(`**/api/projects/${project.id}/input-snapshots`, async route => {
    if (route.request().method() === 'POST' && !snapshotDropped) { snapshotDropped = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '创建输入快照', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '尚不能确认操作结果' })).toBeVisible();
  await page.reload();
  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '成果', exact: true }).click();
  await page.getByText('办公项目输入快照 · 1', { exact: true }).click();
  await page.getByLabel('原始文件绝对路径（每行一个）').fill(source);
  await page.getByRole('button', { name: '创建输入快照', exact: true }).click();
  await expect(page.getByText('输入快照已保存，原文件保持不变。', { exact: true })).toBeVisible();
  await page.unroute(`**/api/projects/${project.id}/input-snapshots`);
  await expect(page.getByText('办公项目输入快照 · 1', { exact: true })).toBeVisible();
  const snapshotRequests = requests.filter(request => request.path === `/api/projects/${project.id}/input-snapshots`);
  expect(snapshotRequests).toHaveLength(2); expect(snapshotRequests[0].key).toBe(snapshotRequests[1].key);
  const input = app.workbench.workflows.office.list(project.id)[0];
  await page.getByRole('button', { name: '核对原文件是否变化', exact: true }).click();
  await expect(page.getByText('原文件与输入快照一致。', { exact: true })).toBeVisible();
  checks.push('Office input snapshot lost receipt survives actual page reload with same persisted operation key and one snapshot; source hashes remain unchanged');

  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '编排', exact: true }).click();
  await page.getByRole('button', { name: '新建计划', exact: true }).click();
  await page.getByLabel('计划名称').fill('客户分析报告交付');
  await page.getByLabel('目标与范围').fill('从固定 CSV 输入分析合计 30，生成报告，独立复核后另存交付。');
  await page.getByRole('button', { name: '生成草稿', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  const workflow = app.workbench.workflows.list(project.id)[0];
  const canvasTransform = () => page.locator('.react-flow__viewport').evaluate(element => getComputedStyle(element).transform);
  const canvasZoom = async () => Number((await canvasTransform()).match(/^matrix\(([^,]+)/)?.[1] ?? '0');
  const settleCanvas = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const expectWholeGraph = async () => {
    await expect(page.locator('.react-flow__node')).toHaveCount(4);
    await expect.poll(() => page.locator('.flow-container').evaluate(container => {
      const area = container.getBoundingClientRect();
      return [...container.querySelectorAll('.react-flow__node')].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width === 0 || rect.left < area.left - 1 || rect.top < area.top - 1 || rect.right > area.right + 1 || rect.bottom > area.bottom + 1;
      }).map(node => node.getAttribute('data-id'));
    }), { message: 'All workflow nodes must fit inside the actual canvas, including when task details are open' }).toEqual([]);
  };
  await expectWholeGraph();
  let nodeSelections = 0;
  const selectNode = async title => { if (nodeSelections++ === 0) await page.locator('.react-flow__node').filter({ has: page.getByText(title, { exact: true }) }).click(); else await page.getByLabel('选择任务节点', { exact: true }).selectOption({ label: title }); await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue(title); };
  await selectNode('分析与整理');
  await page.getByLabel('固定输入引用（每行一个）').fill(input.id);
  let dropped = false;
  await page.route(`**/api/workflows/${workflow.id}/draft`, async route => { if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '尚不能确认操作结果' })).toBeVisible();
  await page.getByRole('button', { name: '保存修订', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存修订', exact: true })).toBeDisabled();
  expect(app.workbench.workflows.get(workflow.id).currentVersion).toBe(2);
  const revisions = requests.filter(request => request.path === `/api/workflows/${workflow.id}/draft`);
  expect(revisions).toHaveLength(2); expect(revisions[0].key).toBe(revisions[1].key);
  await page.unroute(`**/api/workflows/${workflow.id}/draft`);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '自动排列', exact: true }).click();
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存布局', exact: true })).toBeDisabled();
  expect(app.workbench.workflows.get(workflow.id).currentVersion).toBe(2);
  expect(sends.filter(send => !send.agentId.startsWith('verify-'))).toHaveLength(0);
  await expectWholeGraph();
  await page.screenshot({ path: join(evidence, 'canvas-draft-1440.png') });
  await page.getByRole('button', { name: '新建计划', exact: true }).click();
  await page.getByLabel('计划名称').fill('画布切换验收草稿');
  await page.getByLabel('目标与范围').fill('仅检查流程切换与整图展示；不确认、不派发。');
  await page.getByRole('button', { name: '生成草稿', exact: true }).click();
  await expect(page.getByLabel('当前工作流', { exact: true })).not.toHaveValue(workflow.id);
  await expectWholeGraph();
  await page.getByLabel('当前工作流', { exact: true }).selectOption(workflow.id);
  await expect(page.getByLabel('选择任务节点', { exact: true })).toHaveValue('step-1');
  await expectWholeGraph();
  // Switching the arrangement direction immediately updates both the graph and its handles.
  await page.getByLabel('画布排列方向', { exact: true }).selectOption('TB');
  await expectWholeGraph();
  await page.getByLabel('画布排列方向', { exact: true }).selectOption('LR');
  await expectWholeGraph();
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存布局', exact: true })).toBeDisabled();
  expect(app.workbench.workflows.get(workflow.id).currentVersion).toBe(2);
  expect(sends.filter(send => !send.agentId.startsWith('verify-'))).toHaveLength(0);
  checks.push('Canvas creates/editable DAG; lost revision receipt retries same key and creates one version; layout changes do not execute tasks or revise authorization');

  await page.getByRole('button', { name: '确认整份计划', exact: true }).click();
  const waitRound = async (nodeId, state) => { await expect.poll(async () => (await app.workbench.workflows.detail(workflow.id)).nodes.find(node => node.node.id === nodeId)?.round?.state, { timeout: 30000 }).toBe(state); await page.getByRole('button', { name: '刷新编排', exact: true }).click(); };
  await waitRound('step-1', 'candidate');
  await selectNode('分析与整理');
  await page.getByText('执行验收检查', { exact: true }).click();
  await page.getByRole('button', { name: '核对文件哈希', exact: true }).click();
  await expect(page.getByText('文件完整性检查已完成。', { exact: true })).toBeVisible();
  await page.getByText('人工确认 / 例外验收项', { exact: true }).click();
  await page.getByLabel('数据口径和关键数值核对', { exact: true }).check();
  await page.getByLabel('修改要求 / 人工确认理由', { exact: true }).fill('核对输入 12 + 18 = 30，原始编号和原件保留。');
  await page.getByRole('button', { name: '验收当前版本', exact: true }).click();
  await waitRound('step-2', 'candidate');
  await waitRound('review', 'candidate');
  await selectNode('独立审查');
  await page.getByText('执行验收检查', { exact: true }).click();
  await page.getByLabel('验收项', { exact: true }).selectOption('review');
  await expect(page.getByLabel('独立审查回执', { exact: true }).locator('option')).toHaveCount(2);
  await page.getByLabel('独立审查回执', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: '登记独立审查', exact: true }).click();
  await expect(page.getByText('真实审查证据已关联固定版本。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验收当前版本', exact: true }).click();
  await waitRound('review', 'accepted');
  await selectNode('报告生成');
  await page.getByText('执行验收检查', { exact: true }).click();
  await page.getByRole('button', { name: '核对文件哈希', exact: true }).click();
  await expect(page.getByText('文件完整性检查已完成。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验收当前版本', exact: true }).click();
  await waitRound('step-2', 'accepted');
  await selectNode('人工验收');
  await page.getByLabel('修改要求 / 人工确认理由', { exact: true }).fill('已核对全部版本和独立审查，确认文件交付候选。');
  await page.getByRole('button', { name: '确认检查点', exact: true }).click();
  await expect.poll(() => app.workbench.workflows.get(workflow.id).status).toBe('completed');
  expect(app.workbench.workflows.office.checkInputs(input.id).unchanged).toBe(true);
  checks.push('Office workflow executes real isolated files via simulated agents; browser registers exact structured review receipt, checks files, records manual version acceptance and finishes workflow');

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '成果', exact: true }).click();
  let converterAvailable = false;
  await page.route('**/api/previews/converter', route => route.fulfill({ json: { available: converterAvailable, name: 'UI simulated converter status', detail: '仅用于状态显示验收，未进行文档转换。' } }));
  await page.getByRole('button', { name: '重新检测文档转换器' }).click();
  await expect(page.getByText('DOCX / PPTX：内容提取预览与原件下载', { exact: true })).toBeVisible();
  converterAvailable = true;
  await page.getByRole('button', { name: '重新检测文档转换器' }).click();
  await expect(page.getByText('DOCX / PPTX：可生成逐页视觉预览', { exact: true })).toBeVisible();
  await page.unroute('**/api/previews/converter');
  await page.getByRole('button', { name: '重新检测文档转换器' }).click();
  checks.push('Converter availability branches are UI-simulated; actual document visual conversion is not claimed');
  await page.getByLabel('成果工作流').selectOption(workflow.id);
  await expect(page.getByText('文件验收与交付 · 待交付', { exact: true })).toBeVisible();
  await page.getByText('文件验收与交付 · 待交付', { exact: true }).click();
  await page.getByRole('checkbox', { name: '已核对全部当前成果、审查与原始输入，确认另存交付版本。', exact: true }).check();
  await page.getByRole('button', { name: '确认另存文件交付版本', exact: true }).click();
  await expect(page.getByText('文件验收与交付 · 已交付', { exact: true })).toBeVisible();
  expect(hash(await readFile(source))).toBe(originalHash);
  const delivery = app.workbench.store.all('file_deliveries')[0];
  expect(delivery.bundleIds).toHaveLength(2);
  for (const file of delivery.files) expect(hash(await readFile(file.path))).toBe(file.sha256);
  await page.locator('.artifact-file-row').filter({ hasText: '分析结果.csv' }).first().click();
  await expect(page.getByRole('table', { name: 'CSV 数据预览' })).toContainText('000123');
  await page.screenshot({ path: join(evidence, 'office-delivery-1920.png') });
  await page.locator('.artifact-file-row').filter({ hasText: '报告.md' }).first().click();
  await expect(page.locator('.artifact-markdown').getByRole('heading', { name: '客户报告' })).toBeVisible();
  await page.locator('.artifact-file-row').filter({ hasText: '流程.mmd' }).first().click();
  await expect(page.getByRole('img', { name: 'Mermaid 图表预览', exact: true })).toBeVisible();
  await page.locator('.artifact-file-row').filter({ hasText: '原型.html' }).first().click();
  const frame = page.locator('iframe[title^="隔离原型预览"]');
  await expect(frame).toBeVisible();
  expect(new URL(await frame.getAttribute('src')).port).not.toBe(new URL(base).port);
  await expect(frame.contentFrame().getByRole('button', { name: '查看合计 30', exact: true })).toHaveCSS('color', 'rgb(37, 99, 235)');
  for (const color of ['红色', '蓝色']) await expect.poll(() => frame.contentFrame().getByAltText(`${color}图标`).evaluate(image => image.naturalWidth)).toBe(8);
  await frame.contentFrame().getByRole('button', { name: '查看合计 30', exact: true }).click();
  await expect(frame.contentFrame().getByRole('button', { name: '已点击', exact: true })).toBeVisible();
  const prototypeEntry = delivery.files.find(file => file.name === '原型.html');
  expect(prototypeEntry).toBeTruthy();
  const deliveredRoot = resolve(prototypeEntry.path, '..');
  for (const resource of ['assets/style.css', 'assets/app.js', 'assets/value.js', 'assets/red/icon.svg', 'assets/blue/icon.svg']) {
    const deliveredFile = delivery.files.find(file => resolve(file.path) === resolve(deliveredRoot, resource));
    expect(deliveredFile, `Missing relative resource: ${resource}`).toBeTruthy();
    expect(hash(await readFile(deliveredFile.path))).toBe(deliveredFile.sha256);
  }
  expect(previewRequests.some(request => request.path.endsWith('/assets/value.js'))).toBe(true);
  expect(previewRequests.some(request => request.hasControlToken)).toBe(false);
  await page.screenshot({ path: join(evidence, 'nested-prototype-1920.png') });
  // Serve only the delivery manifest's files to prove the exported prototype works independently.
  const deliveredPaths = new Map(delivery.files.map(file => [relative(delivery.directory, file.path).split(sep).join('/'), file.path]));
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  deliveryServer = createServer(async (request, response) => {
    try {
      const file = deliveredPaths.get(decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1)));
      if (!file) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      response.end(await readFile(file));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolveReady => deliveryServer.listen(0, '127.0.0.1', resolveReady));
  const exported = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await exported.goto(`http://127.0.0.1:${deliveryServer.address().port}/${relative(delivery.directory, prototypeEntry.path).split(sep).map(encodeURIComponent).join('/')}`);
    await expect(exported.getByRole('button', { name: '查看合计 30', exact: true })).toHaveCSS('color', 'rgb(37, 99, 235)');
    for (const color of ['红色', '蓝色']) await expect.poll(() => exported.getByAltText(`${color}图标`).evaluate(image => image.naturalWidth)).toBe(8);
    await exported.getByRole('button', { name: '查看合计 30', exact: true }).click();
    await expect(exported.getByRole('button', { name: '已点击', exact: true })).toBeVisible();
    await exported.screenshot({ path: join(evidence, 'delivered-prototype-1440.png') });
  } finally { await exported.close(); await new Promise(done => deliveryServer.close(done)); deliveryServer = undefined; }
  checks.push('Confirmed office delivery preserves relative CSS/module/import and duplicate-named image directories with original inputs unchanged; actual browser loads nested assets and module interaction both in isolated preview (no control token) and separately served exported files; CSV identifiers and Markdown/Mermaid previews remain usable');

  const lead = app.workbench.agents().find(agent => agent.memberKind === 'controller');
  for (let index = 0; index < 110; index++) app.workbench.event('ui.acceptance', lead.id, `分页证据 ${index} UI-HISTORY`, undefined, project.id);
  await page.getByRole('button', { name: '执行历史', exact: true }).click();
  await page.getByLabel('搜索历史', { exact: true }).fill('UI-HISTORY');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.history-timeline > article')).toHaveCount(100);
  await page.getByRole('button', { name: '更早一页', exact: true }).click();
  await expect(page.locator('.history-timeline > article')).toHaveCount(10);
  app.workbench.addInbox({ projectId: project.id, agentId: lead.id, kind: 'question', title: '确认报告单位', detail: '本次金额是否按元展示？' });
  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '待你处理', exact: true }).click();
  const item = page.locator('.inbox-card').filter({ hasText: '确认报告单位' });
  await item.getByLabel('答复 / 处理说明', { exact: true }).fill('金额按元展示，保留两位小数。');
  await item.getByRole('button', { name: '提交处理记录', exact: true }).click();
  await expect(item).toHaveCount(0);
  expect(app.workbench.store.all('inbox').find(value => value.title === '确认报告单位').state).toBe('resolved');
  checks.push('Persistent history search paginates 110 events; Inbox answer persists and notifies the selected simulated member');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '编排', exact: true }).click();
    await expect(page.getByRole('region', { name: '编排画布' })).toBeVisible();
    // Restoring the selected terminal task still opens on the complete graph.
    await expect(page.getByLabel('选择任务节点', { exact: true })).toHaveValue('acceptance');
    await expectWholeGraph();
    await expect(page.getByRole('button', { name: '暂停新派发', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '添加任务', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存修订', exact: true })).toBeDisabled();
    const beforeSelection = await canvasZoom();
    await page.getByLabel('选择任务节点', { exact: true }).selectOption('step-1');
    await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue('分析与整理');
    await settleCanvas();
    expect(await canvasZoom()).toBeCloseTo(beforeSelection, 3);
    await expectWholeGraph();
    // A deliberate zoom and pan must survive detail toggles and state refresh.
    await page.locator('.react-flow__controls-zoomin').click();
    const area = await page.locator('.flow-container').boundingBox();
    await page.mouse.move(area.x + 45, area.y + area.height - 150);
    await page.mouse.down(); await page.mouse.move(area.x + 105, area.y + area.height - 120, { steps: 5 }); await page.mouse.up();
    const manualTransform = await canvasTransform();
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(page.locator('.node-inspector')).toHaveCount(0);
    await settleCanvas();
    expect(await canvasTransform()).toBe(manualTransform);
    await page.getByRole('button', { name: '任务详情', exact: true }).click();
    await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue('分析与整理');
    const refreshedDetail = page.waitForResponse(response => new URL(response.url()).pathname === `/api/workflows/${workflow.id}` && response.request().method() === 'GET' && response.ok());
    await page.getByRole('button', { name: '刷新编排', exact: true }).click();
    await refreshedDetail;
    await settleCanvas();
    expect(await canvasTransform()).toBe(manualTransform);
    await page.getByRole('button', { name: '适应全图', exact: true }).click();
    await expectWholeGraph();
    await page.getByLabel('选择任务节点', { exact: true }).selectOption('acceptance');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(evidence, `canvas-${viewport.width}.png`) });
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expectWholeGraph();
    await page.screenshot({ path: join(evidence, `canvas-overview-${viewport.width}.png`) });
    await page.reload();
    await expect(page.getByLabel('选择任务节点', { exact: true })).toHaveValue('acceptance');
    await expectWholeGraph();
  }
  checks.push('Canvas at 1440×900 and 1920×1080 shows all nodes on entry/reload/arrangement; selection never forces a close-up; explicit overview and details toggles work; user zoom/pan survives details and refresh');
  // Outbound actions use an explicit HTTP simulation. No remote Git, PR or
  // deployment command is sent to the actual local backend in this section.
  const outbound = [], executions = [], commit = 'a'.repeat(40);
  const simulatedIntegration = { workflowId: workflow.id, branch: 'integration/ui-only', targetBranch: 'main', worktree: join(evidence, 'simulated-integration'), headCommit: commit, baseCommit: commit, state: 'delivered', checks: [], integratedBundleIds: [] };
  await page.route('**/api/state', async route => { const response = await route.fetch(); const value = await response.json(); value.projects = value.projects.map(item => item.id === project.id ? { ...item, kind: 'code' } : item); await route.fulfill({ json: value }); });
  await page.route(`**/api/workflows/${workflow.id}`, async route => { const value = await app.workbench.workflows.detail(workflow.id); await route.fulfill({ json: { ...value, integration: simulatedIntegration } }); });
  await page.route(`**/api/workflows/${workflow.id}/integration/diff`, route => route.fulfill({ json: { commit, baseCommit: commit, text: 'UI contract simulation only' } }));
  await page.route(`**/api/workflows/${workflow.id}/delivery-actions`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: outbound });
    const input = route.request().postDataJSON(); let record = outbound.find(item => JSON.stringify(item.input) === JSON.stringify(input));
    if (!record) {
      const commands = input.kind === 'deploy' ? [{ command: input.command, args: input.args }] : [{ command: 'git', args: ['push', input.remote, `${commit}:refs/heads/${input.branch}`] }];
      if (input.kind === 'pull-request') commands.push({ command: 'gh', args: ['pr', 'create', '--head', input.branch, '--base', input.base, '--title', input.title, '--body-file', '<reviewed-pr-body.md>', ...(input.draft ? ['--draft'] : [])] });
      record = { id: `simulated-${outbound.length}`, workflowId: workflow.id, projectId: project.id, kind: input.kind, commit, worktree: simulatedIntegration.worktree, fingerprint: randomUUID(), createdAt: new Date().toISOString(), state: 'prepared', input, commands, receipts: [] }; outbound.push(record);
    }
    return route.fulfill({ json: record });
  });
  await page.route('**/api/delivery-actions/*/execute', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3], record = outbound.find(item => item.id === id), body = route.request().postDataJSON();
    expect(body).toEqual({ confirmedCommit: record.commit, fingerprint: record.fingerprint }); executions.push(body);
    record.state = 'unknown'; record.detail = '模拟回执缺失；没有实际远端操作。';
    await route.fulfill({ json: record });
  });
  await page.route('**/api/delivery-actions/*/reconcile', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3], record = outbound.find(item => item.id === id), body = route.request().postDataJSON();
    record.state = body.result; record.reconciliation = { ...body, at: new Date().toISOString() }; await route.fulfill({ json: record });
  });
  await page.reload();
  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '成果', exact: true }).click();
  await page.getByLabel('成果工作流').selectOption(workflow.id);
  await page.getByText('后续交付动作 · 推送 / PR / 部署', { exact: true }).click();
  const panel = page.locator('.outbound-delivery');
  await panel.getByLabel('推送目标分支', { exact: true }).fill('feature/ui-contract');
  await panel.getByRole('button', { name: '准备动作预览', exact: true }).click();
  const push = panel.locator('.delivery-action-record').filter({ has: page.getByText('推送提交', { exact: true }) });
  await expect(push.getByRole('button', { name: '确认执行推送提交', exact: true })).toBeDisabled(); expect(executions).toHaveLength(0);
  await push.getByRole('checkbox').check(); await push.getByRole('button', { name: '确认执行推送提交', exact: true }).click();
  await expect(push.getByText('结果未知 · 需要核对', { exact: true })).toBeVisible();
  await expect(push.getByRole('button', { name: '确认执行推送提交', exact: true })).toHaveCount(0);
  await push.getByLabel('核对后的实际结果').selectOption('failed'); await push.getByLabel('核对依据').fill('模拟场景已核对，未进行实际推送。');
  await push.getByRole('button', { name: '记录人工核对结论', exact: true }).click(); await expect(push.getByText('已核对失败', { exact: true })).toBeVisible(); expect(executions).toHaveLength(1);
  await panel.getByLabel('动作类型').selectOption('pull-request');
  await panel.getByLabel('推送目标分支 / PR 源分支', { exact: true }).fill('feature/pr-contract'); await panel.getByLabel('PR 标题', { exact: true }).fill('UI 契约验证'); await panel.getByLabel('PR 描述', { exact: true }).fill('第一行\n\n第二行 $(literal)');
  await expect(panel.getByRole('checkbox', { name: '先创建草稿 PR', exact: true })).toBeChecked();
  await panel.getByRole('button', { name: '准备动作预览', exact: true }).click();
  await expect.poll(() => outbound.length).toBe(2); expect(outbound[1].input).toMatchObject({ draft: true, body: '第一行\n\n第二行 $(literal)' });
  await panel.getByLabel('动作类型').selectOption('deploy'); await panel.getByLabel('部署执行程序').fill('simulated-deploy'); await panel.getByLabel('部署参数（JSON 字符串数组）').fill('{"invalid":true}');
  await panel.getByRole('button', { name: '准备动作预览', exact: true }).click(); await expect(panel.getByRole('alert').filter({ hasText: '字符串数组' })).toBeVisible(); expect(outbound).toHaveLength(2);
  await panel.getByLabel('部署参数（JSON 字符串数组）').fill('["--project","name with spaces"]'); await panel.getByRole('button', { name: '准备动作预览', exact: true }).click();
  await expect.poll(() => outbound.length).toBe(3); expect(outbound[2].commands).toEqual([{ command: 'simulated-deploy', args: ['--project', 'name with spaces'] }]); expect(executions).toHaveLength(1);
  await page.screenshot({ path: join(evidence, 'outbound-actions-contract-1920.png'), fullPage: true });
  checks.push('Outbound action UI HTTP contracts simulated: preview never executes; exact commit/fingerprint confirmation; unknown requires manual reconciliation and cannot repeat; draft PR newlines and deployment argument boundaries preserved. No real push/PR/deploy claimed');
  await page.unrouteAll({ behavior: 'wait' });
  const codeSource = join(evidence, 'local-push-source'), bare = join(evidence, 'local-only-remote.git');
  await mkdir(codeSource);
  await runCommand('git', ['init', '-b', 'main'], codeSource);
  await runCommand('git', ['config', 'user.name', 'UI Fixture'], codeSource);
  await runCommand('git', ['config', 'user.email', 'ui-fixture@localhost'], codeSource);
  await writeFile(join(codeSource, 'answer.mjs'), 'export const answer = 0;\n');
  await writeFile(join(codeSource, 'answer.test.mjs'), "import assert from 'node:assert/strict';import {answer} from './answer.mjs';assert.equal(answer,42);\n");
  await runCommand('git', ['add', '.'], codeSource); await runCommand('git', ['commit', '-m', 'Bounded local push UI baseline'], codeSource);
  await runCommand('git', ['init', '--bare', bare], codeSource); await runCommand('git', ['remote', 'add', 'fixture', bare], codeSource);
  const initialCommit = await runCommand('git', ['rev-parse', 'HEAD'], codeSource);
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const actualRequest = async (path, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-workbench-token': bootstrap.token, 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); if (!response.ok) throw new Error(`${path}: ${value.error}`); return value;
  };
  const codeProject = await actualRequest('/api/projects', { name: '仅本地裸仓库推送验收', path: codeSource });
  const codeWriter = await actualRequest('/api/agents', { projectId: codeProject.id, name: 'UI 模拟实施', runtime: 'workbuddy', roleTemplateId: 'fullstack', memberKind: 'worker', role: '实施' });
  const codeVerification = await actualRequest(`/api/connections/${codeWriter.connectionId}/verify`, { projectId: codeProject.id, capabilities: ['inference', 'streaming', 'tools'] }); expect(codeVerification.success).toBe(true);
  const codeFlow = await actualRequest('/api/workflows', { projectId: codeProject.id, name: '本地推送边界验收', goal: '实际 Git 候选仅推到隔离本地裸仓库', targetBranch: 'main', nodes: [{ id: 'code', title: '固定代码候选', description: 'UI transport simulation produces answer=42.', acceptance: '实际测试通过', kind: 'task', agentId: codeWriter.id, dependencies: [], requiredCapabilities: [], inputs: [], checks: [{ id: 'test', label: '实际本地测试', kind: 'test', command: process.execPath, args: ['--test', 'answer.test.mjs'] }] }] });
  await actualRequest(`/api/workflows/${codeFlow.id}/confirm`, { version: 1 });
  // The completion receipt marks the round candidate before the bundle is
  // attached, and review rounds are candidate without any bundle. Wait for the
  // actual artifact instead of the state alone, or this fetch races that window.
  await expect.poll(async () => { const view = (await app.workbench.workflows.detail(codeFlow.id)).nodes[0]; return view.round?.state === 'candidate' && !!view.bundle; }, { timeout: 30000 }).toBe(true);
  let codeDetail = await actualRequest(`/api/workflows/${codeFlow.id}`);
  const codeBundle = codeDetail.nodes[0].bundle;
  await actualRequest(`/api/bundles/${codeBundle.id}/check`, { requirementId: 'test', command: process.execPath, args: ['--test', 'answer.test.mjs'] });
  await actualRequest(`/api/workflows/${codeFlow.id}/nodes/code/accept`, { planVersion: 1, roundId: codeDetail.nodes[0].round.id, bundleId: codeBundle.id });
  await actualRequest(`/api/workflows/${codeFlow.id}/integration/check`, { command: process.execPath, args: ['--test', 'answer.test.mjs'] });
  codeDetail = await actualRequest(`/api/workflows/${codeFlow.id}`); expect(codeDetail.workflow.status).toBe('completed'); expect(codeDetail.integration.state).toBe('verified');
  await page.reload(); await page.getByLabel('当前项目', { exact: true }).selectOption(codeProject.id);
  await page.getByRole('navigation', { name: '工作内容' }).getByRole('button', { name: '成果', exact: true }).click();
  await page.getByLabel('成果工作流').selectOption(codeFlow.id);
  await page.getByText('后续交付动作 · 推送 / PR / 部署', { exact: true }).click();
  const actualPanel = page.locator('.outbound-delivery');
  await actualPanel.getByLabel('Git 远端名称', { exact: true }).fill('fixture'); await actualPanel.getByLabel('推送目标分支', { exact: true }).fill('release/ui-only');
  await actualPanel.getByRole('button', { name: '准备动作预览', exact: true }).click();
  await expect(actualPanel.getByText('已准备 · 等待确认', { exact: true })).toBeVisible();
  expect(await runCommand('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], codeSource)).toBe('');
  const actualCard = actualPanel.locator('.delivery-action-record');
  await expect(actualCard.getByText(bare, { exact: true })).toBeVisible();
  await expect(actualCard.getByRole('button', { name: '确认执行推送提交', exact: true })).toBeDisabled();
  await actualCard.getByRole('checkbox').check(); await actualCard.getByRole('button', { name: '确认执行推送提交', exact: true }).click();
  await expect(actualCard.getByText('成功', { exact: true })).toBeVisible();
  expect(await runCommand('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/release/ui-only'], codeSource)).toBe(codeDetail.integration.headCommit);
  await actualPanel.getByRole('button', { name: '准备动作预览', exact: true }).click();
  const actualRecords = await actualRequest(`/api/workflows/${codeFlow.id}/delivery-actions`);
  expect(actualRecords).toHaveLength(1); expect(actualRecords[0].receipts).toHaveLength(1);
  expect(app.workbench.workflows.get(codeFlow.id).status).toBe('completed');
  expect(await runCommand('git', ['rev-parse', 'HEAD'], codeSource)).toBe(initialCommit);
  await page.screenshot({ path: join(evidence, 'actual-local-push-1920.png'), fullPage: true });
  checks.push('Actual HTTP and desktop UI: real isolated Git candidate/test/integration; preparing push leaves local bare repository empty; exact confirmation pushes one commit to local bare only; duplicate prepare retains one action/receipt; target main and workflow delivery status stay unchanged. Agent transport/Beads remain simulated, no external PR/deploy');
  expect(errors).toEqual([]);
  await writeFile(join(evidence, 'report.json'), JSON.stringify({ status: 'passed', buildDir, layer: 'Real desktop browser, actual local HTTP/SQLite/files/MCP; simulated model transport and Beads repository. No native auth or real provider acceptance claimed.', checks, errors, evidence }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks, evidence }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ error: String(error), errors, checks, sends: sends.map(({ text, ...safe }) => safe), evidence }, null, 2));
  console.error(`Evidence: ${evidence}`); throw error;
} finally { if (deliveryServer) await new Promise(done => deliveryServer.close(done)); await browser.close(); await app?.close(); }
