import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { mutate, query } from './api.js';

export function useResource<T>(path: string | undefined, revision: unknown = 0) {
  const [value, setValue] = useState<T>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, bump] = useState(0);
  const context = useRef(path);
  useEffect(() => {
    if (context.current !== path) setValue(undefined);
    context.current = path;
    if (!path) { setValue(undefined); setError(''); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void query<T>(path, controller.signal).then(next => { if (!controller.signal.aborted) setValue(next); }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, refresh, revision]);
  return { value: context.current === path ? value : undefined, loading: !!path && (context.current !== path || loading), error: context.current === path ? error : '', reload: useCallback(() => bump(v => v + 1), []) };
}

export function useAction(onSuccess?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  const pending = useRef(false);
  const execute = async <T,>(path: string, body: unknown = {}, method = 'POST', message = '操作已保存。'): Promise<T | undefined> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { const result = await mutate(path, body, method) as T; setNotice(message); onSuccess?.(); return result; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, notice, execute, setError };
}

export function Feedback({ error, notice, loading }: { error?: string; notice?: string; loading?: boolean }) {
  return <>{error && <p className="upgrade-error" role="alert">{error}</p>}{notice && <p className="upgrade-notice" role="status">{notice}</p>}{loading && <p className="upgrade-loading" role="status"><LoaderCircle size={15} className="spin" />正在读取本机记录…</p>}</>;
}
export function SectionHeader({ title, detail, children, reload }: { title: string; detail?: string; children?: ReactNode; reload?: () => void }) {
  return <div className="upgrade-section-header"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div><div className="upgrade-actions">{children}{reload && <button type="button" className="icon-button" aria-label={`刷新${title}`} onClick={reload}><RefreshCw size={16} /></button>}</div></div>;
}
export function NoRecords({ title, children }: { title: string; children?: ReactNode }) { return <div className="upgrade-empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>; }
export function localTime(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未记录'; }
export const runtimeLabels = { codex: 'Codex', claude: 'Claude Code', workbuddy: 'WorkBuddy' } as const;
