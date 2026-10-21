/**
 * Explicit local evidence archive; does not discover files, change evidence, or run models.
 * create --source=<existing-directory> --target=<new-directory> --file=<relative-path> [--file=...]
 * create --source=... --target=... --list=<JSON-file-with-files-and-optional-references>
 * verify --archive=<existing-archive-directory>
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEvidenceArchive, verifyEvidenceArchive, type EvidenceArchiveInput } from '../src/server/evidence-archive.js';

try {
  const [command, ...args] = process.argv.slice(2);
  const values = new Map<string, string[]>();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error('参数必须使用 --名称=值 格式');
    values.set(match[1]!, [...(values.get(match[1]!) ?? []), match[2]!]);
  }
  const one = (key: string, required = false): string | undefined => {
    const items = values.get(key) ?? [];
    if (items.length > 1 || required && items.length !== 1) throw new Error(`需要且只允许一个 --${key}=...`);
    return items[0];
  };
  if (command === 'create') {
    if ([...values.keys()].some(key => !['source', 'target', 'file', 'list'].includes(key))) throw new Error('create 包含未知参数');
    const sourceDirectory = resolve(one('source', true)!), targetDirectory = resolve(one('target', true)!);
    const listPath = one('list');
    let files: EvidenceArchiveInput['files'] = [], references: EvidenceArchiveInput['references'];
    if (listPath) {
      const list: unknown = JSON.parse(await readFile(resolve(listPath), 'utf8'));
      if (Array.isArray(list)) files = list;
      else if (list && typeof list === 'object' && 'files' in list && Array.isArray(list.files)) {
        files = list.files;
        references = (list as Pick<EvidenceArchiveInput, 'references'>).references;
      } else throw new Error('清单 JSON 必须是文件数组或包含 files 数组的对象');
    }
    files = [...files, ...(values.get('file') ?? [])];
    const manifest = await createEvidenceArchive({ sourceDirectory, targetDirectory, files, references });
    console.log(JSON.stringify({ status: 'complete', scope: manifest.scope, restoreReady: false, targetDirectory, files: manifest.files.length }));
  } else if (command === 'verify') {
    if ([...values.keys()].some(key => key !== 'archive')) throw new Error('verify 只接受 --archive=...');
    const result = await verifyEvidenceArchive(one('archive', true)!);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  } else throw new Error('用法：create --source=... --target=... --file=...；或 verify --archive=...');
} catch (error) {
  console.error(error instanceof Error ? error.message : '证据归档操作失败');
  process.exitCode = 1;
}
