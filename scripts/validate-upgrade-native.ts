import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createAdapters } from '../src/server/runtime/index.js';
import { ConnectionManager } from '../src/server/connections/index.js';
import type { RuntimeKind } from '../src/shared/types.js';

/** Explicit, billable native connection acceptance. Never run as an automatic health check. */
if (!process.argv.includes('--confirm-usage')) {
  process.stderr.write('This check sends one real inference request per selected native runtime and uses its existing billing source. Run with --confirm-usage after authorization. Optional: --runtime=codex|claude|workbuddy.\n');
  process.exitCode = 2;
} else {
  const selected = process.argv.find(arg => arg.startsWith('--runtime='))?.slice('--runtime='.length);
  if (selected && !['codex', 'claude', 'workbuddy'].includes(selected)) throw new Error('Unknown runtime');
  const kinds: RuntimeKind[] = selected ? [selected as RuntimeKind] : ['codex', 'claude', 'workbuddy'];
  const directory = await mkdtemp(join(tmpdir(), 'awb-upgrade-native-'));
  const store = new Store(join(directory, 'verification.sqlite'));
  const adapters = createAdapters();
  const manager = new ConnectionManager({ dataDir: directory, store, adapters });
  const reports: unknown[] = [];
  try {
    for (const runtime of kinds) {
      const installed = await adapters[runtime].discover();
      if (!installed.available) { reports.push({ runtime, success: false, status: 'not-installed', detail: installed.detail }); process.exitCode = 1; continue; }
      process.stdout.write(`Validating ${runtime} with its existing native configuration...\n`);
      const profile = manager.ensureNative(runtime);
      const result = await manager.verify(profile.id, { cwd: directory, capabilities: ['inference', 'streaming', 'tools'] });
      // One request was sent. These vendors report cumulative session snapshots or
      // one terminal turn usage: persist only the final snapshot in this summary.
      const report = { runtime, version: installed.version, success: result.success, checkedAt: result.checkedAt,
        observedModel: result.observedModel ?? null, observedProvider: result.observedProvider ?? null,
        nativeSessionId: result.nativeSessionId, capabilities: result.capabilities, detail: result.detail,
        finalUsage: result.usage.at(-1) ?? null,
        coverage: 'Final native snapshot only. Cache/reasoning are subsets, not extra charges. Missing usage/provider stays unknown.' };
      reports.push(report); process.stdout.write(`${JSON.stringify(report)}\n`);
      if (!result.success) process.exitCode = 1;
    }
    const path = join(directory, 'native-connection-report.json');
    await writeFile(path, JSON.stringify({ checkedAt: new Date().toISOString(), scope: 'Native connection inference, streaming and temporary local MCP tool only; no login mutation or alternate provider fallback.', reports }, null, 2));
    process.stdout.write(`Report: ${path}\n`);
  } finally { await manager.close(); store.db.close(); }
}
