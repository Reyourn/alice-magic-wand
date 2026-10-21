import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowRight, Bot, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Command, FileCheck2, FolderGit2, GitBranch, Hand, Info, Layers2, Link2, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeft, PanelRight, Paperclip, Pencil, Plus, RefreshCw, Send, ShieldCheck, Square, Terminal, TriangleAlert, Users, X } from 'lucide-react';
import type { Agent, Artifact, RuntimeKind, Snapshot, Task, WorkbenchEvent } from '../shared/types.js';
import { mutate, readState, uploadImage } from './api.js';
import { DraftImages, attachmentAccept, messageAttachments, MessageImages, useDraftImages } from './image-attachments.js';
import { ModelSettings, modelReceiptText } from './model-settings.js';
import { ProjectPicker } from './project-picker.js';
import { AgentTokenUsage, TaskTokenUsage } from './token-usage.js';
import { MemberEditor } from './member-editor.js';
import { UpgradeWorkspace, workspaceViews, type WorkspaceView } from './upgrade-workspace.js';
import { RuntimeAuthenticationPanel } from './runtime-authentication.js';
import './upgrade.css';

const runtimeName: Record<RuntimeKind, string> = { codex: 'Codex', claude: 'Claude Code', workbuddy: 'WorkBuddy' };
const stateName: Record<string, string> = { offline: '未启动', starting: '启动中', idle: '就绪', running: '执行中', waiting_approval: '待批准', interrupting: '中断中', stopped: '已停止', error: '运行异常', unknown: '待核对', open: '待处理', in_progress: '进行中', blocked: '受阻', closed: '已完成', deferred: '已延后' };
const artifactName: Record<Artifact['kind'], string> = { commit: '提交', test: '测试', review: '审查', pr: 'Pull Request', file: '文件', summary: '总结' };
const empty: Snapshot = { projects: [], agents: [], tasks: [], bindings: [], artifacts: [], approvals: [], runtimes: [], events: [], errors: [], usage: [], usageSummaries: [] };
type Modal = { kind: 'project' | 'agent' | 'task' | 'artifact' | 'help' | 'model'; agent?: Agent } | null;
type Run = (path: string, body: unknown, success?: string, method?: string) => Promise<boolean>;
const isController = (agent?: Agent) => !!agent && (agent.memberKind ? agent.memberKind === 'controller' : /^(controller|主控)$/i.test(agent.role));

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function Status({ value }: { value: string }) { return <span className={`status status-${value}`}><i />{stateName[value] ?? value}</span>; }
function RuntimeMark({ runtime, small = false }: { runtime: RuntimeKind; small?: boolean }) { return <span aria-hidden="true" className={`runtime-mark runtime-${runtime} ${small ? 'small' : ''}`}>{runtime === 'codex' ? <Command size={small ? 14 : 18} /> : runtime === 'claude' ? '✳' : 'W'}</span>; }
function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3>{children}</div>; }

export function Workbench({ readOnlyPreview = false }: { readOnlyPreview?: boolean } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [projectId, setProjectId] = useState('');
  const pendingProjectId = useRef('');
  const [agentId, setAgentId] = useState('');
  const [connection, setConnection] = useState<'loading' | 'connected' | 'reconnecting' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [rightTab, setRightTab] = useState<'tasks' | 'artifacts'>('tasks');
  const [mobileTab, setMobileTab] = useState<'team' | 'chat' | 'tasks'>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(232);
  const [detailsWidth, setDetailsWidth] = useState(340);
  const [view, setView] = useState<WorkspaceView>('chat');
  const selectedProjectView = useRef('');
  useEffect(() => {
    if (!projectId) return;
    if (readOnlyPreview) { setView('chat'); return; }
    selectedProjectView.current = projectId;
    try { const sizes = JSON.parse(localStorage.getItem(`awb:panels:${projectId}`) || '{}') as { left?: number; right?: number }; setSidebarWidth(Math.min(360, Math.max(200, sizes.left ?? 232))); setDetailsWidth(Math.min(560, Math.max(300, sizes.right ?? 340))); } catch { /* use default panel sizes */ }
    try { const saved = localStorage.getItem(`awb:view:${projectId}`); if (['chat', 'workflow', 'artifacts', 'inbox', 'settings', 'history'].includes(saved ?? '')) setView(saved as WorkspaceView); else setView('chat'); } catch { setView('chat'); }
  }, [projectId, readOnlyPreview]);
  const changeView = (next: WorkspaceView) => { if (readOnlyPreview && next !== 'chat') { setError('当前为只读外观预览，请返回工作台执行操作。'); return; } setView(next); if (projectId) { try { localStorage.setItem(`awb:view:${projectId}`, next); } catch { /* optional view preference */ } } };
  const savePanel = (side: 'left' | 'right', width: number) => { if (side === 'left') setSidebarWidth(width); else setDetailsWidth(width); if (projectId) try { localStorage.setItem(`awb:panels:${projectId}`, JSON.stringify({ left: side === 'left' ? width : sidebarWidth, right: side === 'right' ? width : detailsWidth })); } catch { /* optional layout preference */ } };
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  const [narrowWorkspace, setNarrowWorkspace] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 899px)');
    const update = () => setNarrowWorkspace(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const requestGeneration = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const inFlight = useRef(new Set<string>());
  const errorRef = useRef('');
  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) { refreshQueued.current = true; return refreshing.current; }
    const generation = requestGeneration.current;
    const execute = async () => {
      do {
        refreshQueued.current = false;
        try {
          const next = await readState();
          if (generation !== requestGeneration.current) return;
          setSnapshot(next);
          const newlyRegistered = pendingProjectId.current;
          if (newlyRegistered && next.projects.some(project => project.id === newlyRegistered)) {
            pendingProjectId.current = '';
            setProjectId(newlyRegistered);
          } else setProjectId(current => next.projects.some(project => project.id === current) ? current : next.projects[0]?.id ?? '');
        } catch (err) {
          if (generation !== requestGeneration.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setConnection('error');
        }
      } while (refreshQueued.current && generation === requestGeneration.current);
    };
    refreshing.current = execute().finally(() => { refreshing.current = null; });
    return refreshing.current;
  }, []);
  useEffect(() => {
    let active = true;
    let stream: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const next = await readState();
        if (!active) return;
        setSnapshot(next);
        const newlyRegistered = pendingProjectId.current;
        if (newlyRegistered && next.projects.some(project => project.id === newlyRegistered)) {
          pendingProjectId.current = '';
          setProjectId(newlyRegistered);
        } else setProjectId(current => next.projects.some(project => project.id === current) ? current : next.projects[0]?.id ?? '');
        stream = new EventSource('/api/events');
        stream.onopen = () => { if (active) { setConnection('connected'); void refresh(); } };
        stream.onmessage = () => {
          if (!active || timer) return;
          timer = setTimeout(() => { timer = undefined; void refresh(); }, 160);
        };
        stream.onerror = () => { if (active) setConnection('reconnecting'); };
      } catch (err) {
        if (!active) return;
        setConnection('error');
        setError(err instanceof Error ? err.message : String(err));
        reconnect = setTimeout(() => { void connect(); }, 4000);
      }
    };
    void connect();
    const poll = setInterval(() => { void refresh(); }, 12000);
    return () => { active = false; ++requestGeneration.current; stream?.close(); clearTimeout(timer); clearTimeout(reconnect); clearInterval(poll); };
  }, [refresh]);
  useEffect(() => {
    const agents = snapshot.agents.filter(agent => agent.projectId === projectId);
    setAgentId(current => agents.some(agent => agent.id === current) ? current : agents.find(isController)?.id ?? agents[0]?.id ?? '');
  }, [projectId, snapshot.agents]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);
  const run: Run = async (path, body, success, method) => {
    if (readOnlyPreview) {
      errorRef.current = '当前为只读外观预览，请返回工作台执行操作。';
      setError(errorRef.current);
      return false;
    }
    const signature = `${path}:${JSON.stringify(body)}`;
    if (inFlight.current.has(signature)) return false;
    inFlight.current.add(signature); setBusy(current => current + 1); setError(''); errorRef.current = '';
    try {
      const result = await mutate(path, body, method);
      if (path === '/api/projects' && result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
        // A state request started before registration may still be in flight.
        // Select only once a returned snapshot actually contains the new project.
        pendingProjectId.current = result.id;
      }
      if (success) setNotice(success);
      void refresh();
      return true;
    } catch (err) { errorRef.current = err instanceof Error ? err.message : String(err); setError(errorRef.current); return false; }
    finally { inFlight.current.delete(signature); setBusy(current => current - 1); }
  };
  const project = snapshot.projects.find(item => item.id === projectId);
  const agents = snapshot.agents.filter(item => item.projectId === projectId);
  const agent = agents.find(item => item.id === agentId);
  const tasks = snapshot.tasks.filter(item => item.projectId === projectId);
  const artifacts = snapshot.artifacts.filter(item => item.projectId === projectId);
  const selectAgent = (id: string) => { setAgentId(id); setMobileTab('chat'); changeView('chat'); };
  const sidebarVisible = narrowWorkspace ? mobileTab === 'team' : sidebarOpen;
  const detailsVisible = narrowWorkspace ? mobileTab === 'tasks' : detailsOpen;
  const toggleSidebar = () => { if (narrowWorkspace) setMobileTab(sidebarVisible ? 'chat' : 'team'); else setSidebarOpen(current => !current); };
  const toggleDetails = () => { if (narrowWorkspace) setMobileTab(detailsVisible ? 'chat' : 'tasks'); else setDetailsOpen(current => !current); };
  const closeDetails = () => { setDetailsOpen(false); if (narrowWorkspace) setMobileTab('chat'); detailsToggleRef.current?.focus(); };
  return <div className={`app-shell${sidebarVisible ? '' : ' sidebar-collapsed'}${detailsVisible ? ' details-open' : ''}`}>
    <aside style={{ width: narrowWorkspace ? undefined : sidebarWidth }} id="workbench-sidebar" hidden={!sidebarVisible} inert={!sidebarVisible} className={`sidebar ${mobileTab === 'team' ? 'mobile-visible' : ''}`} aria-label="项目与团队">
      <a className="brand" href="#" onClick={event => event.preventDefault()}><span className="brand-mark"><Command size={23} /></span><span>爱丽丝的魔杖<small>本地开发指挥台</small></span><span className="local-badge">LOCAL</span></a>
      <div className="project-switch"><span className="eyebrow">当前项目</span><button className="icon-button" aria-label="添加项目" onClick={() => setModal({ kind: 'project' })}><Plus size={16} /></button>
        <div className="select-with-icon"><FolderGit2 size={18} /><select aria-label="当前项目" value={projectId} onChange={event => setProjectId(event.target.value)}>{!project && <option value="">尚未注册项目</option>}{snapshot.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></div>
        {project && <span className="project-path" title={project.path}>{project.path}</span>}
      </div>
      <div className="team-heading"><span className="eyebrow">团队成员 <b>{agents.length.toString().padStart(2, '0')}</b></span><button className="icon-button" aria-label="添加成员" disabled={!project} onClick={() => setModal({ kind: 'agent' })}><Plus size={16} /></button></div>
      {project && <button className="text-button core-team-entry" disabled={busy > 0} title={project.kind === 'office' ? '主控、数据分析、独立审查；已有成员保留' : '主控、全栈开发、独立审查；已有成员保留'} onClick={() => void run(`/api/projects/${project.id}/core-team`, { preset: project.kind === 'office' ? 'office' : 'development' }, '核心团队已补齐，请在接入中心核对连接与调用能力。')}>补齐核心团队</button>}
      <nav className="agent-list" aria-label="选择成员">{agents.map(item => <button key={item.id} className={`agent-item ${item.id === agentId ? 'selected' : ''}`} onClick={() => selectAgent(item.id)}><RuntimeMark runtime={item.runtime} /><span className="agent-item-text"><strong>{item.name}{isController(item) && <span className="tiny-tag">主控</span>}</strong><span>{runtimeName[item.runtime]}<span className="dot-separator">·</span>{item.controlMode === 'human' ? '人工接管' : stateName[item.state]}</span></span><span title={stateName[item.state]} className={`state-dot state-${item.state}`} /></button>)}
        {!agents.length && <div className="sidebar-empty"><Users size={22} /><p>让合适的 Agent<br />加入你的开发团队</p><button className="text-button" disabled={!project} onClick={() => setModal({ kind: 'agent' })}>创建首位成员 <ArrowRight size={14} /></button></div>}
      </nav>
      <div className="sidebar-bottom"><nav className="workbench-utility-nav" aria-label="工作台工具"><button className={view === 'inbox' ? 'selected' : ''} onClick={() => changeView('inbox')}>待你处理</button><button className={view === 'history' ? 'selected' : ''} onClick={() => changeView('history')}>执行历史</button><button className={view === 'settings' ? 'selected' : ''} onClick={() => changeView('settings')}>设置与接入</button></nav><details className="runtime-disclosure"><summary><span className="eyebrow">本机执行工具 <span>{snapshot.runtimes.filter(item => item.available).length} / 3</span></span><ChevronDown size={13} /></summary>{(['codex', 'claude', 'workbuddy'] as const).map(kind => { const runtime = snapshot.runtimes.find(item => item.kind === kind); return <div className="runtime-row" key={kind} title={runtime?.detail ?? '正在检查本机工具'}><RuntimeMark runtime={kind} small /><span>{runtimeName[kind]}</span><span className={runtime?.available ? 'available' : 'unavailable'}>{runtime ? runtime.available ? '已检测' : '未就绪' : '检查中'}</span></div>; })}</details><button className="help-link" onClick={() => setModal({ kind: 'help' })}><CircleHelp size={15} />连接与使用说明<ArrowRight size={14} /></button></div>
      {!narrowWorkspace && <PanelResize name="项目与团队宽度" side="left" width={sidebarWidth} min={200} max={360} onChange={width => savePanel('left', width)} />}
    </aside>
    <main className="workspace">
      <header className="topbar"><button className="icon-button sidebar-toggle" aria-label={sidebarVisible ? '收起项目与团队' : '展开项目与团队'} aria-expanded={sidebarVisible} aria-controls="workbench-sidebar" onClick={toggleSidebar}><PanelLeft size={18} /></button><div className="workspace-heading"><div className="breadcrumb"><Layers2 size={15} /><span>{project?.name ?? '你的工作台'}</span></div><h1 className="workspace-title">{agent?.name ?? '指挥中心'}</h1></div><div className={`connection connection-${connection}`}><span className="state-dot" />{connection === 'connected' ? '本机已连接' : connection === 'loading' ? '正在连接' : connection === 'reconnecting' ? '实时连接重试中' : '连接异常'}</div><button className="icon-button" aria-label="刷新工作台状态" onClick={() => void refresh()}><RefreshCw size={15} /></button><button ref={detailsToggleRef} className="details-toggle" aria-expanded={detailsVisible} aria-controls="workbench-details" onClick={toggleDetails}><PanelRight size={16} /><span>任务与成果</span><span className="details-toggle-count" title={`${tasks.length} 项任务，${artifacts.length} 项成果`}>{tasks.length + artifacts.length}</span></button></header>
      <nav className="workspace-view-tabs" aria-label="工作内容">{workspaceViews.map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined} className={view === item.id ? 'selected' : ''} onClick={() => changeView(item.id)}>{item.label}</button>)}<span /><button className={view === 'inbox' ? 'selected' : ''} onClick={() => changeView('inbox')}>待你处理</button><button className={view === 'settings' ? 'selected' : ''} onClick={() => changeView('settings')}>设置</button></nav>
      <div className="mobile-nav" role="tablist" aria-label="工作区">{([['team', Users, '团队'], ['chat', MessageSquare, '会话'], ['tasks', Layers2, '任务与成果']] as const).map(([id, Icon, label]) => <button key={id} role="tab" aria-selected={mobileTab === id} className={mobileTab === id ? 'active' : ''} onClick={() => setMobileTab(id)}><Icon size={16} />{label}</button>)}</div>
      {!readOnlyPreview && <RuntimeAuthenticationPanel agents={snapshot.agents} />}
      {(error || snapshot.errors.length > 0) && <div className="alert error-alert" role="alert"><TriangleAlert size={17} /><span>{error || snapshot.errors.join('；')}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => { setError(''); setSnapshot(current => ({ ...current, errors: [] })); }}><X size={16} /></button></div>}
      {notice && <div className="toast" role="status"><Check size={15} />{notice}</div>}
      <div className="workspace-columns" hidden={view !== 'chat'}>
        <section className={`conversation ${mobileTab === 'chat' ? 'mobile-visible' : ''}`} aria-label="Agent 会话">{agent ? <Conversation key={agent.id} agent={agent} snapshot={snapshot} busy={busy > 0} readOnlyPreview={readOnlyPreview} run={run} onEdit={() => setModal({ kind: 'agent', agent })} onModelSettings={() => setModal({ kind: 'model', agent })} /> : <div className="welcome"><span className="welcome-kicker"><span className="state-dot" />YOUR LOCAL COMMAND CENTER</span><div className="welcome-graphic"><div className="graphic-orbit" /><span className="graphic-main"><Command size={36} /></span><span className="graphic-member member-one">✳</span><span className="graphic-member member-two">W</span><span className="graphic-link"><GitBranch size={16} /></span></div><h1>把目标交给团队，<br /><span>把进展掌握在手里。</span></h1><p className="welcome-copy">连接 Codex、Claude Code 与 WorkBuddy。<br />在同一个地方协作、接管和检查成果。</p><div className="onboarding-steps"><div className={project ? 'step complete' : 'step current'}><span>{project ? <Check size={15} /> : '1'}</span><div><strong>接入本地项目</strong><p>自动发现 Git 仓库，连接 Beads 任务</p></div>{!project && <button className="primary-button" onClick={() => setModal({ kind: 'project' })}>添加项目<ArrowRight size={15} /></button>}</div><div className={project ? 'step current' : 'step'}><span>2</span><div><strong>组建你的团队</strong><p>从一位主控 Agent 开始</p></div>{project && <button className="primary-button" onClick={() => setModal({ kind: 'agent' })}>创建主控<Plus size={15} /></button>}</div><div className="step"><span>3</span><div><strong>下达第一个目标</strong><p>实时查看执行过程，随时调整方向</p></div></div></div><div className="welcome-foot"><ShieldCheck size={14} />运行在本机 · 凭据保留在原生工具</div></div>}</section>
        <aside style={{ width: narrowWorkspace ? undefined : detailsWidth }} id="workbench-details" hidden={!detailsVisible} inert={!detailsVisible} className={`details-panel ${mobileTab === 'tasks' ? 'mobile-visible' : ''}`} aria-label="任务与成果">{!narrowWorkspace && <PanelResize name="任务与成果宽度" side="right" width={detailsWidth} min={300} max={560} onChange={width => savePanel('right', width)} />}<div className="panel-tabs" role="tablist" aria-label="项目详情"><button role="tab" aria-selected={rightTab === 'tasks'} onClick={() => setRightTab('tasks')} className={rightTab === 'tasks' ? 'active' : ''}>任务<span>{tasks.length}</span></button><button role="tab" aria-selected={rightTab === 'artifacts'} onClick={() => setRightTab('artifacts')} className={rightTab === 'artifacts' ? 'active' : ''}>成果<span>{artifacts.length}</span></button><button className="icon-button" aria-label={rightTab === 'tasks' ? '创建任务' : '登记成果'} disabled={!project || (rightTab === 'artifacts' && !agents.length)} onClick={() => setModal({ kind: rightTab === 'tasks' ? 'task' : 'artifact' })}><Plus size={17} /></button><button className="icon-button details-close" aria-label="收起任务与成果" onClick={closeDetails}><X size={16} /></button></div><div className="panel-content">{rightTab === 'tasks' ? <><div className="panel-heading"><span>从目标到交付</span><span>{tasks.filter(task => task.status === 'closed').length} 已完成</span></div>{tasks.length ? tasks.map(task => <TaskCard key={task.id} task={task} snapshot={snapshot} agents={agents} run={run} busy={busy > 0} selectAgent={selectAgent} />) : <EmptyState icon={<Layers2 size={25} />} title="下一步，从一个任务开始"><p>将目标发送给主控，由它拆解分派；<br />也可以自己创建任务。</p><button className="secondary-button" disabled={!project} onClick={() => setModal({ kind: 'task' })}><Plus size={14} />创建任务</button></EmptyState>}</> : <><div className="panel-heading"><span>可检查的交付证据</span><FileCheck2 size={14} /></div>{artifacts.length ? artifacts.slice().reverse().map(item => <ArtifactCard key={item.id} artifact={item} snapshot={snapshot} />) : <EmptyState icon={<FileCheck2 size={25} />} title="成果会在这里汇集"><p>提交、测试、审查与 PR，<br />每份成果都关联到具体成员。</p><button className="secondary-button" disabled={!project || !agents.length} onClick={() => setModal({ kind: 'artifact' })}><Plus size={14} />登记成果</button></EmptyState>}</>}</div><div className="panel-footer"><GitBranch size={14} /><span>任务由 Beads 管理 · 代码由 Git 管理</span></div></aside>
      </div>
      {view !== 'chat' && <UpgradeWorkspace key={projectId} view={view} project={project} snapshot={snapshot} selectedAgent={agent} onChanged={() => void refresh()} onNavigate={(next, memberId, workflowId) => { if (memberId) setAgentId(memberId); if (workflowId) try { localStorage.setItem(`awb:workflow:${projectId}`, workflowId); } catch {} changeView(next); }} />}
    </main>
    {modal && <ModalFrame title={modal.kind === 'project' ? '发现与添加项目' : modal.kind === 'agent' ? modal.agent ? '编辑成员' : '添加团队成员' : modal.kind === 'task' ? '创建任务' : modal.kind === 'artifact' ? '登记成果' : modal.kind === 'model' ? '模型设置' : '连接与使用说明'} onClose={() => setModal(null)} busy={busy > 0}>{modal.kind === 'project' ? <ProjectPicker projects={snapshot.projects} busy={busy > 0} run={run} getError={() => errorRef.current} onDone={() => setModal(null)} /> : modal.kind === 'help' ? <Help snapshot={snapshot} /> : modal.kind === 'model' && modal.agent ? <ModelSettings key={modal.agent.id} agent={snapshot.agents.find(item => item.id === modal.agent?.id) ?? modal.agent} agents={snapshot.agents} busy={busy > 0} run={run} getError={() => errorRef.current} onDone={() => setModal(null)} /> : modal.kind === 'agent' ? <MemberEditor key={modal.agent?.id ?? 'new'} agent={modal.agent} projectId={projectId} agents={agents} busy={busy > 0} run={run} getError={() => errorRef.current} onDone={() => setModal(null)} /> : <Editor key={`${modal.kind}:${modal.agent?.id ?? 'new'}`} modal={modal} projectId={projectId} agents={agents} tasks={tasks} snapshot={snapshot} run={run} busy={busy > 0} getError={() => errorRef.current} onDone={() => setModal(null)} />}</ModalFrame>}
  </div>;
}

function Conversation({ agent, snapshot, run, busy, readOnlyPreview, onEdit, onModelSettings }: { agent: Agent; snapshot: Snapshot; run: Run; busy: boolean; readOnlyPreview: boolean; onEdit: () => void; onModelSettings: () => void }) {
  const [text, setText] = useState('');
  const textVersion = useRef(0);
  const draft = useDraftImages();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedImages, setSubmittedImages] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const submittingAny = busy || submitting;
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionInfoRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = sessionInfoRef.current;
    if (!details) return;
    details.open = false;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return;
      event.preventDefault();
      details.open = false;
      details.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [agent.id]);
  const controller = isController(agent);
  const runtime = snapshot.runtimes.find(item => item.kind === agent.runtime);
  const events = snapshot.events.filter(event => event.agentId === agent.id && !/^(runtime.state|runtime.ready|state|heartbeat|agent.updated)$/.test(event.type));
  const modelDescription = `配置：${agent.model || '原生默认'} · 回执：${modelReceiptText(agent.observedModel)}${agent.observedProvider ? ` · 供应商回执：${agent.observedProvider}` : ''}`;
  const approval = snapshot.approvals.filter(item => item.agentId === agent.id);
  const grouped = groupEvents(events);
  const currentTask = snapshot.tasks.find(task => task.id === agent.currentTaskId);
  const executionActive = ['running', 'starting', 'waiting_approval', 'interrupting'].includes(agent.state);
  const canInterrupt = ['running', 'starting', 'waiting_approval', 'unknown', 'error'].includes(agent.state);
  const sendableContent = (!!text.trim() || draft.images.length > 0) && runtime?.available !== false && agent.state !== 'unknown' && (controller || !!agent.worktree);
  const canSend = sendableContent && !submittingAny;
  const showStop = canInterrupt && !sendableContent;
  const actionLabel = submittingAny ? '正在提交' : showStop ? '中断当前执行' : executionActive ? '发送并纠正' : '发送指令';
  useEffect(() => { if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [snapshot.events, approval.length, atBottom]);
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend || submittingRef.current) return;
    const submitted = text.trim();
    const submittedTextVersion = textVersion.current;
    // Preview protection runs before reading or uploading any attachment.
    if (readOnlyPreview) {
      await run(`/api/agents/${agent.id}/messages`, { text: submitted, mode: 'interrupt', source: 'human' });
      return;
    }
    submittingRef.current = true; setSubmitting(true); draft.setError('');
    const images = [...draft.current.current];
    const imageIds = new Set(images.map(image => image.id));
    setSubmittedImages(imageIds);
    try {
      for (const image of images) {
        if (!draft.mounted.current) return;
        // Keep confirmed upload receipts for a retry if a later upload or send fails.
        image.uploaded ??= await uploadImage(agent.id, image.file);
      }
      if (!draft.mounted.current) return;
      const payload = { text: submitted, mode: 'interrupt', source: 'human', ...(images.length ? { attachmentIds: images.map(image => image.uploaded!.id) } : {}) };
      if (await run(`/api/agents/${agent.id}/messages`, payload, '指令已提交；如有当前执行，将在确认停止后继续。') && draft.mounted.current) {
        if (textVersion.current === submittedTextVersion) setText('');
        draft.remove(imageIds); setAtBottom(true);
      }
    } catch (err) {
      if (draft.mounted.current) draft.setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      if (draft.mounted.current) { setSubmitting(false); setSubmittedImages(new Set()); }
    }
  };
  const interrupt = () => {
    if (submittingAny || submittingRef.current || !canInterrupt) return;
    void run(`/api/agents/${agent.id}/interrupt`, {}, '中断请求已提交，代码与会话将保留。');
  };
  return <>
    <div className="conversation-tools">
      <Status value={agent.state} />
      <details ref={sessionInfoRef} className="session-info">
        <summary><Info size={14} /><span>会话信息</span><ChevronDown size={12} /></summary>
        <div className="session-info-content">
          <dl className="session-info-facts">
            <div><dt>执行工具</dt><dd>{runtimeName[agent.runtime]}</dd></div>
            <div><dt>成员角色</dt><dd>{({ controller: '主控', developer: '开发', reviewer: '审查', qa: 'QA' } as Record<string, string>)[agent.role] ?? agent.role}</dd></div>
            <div><dt>配置模型</dt><dd>{agent.model || '原生默认'}</dd></div>
            <div><dt>模型回执</dt><dd>{modelReceiptText(agent.observedModel)}</dd></div>
            <div><dt>供应商回执</dt><dd>{agent.observedProvider || '尚未收到供应商回执'}</dd></div>
            <div><dt>执行权限</dt><dd>{agent.permissionMode === 'read-only' ? '只读' : '工作区可写'}</dd></div>
          </dl>
          <p className="session-control-status">{agent.controlMode === 'human' ? <Hand size={15} /> : <Activity size={15} />}{agent.controlMode === 'human' ? '你正在接管此成员，主控暂停自动派发。' : controller ? '主控可协调团队任务。' : '此成员由主控协调。'}</p>
        </div>
      </details>
      <button disabled={busy} className={`text-button control-mode-button${agent.controlMode === 'human' ? ' is-human-controlled' : ''}`} onClick={() => void run(`/api/agents/${agent.id}/control`, { mode: agent.controlMode === 'human' ? 'auto' : 'human' }, agent.controlMode === 'human' ? '已交还主控，将核对最新任务状态。' : '已接管，主控暂停向此成员派发。')}>{agent.controlMode === 'human' ? <><CheckCheck size={14} />交还主控</> : <><Hand size={14} />人工接管</>}</button>
      <button className="icon-button" aria-label={`编辑 ${agent.name}`} onClick={onEdit}><MoreHorizontal size={19} /></button>
      <AgentTokenUsage agent={agent} summaries={snapshot.usageSummaries ?? []} compact />
    </div>
    {currentTask && <div className="current-task"><GitBranch size={14} /><span>当前任务</span><strong>{currentTask.title}</strong></div>}
    {runtime && !runtime.available && <div className="runtime-warning"><TriangleAlert size={15} /><div><strong>{runtimeName[agent.runtime]} 尚未就绪</strong><span>{runtime.detail}</span></div></div>}
    {agent.lastError && <div className="runtime-warning"><TriangleAlert size={15} /><span>{agent.lastError}</span></div>}
    {agent.state === 'unknown' && <div className="recovery-strip"><span>先核对原进程已退出，再恢复会话。旧指令不会自动重发。</span><button className="secondary-button" disabled={busy} onClick={() => void run(`/api/agents/${agent.id}/recover`, { action: 'resume' }, '已核对旧进程，可以发送新的明确指令继续。')}>核对后恢复</button></div>}
    <div className="message-scroll" ref={scrollRef} onScroll={() => { const view = scrollRef.current; if (view) setAtBottom(view.scrollHeight - view.scrollTop - view.clientHeight < 80); }}>
      <div className="message-content">
      {!grouped.length && <div className="conversation-empty"><span className="eyebrow">{controller ? '一个目标，一支团队' : '准备开始协作'}</span><h2>{controller ? '你想和团队一起完成什么？' : `给 ${agent.name} 一个清晰的方向。`}</h2><p>{controller ? '描述目标、约束和验收要求。主控会结合团队能力拆解任务，并把执行进展带回这里。' : agent.worktree ? '直接指挥成员时，工作台会进入人工接管，避免主控覆盖你的指令。' : '先打开「任务与成果」，创建任务并分派给此成员。工作台会准备独立工作区，随后可在这里补充指令。'}</p><div className="prompt-hint"><MessageSquare size={18} /><span>{controller ? '例如：先检查项目结构，为下一个迭代制定实现方案，完成后安排审查。' : '例如：检查当前任务的实现，并说明还需要哪些验证。'}</span></div><small>这里将显示真实的会话、工具调用和执行结果。</small></div>}
      {grouped.map(event => <EventItem key={conversationEventKey(event)} event={event} agent={agent} />)}
      {approval.map(item => <div className="approval-card" key={item.id}><span className="approval-heading"><ShieldCheck size={18} />需要你的批准</span><strong>{item.tool}</strong><pre>{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2)}</pre><p>请检查操作内容后决定是否允许。</p><div><button className="secondary-button" disabled={busy} onClick={() => void run(`/api/agents/${agent.id}/approvals/${encodeURIComponent(item.id)}`, { allow: false }, '已拒绝本次操作。')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => void run(`/api/agents/${agent.id}/approvals/${encodeURIComponent(item.id)}`, { allow: true }, '已批准本次操作。')}>允许本次操作</button></div></div>)}
      {['running', 'starting', 'interrupting'].includes(agent.state) && <div className="working-indicator" role="status"><LoaderCircle size={14} className="spin" />{agent.state === 'interrupting' ? '正在确认执行停止…' : agent.state === 'starting' ? '正在启动原生会话…' : `${agent.name} 正在工作…`}</div>}
      </div>
    </div>
    <div className="conversation-footer">
    {!atBottom && <button className="scroll-latest" onClick={() => { setAtBottom(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }}><ArrowDown size={14} />回到最新</button>}
    <form className={`composer${dragging ? ' composer--dragging' : ''}`} onSubmit={event => void send(event)}
      onPaste={event => {
        const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
        if (files.length) { if (!event.clipboardData.getData('text/plain')) event.preventDefault(); draft.add(files); }
      }}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); ++dragDepth.current; setDragging(true); } }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } } }}
      onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current = 0; setDragging(false); draft.add(Array.from(event.dataTransfer.files)); } }}>
      {dragging && <div className="composer-drop-hint" aria-hidden="true">松开鼠标添加附件</div>}
      <DraftImages images={draft.images} locked={submittedImages} onRemove={id => draft.remove(new Set([id]))} />
      <textarea aria-label={`发送给 ${agent.name} 的指令`} placeholder={controller ? '告诉主控你想完成什么…' : `向 ${agent.name} 发送指令…`} value={text} onChange={event => { ++textVersion.current; setText(event.target.value); }} rows={3} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      {draft.error && <p className="inline-error composer-image-error" role="alert">{draft.error}</p>}
      {draft.images.length > 0 && <p className="composer-image-help">{submitting ? '正在提交附件与指令…' : `${draft.images.length} 个附件 · 最多 4 个 · 图片 5 MiB，文件 20 MiB${draft.images.some(image => image.previewUrl) ? ' · 图片需所选模型支持识图' : ''}`}</p>}
      <div className="composer-bottom">
        <div className="composer-options">
          <input ref={fileInputRef} type="file" accept={attachmentAccept} multiple aria-label="选择附件" hidden onChange={event => { draft.add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <button type="button" className="icon-button image-add-button" aria-label="添加附件" title="添加图片、PDF、DOCX、XLSX、PPTX 或文本与代码文件，也可粘贴或拖入" onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /></button>
          <button type="button" className="model-settings-button" title={modelDescription} onClick={onModelSettings}><span>模型设置</span><span className="model-setting-value">{agent.model || '原生默认'}</span><ChevronDown size={12} /></button>
          <span className="composer-hint">发送即纠正 · Ctrl + Enter</span>
        </div>
        <button className={`primary-button composer-action${showStop ? ' composer-action--stop' : ''}`} type={showStop ? 'button' : 'submit'} disabled={submittingAny || (!showStop && !canSend)} aria-label={actionLabel} aria-busy={submittingAny} title={actionLabel} onClick={showStop ? interrupt : undefined}>{submittingAny ? <LoaderCircle size={17} className="spin" /> : showStop ? <Square size={14} fill="currentColor" /> : <Send size={17} />}</button>
      </div>
    </form>
    <div className="composer-note">{agent.worktree ? <><GitBranch size={12} /><span title={agent.worktree}>{agent.worktree}</span></> : <><ShieldCheck size={12} /><span>中断会保留会话及已产生的代码成果</span></>}</div>
    </div>
  </>;
}

function toolIdentity(event: WorkbenchEvent): string | undefined {
  if (event.type !== 'runtime.tool') return;
  const id = event.data?.itemId ?? event.data?.id ?? event.data?.tool_use_id;
  if (typeof id !== 'string' && typeof id !== 'number') return;
  return JSON.stringify([event.projectId ?? '', event.agentId ?? '', event.data?.messageId ?? '', id]);
}

export function conversationEventKey(event: WorkbenchEvent): string {
  const tool = toolIdentity(event);
  return tool ? `tool:${tool}` : `event:${event.id}`;
}

function completeToolOutput(event: WorkbenchEvent): string | undefined {
  if (typeof event.data?.aggregatedOutput === 'string') return event.data.aggregatedOutput;
  if (event.data?.phase !== 'completed') return;
  if (typeof event.data.content === 'string') return event.data.content;
  if (Array.isArray(event.data.content)) {
    const parts = event.data.content.filter((part): part is { text: string } => !!part && typeof part === 'object' && typeof part.text === 'string');
    if (parts.length) return parts.map(part => part.text).join('\n');
  }
}

export function groupEvents(events: WorkbenchEvent[]): WorkbenchEvent[] {
  const result: WorkbenchEvent[] = [];
  const tools = new Map<string, WorkbenchEvent>();
  for (const event of events) {
    if (event.type === 'runtime.tool') {
      const key = toolIdentity(event);
      const existing = key ? tools.get(key) : undefined;
      const phase = event.data?.phase;
      if (existing) {
        // A completed aggregate is authoritative; a late delta must not append it again.
        if (existing.data?.phase === 'completed' && phase !== 'completed') continue;
        existing.text = completeToolOutput(event) ?? ((existing.text ?? '') + (event.text ?? ''));
        existing.data = { ...existing.data, ...event.data };
      } else {
        // Empty chunks can precede the visible call when the server's event window rolls.
        if (phase === 'output' && !event.text?.trim()) continue;
        const grouped = { ...event, text: completeToolOutput(event) ?? event.text, data: event.data ? { ...event.data } : undefined };
        result.push(grouped);
        if (key) tools.set(key, grouped);
      }
      continue;
    }
    const last = result.at(-1);
    if (/(^|\.)message$/.test(event.type) && last && /(^|\.)delta$/.test(last.type) && last.agentId === event.agentId && last.data?.messageId === event.data?.messageId && event.text === last.text) result[result.length - 1] = { ...event, id: last.id, createdAt: last.createdAt };
    else if (/(^|\.)result$/.test(event.type) && last?.text === event.text && event.text) result.push({ ...event, text: '本轮执行结束。' });
    else if (/(^|\.)delta$/.test(event.type) && last?.type === event.type && last.agentId === event.agentId && last.data?.messageId === event.data?.messageId && last.data?.itemId === event.data?.itemId) last.text = (last.text ?? '') + (event.text ?? '');
    else result.push({ ...event });
  }
  return result;
}

function EventItem({ event, agent }: { event: WorkbenchEvent; agent: Agent }) {
  const images = messageAttachments(event.data?.attachments);
  const human = /(^|[._])(human|user|message_sent)([._]|$)/.test(event.type) || event.data?.source === 'human';
  const controllerMessage = event.data?.source === 'controller' || event.data?.source === 'system';
  const tool = /tool/.test(event.type);
  const error = /error|failed/.test(event.type);
  const result = /result|completed/.test(event.type);
  const label = human ? '你' : controllerMessage ? '主控协调' : error ? '运行异常' : tool ? '工具调用' : result ? '执行结果' : /interrupt/.test(event.type) ? '执行中断' : /control/.test(event.type) ? '控制权变更' : /dispatch/.test(event.type) ? '任务派发' : /approval/.test(event.type) ? '权限请求' : agent.name;
  if (!event.text && !images.length && !tool && !error && !result && !/dispatch|control|interrupt|approval|queue/.test(event.type)) return null;
  if (tool) {
    const data = event.data ?? {};
    const command = typeof data.command === 'string' ? data.command : typeof data.tool === 'string' ? `${typeof data.server === 'string' ? data.server + '.' : ''}${data.tool}` : typeof data.name === 'string' ? data.name : typeof data.type === 'string' ? data.type : '工具执行';
    const { aggregatedOutput: _aggregate, content: content, ...metadata } = data;
    const details = { ...metadata, ...(completeToolOutput(event) === undefined && content !== undefined ? { content } : {}) };
    const phase = data.phase === 'completed' ? '已结束' : data.phase === 'started' || data.phase === 'output' || data.phase === 'progress' ? '执行中' : '调用记录';
    return <article className="event-item event-tool"><div className="event-meta"><span><Terminal size={15} />工具调用 · {phase}</span><time dateTime={event.createdAt}>{time(event.createdAt)}</time></div><div className="event-text" title={command} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{command}</div><details className="event-details"><summary>查看调用详情{event.text?.trim() ? ` · ${event.text.length.toLocaleString('zh-CN')} 字符输出` : ''}</summary><pre>{JSON.stringify(details, null, 2)}</pre>{event.text?.trim() && <pre aria-label="工具输出">{event.text}</pre>}</details></article>;
  }
  return <article className={`event-item ${human ? 'event-human' : ''} ${tool ? 'event-tool' : ''} ${error ? 'event-error' : ''}`}><div className="event-meta"><span>{human ? <span className="human-avatar">你</span> : tool ? <Terminal size={15} /> : error ? <TriangleAlert size={15} /> : result ? <CheckCheck size={15} /> : <RuntimeMark runtime={agent.runtime} small />}{label}</span><time dateTime={event.createdAt}>{time(event.createdAt)}</time></div>{event.text && <div className="event-text">{event.text}</div>}<MessageImages images={images} />{event.data && (tool || error || result) && Object.keys(event.data).length > 0 && <details className="event-details"><summary>查看{tool ? '调用' : '事件'}详情</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>}</article>;
}

function TaskCard({ task, snapshot, agents, run, busy, selectAgent }: { task: Task; snapshot: Snapshot; agents: Agent[]; run: Run; busy: boolean; selectAgent: (id: string) => void }) {
  const binding = snapshot.bindings.find(item => item.taskId === task.id && item.projectId === task.projectId);
  const [assignee, setAssignee] = useState(binding?.agentId ?? '');
  const [expanded, setExpanded] = useState(false);
  const [reviewTaskId, setReviewTaskId] = useState('');
  const [reason, setReason] = useState('');
  const [returning, setReturning] = useState(false);
  const boundAgent = agents.find(item => item.id === binding?.agentId);
  return <article className={`task-card ${task.status === 'closed' ? 'task-closed' : ''}`}><button className="task-summary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><div><code>{task.id}</code><Status value={task.status} /></div><h3>{task.title}</h3><div className="task-meta"><span>{boundAgent?.name ?? task.owner ?? '尚未分派'}</span>{task.priority !== undefined && <span>P{task.priority}</span>}<ChevronDown size={14} className={expanded ? 'rotate' : ''} /></div></button>{expanded && <div className="task-body"><TaskTokenUsage task={task} summaries={snapshot.usageSummaries ?? []} />{task.description && <p className="preserve-lines">{task.description}</p>}{task.acceptance && <div className="task-section"><span className="eyebrow">验收要求</span><p className="preserve-lines">{task.acceptance}</p></div>}{task.dependencies.length > 0 && <div className="task-section"><span className="eyebrow">前置任务</span><p>{task.dependencies.join(' · ')}</p></div>}{binding && <div className="binding"><span><GitBranch size={13} />{binding.branch}</span><code title={binding.worktree}>{binding.worktree}</code><small>起始提交 <code>{binding.startCommit?.slice(0, 12)}</code></small>{binding.candidateCommit && <small>候选提交 <code>{binding.candidateCommit.slice(0, 12)}</code></small>}<button className="text-button" onClick={() => selectAgent(binding.agentId)}>打开成员会话<ArrowRight size={13} /></button></div>}<label className="small-label">执行成员<select value={assignee} aria-label={`任务 ${task.title} 的执行成员`} onChange={event => setAssignee(event.target.value)}><option value="">选择团队成员</option>{agents.filter(item => !isController(item)).map(item => <option key={item.id} value={item.id}>{item.name} · {runtimeName[item.runtime]}</option>)}</select></label><label className="small-label">审查已有成果（可选）<select aria-label={`任务 ${task.title} 的审查目标`} value={reviewTaskId} onChange={event => setReviewTaskId(event.target.value)}><option value="">从当前仓库版本开始</option>{snapshot.bindings.filter(item => item.projectId === task.projectId && item.taskId !== task.id).map(item => <option key={item.taskId} value={item.taskId}>{snapshot.tasks.find(candidate => candidate.id === item.taskId)?.title ?? item.taskId}</option>)}</select></label><button className="secondary-button full-width" disabled={busy || !assignee || task.status === 'closed'} onClick={() => void run(`/api/tasks/${encodeURIComponent(task.id)}/dispatch`, { projectId: task.projectId, agentId: assignee, ...(reviewTaskId ? { reviewTaskId } : {}) }, '任务派发请求已提交。')}>{binding ? '分派 / 改派任务' : '分派任务'}<ArrowRight size={14} /></button><div className="task-actions"><button disabled={busy} className="text-button" onClick={() => setReturning(value => !value)}>{task.status === 'closed' ? '重新打开' : '退回修改'}</button><button disabled={busy || task.status === 'closed'} className="text-button" onClick={() => void run(`/api/tasks/${encodeURIComponent(task.id)}/status`, { projectId: task.projectId, status: 'closed', reason: '用户在工作台确认验收。' }, '任务已确认完成。')}><Check size={13} />确认完成</button></div>{returning && <form className="return-form" onSubmit={async event => { event.preventDefault(); if (await run(`/api/tasks/${encodeURIComponent(task.id)}/status`, { projectId: task.projectId, status: 'open', reason }, '任务已退回，修改要求已记录。')) { setReturning(false); setReason(''); } }}><label className="small-label">修改要求<textarea required value={reason} onChange={event => setReason(event.target.value)} rows={3} placeholder="说明需要修改或补充验证的内容" /></label><button className="secondary-button" disabled={busy || !reason.trim()}>提交修改要求</button></form>}</div>}</article>;
}

function ArtifactCard({ artifact, snapshot }: { artifact: Artifact; snapshot: Snapshot }) {
  let safeUrl: string | undefined;
  if (artifact.kind === 'pr') { try { const url = new URL(artifact.value); if (url.protocol === 'https:' || url.protocol === 'http:') safeUrl = url.href; } catch { /* display as text */ } }
  return <article className="artifact-card"><div className="artifact-heading"><span className={`artifact-kind artifact-${artifact.kind}`}>{artifactName[artifact.kind]}</span><time>{time(artifact.createdAt)}</time></div><h3>{artifact.title}</h3>{safeUrl ? <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="artifact-link"><Link2 size={14} />{artifact.value}</a> : <pre className="artifact-value">{artifact.value}</pre>}<footer>{snapshot.agents.find(item => item.id === artifact.agentId)?.name ?? artifact.agentId}{artifact.taskId && <><span>·</span><code>{artifact.taskId}</code></>}</footer></article>;
}

function ModalFrame({ title, onClose, busy, children }: { title: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="modal" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === ref.current && !busy) onClose(); }} aria-labelledby="modal-title"><div className="modal-inner"><div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" disabled={busy} aria-label="关闭对话框" onClick={onClose}><X size={19} /></button></div>{children}</div></dialog>;
}

function Editor({ modal, projectId, agents, tasks, snapshot, run, busy, getError, onDone }: { modal: Exclude<Modal, null>; projectId: string; agents: Agent[]; tasks: Task[]; snapshot: Snapshot; run: Run; busy: boolean; getError: () => string; onDone: () => void }) {
  const [runtime, setRuntime] = useState<RuntimeKind>(modal.agent?.runtime ?? 'codex');
  const [role, setRole] = useState(modal.agent?.role ?? (agents.some(isController) ? 'developer' : 'controller'));
  const [localError, setLocalError] = useState('');
  const [dependencyIds, setDependencyIds] = useState<string[]>([]);
  const [kind, setKind] = useState<Artifact['kind']>('summary');
  const form = useRef<HTMLFormElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLocalError('');
    if (!form.current || busy) return;
    const values = new FormData(form.current);
    const str = (name: string) => String(values.get(name) ?? '').trim();
    let path = ''; let payload: unknown; let message = '';
    if (modal.kind === 'agent') { path = modal.agent ? `/api/agents/${modal.agent.id}` : '/api/agents'; payload = { projectId, name: str('name'), role, runtime, model: str('model'), instructions: str('instructions'), permissionMode: str('permissionMode') }; message = modal.agent ? '成员配置已保存。' : '成员已加入团队。'; }
    else if (modal.kind === 'task') { path = '/api/tasks'; payload = { projectId, title: str('title'), description: str('description'), acceptance: str('acceptance'), dependencies: dependencyIds, priority: Number(str('priority')) }; message = '任务已创建。'; }
    else { path = '/api/artifacts'; payload = { projectId, agentId: str('agentId'), taskId: str('taskId') || undefined, kind, title: str('title'), value: str('value') }; message = '成果已登记。'; }
    const ok = await run(path, payload, message, modal.agent ? 'PATCH' : 'POST');
    if (ok) onDone(); else setLocalError(getError() || '保存未成功，请检查输入后重试。');
  };
  return <form ref={form} className="editor-form" onSubmit={event => void submit(event)}>{modal.kind === 'agent' ? <><p className="form-intro">每个成员拥有独立会话。主控负责安排任务，你随时可以接管。</p><label>成员名称<input autoFocus required name="name" defaultValue={modal.agent?.name ?? (role === 'controller' ? '主控' : '')} placeholder="例如：后端开发、代码审查" maxLength={100} /></label><div className="form-row"><label>角色<select name="role" value={role} onChange={event => setRole(event.target.value)}><option value="controller">主控</option><option value="developer">开发</option><option value="reviewer">审查</option><option value="qa">QA</option>{!['controller', 'developer', 'reviewer', 'qa'].includes(role) && <option value={role}>{role}</option>}</select></label><label>执行工具<select value={runtime} onChange={event => setRuntime(event.target.value as RuntimeKind)}>{(['codex', 'claude', 'workbuddy'] as const).map(value => <option key={value} value={value}>{runtimeName[value]}</option>)}</select></label></div><div className="runtime-form-info"><RuntimeMark runtime={runtime} small /><span>{snapshot.runtimes.find(item => item.kind === runtime)?.detail ?? '尚未获取工具状态'}</span></div><div className="form-row"><label>模型<input name="model" defaultValue={modal.agent?.model ?? ''} placeholder="留空使用原生默认配置" spellCheck={false} /></label><label>执行权限<select name="permissionMode" defaultValue={modal.agent?.permissionMode ?? (role === 'controller' || role === 'reviewer' ? 'read-only' : 'workspace-write')}><option value="read-only">只读</option><option value="workspace-write">工作区可写</option></select></label></div><label>角色指令<textarea name="instructions" defaultValue={modal.agent?.instructions ?? ''} rows={4} placeholder="说明职责、编码约定和验收要求…" /></label><p className="field-note">模型名称按本机配置填写；实际模型以执行工具回执为准。</p></> : modal.kind === 'task' ? <><p className="form-intro">明确目标和完成标准，然后将任务交给合适的团队成员。</p><label>任务标题<input autoFocus required name="title" placeholder="一句话说明要完成的工作" maxLength={200} /></label><label>任务描述<textarea name="description" rows={3} placeholder="描述当前问题、预期行为与约束" /></label><label>验收要求<textarea name="acceptance" rows={3} placeholder="列出可检查的完成条件" /></label><label>优先级<select name="priority" defaultValue="2"><option value="0">P0 · 紧急</option><option value="1">P1 · 高</option><option value="2">P2 · 正常</option><option value="3">P3 · 低</option><option value="4">P4 · 待安排</option></select></label>{tasks.length > 0 && <fieldset className="dependency-options"><legend>前置任务（可选）</legend>{tasks.map(task => <label key={task.id} className="checkbox-label"><input type="checkbox" checked={dependencyIds.includes(task.id)} onChange={event => setDependencyIds(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))} /><span><code>{task.id}</code> {task.title}</span></label>)}</fieldset>}</> : <><p className="form-intro">记录实际完成的工作及其证据。文件路径仅作为文本展示。</p><label>成果标题<input autoFocus required name="title" placeholder="例如：认证模块测试通过" /></label><div className="form-row"><label>成果类型<select value={kind} onChange={event => setKind(event.target.value as Artifact['kind'])}>{Object.entries(artifactName).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></label><label>产出成员<select required name="agentId" defaultValue={agents[0]?.id ?? ''}><option value="" disabled>选择成员</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label></div><label>关联任务<select name="taskId" defaultValue=""><option value="">项目级成果</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.id} · {task.title}</option>)}</select></label><label>{kind === 'commit' ? '提交 SHA' : kind === 'pr' ? 'PR 链接' : kind === 'file' ? '文件绝对路径' : '结果与证据'}<textarea required name="value" rows={5} placeholder={kind === 'pr' ? 'https://github.com/…/pull/…' : kind === 'file' ? 'D:\Projects\…' : '填写实际结果、引用或验证输出'} /></label></>}{localError && <p role="alert" className="inline-error">{localError}</p>}<div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onDone}>取消</button><button className="primary-button" disabled={busy} type="submit">{busy && <LoaderCircle size={15} className="spin" />}{modal.agent ? '保存更改' : modal.kind === 'agent' ? '添加成员' : modal.kind === 'task' ? '创建任务' : '保存成果'}</button></div></form>;
}

function Help({ snapshot }: { snapshot: Snapshot }) {
  return <div className="help-content"><p>工作台只连接本机服务。关闭浏览器不会停止后端任务；中断操作会保留代码和会话。</p>{snapshot.runtimes.map(runtime => <section key={runtime.kind}><h3><RuntimeMark runtime={runtime.kind} small />{runtimeName[runtime.kind]}<span className={runtime.available ? 'available' : 'unavailable'}>{runtime.available ? '已检测' : '未就绪'}</span></h3><p>{runtime.detail}</p>{runtime.version && <small>版本 {runtime.version}</small>}{runtime.executable && <code>{runtime.executable}</code>}<p className="capability-row">中断：{runtime.capabilities.interrupt ? '支持' : '不支持'}　恢复：{runtime.capabilities.resume ? '支持' : '不支持'}　权限请求：{runtime.capabilities.approvals ? '支持' : '不支持'}</p></section>)}<div className="help-control"><strong>你始终拥有决定权</strong><p>发送指令时，空闲成员直接执行；正在执行的成员会先确认停止，再沿用会话处理新指令。成员可中断且没有可发送内容时，输入框右下角提供中断按钮，中断保留代码和会话；有可发送内容时用于发送。接管成员后主控暂停向它发送指令，交还时重新核对状态。</p><p>若运行工具未就绪，请先在原生工具中完成安装、登录及配置，再刷新工作台。</p></div></div>;
}

function PanelResize({ name, side, width, min, max, onChange }: { name: string; side: 'left' | 'right'; width: number; min: number; max: number; onChange: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  return <div role="separator" tabIndex={0} aria-label={name} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} className={`panel-resize panel-resize-${side}`} onPointerDown={event => { start.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }} onPointerMove={event => { if (start.current) onChange(clamp(start.current.width + (event.clientX - start.current.x) * (side === 'left' ? 1 : -1))); }} onPointerUp={event => { start.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { start.current = undefined; }} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); onChange(event.key === 'Home' ? min : event.key === 'End' ? max : clamp(width + (event.key === 'ArrowRight' ? 10 : -10) * (side === 'left' ? 1 : -1))); }} />;
}
