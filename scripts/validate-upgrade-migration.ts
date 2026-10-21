/** Rehearse startup migration on a SQLite backup. Never opens the source for writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkbenchService } from '../src/server/service.js';
import type { Agent, RuntimeAdapter, RuntimeKind } from '../src/shared/types.js';

const sourceArgument = process.argv.find(value => value.startsWith('--source='))?.slice(9);
if (!sourceArgument) throw new Error('Pass --source=<existing-workbench.sqlite>; only its isolated backup is migrated.');
const source = resolve(sourceArgument);
const output = resolve('.workbench', 'migration-validation', String(Date.now()));
mkdirSync(output, { recursive: true });
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fileHashes = () => Object.fromEntries([source, `${source}-wal`].filter(existsSync).map(path => [path, digest(readFileSync(path))]));
const beforeFiles = fileHashes();
const original = new DatabaseSync(source, { readOnly: true });
const copyPath = join(output, 'workbench.sqlite');
type Row = { collection: string; id: string; json: string };
const rows = original.prepare('SELECT collection,id,json FROM entities ORDER BY collection,id').all() as Row[];
const events = original.prepare('SELECT id,json FROM events ORDER BY id').all();
const version = Number((original.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
await backup(original, copyPath);
original.close();
let attempts = 0;
const adapters = (['codex', 'claude', 'workbuddy'] as RuntimeKind[]).map(kind => ({
  kind,
  async discover() { throw new Error('Migration must not inspect or start a native runtime'); },
  async connect() { attempts++; throw new Error('Migration must not dispatch native calls'); },
} satisfies RuntimeAdapter));
const service = new WorkbenchService({ dataDir: output, adapters });
let report: Record<string, unknown>;
try {
  // Compare persisted evidence byte-for-byte, independently of UI summaries.
  const preserved = ['projects', 'messages', 'artifacts', 'attachments', 'bindings', 'usage', 'usage_origins', 'usage_checkpoints', 'usage_turn_sources'];
  for (const row of rows.filter(row => preserved.includes(row.collection))) {
    const current = service.store.db.prepare('SELECT json FROM entities WHERE collection=? AND id=?').get(row.collection, row.id) as { json: string };
    assert.equal(current.json, row.json, `Historical ${row.collection}/${row.id} changed`);
  }
  for (const row of rows.filter(row => row.collection === 'agents')) {
    const old = JSON.parse(row.json) as Agent;
    const current = service.getAgent(row.id);
    for (const field of ['id', 'projectId', 'name', 'role', 'instructions', 'runtime', 'model', 'nativeSessionId', 'worktree'] as const) {
      assert.deepEqual(current[field], old[field], `Member ${field} changed`);
    }
    assert.equal(current.connectionId, old.connectionId ?? `native-${old.runtime}`);
    if (!old.connectionId) assert.equal(service.connectionManager.get(current.connectionId!).verifications.length, 0, 'Migration fabricated verification');
  }
  assert.deepEqual(service.store.db.prepare('SELECT id,json FROM events WHERE id<=? ORDER BY id').all(events.length ? (events.at(-1) as { id: number }).id : 0), events);
  const backups = readdirSync(output).filter(name => name.includes('.pre-upgrade-'));
  if (version < 1) {
    assert.equal(backups.length, 1, 'Expected a pre-migration backup');
    const saved = new DatabaseSync(join(output, backups[0]!), { readOnly: true });
    try {
      assert.deepEqual(saved.prepare('SELECT collection,id,json FROM entities ORDER BY collection,id').all(), rows);
      assert.deepEqual(saved.prepare('SELECT id,json FROM events ORDER BY id').all(), events);
    } finally { saved.close(); }
  }
  await new Promise<void>(done => setImmediate(done));
  assert.equal(attempts, 0);
  report = { passed: true, sourceVersion: version, migratedCopyVersion: 1, sourceUnchanged: true, nativeCalls: attempts, historicalEvents: events.length, historicalEntities: rows.length, preservedCollections: preserved, backupVerified: version < 1, fixture: output, scope: 'Real legacy SQLite backup and service migration; native adapters denied, no project/Beads commands or model requests.' };
} finally { await service.close(); }
assert.deepEqual(fileHashes(), beforeFiles, 'Original SQLite or WAL changed during rehearsal');
writeFileSync(join(output, 'report.json'), JSON.stringify(report!, null, 2));
console.log(JSON.stringify(report!));
