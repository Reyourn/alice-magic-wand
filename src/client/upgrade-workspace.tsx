import { useEffect, useState } from 'react';
import { History, Inbox, Search } from 'lucide-react';
import type { Agent, HistoryPage, InboxItem, Project, Snapshot } from '../shared/types.js';
import { ConnectionCenter } from './connection-center.js';
import { CapabilityCenter, RoleCatalog } from './capability-center.js';
import { WorkflowCanvas } from './workflow-canvas.js';
import { ArtifactExplorer } from './artifact-explorer.js';
import { Feedback, localTime, NoRecords, SectionHeader, useAction, useResource } from './upgrade-common.js';
export type WorkspaceView = 'chat' | 'workflow' | 'artifacts' | 'inbox' | 'settings' | 'history';
export const workspaceViews: { id: WorkspaceView; label: string }[] = [{ id: 'chat', label: '会话' }, { id: 'workflow', label: '编排' }, { id: 'artifacts', label: '成果' }];

export function UpgradeWorkspace({ view, project, snapshot, selectedAgent, onChanged, onNavigate }: { view: WorkspaceView; project?: Project; snapshot: Snapshot; selectedAgent?: Agent; onChanged: () => void; onNavigate: (view: WorkspaceView, agentId?: string, workflowId?: string) => void }) {
  const [settingsTab, setSettingsTab] = useState<'connections' | 'roles' | 'capabilities'>('connections');
  if (view === 'workflow') return <WorkflowCanvas project={project} snapshot={snapshot} onChanged={onChanged} />;
  if (view === 'artifacts') return <ArtifactExplorer project={project} snapshot={snapshot} onChanged={onChanged} />;
  if (view === 'inbox') return <InboxPanel projectId={project?.id} onChanged={onChanged} onNavigate={onNavigate} revision={snapshot.events.at(-1)?.id} />;
  if (view === 'history') return <HistoryPanel projectId={project?.id} snapshot={snapshot} initialAgentId={selectedAgent?.id} />;
  if (view === 'settings') return <div className="settings-workspace"><nav className="settings-tabs" aria-label="设置类别">{([['connections', '接入与认证'], ['roles', '角色模板'], ['capabilities', '能力中心']] as const).map(([id, title]) => <button key={id} aria-current={settingsTab === id ? 'page' : undefined} className={settingsTab === id ? 'selected' : ''} onClick={() => setSettingsTab(id)}>{title}</button>)}</nav>{settingsTab === 'connections' ? <ConnectionCenter snapshot={snapshot} projectId={project?.id ?? ''} onChanged={onChanged} /> : settingsTab === 'roles' ? <RoleCatalog /> : <CapabilityCenter snapshot={snapshot} onChanged={onChanged} />}</div>;
  return null;
}

function InboxPanel({ projectId, onChanged, revision, onNavigate }: { projectId?: string; onChanged: () => void; revision?: number; onNavigate: (view: WorkspaceView, agentId?: string, workflowId?: string) => void }) {
  const data = useResource<InboxItem[]>(`/api/inbox${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`, revision);
  const [showResolved, setShowResolved] = useState(false);
  useEffect(() => { const timer = setInterval(data.reload, 10000); return () => clearInterval(timer); }, [data.reload]);
  const items = data.value?.filter(item => showResolved || item.state === 'open');
  return <section className="upgrade-page"><SectionHeader title="待你处理" detail="计划确认、问题回答、认证异常、恢复和交付集中在这里。" reload={data.reload}><label className="checkbox-label"><input type="checkbox" checked={showResolved} onChange={event => setShowResolved(event.target.checked)} />包含已处理</label></SectionHeader><Feedback loading={data.loading && !data.value} error={data.error} /><div className="inbox-list">{items?.map(item => <InboxCard key={item.id} item={item} onNavigate={onNavigate} onChanged={() => { data.reload(); onChanged(); }} />)}{items?.length === 0 && <NoRecords title="当前没有待处理事项">任务需要你的判断时会出现在这里。</NoRecords>}</div></section>;
}
function InboxCard({ item, onChanged, onNavigate }: { item: InboxItem; onChanged: () => void; onNavigate: (view: WorkspaceView, agentId?: string, workflowId?: string) => void }) {
  const [answer, setAnswer] = useState(''); const action = useAction(onChanged);
  return <article className="upgrade-card inbox-card"><header><h3><Inbox size={16} />{item.title}</h3><span className="upgrade-tag">{item.state === 'open' ? '待处理' : '已处理'}</span></header><p className="preserve-lines">{item.detail}</p><small>{localTime(item.createdAt)}{item.taskId && ` · 任务 ${item.taskId}`}</small>{item.answer && <p>处理记录：{item.answer}</p>}{item.state === 'open' && <div className="upgrade-actions">{item.agentId && <button className="secondary-button" onClick={() => onNavigate('chat', item.agentId)}>前往成员会话处理</button>}{item.workflowId && <button className="secondary-button" onClick={() => onNavigate(item.kind === 'delivery' ? 'artifacts' : 'workflow', undefined, item.workflowId)}>{item.kind === 'delivery' ? '查看交付候选' : '核对工作流'}</button>}{item.kind === 'authentication' && <button className="secondary-button" onClick={() => onNavigate('settings')}>打开接入中心</button>}</div>}{item.state === 'open' && !/^(runtime|approval|workflow):/.test(item.id) && <form className="editor-form" onSubmit={event => { event.preventDefault(); void action.execute(`/api/inbox/${item.id}/resolve`, { answer }, 'POST', '处理记录已提交。'); }}><label>答复 / 处理说明<textarea value={answer} required onChange={event => setAnswer(event.target.value)} rows={2} /></label><div className="upgrade-actions"><button className="secondary-button" disabled={action.busy || !answer.trim()}>提交处理记录</button></div></form>}<Feedback {...action} /></article>;
}

function HistoryPanel({ projectId, snapshot, initialAgentId }: { projectId?: string; snapshot: Snapshot; initialAgentId?: string }) {
  const [agentId, setAgentId] = useState(initialAgentId ?? '');
  const [taskId, setTaskId] = useState('');
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [before, setBefore] = useState<number>();
  const [cursors, setCursors] = useState<(number | undefined)[]>([]);
  const params = new URLSearchParams({ limit: '100', ...(projectId ? { projectId } : {}), ...(agentId ? { agentId } : {}), ...(taskId ? { taskId } : {}), ...(submittedSearch ? { search: submittedSearch } : {}), ...(before ? { before: String(before) } : {}) });
  const data = useResource<HistoryPage>(`/api/history?${params}`, before === undefined ? snapshot.events.at(-1)?.id : undefined);
  const reset = () => { setBefore(undefined); setCursors([]); };
  return <section className="upgrade-page"><SectionHeader title="执行历史" detail="按成员、任务和关键词读取持久记录。历史回执与当前会话分开核对。" reload={data.reload} /><form className="history-filters" onSubmit={event => { event.preventDefault(); reset(); setSubmittedSearch(search); }}><select aria-label="历史成员" value={agentId} onChange={event => { reset(); setAgentId(event.target.value); }}><option value="">全部成员</option>{snapshot.agents.filter(agent => !projectId || agent.projectId === projectId).map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select><select aria-label="历史任务" value={taskId} onChange={event => { reset(); setTaskId(event.target.value); }}><option value="">全部任务</option>{snapshot.tasks.filter(task => !projectId || task.projectId === projectId).map(task => <option value={task.id} key={task.id}>{task.title}</option>)}</select><input aria-label="搜索历史" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索指令、工具和结果" /><button className="secondary-button"><Search size={14} />搜索</button></form><Feedback error={data.error} loading={data.loading} /><div className="history-timeline">{data.value?.events.map(event => <article key={event.id}><span className="timeline-marker"><History size={13} /></span><header><strong>{snapshot.agents.find(agent => agent.id === event.agentId)?.name || '工作台'}</strong><small>{event.type} · {localTime(event.createdAt)}</small></header><p className="preserve-lines">{event.text || '事件记录'}</p>{event.data && <details><summary>记录详情</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}</article>)}{data.value?.events.length === 0 && <NoRecords title="没有匹配的历史记录">尝试更换成员、任务或关键词。</NoRecords>}</div><div className="upgrade-actions"><button className="secondary-button" disabled={data.loading || !cursors.length} onClick={() => { setBefore(cursors.at(-1)); setCursors(current => current.slice(0, -1)); }}>更新一页</button><button className="secondary-button" disabled={data.loading || !data.value?.nextBefore} onClick={() => { setCursors(current => [...current, before]); setBefore(data.value?.nextBefore); }}>更早一页</button></div></section>;
}
