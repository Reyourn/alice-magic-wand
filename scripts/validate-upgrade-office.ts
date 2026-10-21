/** Real native office acceptance. Never run implicitly: --confirm-usage is required.
 * Uses a fresh ordinary folder, actual Beads control repository, immutable input
 * snapshots and native Codex / WorkBuddy / Claude. No mock adapters or credentials.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { chromium } from '@playwright/test';
import { buildApp } from '../src/server/index.js';
import { runCommand } from '../src/server/repositories.js';
import type { Agent, Approval, ConnectionProfile, ConnectionVerification, FileDelivery, InputSnapshot, Project, WorkbenchEvent, WorkflowDetail, WorkflowNode } from '../src/shared/types.js';
import { createPptxFixture } from './fixtures/pptx.mjs';
import { nativeFinalizationPending } from './validation-finalization.js';

const sourceReport = process.argv.find(value => value.startsWith('--verified-report='))?.slice('--verified-report='.length);
const resumeFixture = process.argv.find(value => value.startsWith('--resume-fixture='))?.slice('--resume-fixture='.length);
const prepareOnly = process.argv.includes('--prepare-only');
if (!prepareOnly && (!process.argv.includes('--confirm-usage') || (!sourceReport && !resumeFixture))) {
  console.log('Prepared only. Run after approval: npx tsx scripts/validate-upgrade-office.ts --confirm-usage --verified-report=<existing-real-collaboration-report.json>');
  console.log('Reuses unchanged real native verification evidence only after assertReady. Sends actual model requests and saves only isolated fixture output.');
  process.exitCode = 2;
  console.log('Resume the preserved workflow without new tasks: --confirm-usage --resume-fixture=<paused-isolated-fixture>');
} else await acceptance(sourceReport ? resolve(sourceReport) : '', prepareOnly, resumeFixture ? resolve(resumeFixture) : undefined);

async function acceptance(borrowedEvidenceFrom: string, prepareOnly = false, resume?: string): Promise<void> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixture = resume ?? await mkdtemp(join(tmpdir(), 'awb-upgrade-office-'));
  assert(!resume || /^awb-upgrade-office-/.test(fixture.split(/[\\/]/).at(-1)!), 'Resume only an isolated office acceptance fixture');
  const source = join(fixture, 'ordinary-business-folder');
  if (!resume) await mkdir(source);
  const dataDir = join(fixture, 'data'), reportPath = join(fixture, resume ? `office-resume-report-${Date.now()}.json` : 'office-report.json');
  const paused = resume ? JSON.parse(await readFile(join(fixture, 'pause-report.json'), 'utf8')) as {
    workflow: WorkflowDetail; sourceHashes: {path: string; before: string}[]; shutdown: {unconfirmedPids: number[]};
  } : undefined;
  if (paused) assert.equal(paused.shutdown.unconfirmedPids.length, 0, 'Original writers must have a confirmed stop record');
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const csvPath = join(source, '客户金额.csv'), xlsxPath = join(source, '运营口径.xlsx'), pptxPath = join(source, '演示资料.pptx');
  if (!resume) {
  await writeFile(csvPath, 'customer_id,amount\n000123,100\n000456,200\n000789,0\n');
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('核对口径').addRows([['指标', '数值'], ['客户数量', 3], ['金额合计', 300], ['单位', '元']]);
  await workbook.xlsx.writeFile(xlsxPath);
  await writeFile(pptxPath, await createPptxFixture('OFFICE-PPTX-6832'));
  }
  const sources = [csvPath, xlsxPath, pptxPath];
  const before = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))])));
  for (const entry of paused?.sourceHashes ?? []) assert.equal(before[entry.path], entry.before, 'Original input changed since pause');
  if (resume) await copyFile(join(dataDir, 'workbench.sqlite'), join(dataDir, `workbench.sqlite.pre-resume-${Date.now()}.backup`));

  // A bounded reader lets both native tools parse the actual binary snapshots
  // with installed production parsers. It contains no precomputed answers.
  const reader = join(fixture, 'read-inputs.mjs');
  if (!resume) {
  await writeFile(reader, `import {readFile,readdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {extractDocument} from ${JSON.stringify(pathToFileURL(join(root, 'dist/server/documents.js')).href)};
const root=${JSON.stringify(fixture)},directory=resolve(process.argv[2]||'inputs'),part=relative(root,directory);
if(part.startsWith('..')||isAbsolute(part))throw new Error('Outside isolated fixture');
for(const entry of await readdir(directory,{recursive:true,withFileTypes:true})){if(!entry.isFile())continue;const path=join(entry.parentPath,entry.name),name=relative(directory,path);if(!/\\.(xlsx|pptx|csv)$/i.test(name))continue;const bytes=await readFile(path);if(/\\.(xlsx|pptx)$/i.test(name))console.log(JSON.stringify({name,...await extractDocument({name,bytes})}));else console.log(JSON.stringify({name,text:bytes.toString('utf8')}));}
`);
  }
  const checker = join(fixture, 'check-output.mjs');
  if (!resume) {
  await writeFile(checker, `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const summary=JSON.parse(await readFile('outputs/summary.json','utf8'));
assert.equal(summary.totalAmount,300);assert.equal(summary.customerCount,3);assert.equal(summary.xlsxDeclaredTotal,300);assert.equal(summary.pptxCustomerCount,2689);assert.equal(summary.pptxCode,'OFFICE-PPTX-6832');assert.deepEqual(summary.customerIds,['000123','000456','000789']);
const csv=await readFile('outputs/summary.csv','utf8');assert(csv.includes('300')&&csv.includes('000123')&&csv.includes('000456')&&csv.includes('000789'));
const html=await readFile('outputs/report.html','utf8');assert(/<html[\\s>]/i.test(html));assert(/<title>[^<]+<\\/title>/i.test(html));assert(html.includes('300')&&html.includes('2689'));
console.log('Actual JSON/CSV/HTML readable; fixed source values and leading-zero identifiers match.');
`);
  }
  if (prepareOnly) {
    const parsed = await runCommand(process.execPath, [reader, source], fixture);
    assert(parsed.includes('OFFICE-PPTX-6832') && parsed.includes('2689') && parsed.includes('000123') && parsed.includes('300'));
    await runCommand(process.execPath, ['--check', checker], fixture);
    for (const path of sources) assert.equal(hash(await readFile(path)), before[path]);
    await writeFile(join(fixture, 'preparation-report.json'), JSON.stringify({ status: 'prepared-only', fixture, nativeRuntimeExecuted: false, providerUsage: false, sourceHashes: before, parserChecked: ['csv', 'xlsx', 'pptx'], helperSyntaxChecked: true }, null, 2));
    console.log(`Fixture preparation passed; no native requests sent: ${fixture}`);
    return;
  }

  const token = randomUUID(); let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let origin = '', workflowId = '', failure: string | undefined;
  let finalWorkflow: WorkflowDetail | undefined, delivery: FileDelivery | undefined, agents: Agent[] = [];
  let timer: NodeJS.Timeout | undefined, approving = false;
  const events: WorkbenchEvent[] = [], approvalReceipts: unknown[] = [], borrowedVerifications: unknown[] = [];
  const pendingApprovals = new Set<string>();
  const checks: Record<string, boolean> = {};
  const progress = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
  const request = async <T>(path: string, method = 'GET', body?: unknown, key: string = randomUUID()): Promise<T> => {
    const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'x-workbench-token': token, 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    const value = await response.json(); if (!response.ok) throw new Error(`${method} ${path}: ${value.error ?? response.status}`); return value as T;
  };
  const waitFor = async <T>(label: string, read: () => Promise<T | undefined> | T | undefined, timeout = 600000): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failure) throw new Error(failure);
      const error = agents.map(agent => app!.workbench.getAgent(agent.id)).find(agent => ['error', 'unknown'].includes(agent.state));
      if (error) throw new Error(`${error.runtime}: ${error.lastError ?? error.state}`);
      const value = await read(); if (value !== undefined) return value; await delay(500);
    }
    throw new Error(`Timed out without retrying native delivery: ${label}`);
  };
  const withinFixture = (path: string, cwd: string) => { const suffix = relative(fixture, resolve(cwd, path)); return !suffix.startsWith('..') && !isAbsolute(suffix); };
  const approve = (approval: Approval): boolean => {
    const member = agents.find(agent => agent.id === approval.agentId); if (!member || !app) return false;
    const current = app.workbench.getAgent(member.id), cwd = current.worktree ?? source;
    const input = approval.input as Record<string, unknown>, tool = approval.tool.toLowerCase();
    if (tool.includes('workbench') || input?.server === 'workbench' || input?.serverName === 'workbench'
      || tool === 'deferexecutetool' && typeof input?.toolName === 'string' && input.toolName.startsWith('mcp__workbench__')) return true;
    const paths = ['path', 'file_path', 'filePath', 'target_file'].flatMap(key => typeof input?.[key] === 'string' ? [input[key] as string] : []);
    if (/read|write|edit|replace|list|glob|grep|search/.test(tool) && paths.length) return paths.every(path => withinFixture(path, cwd));
    const command = typeof input?.command === 'string' ? input.command.trim() : typeof input?.cmd === 'string' ? input.cmd.trim() : '';
    // Accept only the exact read-only helper through the current Node executable,
    // including the native PowerShell call operator and optional exit-code print.
    const helper = command.match(/^(?:&\s+)?(?:["']([^"']+node\.exe)["']|(node))\s+["']([^"']+)["']\s+["']?inputs["']?(?:;\s*(?:echo\s+)?["']EXIT(?:_CODE)?=\$(?:\?|LASTEXITCODE)["'])?$/i);
    if (helper && (helper[2] === 'node' || resolve(helper[1]!).toLowerCase() === resolve(process.execPath).toLowerCase())
      && resolve(helper[3]!).toLowerCase() === resolve(reader).toLowerCase()) return true;
    if (!command || /[;&|<>`\r\n]/.test(command) || command.includes('$(')) return false;
    if (['pwd', 'Get-Location'].includes(command)) return true;
    const list = command.match(/^(?:ls(?:\s+-la)?|Get-ChildItem(?:\s+-Force)?)(?:\s+-LiteralPath)?\s+["']?([^"']+?)["']?$/i);
    if (list) return withinFixture(list[1]!, cwd);
    const read = command.match(/^(?:cat|type|Get-Content)(?:\s+-LiteralPath)?\s+["']?([^"']+?)["']?$/);
    return !!read && withinFixture(read[1]!, cwd);
  };
  try {
    progress(`Real office fixture: ${fixture}`);
    assert(existsSync(join(root, 'dist/server/documents.js')), 'Build server before office acceptance');
    const previous = borrowedEvidenceFrom ? JSON.parse(await readFile(borrowedEvidenceFrom, 'utf8')) as { verificationReceipts?: ConnectionVerification[] } : undefined;
    app = await buildApp({ dataDir, token, staticRoot: false });
    app.workbench.on('event', (event: WorkbenchEvent) => {
      events.push(event);
      if (['runtime.ready', 'runtime.result', 'runtime.error'].includes(event.type)) progress(`${agents.find(agent => agent.id === event.agentId)?.runtime ?? event.agentId}: ${event.type}`);
    });
    origin = await app.listen({ host: '127.0.0.1', port: 0 }); app.workbench.setBaseUrl(origin);
    await writeFile(join(fixture, 'resume-server.json'), JSON.stringify({ origin, pid: process.pid, token }, null, 2));
    const project = paused ? app.workbench.getProject(paused.workflow.workflow.projectId) : await request<Project>('/api/projects', 'POST', { name: '真实办公协作验收', path: source, kind: 'office' });
    assert(project.controlPath && project.controlPath !== source && existsSync(join(project.controlPath, '.git')));
    assert(!existsSync(join(source, '.git'))); checks.privateControlRepository = true;
    agents = paused ? app.workbench.agents().filter(agent => agent.projectId === project.id) : await request<Agent[]>(`/api/projects/${project.id}/core-team`, 'POST', { preset: 'office' });
    const lead = agents.find(agent => agent.runtime === 'codex')!, writer = agents.find(agent => agent.runtime === 'workbuddy')!, reviewer = agents.find(agent => agent.runtime === 'claude')!;
    assert(lead && writer && reviewer);
    if (paused) {
      assert.equal(app.workbench.workflows.list(project.id).length, 1, 'Do not create a duplicate office workflow');
      assert(agents.every(agent => agent.controlMode === 'human'), 'Inspect current controls before resuming');
      assert(app.workbench.store.all<{state: string}>('runs').every(run => run.state === 'terminal'), 'Original writers are not all terminal');
    }
    for (const agent of agents) {
      const profile = app.workbench.connectionManager.get(agent.connectionId!);
      const verification = (previous?.verificationReceipts ?? app.workbench.store.get<ConnectionProfile>('connections', profile.id)?.verifications)?.find(row => row.connectionId === profile.id && row.revision === profile.revision && row.requestedModel === profile.defaultModel && row.success && row.contextFingerprint);
      assert(verification, `No unchanged real verification for ${agent.runtime}; do not fabricate or automatically bill a replacement probe`);
      if (!paused) {
        const stored = app.workbench.store.get<ConnectionProfile>('connections', profile.id)!;
        app.workbench.store.put('connections', profile.id, { ...stored, verifications: [verification], status: verification.status });
      }
      const checked = await app.workbench.connectionManager.assertReady(profile.id, agent.model, agent.worktree ?? project.controlPath ?? source, ['inference', 'streaming', 'tools']);
      borrowedVerifications.push({ runtime: agent.runtime, borrowedEvidenceFrom, ...checked });
    }
    checks.nativeEvidenceUnchangedAndRechecked = borrowedVerifications.length === 3;
    const input = paused ? app.workbench.workflows.office.list(project.id)[0]! : await request<InputSnapshot>(`/api/projects/${project.id}/input-snapshots`, 'POST', { paths: sources });
    assert(input && app.workbench.workflows.office.checkInputs(input.id).unchanged);
    const nodes: WorkflowNode[] = [
      { id: 'report', kind: 'task', title: '固定输入分析与报告', agentId: writer.id, dependencies: [], inputs: [input.id], requiredCapabilities: [], description: `调用 get_task_context；执行只读解析助手 node "${reader}" inputs，实际读取 inputs 中的 CSV、XLSX、PPTX。只在 outputs 生成 summary.json、summary.csv、report.html。summary.json 字段为 totalAmount、customerCount、xlsxDeclaredTotal、pptxCustomerCount、pptxCode、customerIds；数值必须从资料读取计算。CSV 必须保留全部客户编号前导零及金额合计，HTML 为可在浏览器打开的中文报告，呈现表格金额合计与演示资料客户总数，并说明这两套资料含义不同不能混算。不安装依赖，不访问网络，不修改 inputs、助手或原文件。`, acceptance: '原始文件不变；输出内容可读、数据口径一致、编号前导零保留；固定版本独立复核通过。', checks: [{ id: 'semantic', kind: 'test', label: '实际输出与关键数据核对', command: process.execPath, args: [checker] }, { id: 'review', kind: 'review', label: 'Claude 独立复核' }] },
      { id: 'review', kind: 'review', title: '文件与数据独立复核', agentId: reviewer.id, dependencies: [{ nodeId: 'report', kind: 'candidate' }], inputs: [input.id], requiredCapabilities: [], description: `调用 get_task_context。执行只读解析助手 node "${reader}" inputs，复核当前 inputs 中原始 CSV/XLSX/PPTX 与固定候选 JSON/CSV/HTML；金额汇总、客户编号及 PPTX 内容必须对应实际资料。只读，不修改候选文件。最终输出要求的 WORKBENCH_REVIEW_RESULT 单行，引用系统提供的准确版本，实际通过才 passed。`, acceptance: '输出有明确版本、实际理由的独立复核结果。', checks: [] },
    ];
    const workflow = paused ? paused.workflow.workflow : await request<{ id: string }>('/api/workflows', 'POST', { projectId: project.id, name: '表格与演示资料办公协作', goal: '真实三端完成固定资料分析、报告、独立复核和主控验收，另存独立交付版本。', nodes, maxReworkRounds: 1 });
    workflowId = workflow.id;
    timer = setInterval(() => { if (approving || !app) return; approving = true; void (async () => {
      for (const approval of app!.workbench.store.all<Approval>('approvals')) {
        if (!approve(approval)) {
          if (!pendingApprovals.has(approval.id)) {
            pendingApprovals.add(approval.id);
            progress(`Pending manual inspection: ${approval.tool} ${approval.id}; inspect the actual isolated-fixture command before deciding.`);
            await writeFile(join(fixture, 'pending-approval.json'), JSON.stringify({ origin, approval }, null, 2));
          }
          continue;
        }
        await app!.workbench.respondApproval(approval.agentId, approval.id, true);
        approvalReceipts.push({ agentId: approval.agentId, tool: approval.tool, input: approval.input, allow: true, reason: 'Exact read-only helper or native file operation within this isolated fixture.' });
      }
    })().catch(error => { failure = app!.workbench.publicError(error); }).finally(() => { approving = false; }); }, 250);
    if (paused) {
      const oldRound = app.workbench.workflows.rounds(workflowId).at(-1)!;
      assert.equal(oldRound.state, 'failed');
      const resumed = await request<{ messageId: string }>(`/api/agents/${writer.id}/messages`, 'POST', {
        text: `用户已恢复办公协作。继续当前固定输入任务，先 get_task_context 核对，保留现有 outputs/summary.json 并根据真实输入补齐 summary.csv 和 report.html。只执行这条只读单命令：node "${reader}" inputs 。工作目录已经正确，不要 cd、Set-Location、ls、/tmp、管道或追加命令，不安装依赖或联网。用原生 Write 工具写当前 outputs，必须保留客户编号前导零，金额及演示资料分别标明口径。按既定要求完成三个文件后结束本轮，不改原件或助手，也不读取检查脚本答案。`,
      }, `resume-office-human-${oldRound.id}`);
      await waitFor('human continuation of preserved office round', () => {
        const message = app!.workbench.store.get<{state: string}>('messages', resumed.messageId);
        if (message?.state === 'failed' || message?.state === 'uncertain') throw new Error(`Office resume message ${message.state}`);
        return message?.state === 'completed' ? true : undefined;
      });
      assert.equal(app.workbench.workflows.rounds(workflowId).filter(round => round.messageId === resumed.messageId).length, 1);
      checks.sameWorkflowHumanContinuation = true;
      await request(`/api/agents/${writer.id}/control`, 'POST', { mode: 'auto' });
      await request(`/api/agents/${reviewer.id}/control`, 'POST', { mode: 'auto' });
      await request(`/api/agents/${lead.id}/control`, 'POST', { mode: 'auto' });
      await request(`/api/workflows/${workflowId}/pause`, 'POST', { paused: false });
    } else {
    const controller = await request<{ messageId: string }>(`/api/agents/${lead.id}/messages`, 'POST', { text: `你负责办公验收工作流 ${workflowId}。只用 workbench MCP，不直接读写业务文件。先 get_workflow 阅读整份计划，等待用户确认，不提新计划。确认后的完成通知到达时 get_workflow，实施 candidate 后 run_declared_check(semantic) 使用已声明命令；等待 Claude WORKBENCH_REVIEW_RESULT，按真实原文 conclusion 记录 record_review(review)。测试及复核通过后 accept_task(report) 必须准确指定当前 roundId、bundleId；accept_task(review) 关闭当前独立复核轮。任务未通过不要宣称完成，可在计划范围内 return_task 最多一轮，稳定幂等键，明确实际问题。只有两个任务都通过才宣告可验收，文件交付由用户单独确认。禁止覆盖原件、部署、上传或切换账号。` });
    await waitFor('controller reads approved scope', () => { const row = app!.workbench.store.get<{ state: string }>('messages', controller.messageId); if (row?.state === 'failed' || row?.state === 'uncertain') throw new Error(`Controller message ${row.state}`); return row?.state === 'completed' ? true : undefined; });
    assert.equal(app.workbench.workflows.rounds(workflowId).length, 0, 'No task dispatch before human confirmation');
    await request(`/api/workflows/${workflowId}/confirm`, 'POST', { version: 1 });
    }
    finalWorkflow = await waitFor('native office workflow accepted', async () => { const value = await app!.workbench.workflows.detail(workflowId); return value.workflow.status === 'completed' ? value : undefined; });
    await waitFor('native final replies and queued completion notices', () => {
      return nativeFinalizationPending(app!.workbench.store,agents.map(agent=>agent.id)) ? undefined : true;
    }, 180000);
    checks.nativeFinalTurnsConfirmed = true;
    const bundle = finalWorkflow.nodes.find(node => node.node.id === 'report')!.bundle!;
    assert(bundle?.kind === 'files' && bundle.files.length >= 3);
    assert(finalWorkflow.evidence.some(row => row.bundleId === bundle.id && row.kind === 'test' && row.exitCode === 0 && !row.stale));
    assert(finalWorkflow.evidence.some(row => row.bundleId === bundle.id && row.kind === 'review' && row.result === 'passed' && !row.stale));
    checks.realNativeThreeToolExecution = agents.every(agent => events.some(event => event.agentId === agent.id && event.type === 'runtime.result'));
    checks.nativeControllerAcceptance = events.some(event => event.agentId === lead.id && event.type === 'runtime.tool' && JSON.stringify(event.data).includes('accept_task'));
    checks.versionBoundChecksAndReview = true;
    delivery = await request<FileDelivery>(`/api/workflows/${workflowId}/deliver-office`, 'POST', { confirmedBundleIds: finalWorkflow.nodes.flatMap(node => node.bundle ? [node.bundle.id] : []) });
    for (const file of delivery.files) assert.equal(hash(await readFile(file.path)), file.sha256);
    checks.separateVersionedDelivery = true;
    const htmlIndex = bundle.files.findIndex(file => file.name.endsWith('.html')); assert(htmlIndex >= 0);
    const preview = await request<{ kind: string; url: string }>(`/api/bundles/${bundle.id}/files/${htmlIndex}/preview`);
    assert.equal(preview.kind, 'html'); assert.notEqual(new URL(preview.url).origin, new URL(origin).origin);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try { const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await page.route('**/*', route => new URL(route.request().url()).origin === new URL(preview.url).origin ? route.continue() : route.abort()); await page.goto(preview.url); assert((await page.locator('body').innerText()).includes('300')); await page.screenshot({ path: join(fixture, 'actual-office-report-1920.png'), fullPage: true }); } finally { await browser.close(); }
    checks.actualHtmlBrowserPreview = true;
    assert(app.workbench.workflows.office.checkInputs(input.id).unchanged);
    for (const path of sources) assert.equal(hash(await readFile(path)), before[path]);
    checks.originalCsvXlsxPptxUnchanged = true;
    assert(Object.values(checks).every(Boolean));
    progress('Real office candidate accepted and copied to versioned delivery; all originals unchanged.');
  } catch (error) { failure = app ? app.workbench.publicError(error) : String(error); process.exitCode = 1; progress(`Incomplete: ${failure}`); }
  finally {
    if (timer) clearInterval(timer);
    // Snapshot each collection independently before closing. Explicit external
    // shutdown may already have closed SQLite; it must not discard all evidence.
    const cleanupErrors: string[] = [];
    const readSafely = <T>(label: string, read: () => T, fallback: T): T => {
      try { return read(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); return fallback; }
    };
    if (app && failure && workflowId) {
      try {
        app.workbench.workflows.setPaused(workflowId, true);
        for (const agent of app.workbench.agents()) {
          await app.workbench.control(agent.id, 'human');
          if (['running', 'starting', 'waiting_approval', 'interrupting'].includes(app.workbench.getAgent(agent.id).state))
            await app.workbench.interrupt(agent.id);
        }
      } catch (error) { cleanupErrors.push(`pause: ${String(error)}`); }
    }
    if (app && workflowId) finalWorkflow = await app.workbench.workflows.detail(workflowId).catch(error => { cleanupErrors.push(`workflow: ${String(error)}`); return finalWorkflow; });
    const usage = readSafely('usage', () => app?.workbench.usage.records() ?? [], []);
    const runtimes = readSafely('agents', () => app?.workbench.agents().map(agent => ({ runtime: agent.runtime, nativeSessionId: agent.nativeSessionId, observedModel: agent.observedModel, observedProvider: agent.observedProvider, state: agent.state })) ?? [], []);
    const runs = readSafely('runs', () => app?.workbench.store.all('runs') ?? [], []);
    try { await app?.close(); } catch (error) { cleanupErrors.push(`close: ${String(error)}`); }
    const originalHashesAfter = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))])));
    await writeFile(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), passed: !failure && !cleanupErrors.length && Object.values(checks).every(Boolean), scope: 'Real native agents and actual Beads/Git/SQLite. CSV/XLSX/PPTX fixed input parsed with production extraction helper; actual JSON/CSV/HTML output. Does not claim editable PPTX/DOCX output or visual validation of source office files.', fixture, resumedFrom: resume ? join(resume, 'pause-report.json') : undefined, borrowedEvidenceFrom, borrowedVerifications, checks, failure, cleanupErrors, originalHashesBefore: before, originalHashesAfter, runtimes, runs, finalWorkflow, delivery, approvalReceipts, usage, events: events.filter(event => !['runtime.delta', 'runtime.tool'].includes(event.type)) }, null, 2));
    progress(`Report: ${reportPath}`);
  }
}
