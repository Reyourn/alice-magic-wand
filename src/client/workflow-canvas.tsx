import { useCallback, useEffect, useRef, useState } from 'react';
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, applyNodeChanges, useUpdateNodeInternals, type Connection, type Node, type NodeProps, type NodeChange, type ReactFlowInstance } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Check, GitBranch, LayoutGrid, Maximize, PanelRight, Pause, Play, Plus, Save, X } from 'lucide-react';
import type { Agent, Project, Snapshot, Workflow, WorkflowDetail, WorkflowDraftInput, WorkflowLayout, WorkflowNode, WorkflowNodeView } from '../shared/types.js';
import { Feedback, localTime, NoRecords, runtimeLabels, SectionHeader, useAction, useResource } from './upgrade-common.js';
import '@xyflow/react/dist/style.css';

const workflowNames: Record<string, string> = { draft: '计划草稿', confirming: '确认中', ready: '待执行', running: '执行中', paused: '已暂停', blocked: '受阻', completed: '已验收', delivered: '已交付' };
const roundNames: Record<string, string> = { prepared: '待派发', dispatching: '派发中', running: '执行中', candidate: '待审查', accepted: '已验收', failed: '失败', unknown: '待核对', returned: '待返工' };
type TaskNodeData = { label: string; member: string; runtime?: string; status: string; blocked: string; kind: string; direction: 'LR' | 'TB' };
function TaskNode({ id, data, selected }: NodeProps<Node<TaskNodeData>>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.direction, updateNodeInternals]);
  return <div className={`flow-task${selected ? ' selected' : ''}`}><Handle type="target" position={data.direction === 'TB' ? Position.Top : Position.Left} /><div className="flow-task-heading"><span>{data.kind === 'review' ? '独立审查' : data.kind === 'manual' ? '人工确认' : '执行任务'}</span><b>{data.status}</b></div><strong>{data.label}</strong><div className="flow-task-member">{data.member}{data.runtime && <small>{data.runtime}</small>}</div>{data.blocked && <p>{data.blocked}</p>}<Handle type="source" position={data.direction === 'TB' ? Position.Bottom : Position.Right} /></div>;
}
const nodeTypes = { task: TaskNode };
const overviewOptions = { minZoom: 0.05, maxZoom: 1, padding: { top: '64px', right: '32px', bottom: '60px', left: '32px' } } as const;
export function layoutDirection(nodes: WorkflowNode[], layout: WorkflowLayout, fallback: 'LR' | 'TB'): 'LR' | 'TB' {
  let horizontal = 0, vertical = 0;
  for (const node of nodes) for (const dependency of node.dependencies) {
    const source = layout[dependency.nodeId], target = layout[node.id];
    if (source && target) { horizontal += Math.abs(target.x - source.x); vertical += Math.abs(target.y - source.y); }
  }
  return horizontal === vertical ? fallback : horizontal > vertical ? 'LR' : 'TB';
}
export function arrangeNodes(nodes: WorkflowNode[], direction: 'LR' | 'TB' = 'LR'): WorkflowLayout {
  const graph = new dagre.graphlib.Graph(); graph.setGraph({ rankdir: direction, nodesep: 42, ranksep: 74 }); graph.setDefaultEdgeLabel(() => ({}));
  nodes.forEach(node => graph.setNode(node.id, { width: 244, height: 180 }));
  nodes.forEach(node => node.dependencies.forEach(dependency => { if (nodes.some(item => item.id === dependency.nodeId)) graph.setEdge(dependency.nodeId, node.id); }));
  dagre.layout(graph);
  return Object.fromEntries(nodes.map(node => { const point = graph.node(node.id); return [node.id, { x: point.x - 122, y: point.y - 90 }]; }));
}
export function createsCycle(nodes: WorkflowNode[], source: string, target: string): boolean {
  if (source === target) return true;
  const seen = new Set<string>();
  const visit = (id: string): boolean => { if (id === target) return true; if (seen.has(id)) return false; seen.add(id); return nodes.find(node => node.id === id)?.dependencies.some(dependency => visit(dependency.nodeId)) ?? false; };
  return visit(source);
}

export function affectedPlanNodes(previous: WorkflowNode[], next: WorkflowNode[]): string[] {
  const impacted = new Set([...previous, ...next].filter(node => JSON.stringify(previous.find(item => item.id === node.id)) !== JSON.stringify(next.find(item => item.id === node.id))).map(node => node.id));
  let changed = true;
  while (changed) { changed = false; for (const node of next) if (!impacted.has(node.id) && node.dependencies.some(dep => impacted.has(dep.nodeId))) { impacted.add(node.id); changed = true; } }
  return [...impacted].map(id => next.find(node => node.id === id)?.title ?? `${previous.find(node => node.id === id)?.title ?? id}（移除）`);
}

export function WorkflowCanvas({ project, snapshot, onChanged }: { project?: Project; snapshot: Snapshot; onChanged: () => void }) {
  const list = useResource<Workflow[]>(project ? `/api/projects/${project.id}/workflows` : undefined);
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem(`awb:workflow:${project?.id}`) || ''; } catch { return ''; } });
  const [creating, setCreating] = useState(false);
  const workflowId = list.value?.some(item => item.id === selected) ? selected : list.value?.[0]?.id;
  const detail = useResource<WorkflowDetail>(workflowId ? `/api/workflows/${workflowId}` : undefined);
  const refresh = () => { list.reload(); detail.reload(); onChanged(); };
  const action = useAction(refresh);
  useEffect(() => { const timer = setInterval(() => { list.reload(); detail.reload(); }, 7000); return () => clearInterval(timer); }, [list.reload, detail.reload]);
  if (!project) return <section className="upgrade-page"><NoRecords title="先选择或添加一个项目">编排计划、执行轮次和成果会保存在对应项目中。</NoRecords></section>;
  return <section className="upgrade-page workflow-page" aria-label="编排画布"><SectionHeader title="编排" detail="确认整份计划后推进协作。拖动节点只改变布局，修订分工与依赖需要重新确认。" reload={refresh}><select aria-label="当前工作流" value={workflowId ?? ''} onChange={event => { setSelected(event.target.value); try { localStorage.setItem(`awb:workflow:${project.id}`, event.target.value); } catch {} setCreating(false); }}><option value="" disabled>选择工作流</option>{list.value?.map(item => <option value={item.id} key={item.id}>{item.name} · {workflowNames[item.status] ?? item.status}</option>)}</select><button className="secondary-button" onClick={() => setCreating(true)}><Plus size={14} />新建计划</button></SectionHeader><Feedback error={list.error || detail.error || action.error} notice={action.notice} loading={list.loading && !list.value} />
    {creating ? <WorkflowCreator project={project} agents={snapshot.agents.filter(agent => agent.projectId === project.id)} onCancel={() => setCreating(false)} onCreate={async input => { const workflow = await action.execute<Workflow>('/api/workflows', input); if (workflow) { setSelected(workflow.id); try { localStorage.setItem(`awb:workflow:${project.id}`, workflow.id); } catch {} setCreating(false); } }} busy={action.busy} /> : detail.value ? <WorkflowEditor key={detail.value.workflow.id} detail={detail.value} snapshot={snapshot} refresh={refresh} /> : !list.loading && <NoRecords title="从一个可确认的计划开始">让主控在会话中提议计划，或选择“新建计划”使用流程模板。现有任务仍保留在任务面板中，不会自动运行。</NoRecords>}
  </section>;
}

export function buildWorkflowTemplate(template: string, agents: Agent[]): WorkflowNode[] {
  const workers = agents.filter(agent => agent.memberKind ? agent.memberKind !== 'controller' : !/^(controller|主控)$/i.test(agent.role));
  const writer = workers.find(agent => agent.permissionMode === 'workspace-write');
  const reviewer = workers.find(agent => agent.permissionMode === 'read-only' && agent.id !== writer?.id);
  const spec = template === 'analysis'
    ? [{ title: '分析与整理', checks: [{ id: 'files', label: '分析文件可打开', kind: 'file' as const }, { id: 'data', label: '数据口径和关键数值核对', kind: 'manual' as const }] }, { title: '报告生成', checks: [{ id: 'files', label: '报告可打开', kind: 'file' as const }, { id: 'review', label: '报告独立复核通过', kind: 'review' as const }] }]
    : template === 'design'
      ? [{ title: '需求与交互', checks: [{ id: 'scope', label: '需求和交互范围确认', kind: 'manual' as const }] }, { title: '原型实现', checks: [{ id: 'review', label: '独立体验审查通过', kind: 'review' as const }] }]
      : [{ title: '方案与实现', checks: [{ id: 'test', label: '实际开发测试通过', kind: 'test' as const }, { id: 'review', label: '固定候选独立审查通过', kind: 'review' as const }] }];
  const tasks: WorkflowNode[] = spec.map((item, index) => ({ id: `step-${index + 1}`, title: item.title, description: '', acceptance: item.checks.map(check => check.label).join('；'), kind: 'task', agentId: writer?.id, dependencies: index ? [{ nodeId: `step-${index}`, kind: 'accepted' }] : [], requiredCapabilities: [], inputs: [], checks: item.checks }));
  const source = tasks.at(-1)!;
  tasks.push({ id: 'review', title: '独立审查', description: '对固定候选版本独立核对，按要求返回结构化审查结论。', acceptance: '结论关联候选版本，并给出发现的问题或通过理由。', kind: 'review', agentId: reviewer?.id, dependencies: [{ nodeId: source.id, kind: 'candidate' }], requiredCapabilities: [], inputs: [], checks: [] });
  tasks.push({ id: 'acceptance', title: '人工验收', description: '', acceptance: '检查全部成果与版本证据，确认交付候选。', kind: 'manual', dependencies: tasks.map(node => ({ nodeId: node.id, kind: 'accepted' })), requiredCapabilities: [], inputs: [], checks: [{ id: 'acceptance', label: '用户确认交付候选', kind: 'manual' }] });
  return tasks;
}

function WorkflowCreator({ project, agents, busy, onCreate, onCancel }: { project: Project; agents: Agent[]; busy: boolean; onCreate: (input: WorkflowDraftInput) => Promise<void>; onCancel: () => void }) {
  const [template, setTemplate] = useState(project.kind === 'office' ? 'analysis' : 'development');
  return <form className="editor-form upgrade-card workflow-create" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); void onCreate({ projectId: project.id, name: String(values.get('name')), goal: String(values.get('goal')), nodes: buildWorkflowTemplate(template, agents), targetBranch: String(values.get('branch') || '') || undefined, maxReworkRounds: Number(values.get('maxReworkRounds') || 2) }); }}><header><h3>新建计划草稿</h3><button type="button" className="icon-button" aria-label="取消新建计划" onClick={onCancel}><X size={16} /></button></header><div className="form-row"><label>计划名称<input required name="name" placeholder="本次要交付什么" /></label><label>流程模板<select value={template} onChange={event => setTemplate(event.target.value)}><option value="development">功能开发</option><option value="analysis">分析报告</option><option value="design">设计原型</option></select></label></div><label>目标与范围<textarea required name="goal" rows={4} placeholder="描述目标、输入与验收边界，创建后可以逐项编辑任务。" /></label><div className="form-row">{project.kind !== 'office' && <label>目标分支<input name="branch" placeholder="例如 main，留空由仓库确认" spellCheck={false} /></label>}<label>最多自动返工轮数<input type="number" name="maxReworkRounds" min={0} max={10} defaultValue={2} /></label></div><p className="field-note">模板只生成可编辑草稿。缺少可写实施成员或独立只读审查成员时，先在计划中指定负责人。确认之前不会自动派发。</p><div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" disabled={busy}>生成草稿</button></div></form>;
}

function WorkflowEditor({ detail, snapshot, refresh }: { detail: WorkflowDetail; snapshot: Snapshot; refresh: () => void }) {
  const workflow = detail.workflow;
  const finished = workflow.status === 'completed' || workflow.status === 'delivered';
  const [direction, setDirection] = useState<'LR' | 'TB'>(() => layoutDirection(detail.plan.nodes, workflow.layout, typeof window !== 'undefined' && window.innerWidth < 1200 ? 'TB' : 'LR'));
  const flow = useRef<Pick<ReactFlowInstance<Node<TaskNodeData>>, 'fitView'> | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const followOverview = useRef(true);
  const [flowReady, setFlowReady] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [draft, setDraft] = useState(detail.plan.nodes);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState(() => { try { return localStorage.getItem(`awb:workflow-node:${workflow.id}`) || ''; } catch { return ''; } });
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [baseVersion, setBaseVersion] = useState(detail.plan.version);
  useEffect(() => { try { localStorage.setItem(`awb:workflow-node:${workflow.id}`, selectedId); } catch {} }, [workflow.id, selectedId]);
  const [layout, setLayout] = useState<WorkflowLayout>(Object.keys(workflow.layout).length ? workflow.layout : arrangeNodes(detail.plan.nodes, direction));
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const action = useAction(refresh);
  const agents = snapshot.agents.filter(agent => agent.projectId === workflow.projectId);
  useEffect(() => { if (!dirty) { setDraft(detail.plan.nodes); setBaseVersion(detail.plan.version); } }, [detail.plan.version, detail.plan.nodes, dirty]);
  const selected = draft.find(node => node.id === selectedId);
  const selectedView = detail.nodes.find(view => view.node.id === selectedId);
  const selectNode = (id: string) => { setSelectedId(id); setInspectorOpen(true); };
  const fitOverview = useCallback(() => { followOverview.current = true; void flow.current?.fitView(overviewOptions); }, []);
  const arrange = (nextDirection: 'LR' | 'TB') => {
    followOverview.current = true;
    setDirection(nextDirection); setLayout(arrangeNodes(draft, nextDirection)); setLayoutDirty(true); setFitRequest(value => value + 1);
  };
  useEffect(() => {
    if (!flowReady || !followOverview.current) return;
    // Measurements and explicit arrangement may change bounds; selection never requests a close-up.
    const frame = requestAnimationFrame(() => { if (followOverview.current) fitOverview(); });
    return () => cancelAnimationFrame(frame);
  }, [flowReady, fitRequest, dimensions, fitOverview]);
  useEffect(() => {
    if (!flowReady || !container.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (followOverview.current) fitOverview(); });
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [flowReady, fitOverview]);
  const runtimeNodes: Node<TaskNodeData>[] = draft.map((node, index) => { const view = detail.nodes.find(item => item.node.id === node.id); const member = agents.find(agent => agent.id === node.agentId); return { id: node.id, type: 'task', measured: dimensions[node.id], position: layout[node.id] ?? { x: index * 300, y: 30 }, selected: node.id === selectedId, data: { label: node.title, member: member?.name || (node.kind === 'manual' ? view?.accepted ? '已由你确认' : '等待你确认' : '尚未指定成员'), runtime: member ? runtimeLabels[member.runtime] : undefined, status: view?.accepted ? '已验收' : view?.round ? roundNames[view.round.state] || view.round.state : workflow.confirmedVersion ? '待执行' : '草稿', blocked: view?.blockedReasons.join('；') || '', kind: node.kind, direction } }; });
  const edges = draft.flatMap(node => node.dependencies.map(dependency => ({ id: `${dependency.nodeId}:${node.id}`, source: dependency.nodeId, target: node.id, label: dependency.kind === 'candidate' ? '固定候选' : '验收后', animated: false, style: { stroke: '#888a95' }, labelStyle: { fill: '#dedee8', fontSize: 10 }, labelBgStyle: { fill: '#24252d' } })));
  const nodeChanges = useCallback((changes: NodeChange<Node<TaskNodeData>>[]) => { const updated = applyNodeChanges(changes, runtimeNodes); if (changes.some(change => change.type === 'dimensions')) setDimensions(current => ({ ...current, ...Object.fromEntries(updated.filter(node => node.measured?.width && node.measured?.height).map(node => [node.id, { width: node.measured!.width!, height: node.measured!.height! }])) })); setLayout(Object.fromEntries(updated.map(node => [node.id, node.position]))); if (changes.some(change => change.type === 'position' && change.dragging)) setLayoutDirty(true); }, [runtimeNodes]);
  const connect = (edge: Connection) => { if (finished) return; if (!edge.source || !edge.target) return; if (createsCycle(draft, edge.source, edge.target)) { action.setError('此依赖会形成循环。首版计划使用无环依赖，请通过新执行轮次返工。'); return; } const target = draft.find(node => node.id === edge.target); if (detail.nodes.find(view => view.node.id === edge.target)?.round) { action.setError('已执行任务不能修改依赖；请通过返工或新增任务调整。'); return; } if (target?.dependencies.some(dep => dep.nodeId === edge.source)) return; setDraft(current => current.map(node => node.id === edge.target ? { ...node, dependencies: [...node.dependencies, { nodeId: edge.source, kind: node.kind === 'review' ? 'candidate' : 'accepted' }] } : node)); setDirty(true); };
  const updateNode = (next: WorkflowNode) => { setDraft(current => current.map(node => node.id === next.id ? next : node)); setDirty(true); };
  const unconfirmed = workflow.confirmedVersion !== workflow.currentVersion;
  const usage = snapshot.usage.filter(item => item.workflowId === workflow.id && item.scope === 'turn');
  const totals = usage.map(item => item.counts.totalTokens).filter((value): value is number => typeof value === 'number');
  const total = totals.length ? totals.reduce((sum, value) => sum + value, 0).toLocaleString('zh-CN') : '尚未收到总量回执';
  const partialUsage = usage.some(item => item.partial || item.counts.totalTokens === undefined) || usage.length < detail.rounds.filter(round => round.state !== 'prepared').length;
  return <div className="workflow-editor"><div className="workflow-toolbar"><span className="upgrade-tag">{workflowNames[workflow.status]}</span><span>计划 v{detail.plan.version}{unconfirmed ? ' · 待确认' : ' · 已确认'}</span><span className="workflow-goal" title={workflow.goal}>{workflow.goal}</span><select aria-label="选择任务节点" value={selectedId} onChange={event => selectNode(event.target.value)}><option value="">选择任务查看详情</option>{draft.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</select><select aria-label="画布排列方向" value={direction} onChange={event => arrange(event.target.value as 'LR' | 'TB')}><option value="TB">上下排列</option><option value="LR">左右排列</option></select><button className="text-button" disabled={action.busy} onClick={() => arrange(direction)}><LayoutGrid size={14} />自动排列</button><button className="text-button" disabled={action.busy || !layoutDirty} onClick={async () => { const saved = await action.execute(`/api/workflows/${workflow.id}/layout`, { layout }); if (saved) setLayoutDirty(false); }}><Save size={14} />保存布局</button><button className="secondary-button" disabled={action.busy || !dirty || finished} onClick={async () => { const saved = await action.execute(`/api/workflows/${workflow.id}/draft`, { nodes: draft, name: workflow.name, goal: workflow.goal, baseVersion }); if (saved) setDirty(false); }}><Save size={14} />保存修订</button>{unconfirmed ? <button className="primary-button" disabled={action.busy || dirty} onClick={() => void action.execute(`/api/workflows/${workflow.id}/confirm`, { version: detail.plan.version }, 'POST', '计划已确认，后台将检查连接和能力后派发。')}><Check size={14} />确认整份计划</button> : <button className="secondary-button" disabled={action.busy || dirty || workflow.status === 'completed' || workflow.status === 'delivered'} onClick={() => void action.execute(`/api/workflows/${workflow.id}/pause`, { paused: workflow.status !== 'paused' })}>{workflow.status === 'paused' ? <Play size={14} /> : <Pause size={14} />}{workflow.status === 'paused' ? '继续工作流' : '暂停新派发'}</button>}</div>
    {unconfirmed && detail.rounds.some(round => round.state === 'prepared' && round.planVersion === detail.plan.version && round.reworkReason) && <p className="upgrade-notice">改派或返工已形成新计划版本。请核对负责人和影响范围，确认整份计划后再派发。</p>}
    {dirty && <div className="upgrade-notice"><p>本地修订基于 v{baseVersion}。影响范围：{affectedPlanNodes(detail.plans.find(plan => plan.version === baseVersion)?.nodes ?? detail.plan.nodes, draft).join('、') || '无'}。已完成任务不会自动重跑。</p>{detail.plan.version !== baseVersion && <p>服务器已有 v{detail.plan.version}，请核对后重新编辑，避免覆盖他人的修订。</p>}<button className="text-button" onClick={() => { setDirty(false); setDraft(detail.plan.nodes); setBaseVersion(detail.plan.version); }}>放弃本地修订并读取最新</button></div>}<Feedback {...action} />{workflow.lastError && <p className="upgrade-error">{workflow.lastError}</p>}
    <div className={`workflow-board${selected && inspectorOpen ? ' has-selection' : ''}`}><div className="flow-container" ref={container}><ReactFlow onInit={instance => { flow.current = instance; setFlowReady(true); }} nodes={runtimeNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={nodeChanges} onConnect={connect} onNodeClick={(_, node) => selectNode(node.id)} onPaneClick={() => setSelectedId('')} onMoveStart={event => { if (event) followOverview.current = false; }} onNodeDragStart={() => { followOverview.current = false; }} fitView fitViewOptions={overviewOptions} minZoom={0.05} maxZoom={1.6} colorMode="dark" deleteKeyCode={null}><Background gap={24} color="#383943" /><Controls showInteractive={false} showFitView={false} onZoomIn={() => { followOverview.current = false; }} onZoomOut={() => { followOverview.current = false; }} /><MiniMap nodeColor="#b8b9c7" maskColor="#111217bb" pannable zoomable /></ReactFlow><button className="secondary-button flow-add" disabled={finished || action.busy} onClick={() => { const id = crypto.randomUUID(); setDraft(current => [...current, { id, title: '新任务', description: '', acceptance: '', kind: 'task', dependencies: [], requiredCapabilities: [], inputs: [], checks: [] }]); selectNode(id); setDirty(true); }}><Plus size={14} />添加任务</button><div className="flow-view-actions"><button className="secondary-button" onClick={fitOverview}><Maximize size={14} />适应全图</button>{selected && <button className="secondary-button" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(value => !value)}><PanelRight size={14} />{inspectorOpen ? '收起详情' : '任务详情'}</button>}</div></div>{selected && inspectorOpen && <NodeInspector key={`${selected.id}:${selectedView?.round?.id ?? 'draft'}:${selectedView?.bundle?.id ?? ''}`}  node={selected} view={selectedView} detail={detail} agents={agents} allNodes={draft} onChange={updateNode} onClose={() => setInspectorOpen(false)} onRemove={() => { setDraft(current => current.filter(node => node.id !== selected.id).map(node => ({ ...node, dependencies: node.dependencies.filter(dep => dep.nodeId !== selected.id) }))); setSelectedId(''); setDirty(true); }} refresh={refresh} />}</div><div className="workflow-foot"><span>节点表示真实计划任务 · {detail.rounds.length} 个执行轮次 · {detail.bundles.length} 份成果包</span><span title="仅累计明确归属此工作流的轮次回执；提计划前或跨工作流的主控对话未分摊。">已归属工作流 Token：{total}{partialUsage && ' · 部分统计'}</span></div>
    {detail.integration && <div className="upgrade-subcard"><strong><GitBranch size={14} /> 整合分支 {detail.integration.branch}</strong><p>状态：{detail.integration.state} · 提交：{detail.integration.headCommit}</p><p>已整合 {detail.integration.integratedBundleIds.length} 份成果；任务验收与项目交付分别记录。</p></div>}
  </div>;
}

function NodeInspector({ node, view, detail, agents, allNodes, onChange, onClose, onRemove, refresh }: { node: WorkflowNode; view?: WorkflowNodeView; detail: WorkflowDetail; agents: Agent[]; allNodes: WorkflowNode[]; onChange: (node: WorkflowNode) => void; onClose: () => void; onRemove: () => void; refresh: () => void }) {
  const [reason, setReason] = useState('');
  const [exceptions, setExceptions] = useState<string[]>([]);
  const [reassign, setReassign] = useState(view?.round?.agentId ?? node.agentId ?? '');
  const [override, setOverride] = useState(false);
  const action = useAction(refresh);
  const locked = !!view?.round || ['completed', 'delivered'].includes(detail.workflow.status);
  const reworkLimitReached = (view?.round?.automaticReworkCount ?? Math.max(0, (view?.round?.number ?? 1) - 1)) >= detail.workflow.maxReworkRounds;
  const evidence = detail.evidence.filter(item => item.bundleId === view?.bundle?.id);
  return <aside className="node-inspector editor-form" aria-label="任务详情"><header><h3>任务详情</h3><button className="icon-button" aria-label="关闭任务详情" onClick={onClose}><X size={16} /></button></header><label>任务名称<input value={node.title} disabled={locked} onChange={event => onChange({ ...node, title: event.target.value })} /></label><div className="form-row"><label>任务类型<select value={node.kind} disabled={locked} onChange={event => onChange({ ...node, kind: event.target.value as WorkflowNode['kind'] })}><option value="task">执行任务</option><option value="review">独立审查</option><option value="manual">人工确认</option></select></label><label>负责人<select value={node.agentId ?? ''} disabled={locked || node.kind === 'manual'} onChange={event => onChange({ ...node, agentId: event.target.value || undefined })}><option value="">尚未指定</option>{agents.filter(agent => (agent.memberKind ? agent.memberKind !== 'controller' : !/^(controller|主控)$/i.test(agent.role))).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label></div><label>目标与输入<textarea rows={3} disabled={locked} value={node.description} onChange={event => onChange({ ...node, description: event.target.value })} /></label><label>验收要求<textarea rows={3} disabled={locked} value={node.acceptance} onChange={event => onChange({ ...node, acceptance: event.target.value })} /></label><label>能力要求（每行一个 ID）<textarea rows={2} disabled={locked} value={node.requiredCapabilities.join('\n')} onChange={event => onChange({ ...node, requiredCapabilities: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} /></label><label>固定输入引用（每行一个）<textarea rows={2} disabled={locked} value={node.inputs.join('\n')} onChange={event => onChange({ ...node, inputs: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })} /></label>
    <fieldset className="upgrade-checks"><legend>验收证据</legend>{node.checks.map(check => <div className="upgrade-check-editor" key={check.id}><div className="upgrade-check-row"><input aria-label="验收项名称" value={check.label} disabled={locked} onChange={event => onChange({ ...node, checks: node.checks.map(item => item.id === check.id ? { ...item, label: event.target.value } : item) })} /><select aria-label="证据类型" value={check.kind} disabled={locked} onChange={event => onChange({ ...node, checks: node.checks.map(item => item.id === check.id ? { ...item, kind: event.target.value as typeof item.kind } : item) })}><option value="test">测试</option><option value="review">独立审查</option><option value="file">文件检查</option><option value="manual">人工确认</option></select><button type="button" className="icon-button" aria-label="删除验收项" disabled={locked} onClick={() => onChange({ ...node, checks: node.checks.filter(item => item.id !== check.id) })}><X size={12} /></button></div>{check.kind === 'test' && <div className="editor-form"><label>计划中的检查命令<input value={check.command ?? ''} disabled={locked} placeholder="例如 npm" onChange={event => onChange({ ...node, checks: node.checks.map(item => item.id === check.id ? { ...item, command: event.target.value } : item) })} /></label><label>检查参数（每行一个）<textarea value={(check.args ?? []).join('\n')} disabled={locked} rows={2} placeholder="test" onChange={event => onChange({ ...node, checks: node.checks.map(item => item.id === check.id ? { ...item, args: event.target.value ? event.target.value.split('\n') : [] } : item) })} /></label></div>}</div>)}<button className="text-button" disabled={locked} onClick={() => onChange({ ...node, checks: [...node.checks, { id: crypto.randomUUID(), label: '验收项', kind: 'test' }] })}><Plus size={13} />添加验收项</button></fieldset>
    {!!node.dependencies.length && <div className="upgrade-checks"><strong>前置依赖</strong>{node.dependencies.map(dependency => <div className="dependency-edit" key={dependency.nodeId}><span>{allNodes.find(item => item.id === dependency.nodeId)?.title ?? dependency.nodeId}</span><select aria-label="依赖条件" disabled={locked} value={dependency.kind} onChange={event => onChange({ ...node, dependencies: node.dependencies.map(item => item.nodeId === dependency.nodeId ? { ...item, kind: event.target.value as 'accepted' | 'candidate' } : item) })}><option value="accepted">验收后开始</option><option value="candidate">固定候选成果</option></select><button className="icon-button" aria-label="移除依赖" disabled={locked} onClick={() => onChange({ ...node, dependencies: node.dependencies.filter(item => item.nodeId !== dependency.nodeId) })}><X size={12} /></button></div>)}</div>}
    {!!view?.blockedReasons.length && <p className="upgrade-error">{view.blockedReasons.join('；')}</p>}{view?.round && <div className="upgrade-subcard"><strong>第 {view.round.number} 轮 · {roundNames[view.round.state]}</strong><p>{localTime(view.round.createdAt)}</p>{view.round.worktree && <code>{view.round.worktree}</code>}{view.round.candidateCommit && <code>{view.round.candidateCommit}</code>}{view.round.reworkReason && <p>修改要求：{view.round.reworkReason}</p>}</div>}{view?.bundle && <div className="upgrade-subcard"><strong>成果包 · {view.bundle.id}</strong><code>版本 {view.bundle.version}</code><p>{view.bundle.files.length} 个文件 · {evidence.length} 条对应证据</p>{evidence.map(item => <p key={item.id}>{item.kind} · {item.result}{item.stale && ` · 已过期：${item.staleReason || '成果版本已变化'}`} · {item.conclusion || item.command || item.reason}</p>)}</div>}
    {view?.bundle && <EvidenceActions key={view.bundle.id} bundleId={view.bundle.id} node={node} detail={detail} refresh={refresh} />}
    {node.kind === 'review' && view?.round && node.dependencies.filter(dep => dep.kind === 'candidate').map(dep => { const target = detail.nodes.find(item => item.node.id === dep.nodeId); return target?.bundle && <div className="upgrade-subcard" key={target.bundle.id}><strong>被审查成果：{target.node.title}</strong><EvidenceActions bundleId={target.bundle.id} node={target.node} detail={detail} refresh={refresh} /></div>; })}
    <Feedback {...action} />{(view?.round || node.kind === 'manual') && <label>修改要求 / 人工确认理由<textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明修改内容，或针对当前成果版本的确认理由" /></label>}
    {view?.round && !view.accepted && !!view.bundle && !!node.checks.length && <details className="manual-exceptions"><summary>人工确认 / 例外验收项</summary><p className="field-note">仅对勾选项记录当前版本的理由。测试、文件或审查未通过时，例外会明确留档。</p>{node.checks.filter(check => { const current = evidence.filter(item => item.requirementId === check.id && item.version === view.bundle?.version).at(-1); return !current || current.result !== 'passed' || current.stale; }).map(check => <label className="checkbox-label" key={check.id}><input type="checkbox" checked={exceptions.includes(check.id)} onChange={event => setExceptions(current => event.target.checked ? [...current, check.id] : current.filter(id => id !== check.id))} />{check.label}</label>)}</details>}
    {view?.round && ['candidate', 'accepted', 'failed'].includes(view.round.state) && <details className="rework-controls"><summary>退回修改 / 改派</summary><label>下一轮负责人<select value={reassign} onChange={event => setReassign(event.target.value)}>{agents.filter(agent => agent.memberKind !== 'controller').map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>{reworkLimitReached && <label className="checkbox-label"><input type="checkbox" checked={override} onChange={event => setOverride(event.target.checked)} />已达到自动返工上限，人工批准额外一轮</label>}<button className="secondary-button" disabled={action.busy || !reason.trim() || !reassign || (reworkLimitReached && !override)} onClick={() => void action.execute(`/api/workflows/${detail.workflow.id}/nodes/${node.id}/rework`, { reason, sourceBundleId: view.bundle?.id, sourceRoundId: view.bundle ? undefined : view.round?.id, agentId: reassign, humanOverride: override, planVersion: detail.plan.version }, 'POST', reassign !== view.round?.agentId ? '改派已生成计划修订，请确认整份新计划后再派发。' : '修改要求已提交并关联原成果；原写者确认停止后才会派发下一轮。')}>提交退回修改</button></details>}
    {view?.round && !view.accepted && view.round.state === 'candidate' && <button className="primary-button" disabled={action.busy || (exceptions.length > 0 && !reason.trim())} onClick={() => void action.execute(`/api/workflows/${detail.workflow.id}/nodes/${node.id}/accept`, { bundleId: view.bundle?.id, roundId: view.round?.id, planVersion: detail.plan.version, manualExceptions: exceptions.map(requirementId => ({ requirementId, reason })) }, 'POST', '验收请求已处理。')}>验收当前版本</button>}
    {!view?.accepted && node.kind === 'manual' && detail.workflow.confirmedVersion === detail.plan.version && <button className="primary-button" disabled={action.busy || !reason.trim() || view?.blockedReasons.some(item => item !== '等待人工确认')} onClick={() => void action.execute(`/api/workflows/${detail.workflow.id}/nodes/${node.id}/accept`, { reason, planVersion: detail.plan.version }, 'POST', '人工检查点已确认。')}>确认检查点</button>}
    {!locked && <button className="text-button" onClick={onRemove}>从计划草稿移除此节点</button>}{locked && <p className="field-note">此任务已产生轮次，输入与验收要求固定。使用退回修改或新增任务调整工作。</p>}

  </aside>;
}

function EvidenceActions({ bundleId, node, detail, refresh }: { bundleId: string; node: WorkflowNode; detail: WorkflowDetail; refresh: () => void }) {
  const [requirementId, setRequirementId] = useState(node.checks[0]?.id ?? '');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('[]');
  const [reviewRoundId, setReviewRoundId] = useState('');
  const receipts = useResource<{ roundId: string; bundleId: string; version: string; result: 'passed' | 'failed'; conclusion: string }[]>(`/api/workflows/${detail.workflow.id}/review-records`, detail.rounds.map(round => `${round.id}:${round.state}`).join(','));
  const action = useAction(refresh);
  const check = node.checks.find(item => item.id === requirementId);
  const reviews = receipts.value?.filter(receipt => receipt.bundleId === bundleId) ?? [];
  const selectedReview = reviews.find(receipt => receipt.roundId === reviewRoundId);
  useEffect(() => { setCommand(check?.command ?? ''); setArgs(JSON.stringify(check?.args ?? [])); }, [check?.id, check?.command]);
  if (!node.checks.length) return null;
  return <details className="evidence-actions"><summary>执行验收检查</summary><div className="editor-form"><label>验收项<select aria-label="验收项" value={requirementId} onChange={event => setRequirementId(event.target.value)}>{node.checks.map(item => <option key={item.id} value={item.id}>{item.label} · {item.kind}</option>)}</select></label>{check?.kind === 'test' && <><label>命令<input value={command} onChange={event => setCommand(event.target.value)} placeholder="npm" spellCheck={false} /></label><label>参数（JSON 字符串数组）<input value={args} onChange={event => setArgs(event.target.value)} placeholder={'["test"]'} spellCheck={false} /></label><button className="secondary-button" disabled={action.busy || !command.trim()} onClick={() => { let parameters: unknown; try { parameters = JSON.parse(args); if (!Array.isArray(parameters) || parameters.some(item => typeof item !== 'string')) throw new Error(); } catch { action.setError('命令参数必须为 JSON 字符串数组。'); return; } void action.execute(`/api/bundles/${bundleId}/check`, { requirementId, command, args: parameters }, 'POST', '检查已执行并绑定当前成果版本。'); }}>运行检查并登记证据</button></>}{check?.kind === 'file' && <button className="secondary-button" disabled={action.busy} onClick={() => void action.execute(`/api/bundles/${bundleId}/file-check`, { requirementId }, 'POST', '文件完整性检查已完成。')}>核对文件哈希</button>}{check?.kind === 'review' && <><p className="field-note">读取独立成员的真实结构化回执，登记结论时核对原始版本。</p><Feedback error={receipts.error} loading={receipts.loading} /><label>独立审查回执<select aria-label="独立审查回执" value={reviewRoundId} onChange={event => setReviewRoundId(event.target.value)}><option value="">选择已完成的审查回执</option>{reviews.map(receipt => <option key={receipt.roundId} value={receipt.roundId}>第 {detail.rounds.find(round => round.id === receipt.roundId)?.number ?? '?'} 轮 · {receipt.result === 'passed' ? '通过' : '不通过'}</option>)}</select></label>{!receipts.loading && !reviews.length && <p className="field-note">没有与此成果版本匹配的审查回执。审查成员需完成任务并输出 WORKBENCH_REVIEW_RESULT 结构化结论。</p>}{selectedReview && <div className="upgrade-subcard"><code>版本：{selectedReview.version}</code><p>结果：{selectedReview.result === 'passed' ? '通过' : '不通过'}</p><p className="preserve-lines">{selectedReview.conclusion}</p></div>}<button className="secondary-button" disabled={action.busy || !selectedReview} onClick={() => selectedReview && void action.execute(`/api/bundles/${bundleId}/review`, { requirementId, reviewRoundId: selectedReview.roundId, result: selectedReview.result, conclusion: selectedReview.conclusion }, 'POST', '真实审查证据已关联固定版本。')}>登记独立审查</button></>}{check?.kind === 'manual' && <p className="field-note">使用下方人工确认并填写理由；确认仅针对当前成果版本。</p>}<Feedback {...action} /></div></details>;
}
