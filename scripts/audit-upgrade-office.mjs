/** Read-only audit of an existing native office run. Never sends model requests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from 'node:net';

const reportArg = process.argv.find(value => value.startsWith('--report='))?.slice(9);
const outputArg = process.argv.find(value => value.startsWith('--output='))?.slice(9);
assert(reportArg && outputArg, 'Required: --report=<existing-report.json> --output=<audit.json>');
const reportPath = resolve(reportArg), outputPath = resolve(outputArg);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const db = new DatabaseSync(join(report.fixture, 'data', 'workbench.sqlite'), { readOnly: true });
const rows = collection => db.prepare('SELECT json FROM entities WHERE collection=?').all(collection).map(row => JSON.parse(row.json));
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const listening = origin => new Promise(resolveListening => {
  const url = new URL(origin), socket = connect({ host: url.hostname, port: Number(url.port) });
  const done = result => { socket.destroy(); resolveListening(result); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(2000, () => done(true));
});
try {
  const workflowId = report.finalWorkflow.workflow.id;
  const workflow = rows('workflows').find(item => item.id === workflowId);
  assert.equal(workflow.status, 'delivered');
  const beforePause = JSON.parse(await readFile(join(report.fixture, 'pause-report.json'), 'utf8'));
  assert.deepEqual(workflow.taskIds, beforePause.workflow.workflow.taskIds);
  assert.equal(workflow.currentVersion, beforePause.workflow.workflow.currentVersion);
  const sourceHashes = await Promise.all(Object.entries(report.originalHashesBefore).map(async ([path, expected]) => {
    const actual = await hash(path); assert.equal(actual, expected);
    return { name: basename(path), sha256: actual, unchanged: true };
  }));
  const delivery = rows('file_deliveries').find(item => item.id === report.delivery.id);
  const files = await Promise.all(delivery.files.map(async file => {
    const actual = await hash(file.path); assert.equal(actual, file.sha256);
    return { name: file.name, sha256: actual, size: file.size, matchesDeliveredVersion: true };
  }));
  const bundle = rows('artifact_bundles').find(item => item.id === delivery.bundleIds[0]);
  const evidence = rows('verification_evidence').filter(item => item.bundleId === bundle.id);
  const test = evidence.find(item => item.kind === 'test' && item.exitCode === 0 && item.version === bundle.version);
  const review = evidence.find(item => item.kind === 'review' && item.result === 'passed' && item.version === bundle.version);
  assert(test && review);
  const runs = rows('runs'), server = JSON.parse(await readFile(join(report.fixture, 'resume-server.json'), 'utf8'));
  const pids = [...new Set([...runs.map(run => run.pid).filter(Boolean), server.pid])];
  const unconfirmedPids = pids.filter(alive), serverListening = await listening(server.origin);
  assert.equal(unconfirmedPids.length, 0, 'Do not declare shutdown while a recorded process still exists');
  assert.equal(serverListening, false, 'Isolated server still listening');
  const turnRecords = report.usage.filter(item => item.scope === 'turn').map(item => ({
    runtime: item.runtime, messageId: item.messageId, connectionId: item.connectionId,
    model: item.model ?? null, provider: item.provider ?? null, source: item.source,
    startedAt: item.startedAt ?? null, counts: item.counts, partial: item.partial,
  }));
  const audit = {
    checkedAt: new Date().toISOString(), sourceReport: reportPath,
    status: 'business-path-verified-with-explicit-limitations',
    nativeCallsMadeByAudit: false, databaseReadOnly: true,
    workflow: { id: workflow.id, status: workflow.status, version: workflow.currentVersion, taskIds: workflow.taskIds },
    bundle: { id: bundle.id, version: bundle.version, roundId: bundle.roundId, files },
    verification: { checkId: test.id, exitCode: test.exitCode, log: test.log,
      reviewId: review.id, reviewerId: review.reviewerId, reviewRoundId: review.reviewRoundId,
      reviewResult: review.result, reviewConclusion: review.conclusion },
    checks: report.checks, sourceHashes, deliveryId: delivery.id,
    screenshot: join(report.fixture, 'actual-office-report-1920.png'),
    shutdown: { exitedPids: pids, unconfirmedPids, serverPort: Number(new URL(server.origin).port), serverPortClosed: !serverListening },
    finalNativeRuns: runs.map(run => ({ runtime: run.runtime, messageId: run.messageId,
      recordedState: run.state, receiptState: run.state === 'terminal' ? 'terminal' : 'unknown',
      pidExited: !alive(run.pid) })),
    limitations: [
      'The harness source report passed its business checks but omitted a final-native-turn shutdown gate. Codex accepted both tasks, then the server closed before its last natural-language completion receipt. The persisted active run is treated as unknown, not as successful terminal.',
      'The independent review passed numerical/version checks but flagged report.html line 95: 不存在包含关系 is unsupported when the source only says the population scope is unknown. This semantic recommendation remains in the immutable delivered sample.',
      'CSV has a total row in the identifier column and a UTF-8 BOM; downstream sums must exclude that total row. Raw identifier bytes retain leading zeroes; arbitrary spreadsheet import behavior is not certified.',
      'Only synthetic CSV/XLSX/PPTX input parsing and JSON/CSV/HTML output were validated; no claim of editable Word/PowerPoint creation or source Office document visual fidelity.',
    ],
    usageCoverage: 'Actual native turn receipts from this preserved fixture, including historical/pause attempts. Session records excluded to avoid double counting; cache and reasoning counts are subsets, not extra total. Final Codex run lacks a final completion receipt.',
    usage: turnRecords,
  };
  await writeFile(outputPath, JSON.stringify(audit, null, 2));
  console.log(JSON.stringify({ status: audit.status, outputPath, deliveryId: delivery.id, files: files.length, originalsUnchanged: sourceHashes.length, exitedPids: pids }));
} finally { db.close(); }
