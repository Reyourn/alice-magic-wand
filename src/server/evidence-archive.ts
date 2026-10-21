import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const manifestName = 'manifest.json';
const stateName = 'archive-state.json';
const scope = 'validation-evidence' as const;
type References = Record<string, string>;

export interface EvidenceArchiveInputFile { path: string; expectedSha256?: string; references?: References; }
export interface EvidenceArchiveFile extends EvidenceArchiveInputFile { sha256: string; size: number; }
export interface EvidenceArchiveManifest {
  schemaVersion: 1;
  scope: typeof scope;
  restoreReady: false;
  createdAt: string;
  sourceDirectory: string;
  references?: References;
  files: EvidenceArchiveFile[];
}
export interface EvidenceArchiveInput {
  sourceDirectory: string;
  targetDirectory: string;
  files: (string | EvidenceArchiveInputFile)[];
  references?: References;
}
export interface EvidenceArchiveVerification {
  valid: boolean;
  scope: typeof scope;
  restoreReady: false;
  archiveDirectory: string;
  manifest?: EvidenceArchiveManifest;
  issues: { path: string; reason: string }[];
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function filePath(value: unknown): string {
  if (typeof value !== 'string' || !value || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error('清单文件必须使用源目录内的相对路径');
  }
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part)
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`清单文件路径无效或越界：${value}`);
  }
  return parts.join('/');
}

function references(value: unknown): References | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, item]) => !key || typeof item !== 'string')) {
    throw new Error('证据引用必须是名称与字符串值组成的对象');
  }
  return { ...value as References };
}

/** Deliberately reject all links, including in-root links, so copies have one unambiguous source. */
async function regularFile(root: string, path: string): Promise<string> {
  let current = root;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`不允许符号链接或目录联接：${path}`);
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`不是普通文件路径：${path}`);
    }
    if (!inside(root, await realpath(current))) throw new Error(`文件路径越过源目录：${path}`);
  }
  return current;
}

async function absentDestination(path: string): Promise<string> {
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      await lstat(ancestor);
      if (!missing.length) throw new Error('归档目标已经存在，拒绝覆盖');
      const actual = await realpath(ancestor);
      if (!(await lstat(actual)).isDirectory()) throw new Error('归档目标的上级不是目录');
      return resolve(actual, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('找不到归档目标的上级目录');
      ancestor = parent;
    }
  }
}

async function digest(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), size };
}

async function copyVerified(source: string, destination: string, expectedSha256?: string): Promise<{ sha256: string; size: number }> {
  const before = await digest(source);
  if (expectedSha256 && before.sha256 !== expectedSha256) throw new Error('源文件与声明的固定版本哈希不匹配');
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(createReadStream(source), new Transform({
    transform(chunk: Buffer, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); },
  }), createWriteStream(destination, { flags: 'wx' }));
  const copied = { sha256: hash.digest('hex'), size };
  const after = await digest(source), saved = await digest(destination);
  if ([copied, after, saved].some(value => value.sha256 !== before.sha256 || value.size !== before.size)) {
    throw new Error('证据在复制期间发生变化或复制校验失败；归档未完成');
  }
  return copied;
}

/**
 * Copies only an explicit file list; does not interpret report contents or follow their paths.
 * This is a local evidence archive, not a database backup or an executable recovery package.
 */
export async function createEvidenceArchive(input: EvidenceArchiveInput): Promise<EvidenceArchiveManifest> {
  const source = await realpath(resolve(input.sourceDirectory));
  if (!(await lstat(source)).isDirectory()) throw new Error('证据源必须是目录');
  const requestedTarget = resolve(input.targetDirectory), target = await absentDestination(requestedTarget);
  if (inside(source, target) || inside(target, source)
    || inside(resolve(input.sourceDirectory), requestedTarget) || inside(requestedTarget, resolve(input.sourceDirectory))) {
    throw new Error('源目录与归档目标不得相同或互相包含');
  }
  if (!Array.isArray(input.files) || input.files.length === 0) throw new Error('至少明确选择一个证据文件');
  const selected = input.files.map(item => {
    const value = typeof item === 'string' ? { path: item } : item;
    if (!value || typeof value !== 'object') throw new Error('证据文件清单无效');
    if (value.expectedSha256 !== undefined && (typeof value.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedSha256))) {
      throw new Error('expectedSha256 必须是 64 位小写十六进制 SHA256');
    }
    return { path: filePath(value.path), expectedSha256: value.expectedSha256, references: references(value.references) };
  });
  const seen = new Set<string>();
  for (const item of selected) {
    const key = item.path.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`清单包含重复文件路径：${item.path}`);
    seen.add(key);
    const path = await regularFile(source, item.path);
    if (item.expectedSha256 && (await digest(path)).sha256 !== item.expectedSha256) {
      throw new Error(`源文件与声明的固定版本哈希不匹配：${item.path}`);
    }
  }
  const manifest: EvidenceArchiveManifest = {
    schemaVersion: 1, scope, restoreReady: false, createdAt: new Date().toISOString(),
    sourceDirectory: source, references: references(input.references), files: [],
  };
  await mkdir(dirname(target), { recursive: true });
  if (await realpath(dirname(target)) !== dirname(target)) throw new Error('归档目标上级目录发生变化');
  await mkdir(target); // Exclusive creation: another invocation cannot overwrite this archive.
  const statePath = join(target, stateName);
  try {
    await writeFile(statePath, JSON.stringify({ status: 'incomplete', scope, createdAt: manifest.createdAt }, null, 2), { flag: 'wx' });
    for (const item of selected) {
      const current = await regularFile(source, item.path), destination = join(target, 'files', item.path);
      await mkdir(dirname(destination), { recursive: true });
      const copied = await copyVerified(current, destination, item.expectedSha256);
      await regularFile(source, item.path);
      manifest.files.push({ ...item, ...copied });
    }
    const temporaryManifest = join(target, 'manifest.pending.json');
    await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await rename(temporaryManifest, join(target, manifestName));
    await writeFile(statePath, JSON.stringify({ status: 'complete', scope, createdAt: manifest.createdAt, completedAt: new Date().toISOString() }, null, 2));
    return manifest;
  } catch (error) {
    await writeFile(statePath, JSON.stringify({
      status: 'incomplete', scope, createdAt: manifest.createdAt, failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : '归档失败',
    }, null, 2)).catch(() => {});
    throw new Error(`证据归档未完成，保留目录供核对：${target}`, { cause: error });
  }
}

function parseManifest(value: unknown): EvidenceArchiveManifest {
  const data = value as EvidenceArchiveManifest | undefined;
  if (!data || data.schemaVersion !== 1 || data.scope !== scope || data.restoreReady !== false
    || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))
    || typeof data.sourceDirectory !== 'string' || !Array.isArray(data.files) || !data.files.length) {
    throw new Error('归档清单格式无效');
  }
  references(data.references);
  const seen = new Set<string>();
  for (const item of data.files) {
    if (!item || filePath(item.path) !== item.path || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('归档文件清单格式无效');
    if (item.expectedSha256 !== undefined && item.expectedSha256 !== item.sha256) throw new Error('固定版本哈希与归档内容哈希不同');
    const key = item.path.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error('归档清单包含重复文件');
    seen.add(key);
    references(item.references);
  }
  return data;
}

/** Read-only verification. Original source files are not required and are never opened. */
export async function verifyEvidenceArchive(directory: string): Promise<EvidenceArchiveVerification> {
  const result: EvidenceArchiveVerification = { valid: false, scope, restoreReady: false, archiveDirectory: resolve(directory), issues: [] };
  const issue = (path: string, reason: string) => { result.issues.push({ path, reason }); };
  let root: string;
  try {
    root = await realpath(result.archiveDirectory);
    if (!(await lstat(root)).isDirectory()) throw new Error('归档位置不是目录');
  } catch { issue('.', '归档目录不存在或不可读'); return result; }
  try {
    const state = JSON.parse(await readFile(await regularFile(root, stateName), 'utf8')) as { status?: string; scope?: string };
    if (state.status !== 'complete' || state.scope !== scope) issue(stateName, '归档尚未完整完成');
  } catch { issue(stateName, '归档完成状态缺失或无效'); }
  try { result.manifest = parseManifest(JSON.parse(await readFile(await regularFile(root, manifestName), 'utf8'))); }
  catch { issue(manifestName, '归档清单缺失、无效或包含越界路径'); return result; }
  const expected = new Set([manifestName, stateName, ...result.manifest.files.map(file => `files/${file.path}`)]);
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, full = join(current, entry.name);
      if (entry.isSymbolicLink()) { issue(path, '归档包含符号链接或目录联接'); continue; }
      if (entry.isDirectory()) await walk(full, path);
      else if (!entry.isFile()) issue(path, '归档包含非普通文件');
      else if (!expected.has(path)) issue(path, '清单之外的额外文件');
    }
  };
  try { await walk(root, ''); } catch { issue('.', '无法枚举归档全部文件'); }
  for (const file of result.manifest.files) {
    const path = `files/${file.path}`;
    try {
      const actual = await digest(await regularFile(root, path));
      if (actual.sha256 !== file.sha256 || actual.size !== file.size) issue(path, '内容哈希或大小不匹配');
    } catch { issue(path, '文件缺失、不可读或路径不安全'); }
  }
  result.valid = result.issues.length === 0;
  return result;
}
