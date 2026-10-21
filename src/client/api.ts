import type { Attachment, ProjectDiscovery, RuntimeModelCatalog, Snapshot } from '../shared/types.js';
import { IMAGE_MIME_BY_EXTENSION, fileExtension } from '../shared/attachment-formats.js';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Read-only control-plane queries never trigger inference or persist a credential. */
export async function query<T>(path: string, signal?: AbortSignal): Promise<T> {
  await getToken();
  signal?.throwIfAborted();
  const response = await fetch(path, { cache: 'no-store', signal });
  const result: unknown = await response.json();
  signal?.throwIfAborted();
  if (!response.ok) throw new ApiError(result && typeof result === 'object' && 'error' in result ? String(result.error) : `读取失败（${response.status}）`, response.status);
  return result as T;
}

let token: string | undefined;
let bootstrap: Promise<string> | undefined;
type PendingMutation = { key: string; createdAt: number };
const uncertainRequests = new Map<string, PendingMutation>();
const mutationPrefix = 'awb:pending-mutation:v1:';
const maxPendingMutations = 512;
const pendingReviewAge = 30 * 24 * 60 * 60 * 1000;

function mutationStorage(): Storage | undefined {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
    if (typeof window === 'undefined') return undefined; // Non-browser unit tests.
  } catch { /* Refuse a write whose identity cannot survive reload. */ }
  throw new ApiError('浏览器无法保存待确认操作编号，请启用此本机站点的存储后重试。操作尚未发送。', 0);
}

async function reserveMutation(signature: string): Promise<PendingMutation> {
  const reserve = () => {
    const storage = mutationStorage();
    let prior = uncertainRequests.get(signature);
    if (storage) {
      const saved = storage.getItem(mutationPrefix + signature);
      if (saved) {
        try {
          const record = JSON.parse(saved) as PendingMutation;
          if (!/^[0-9a-f-]{36}$/i.test(record.key) || !Number.isFinite(record.createdAt)) throw new Error();
          prior = record;
        } catch { throw new ApiError('待确认操作编号损坏，请先核对服务端执行记录，当前操作未重新发送。', 0); }
      }
    }
    if (prior) {
      if (Date.now() - prior.createdAt > pendingReviewAge) throw new ApiError('此操作已超过 30 天未确认。原编号仍被保留，请先核对服务端记录后处理，工作台不会生成新编号重发。', 0);
      return prior;
    }
    const count = storage ? Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(key => key?.startsWith(mutationPrefix)).length : uncertainRequests.size;
    if (count >= maxPendingMutations) throw new ApiError('待确认操作已达到保存上限，请先核对已有操作的执行记录。新操作尚未发送。', 0);
    const record = { key: crypto.randomUUID(), createdAt: Date.now() };
    try { storage?.setItem(mutationPrefix + signature, JSON.stringify(record)); }
    catch { throw new ApiError('无法持久保存操作编号，新操作尚未发送。请检查此本机站点的存储空间。', 0); }
    uncertainRequests.set(signature, record);
    return record;
  };
  // Serialize the read/reserve section across same-origin browser windows.
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(mutationPrefix + signature, reserve) : reserve();
}

function finishMutation(signature: string): void {
  uncertainRequests.delete(signature);
  try { mutationStorage()?.removeItem(mutationPrefix + signature); } catch { /* Keeping the old key is safe if browser storage becomes unavailable. */ }
}

async function getToken(): Promise<string> {
  if (token) return token;
  bootstrap ??= fetch('/api/bootstrap', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new ApiError('无法建立本机连接，请确认工作台服务正在运行。', response.status);
    const body = await response.json() as { token: string };
    token = body.token;
    return token;
  }).finally(() => { bootstrap = undefined; });
  return bootstrap;
}

export async function readState(): Promise<Snapshot> {
  await getToken();
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) throw new ApiError('暂时无法读取工作台状态，请重试。', response.status);
  return response.json() as Promise<Snapshot>;
}

export async function readProjectDiscovery(options: { signal?: AbortSignal } = {}): Promise<ProjectDiscovery> {
  const response = await fetch('/api/projects/discovery', { cache: 'no-store', signal: options.signal });
  options.signal?.throwIfAborted();
  const result: unknown = await response.json();
  options.signal?.throwIfAborted();
  if (!response.ok) {
    const detail = result && typeof result === 'object' && 'error' in result ? String(result.error) : `项目检测失败（${response.status}）`;
    throw new ApiError(detail, response.status);
  }
  return result as ProjectDiscovery;
}

export async function readModelCatalog(agentId: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<RuntimeModelCatalog> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/models${options.refresh ? '?refresh=1' : ''}`, { cache: 'no-store', signal: options.signal });
  options.signal?.throwIfAborted();
  const result: unknown = await response.json();
  // A response body can finish after the dialog was closed or another member selected.
  options.signal?.throwIfAborted();
  if (!response.ok) {
    const detail = result && typeof result === 'object' && 'error' in result ? String(result.error) : `模型目录读取失败（${response.status}）`;
    throw new ApiError(detail, response.status);
  }
  return result as RuntimeModelCatalog;
}

export async function uploadImage(agentId: string, file: File): Promise<Attachment> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取「${file.name}」，请重新选择附件。`));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      if (separator < 0) reject(new Error(`无法读取「${file.name}」，请重新选择附件。`));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
  return await mutate(`/api/agents/${encodeURIComponent(agentId)}/attachments`, { name: file.name, mimeType: file.type || IMAGE_MIME_BY_EXTENSION[fileExtension(file.name)] || '', data }) as Attachment;
}

/** Retain the same key after uncertain network outcomes. A confirmed response ends the operation. */
export async function mutate(path: string, body: unknown, method = 'POST'): Promise<unknown> {
  const serialized = JSON.stringify(body);
  // Only an opaque digest and random operation identity reach persistent storage.
  // This includes sensitive connection writes: no URL, body, attachment or key is saved.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${method}:${path}:${serialized}`));
  const signature = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const { key } = await reserveMutation(signature);
  const credential = await getToken();
  let response: Response;
  try {
    response = await fetch(path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': credential, 'Idempotency-Key': key },
      body: serialized,
    });
  } catch {
    throw new ApiError('连接中断，尚不能确认操作结果。请检查状态后重试；重试会沿用原指令编号，避免重复执行。', 0);
  }
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new ApiError('服务回执不完整，尚不能确认操作结果。请核对状态后重试，重试会沿用原指令编号。', 0); }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) token = undefined;
    // A server error may follow a completed side effect. Keep its key until success.
    // Conflict can mean the original delivery is still unresolved. Do not turn
    // a retry into a second write by allocating a new operation identifier.
    const retrySafe = !!result && typeof result === 'object' && 'retrySafe' in result && result.retrySafe === true;
    if (retrySafe) finishMutation(signature);
    const message = result && typeof result === 'object' && 'error' in result ? String(result.error) : `操作失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  finishMutation(signature);
  return result;
}
