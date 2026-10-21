import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_CHARACTERS = 40000;
export const DOCUMENT_TIMEOUT_MS = 15000;
export interface ExtractedDocument { text: string; truncated: boolean; format: string; detail: string; }
let activeWorkers = 0;

export async function extractDocument(input: { name: string; bytes: Buffer }): Promise<ExtractedDocument> {
  if (!input.bytes.length) throw new Error('文件为空，无法读取内容。');
  if (input.bytes.length > MAX_DOCUMENT_BYTES) throw new Error('文件不能超过 20 MiB。');
  const extension = extname(input.name).toLowerCase();
  const worker = new URL(import.meta.url.endsWith('.ts') ? './document-worker.ts' : './document-worker.js', import.meta.url);
  const args = ['--max-old-space-size=256', ...(worker.pathname.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : []), fileURLToPath(worker)];
  if (activeWorkers >= 2) throw new Error('当前文件解析繁忙，请稍后重试。');
  activeWorkers++;
  try { return await new Promise<ExtractedDocument>((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', outputBytes = 0, failure: Error | undefined, settled = false;
    const fail = (error: Error) => { failure ??= error; child.kill(); };
    const timeout = setTimeout(() => fail(new Error('文件解析超过 15 秒，已停止。请拆分或简化文件后重试。')), DOCUMENT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > 512 * 1024) fail(new Error('文件解析输出超过限制，已停止。'));
      else output += chunk;
    });
    // Parser diagnostics can contain user content. Never forward them to logs/UI.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { failure ??= new Error('无法启动本地文件解析程序。'); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error('文件解析失败或超出内存限制，请拆分文件后重试。')); return; }
      try {
        const result = JSON.parse(output) as ExtractedDocument & { error?: string };
        if (result.error) { reject(new Error(result.error)); return; }
        if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > MAX_DOCUMENT_CHARACTERS || typeof result.truncated !== 'boolean' || typeof result.format !== 'string' || typeof result.detail !== 'string') throw new Error();
        resolve(result);
      } catch { reject(new Error('本地文件解析结果无效。')); }
    });
    child.stdin.end(JSON.stringify({ extension, data: input.bytes.toString('base64') }));
  }); } finally { activeWorkers--; }
}
