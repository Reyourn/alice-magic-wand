import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { Agent, ConnectionProfile, RuntimeAuthenticationSession } from '../shared/types.js';
import { query } from './api.js';
import { Feedback, localTime, useAction } from './upgrade-common.js';

const states: Record<RuntimeAuthenticationSession['state'], string> = {
  starting: '正在启动授权', waiting: '等待原生授权', authenticated: '本进程已授权', failed: '授权失败', stopping: '正在确认停止', stopped: '进程已停止', unknown: '停止状态待核对',
};
export function runtimeAuthenticationPending(session: RuntimeAuthenticationSession): boolean { return ['starting', 'waiting', 'stopping', 'unknown'].includes(session.state); }
export function canAuthorizeRuntime(session: RuntimeAuthenticationSession): boolean { return session.state === 'waiting' && session.canAuthorize; }
export function canCancelRuntimeAuthentication(session: RuntimeAuthenticationSession): boolean { return ['starting', 'waiting', 'unknown'].includes(session.state); }

export function RuntimeAuthenticationCard({ session, agents, connections, stale, onChanged }: { session: RuntimeAuthenticationSession; agents: Agent[]; connections: ConnectionProfile[]; stale?: boolean; onChanged: () => void }) {
  // This action owns its own busy state, independent of pending member startup or connection verification.
  const action = useAction(onChanged);
  const member = agents.find(agent => agent.id === session.agentId);
  const connection = connections.find(profile => profile.id === session.connectionId);
  const authorize = !stale && !action.busy && canAuthorizeRuntime(session);
  return <article className={`runtime-auth-card runtime-auth-${session.state}`} aria-label={`${session.edition === 'china' ? '国内版' : '国际版'}执行会话授权`}>
    <header><strong>WorkBuddy {session.edition === 'china' ? '国内版' : '国际版'}</strong><span role="status">{['starting', 'stopping'].includes(session.state) && <LoaderCircle size={13} className="spin" />}{states[session.state]}</span></header>
    <dl><div><dt>成员</dt><dd>{member?.name || (session.agentId.startsWith('verify-') ? '连接验证会话' : session.agentId || '未绑定成员的验证会话')}</dd></div><div><dt>连接</dt><dd>{connection?.name || session.connectionId} · v{session.connectionRevision}</dd></div><div className="runtime-auth-cwd"><dt>固定工作区</dt><dd><code>{session.cwd}</code></dd></div></dl>
    <p>{session.detail}</p>
    <div className="runtime-auth-actions">{authorize ? <a className="primary-button" href={`/api/runtime-auth/${encodeURIComponent(session.id)}/open`} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开原生授权</a> : session.state === 'waiting' && <button type="button" className="secondary-button" disabled>{stale ? '请刷新授权状态' : action.busy ? '正在取消授权' : '等待原生授权入口'}</button>}{canCancelRuntimeAuthentication(session) && <button type="button" className="secondary-button" disabled={action.busy} onClick={() => void action.execute(`/api/runtime-auth/${encodeURIComponent(session.id)}/cancel`, {}, 'POST', '已请求取消此执行进程的授权，请等待停止确认。')}><Square size={12} />{session.state === 'unknown' ? '重试取消此进程' : '取消此进程授权'}</button>}<small>更新：{localTime(session.updatedAt)}</small></div>
    {session.state === 'unknown' && <p className="runtime-auth-attention">尚未确认旧进程停止，相关执行保持待核对，不能据此启动第二个写者。</p>}
    <Feedback {...action} />
  </article>;
}

export function RuntimeAuthenticationView({ sessions, agents, connections, loading, error, onRefresh }: { sessions?: RuntimeAuthenticationSession[]; agents: Agent[]; connections: ConnectionProfile[]; loading?: boolean; error?: string; onRefresh: () => void }) {
  const ordered = [...sessions ?? []].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pending = ordered.filter(runtimeAuthenticationPending), recent = ordered.filter(session => !runtimeAuthenticationPending(session)).slice(0, 8);
  return <section className={`runtime-auth-panel${pending.length ? ' has-pending' : ''}`} aria-label="执行会话授权">
    <header><strong><ShieldCheck size={15} />执行会话授权</strong><span>{loading && !sessions ? '正在读取原生授权记录…' : pending.length ? `${pending.length} 个执行进程等待处理` : '当前没有待处理的执行授权'}</span><button type="button" className="icon-button" aria-label="刷新执行会话授权" onClick={onRefresh}><RefreshCw size={14} /></button></header>
    {error && <p className="runtime-auth-error" role="alert">授权状态读取失败：{error}。旧记录保留，请刷新后再打开授权。</p>}
    {pending.length > 0 && <><p className="runtime-auth-explanation">每个执行进程独立进行原生授权。点击链接后在原生页面完成登录和授权；各版本按实际页面操作。国内版显示二维码时可扫码完成。工作台不保存授权网址或令牌。关闭服务后需重新授权，不会退出 WorkBuddy 桌面账号。</p><div className="runtime-auth-pending">{pending.map(session => <RuntimeAuthenticationCard key={session.id} session={session} agents={agents} connections={connections} stale={!!error} onChanged={onRefresh} />)}</div></>}
    {recent.length > 0 && <details className="runtime-auth-recent"><summary>最近授权记录 · {recent.length}</summary><p className="runtime-auth-explanation">“本进程已授权”只代表此原生进程通过授权，任务和调用结果仍以各自回执为准。已授权成员的停止操作位于成员会话。</p>{recent.map(session => <RuntimeAuthenticationCard key={session.id} session={session} agents={agents} connections={connections} onChanged={onRefresh} />)}</details>}
  </section>;
}

export function RuntimeAuthenticationPanel({ agents }: { agents: Agent[] }) {
  const [sessions, setSessions] = useState<RuntimeAuthenticationSession[]>();
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    // Reading names never delays the authorization record or requires the settings page to be open.
    void query<ConnectionProfile[]>('/api/connections', controller.signal).then(next => { if (!controller.signal.aborted) setConnections(next); }).catch(() => {});
    const poll = async () => {
      try {
        const next = await query<RuntimeAuthenticationSession[]>('/api/runtime-auth', controller.signal);
        if (controller.signal.aborted) return;
        setSessions(next); setError('');
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void poll(), 2000); } }
    };
    setLoading(true); void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  return <RuntimeAuthenticationView sessions={sessions} agents={agents} connections={connections} loading={loading} error={error} onRefresh={refresh} />;
}
