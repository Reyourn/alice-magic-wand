import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, RefreshCw, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import type { Agent, ConnectionProfile, RuntimeKind, RuntimeModelCatalog } from '../shared/types.js';
import { query, readModelCatalog } from './api.js';
import { useResource } from './upgrade-common.js';

const runtimeNames: Record<RuntimeKind, string> = { codex: 'Codex', claude: 'Claude Code', workbuddy: 'WorkBuddy' };

export function modelReceiptText(model: unknown): string {
  if (typeof model !== 'string' || !model.trim()) return '尚无具体模型回执';
  if (/^(auto|automatic|default)$/i.test(model.trim())) return '原生自动选择（未返回具体模型）';
  return model.trim();
}

export function configuredModelSuggestions(agents: Agent[], runtime: RuntimeKind): string[] {
  return [...new Set(agents.filter(agent => agent.runtime === runtime).map(agent => agent.model.trim()).filter(Boolean))];
}

export function modelChangeBlockReason(state: Agent['state']): string | undefined {
  if (state === 'unknown') return '会话状态尚未核实，请先核对并恢复，再修改模型。';
  if (state === 'interrupting') return '正在等待中断确认，确认停止后才能修改模型。';
  if (['starting', 'running', 'waiting_approval'].includes(state)) return '成员正在执行，请先中断并等待停止，再修改模型。';
}

interface Props {
  agent: Agent;
  agents: Agent[];
  busy: boolean;
  run: (path: string, body: unknown, success?: string, method?: string) => Promise<boolean>;
  getError: () => string;
  onDone: () => void;
}

interface CatalogState { context: string; catalog?: RuntimeModelCatalog; loading: boolean; error: string; }

function catalogTime(value?: string): string {
  if (!value) return '未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未提供' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function ModelCatalogSelector({ catalog, loading, error, selectedModel, onSelect, onRefresh }: {
  catalog?: RuntimeModelCatalog; loading: boolean; error: string; selectedModel: string;
  onSelect: (id: string) => void; onRefresh: () => void;
}) {
  const models = catalog?.models ?? [];
  const selected = models.find(item => item.id === selectedModel);
  return <section className="model-catalog" aria-label="原生模型目录">
    <div className="catalog-heading"><strong>原生模型目录</strong><button className="text-button" type="button" disabled={loading} onClick={onRefresh}>{loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{loading ? '检测中' : '刷新检测'}</button></div>
    {loading && <p className="catalog-status" role="status">正在读取该成员执行工具的模型目录…</p>}
    {error && <p className="catalog-error" role="alert">检测未完成：{error}</p>}
    {catalog && <>
      <div className="catalog-metadata"><span>来源：{catalog.source || '未提供'}</span><span>检测时间：{catalogTime(catalog.checkedAt)}</span>{catalog.attemptedAt && catalog.attemptedAt !== catalog.checkedAt && <span>最近尝试：{catalogTime(catalog.attemptedAt)}</span>}</div>
      {catalog.stale && <p className="catalog-stale">正在显示上次检测结果，本次尚未确认最新目录。</p>}
      {catalog.detail && <p className={`catalog-status ${catalog.status === 'unavailable' ? 'catalog-error' : ''}`}>{catalog.detail}</p>}
    </>}
    {models.length > 0 ? <>
      <label>{catalog?.stale ? '上次检测到的模型' : '检测到的模型'}<select aria-label="检测到的模型" value={selected?.id ?? ''} onChange={event => { if (event.target.value) onSelect(event.target.value); }}>
        <option value="">选择模型，不会自动更改当前配置</option>
        {models.map(item => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} · ${item.id}`}{item.isDefault ? ' · 原生默认' : ''}</option>)}
      </select></label>
      {selected?.description && <p className="catalog-description">{selected.description}</p>}
    </> : !loading && <p className="catalog-status">尚无检测到的模型。可以刷新检测、使用原生默认，或输入自定义标识。</p>}
    <p className="catalog-note">目录由原生工具返回，不代表当前账号额度或每个模型都能成功执行。检测不会发起模型推理，也不会修改已选配置。</p>
  </section>;
}

export function ModelSettings({ agent, agents, busy, run, getError, onDone }: Props) {
  const [mode, setMode] = useState<'native' | 'specific'>(agent.model.trim() ? 'specific' : 'native');
  const [model, setModel] = useState(agent.model);
  const [connectionId, setConnectionId] = useState(agent.connectionId ?? '');
  const connections = useResource<ConnectionProfile[]>('/api/connections');
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const catalogContext = JSON.stringify([agent.id, agent.projectId, agent.runtime, agent.worktree ?? '', connectionId, agent.connectionRevision]);
  const [catalogState, setCatalogState] = useState<CatalogState>({ context: catalogContext, loading: true, error: '' });
  const currentCatalog: CatalogState = catalogState.context === catalogContext ? catalogState : { context: catalogContext, loading: true, error: '' };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setCatalogState(previous => ({ context: catalogContext, catalog: previous.context === catalogContext ? previous.catalog : undefined, loading: true, error: '' }));
    const load = connectionId && connectionId !== agent.connectionId ? query<RuntimeModelCatalog>(`/api/connections/${connectionId}/models?projectId=${encodeURIComponent(agent.projectId)}`, controller.signal) : readModelCatalog(agent.id, { refresh: refreshVersion > 0, signal: controller.signal });
    void load.then(catalog => {
      if (!active || controller.signal.aborted) return;
      if (catalog.runtime !== agent.runtime) throw new Error('执行工具已变更，请重新检测模型目录。');
      setCatalogState({ context: catalogContext, catalog, loading: false, error: '' });
    }).catch(reason => {
      if (!active || controller.signal.aborted) return;
      setCatalogState(previous => ({ context: catalogContext, catalog: previous.context === catalogContext && previous.catalog ? { ...previous.catalog, stale: true } : undefined, loading: false, error: reason instanceof Error ? reason.message : String(reason) }));
    });
    return () => { active = false; controller.abort(); };
  }, [catalogContext, agent.id, agent.runtime, refreshVersion]);
  const suggestions = configuredModelSuggestions(agents, agent.runtime);
  const blockReason = modelChangeBlockReason(agent.state);
  const nextModel = mode === 'native' ? '' : model.trim();
  const canSave = !busy && !blockReason && (mode === 'native' || !!nextModel) && (nextModel !== agent.model || connectionId !== (agent.connectionId ?? ''));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setError('');
    const saved = await run(`/api/agents/${agent.id}`, { model: nextModel, ...(connectionId ? { connectionId } : {}) }, '模型配置已保存，下次执行会建立新会话。', 'PATCH');
    if (saved) onDone(); else setError(getError() || '模型配置未保存，请检查状态后重试。');
  };

  return <form className="editor-form model-settings-form" onSubmit={event => void submit(event)}>
    <p className="form-intro">为 {agent.name} 选择模型来源。配置值与原生工具的实际回执分别显示。</p>
    <dl className="model-facts">
      <div><dt>执行工具</dt><dd>{runtimeNames[agent.runtime]}</dd></div>
      <div><dt>当前配置</dt><dd>{agent.model || '使用原生默认'}</dd></div>
      <div><dt>实际回执</dt><dd>{modelReceiptText(agent.observedModel)}</dd></div>
      {agent.observedProvider && <div><dt>供应商回执</dt><dd>{agent.observedProvider}</dd></div>}
    </dl>
    {!!connections.value?.length && <label>连接配置<select aria-label="模型连接配置" value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="" disabled={!!agent.connectionId}>沿用本机配置</option>{connections.value.filter(item => item.runtime === agent.runtime).map(item => <option key={item.id} value={item.id}>{item.name} · v{item.revision}</option>)}</select></label>}
    <fieldset className="model-source-options">
      <legend>模型选择</legend>
      <label className={`model-source-option ${mode === 'native' ? 'selected' : ''}`}>
        <input type="radio" name="modelSource" value="native" checked={mode === 'native'} onChange={() => setMode('native')} />
        <span><strong>使用原生默认</strong><small>沿用执行工具的模型配置</small></span>
      </label>
      <label className={`model-source-option ${mode === 'specific' ? 'selected' : ''}`}>
        <input type="radio" name="modelSource" value="specific" checked={mode === 'specific'} onChange={() => setMode('specific')} />
        <span><strong>指定模型</strong><small>从检测目录选择或输入标识</small></span>
      </label>
    </fieldset>
    <ModelCatalogSelector catalog={currentCatalog.catalog} loading={currentCatalog.loading} error={currentCatalog.error} selectedModel={mode === 'specific' ? model : ''} onSelect={id => { setModel(id); setMode('specific'); }} onRefresh={() => setRefreshVersion(value => value + 1)} />
    {mode === 'specific' && <>
      {suggestions.length > 0 && <details className="configured-model-fallback"><summary>其他已配置值（备用）</summary><label>已配置模型建议<select aria-label="已配置模型建议" value={suggestions.includes(model) ? model : '__custom__'} onChange={event => setModel(event.target.value === '__custom__' ? '' : event.target.value)}>
        <option value="__custom__">输入自定义模型标识</option>
        {suggestions.map(value => <option key={value} value={value}>{value} · 已配置</option>)}
      </select></label><p className="field-note">这些值来自成员已有配置，并非原生检测目录。</p></details>}
      <label>模型标识<input required name="model" value={model} onChange={event => setModel(event.target.value)} placeholder="填写原生工具支持的模型标识" spellCheck={false} maxLength={500} autoComplete="off" /></label>
      <p className="field-note">{suggestions.length ? '建议来自同一工具成员的已有配置，并非当前账号可用模型列表。' : '尚无同一工具的已配置模型可供复用。'}工作台不会猜测可用模型；实际选择以运行回执为准。</p>
    </>}
    <div className="form-hint"><SlidersHorizontal size={16} /><span>修改配置后，下一次执行会建立新会话。旧任务、代码和成果保留，新模型的实际回执将在启动后更新。</span></div>
    {blockReason && <div className="model-settings-block" role="status"><TriangleAlert size={16} /><span>{blockReason}</span></div>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onDone}>取消</button><button type="submit" className="primary-button" disabled={!canSave}>{busy && <LoaderCircle size={15} className="spin" />}保存模型设置</button></div>
  </form>;
}
