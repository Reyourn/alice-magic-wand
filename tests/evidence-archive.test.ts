import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createEvidenceArchive, verifyEvidenceArchive } from '../src/server/evidence-archive.js';

const failures = vi.hoisted(() => ({ manifestWrite: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (failures.manifestWrite && String(args[0]).endsWith('manifest.pending.json')) {
      throw Object.assign(new Error('Simulated disk full'), { code: 'ENOSPC' });
    }
    return actual.writeFile(...args);
  } };
});

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'awb-evidence-archive-'));
  directories.push(root);
  const source = join(root, 'source'), target = join(root, 'archives', 'run-one');
  await mkdir(join(source, 'nested'), { recursive: true });
  const report = Buffer.from('{"state":"unknown","limitations":["缺少最终回执"],"passed":false}\r\n');
  const binary = Buffer.alloc(2 * 1024 * 1024 + 17, 91);
  await writeFile(join(source, 'report.json'), report);
  await writeFile(join(source, 'nested', '截图.png'), binary);
  return { root, source, target, report, binary };
}
afterEach(async () => {
  failures.manifestWrite = false;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const resolved = resolve(directory), remainder = relative(resolve(tmpdir()), resolved);
    if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)
      || !remainder.startsWith('awb-evidence-archive-')) throw new Error('Refusing cleanup outside the fixture temp root');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('explicit validation evidence archives', () => {
  it('preserves bytes, unknown outcomes and references, verifies without the original source', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'unselected.txt'), 'not selected');
    const manifest = await createEvidenceArchive({
      sourceDirectory: f.source, targetDirectory: f.target,
      files: [{ path: 'report.json', references: { workflowId: 'workflow-one' } }, 'nested/截图.png'],
      references: { validation: 'office-native', observedState: 'unknown' },
    });
    expect(manifest.scope).toBe('validation-evidence');
    expect(manifest.restoreReady).toBe(false);
    expect(manifest.files[0]).toMatchObject({ path: 'report.json', size: f.report.length, sha256: createHash('sha256').update(f.report).digest('hex'), references: { workflowId: 'workflow-one' } });
    expect((await readFile(join(f.target, 'files', 'report.json'))).equals(f.report)).toBe(true);
    expect((await readFile(join(f.target, 'files', 'nested', '截图.png'))).equals(f.binary)).toBe(true);
    await rename(f.source, join(f.root, 'source-moved'));
    const result = await verifyEvidenceArchive(f.target);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.manifest?.references).toEqual({ validation: 'office-native', observedState: 'unknown' });
  });

  it('reports missing, tampered and additional files together', async () => {
    const f = await fixture();
    await createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: ['report.json', 'nested/截图.png'] });
    await writeFile(join(f.target, 'files', 'report.json'), 'changed');
    await rm(join(f.target, 'files', 'nested', '截图.png'));
    await writeFile(join(f.target, 'surprise.txt'), 'extra');
    const result = await verifyEvidenceArchive(f.target);
    expect(result.valid).toBe(false);
    expect(result.issues.map(item => item.path).sort()).toEqual(['files/nested/截图.png', 'files/report.json', 'surprise.txt']);
  });

  it('checks the caller supplied historical hash before treating a current file as evidence', async () => {
    const f = await fixture(), expectedSha256 = createHash('sha256').update(f.report).digest('hex');
    await writeFile(join(f.source, 'report.json'), 'changed after validation');
    await expect(createEvidenceArchive({
      sourceDirectory: f.source, targetDirectory: f.target,
      files: [{ path: 'report.json', expectedSha256 }],
    })).rejects.toThrow('固定版本哈希不匹配');
    await writeFile(join(f.source, 'report.json'), f.report);
    const archive = await createEvidenceArchive({
      sourceDirectory: f.source, targetDirectory: f.target,
      files: [{ path: 'report.json', expectedSha256 }],
    });
    expect(archive.files[0]?.expectedSha256).toBe(expectedSha256);
    expect((await verifyEvidenceArchive(f.target)).valid).toBe(true);
  });

  it('refuses overwrite, either containment direction and case-folded duplicate paths', async () => {
    const f = await fixture();
    await mkdir(f.target, { recursive: true });
    await writeFile(join(f.target, 'original.txt'), 'keep');
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: ['report.json'] })).rejects.toThrow('已经存在');
    expect(await readFile(join(f.target, 'original.txt'), 'utf8')).toBe('keep');
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: join(f.source, 'archive'), files: ['report.json'] })).rejects.toThrow('互相包含');
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.root, files: ['report.json'] })).rejects.toThrow();
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: join(f.root, 'other'), files: ['report.json', 'REPORT.json'] })).rejects.toThrow('重复');
  });

  it.each(['../outside.txt', '/absolute.txt', 'C:\\outside.txt', 'nested/../../outside.txt', 'nested\\..\\outside.txt', 'report.json:secret', 'nested//file', 'CON.txt'])('refuses unsafe input path %s', async path => {
    const f = await fixture();
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: [path] })).rejects.toThrow();
    expect((await verifyEvidenceArchive(f.target)).valid).toBe(false);
  });

  it('refuses a source directory junction that points outside the selected source', async () => {
    const f = await fixture(), outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.txt'), 'must not copy');
    await symlink(outside, join(f.source, 'link'), 'junction');
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: ['link/private.txt'] })).rejects.toThrow('目录联接');
  });

  it('resolves target parent junctions before checking source containment', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    await symlink(f.source, alias, 'junction');
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: join(alias, 'archive'), files: ['report.json'] })).rejects.toThrow('互相包含');
  });

  it('does not treat an incomplete archive or a missing manifest as success', async () => {
    const f = await fixture();
    await createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: ['report.json'] });
    await writeFile(join(f.target, 'archive-state.json'), JSON.stringify({ scope: 'validation-evidence', status: 'incomplete' }));
    expect((await verifyEvidenceArchive(f.target)).issues.some(item => item.reason.includes('尚未完整'))).toBe(true);
    await rm(join(f.target, 'manifest.json'));
    const result = await verifyEvidenceArchive(f.target);
    expect(result.valid).toBe(false);
    expect(result.issues.some(item => item.path === 'manifest.json')).toBe(true);
  });

  it('leaves an explicit incomplete state when a write fails after copying evidence', async () => {
    const f = await fixture();
    failures.manifestWrite = true;
    await expect(createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: ['report.json'] })).rejects.toThrow('归档未完成');
    expect((await readFile(join(f.target, 'files', 'report.json'))).equals(f.report)).toBe(true);
    const state = JSON.parse(await readFile(join(f.target, 'archive-state.json'), 'utf8'));
    expect(state.status).toBe('incomplete');
    expect(state.error).toBe('Simulated disk full');
    expect((await verifyEvidenceArchive(f.target)).valid).toBe(false);
  });

  it('does not follow malicious manifest paths or payload junctions', async () => {
    const f = await fixture();
    await createEvidenceArchive({ sourceDirectory: f.source, targetDirectory: f.target, files: ['report.json'] });
    const manifest = JSON.parse(await readFile(join(f.target, 'manifest.json'), 'utf8'));
    manifest.files[0].path = '../source/report.json';
    await writeFile(join(f.target, 'manifest.json'), JSON.stringify(manifest));
    expect((await verifyEvidenceArchive(f.target)).issues.some(item => item.path === 'manifest.json')).toBe(true);
    manifest.files[0].path = 'report.json';
    await writeFile(join(f.target, 'manifest.json'), JSON.stringify(manifest));
    await rename(join(f.target, 'files'), join(f.target, 'old-files'));
    await symlink(f.source, join(f.target, 'files'), 'junction');
    const result = await verifyEvidenceArchive(f.target);
    expect(result.valid).toBe(false);
    expect(result.issues.some(item => item.path === 'files')).toBe(true);
    expect(result.issues.some(item => item.path === 'files/report.json')).toBe(true);
  });
});
