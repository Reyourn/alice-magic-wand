import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { FolderGit2, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Project, ProjectCandidate, ProjectDiscovery } from '../shared/types.js';
import { readProjectDiscovery } from './api.js';

interface Props {
  projects: Project[];
  busy: boolean;
  run: (path: string, body: unknown, success?: string, method?: string) => Promise<boolean>;
  getError: () => string;
  onDone: () => void;
}

const statusNames: Record<ProjectCandidate['status'], string> = {
  ready: '可接入', not_git: '非 Git 仓库', no_commit: '缺少提交', unavailable: '不可访问',
};

function pathKey(path: string): string {
  // Windows paths are case-insensitive; preserve case for other file systems.
  return /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() : path.replace(/\/$/, '');
}

export function ProjectPicker({ projects, busy, run, getError, onDone }: Props) {
  const [mode, setMode] = useState<'discovery' | 'manual'>('discovery');
  const [discovery, setDiscovery] = useState<ProjectDiscovery>();
  const [loading, setLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedName, setSelectedName] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [projectKind, setProjectKind] = useState<'code' | 'office'>('code');
  const [initializeBeads, setInitializeBeads] = useState(true);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setDiscoveryError('');
    setDiscovery(undefined);
    void readProjectDiscovery({ signal: controller.signal }).then(result => {
      if (!active || controller.signal.aborted) return;
      setDiscovery(result);
      setLoading(false);
    }).catch(reason => {
      if (!active || controller.signal.aborted) return;
      setDiscoveryError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [refreshVersion]);

  const isRegistered = (candidate: ProjectCandidate) => !!candidate.registeredProjectId || projects.some(project => pathKey(project.path) === pathKey(candidate.path));
  const selected = discovery?.candidates.find(candidate => candidate.path === selectedPath);
  const manualRegistered = projects.some(project => pathKey(project.path) === pathKey(manualPath.trim()));
  const name = mode === 'discovery' ? selectedName.trim() : manualName.trim();
  const path = mode === 'discovery' ? selected?.path ?? '' : manualPath.trim();
  const canSubmit = !busy && !!name && !!path && (mode === 'manual' ? !manualRegistered : !loading && selected?.status === 'ready' && !isRegistered(selected));

  const changeMode = (next: typeof mode) => { setMode(next); setSubmitError(''); };
  const changeTabWithKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'discovery' : event.key === 'End' ? 'manual' : mode === 'discovery' ? 'manual' : 'discovery';
    changeMode(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#project-tab-${next}`)?.focus();
  };
  const rescan = () => {
    setSelectedPath('');
    setSelectedName('');
    setSubmitError('');
    setLoading(true);
    setRefreshVersion(current => current + 1);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitError('');
    const ok = await run('/api/projects', { name, path, kind: mode === 'manual' ? projectKind : 'code', initializeBeads: projectKind === 'office' || (mode === 'discovery' && selected?.beadsInitialized) ? false : initializeBeads }, '项目已接入。');
    if (ok) onDone(); else setSubmitError(getError() || '接入未成功，请检查项目后重试。');
  };

  return <form className="editor-form project-picker" onSubmit={event => void submit(event)}>
    <p className="form-intro">从本机工具记录和项目目录中发现已有项目，选择后接入工作台。</p>
    <div className="project-picker-tabs" role="tablist" aria-label="添加项目方式">
      {([['discovery', '自动发现'], ['manual', '手动添加']] as const).map(([value, label]) => <button key={value} type="button" id={`project-tab-${value}`} role="tab" aria-selected={mode === value} aria-controls={`project-panel-${value}`} tabIndex={mode === value ? 0 : -1} disabled={busy} onKeyDown={changeTabWithKey} onClick={() => changeMode(value)}>{label}</button>)}
    </div>
    <section id={`project-panel-${mode}`} role="tabpanel" aria-labelledby={`project-tab-${mode}`} className="project-picker-panel">
      {mode === 'discovery' ? <>
        <div className="project-discovery-heading"><span>{loading ? '正在检测本地项目…' : discovery ? `发现 ${discovery.candidates.length} 个项目` : '本地项目'}{discovery?.truncated && ' · 部分结果'}</span><button className="text-button" type="button" disabled={loading || busy} onClick={rescan}>{loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}重新扫描</button></div>
        {loading && <div className="project-discovery-empty" role="status"><LoaderCircle size={20} className="spin" /><p>正在读取本机项目位置并检查仓库状态…</p></div>}
        {discoveryError && <div className="project-discovery-empty"><p className="inline-error" role="alert">检测未完成：{discoveryError}</p><p>可以重新扫描，或切换到手动添加。</p></div>}
        {!loading && discovery && !discovery.candidates.length && <div className="project-discovery-empty" role="status"><FolderGit2 size={22} /><p>暂未发现本地项目。</p><span>检查下方检测来源，或手动填写已有仓库路径。</span></div>}
        {!loading && !!discovery?.candidates.length && <div className="project-candidates" role="radiogroup" aria-label="发现的项目">
          {discovery.candidates.map(candidate => {
            const registered = isRegistered(candidate);
            const disabled = busy || registered || candidate.status !== 'ready';
            return <label key={candidate.path} className={`project-candidate${selectedPath === candidate.path ? ' selected' : ''}${disabled ? ' unavailable' : ''}`}>
              <input type="radio" name="discoveredProject" aria-label={candidate.name} value={candidate.path} disabled={disabled} checked={selectedPath === candidate.path} onChange={() => { setSelectedPath(candidate.path); setSelectedName(candidate.name); setSubmitError(''); }} />
              <span className="project-candidate-content"><span className="project-candidate-heading"><strong>{candidate.name}</strong><span className="project-candidate-status">{registered ? '已接入' : statusNames[candidate.status]}</span></span><span className="project-candidate-path">{candidate.path}</span><span className="project-candidate-sources">来源：{candidate.sources.join('、') || '本地目录'}</span><span className="project-candidate-detail">{registered ? '已在当前项目列表中，无需重复接入。' : candidate.detail}</span></span>
            </label>;
          })}
        </div>}
        {discovery && <details className="project-discovery-sources"><summary>检测来源 · {new Date(discovery.checkedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</summary><ul>{discovery.sources.map((source, index) => <li key={`${source.name}:${index}`}><strong>{source.name}<span>{source.available ? '已读取' : '未读取'}</span></strong><p>{source.detail}</p></li>)}</ul>{discovery.truncated && <p>结果已达扫描上限。未出现的项目可通过手动添加接入。</p>}</details>}
        {!loading && selected && <div className="project-selection-fields"><label>项目名称<input name="name" required value={selectedName} disabled={busy} onChange={event => setSelectedName(event.target.value)} maxLength={100} /></label><label>仓库绝对路径<input name="path" readOnly value={selected.path} spellCheck={false} /></label></div>}
      </> : <>
        <label>项目类型<select aria-label="项目类型" value={projectKind} onChange={event => setProjectKind(event.target.value as 'code' | 'office')}><option value="code">代码项目 · Git 仓库</option><option value="office">办公项目 · 普通文件夹</option></select></label>
        <p className="field-note">{projectKind === 'office' ? '办公资料保持原样。任务管理保存在工作台控制目录，不会在原文件夹初始化 Git。' : '自动发现未覆盖的仓库，可以在这里填写绝对路径。'}</p>
        <label>项目名称<input name="name" required value={manualName} disabled={busy} onChange={event => setManualName(event.target.value)} placeholder="例如：我的开发项目" maxLength={100} /></label>
        <label>{projectKind === 'office' ? '资料文件夹绝对路径' : '仓库绝对路径'}<input name="path" required value={manualPath} disabled={busy} onChange={event => setManualPath(event.target.value)} placeholder="D:\Projects\my-project" spellCheck={false} /></label>
        {manualRegistered && <p className="field-note" role="status">这个项目已经接入，可在左侧当前项目列表中选择。</p>}
      </>}
    </section>
    {(mode === 'discovery' || projectKind === 'code') && (mode === 'manual' || selected) && (mode === 'discovery' && selected?.beadsInitialized ? <p className="field-note">检测到 Beads 目录，接入时会验证现有任务配置。</p> : <label className="checkbox-label"><input type="checkbox" name="initializeBeads" checked={initializeBeads} disabled={busy} onChange={event => setInitializeBeads(event.target.checked)} />接入时在该仓库初始化 Beads（尚未初始化时）</label>)}
    <p className="project-discovery-note">发现项目只读取本地信息。点击“接入项目”才会保存项目配置，并按勾选项初始化任务管理。</p>
    {submitError && <p role="alert" className="inline-error">{submitError}</p>}
    <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onDone}>取消</button><button type="submit" className="primary-button" disabled={!canSubmit}>{busy && <LoaderCircle size={15} className="spin" />}接入项目</button></div>
  </form>;
}
