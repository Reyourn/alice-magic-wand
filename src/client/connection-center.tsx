import { useEffect, useState, type FormEvent } from 'react';
import { Check, ExternalLink, KeyRound, Plug, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { Agent, ConnectionInput, ConnectionMode, ConnectionProfile, ConnectionProtocol, ConnectionState, LoginAttempt, RuntimeKind, RuntimeModelCatalog, Snapshot } from '../shared/types.js';
import { CONNECTION_INSTALL_URLS } from '../shared/connections.js';
import { query } from './api.js';
import { Feedback, localTime, NoRecords, runtimeLabels, SectionHeader, useAction, useResource } from './upgrade-common.js';
import { defaultVerificationCapabilities, loginNeedsResolution, loginNeedsRestart, LoginRecoveryNotice, VerificationUsage } from './connection-verification.js';

export const connectionStateNames: Record<ConnectionState, string> = { unconfigured: '未配置', 'not-installed': '未安装', 'authentication-observed': '检测到认证', verified: '调用已验证', 'authentication-failed': '认证失败', 'quota-exceeded': '额度不足', 'model-unavailable': '模型不可用', 'network-failed': '网络失败', conflict: '配置冲突', unknown: '待核对' };
const modeNames: Record<ConnectionMode, string> = { native: '沿用本机配置', 'official-api': '官方 API', gateway: '兼容网关' };
const protocolNames: Record<ConnectionProtocol, string> = { native: '原生认证', responses: 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages', 'openai-chat': 'OpenAI Chat Completions', codebuddy: 'CodeBuddy 官方' };
function safeExternal(value?: string): string | undefined { if (!value) return; try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol)) return url.href; } catch { /* invalid URL */ } }

type WorkBuddyEdition = 'china' | 'international';
export interface WorkBuddyInstallation {
  edition: WorkBuddyEdition; label: string; executable: string; desktopExecutable?: string; version?: string; available: boolean; detail: string;
  cliVersion?: string; executionPackage?: 'lite' | 'full';
}
interface WorkBuddyInstallations { installations: WorkBuddyInstallation[]; checkedAt: string; }
const workbuddyEditionNames: Record<WorkBuddyEdition, string> = { china: 'WorkBuddy 国内版', international: 'WorkBuddy 国际版' };

export function workbuddyEditionLabel(profile: Pick<ConnectionProfile, 'runtime' | 'mode' | 'workbuddyEdition'>): string {
  return profile.runtime === 'workbuddy' && profile.mode === 'native' ? profile.workbuddyEdition ? workbuddyEditionNames[profile.workbuddyEdition] : 'WorkBuddy · 旧配置 / 自动发现' : runtimeLabels[profile.runtime];
}

export function NativeLoginStatus({ profile }: { profile: ConnectionProfile }) {
  if (profile.mode !== 'native') return null;
  const state = profile.authenticationStatus?.state ?? (profile.status?.state === 'authentication-observed' || profile.status?.state === 'authentication-failed' ? profile.status.state : undefined);
  const label = profile.status?.state === 'authentication-failed' ? 'CLI 调用认证失败' : profile.authenticationStatus?.credentialSource === 'native-codebuddy-identity' ? '账号身份存在，CLI 未就绪' : state === 'authentication-observed' || state === 'verified' ? '已检测到登录' : state === 'authentication-failed' ? '未登录 / 认证失效' : state === 'unconfigured' ? '未检测到登录' : state === 'not-installed' ? '未安装，无法检测登录' : '登录状态待核对';
  return <span className="native-login-status">{label}</span>;
}

export function workbuddyMemoryAuthenticationSupported(profile?: ConnectionProfile, installations?: WorkBuddyInstallation[]): boolean {
  if (!profile || profile.runtime !== 'workbuddy' || profile.mode !== 'native') return false;
  const pathKey = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const installation = installations?.find(item => item.available && (profile.executable
    ? pathKey(profile.executable) === pathKey(item.executable) && (!profile.workbuddyEdition || profile.workbuddyEdition === item.edition)
    : !!profile.workbuddyEdition && profile.workbuddyEdition === item.edition));
  return !!installation && ['5.8.3', '5.8.4'].includes(installation.version ?? '') && installation.cliVersion === '2.161.0' && installation.executionPackage === 'lite';
}

export function workbuddyBundledLoginLimited(profile?: ConnectionProfile, installations?: WorkBuddyInstallation[]): boolean {
  return !!profile && ['unconfigured', 'authentication-failed'].includes(profile.authenticationStatus?.state ?? '') && workbuddyMemoryAuthenticationSupported(profile, installations);
}

export function WorkBuddyBundledLoginNotice({ profile, installations }: { profile?: ConnectionProfile; installations?: WorkBuddyInstallation[] }) {
  return <p className="field-note">{workbuddyMemoryAuthenticationSupported(profile, installations)
    ? '当前选中 2.161.0 lite 内置 CLI 使用原生内存会话：每个执行进程独立授权，不能从桌面受保护凭据恢复登录。点击“授权并验证CLI”会启动此验证进程，等待你在上方“执行会话授权”中扫码，再发起真实请求，产生少量 Token。进程结束或关闭服务后需重新授权，不会退出桌面账号；不要通过先登录再关闭进程的方式反复扫码。'
    : 'WorkBuddy 桌面登录与内置 CLI 认证需分别核对。旧版本、未知安装或已有可用原生凭据不据此判为不支持；检测到登录仍需单独验证实际调用。'}</p>;
}

export function NativeLoginButton({ profile, installations, busy, onClick, onMemoryAuthorize }: { profile: ConnectionProfile; installations?: WorkBuddyInstallation[]; busy?: boolean; onClick: () => void; onMemoryAuthorize?: () => void }) {
  const memoryAuthentication = workbuddyMemoryAuthenticationSupported(profile, installations);
  return <button type="button" className="secondary-button" disabled={busy || memoryAuthentication && !onMemoryAuthorize} onClick={memoryAuthentication ? onMemoryAuthorize : onClick} title={memoryAuthentication ? '在同一执行进程中完成原生授权和真实验证，会产生少量 Token；授权面板可在验证等待时操作。' : undefined}>{memoryAuthentication ? '授权并验证CLI' : '打开原生登录'}</button>;
}

export function WorkBuddyInstallationCards({ discovery, failed, onConfigure }: { discovery?: WorkBuddyInstallations; failed?: boolean; onConfigure: (edition: WorkBuddyEdition) => void }) {
  return <>{(['china', 'international'] as const).map(edition => {
    const installation = discovery?.installations.find(item => item.edition === edition);
    return <article className="upgrade-card" key={edition} aria-label={workbuddyEditionNames[edition]}><header><strong>{workbuddyEditionNames[edition]}</strong><span className="upgrade-tag">{installation ? installation.available ? '已安装' : '未检测到' : failed ? '无法检测' : discovery ? '未检测到' : '检测中'}</span></header><p>桌面 {installation?.version || '版本未知'} · CLI {installation?.cliVersion || '版本未知'} · {installation?.executionPackage || '执行包未知'}</p><code>{installation?.executable || installation?.detail || (failed ? '安装信息读取失败，可指定执行程序路径。' : discovery ? '未发现此版本，可在连接中指定执行程序路径。' : '正在读取安装信息')}</code>{installation?.detail && installation.executable && <p className="field-note">{installation.detail}</p>}<p className="field-note">桌面客户端登录不代表 CLI 已登录。凭据引导限制以选中连接的安装版本和当前认证证据为准。</p><button type="button" className="secondary-button" onClick={() => onConfigure(edition)}>选择{edition === 'china' ? '国内版' : '国际版'}连接与登录</button>{discovery && !installation?.available && <a href={CONNECTION_INSTALL_URLS.workbuddy} target="_blank" rel="noreferrer">官方安装说明 <ExternalLink size={12} /></a>}</article>;
  })}</>;
}

export function ConnectionCenter({ snapshot, projectId, onChanged }: { snapshot: Snapshot; projectId: string; onChanged: () => void }) {
  const data = useResource<ConnectionProfile[]>('/api/connections');
  const installations = useResource<WorkBuddyInstallations>('/api/workbuddy/installations');
  const [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState<ConnectionProfile | 'new'>();
  const [newEdition, setNewEdition] = useState<WorkBuddyEdition>();
  const selected = data.value?.find(item => item.id === selectedId) ?? data.value?.[0];
  const refresh = () => { data.reload(); onChanged(); };
  const statusRefresh = useAction(refresh);
  useEffect(() => {
    // Poll stored observations only. The backend owns authentication checks; this never starts a login or a model request.
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') data.reload(); }, 10000);
    return () => clearInterval(timer);
  }, [data.reload]);
  const configureEdition = (edition: WorkBuddyEdition) => {
    const existing = data.value?.find(profile => profile.runtime === 'workbuddy' && profile.mode === 'native' && profile.workbuddyEdition === edition);
    if (existing) { setSelectedId(existing.id); setEditing(undefined); }
    else { setNewEdition(edition); setEditing('new'); }
  };
  return <section className="upgrade-page connection-center" aria-label="接入与认证中心">
    <SectionHeader title="接入与认证" detail="连接属于工具，成员引用连接。沿用原生登录，或为不同成员配置独立的 API 来源。" reload={() => { data.reload(); installations.reload(); }}><button className="secondary-button" disabled={statusRefresh.busy} onClick={() => void statusRefresh.execute('/api/connections/status/refresh', {}, 'POST', '已读取登录状态；忙碌连接等待空闲再检测，没有发起模型调用。')}><RefreshCw size={15} />刷新登录状态</button><button className="primary-button" onClick={() => { setNewEdition(undefined); setEditing('new'); }}><Plus size={15} />新增连接</button></SectionHeader>
    <p className="field-note">后台自动检查闲置原生连接的登录状态，本页每 10 秒读取最新记录。登录状态检测不会消耗模型 Token；调用验证需手动发起。运行中或原生登录处理中的连接等待空闲后检测。</p>
    <Feedback {...statusRefresh} />
    <div className="enablement-steps" aria-label="启用步骤">{['检测安装', '选择连接', '检查认证', '选择模型', '验证调用', '绑定成员'].map((item, index) => <span key={item}><b>{index + 1}</b>{item}</span>)}</div>
    <div className="runtime-install-grid">{(['codex', 'claude'] as const).map(kind => { const runtime = snapshot.runtimes.find(item => item.kind === kind); return <article className="upgrade-card" key={kind}><header><strong>{runtimeLabels[kind]}</strong><span className="upgrade-tag">{runtime?.available ? '已安装' : '未检测到'}</span></header><p>{runtime?.version || '版本未知'}</p><code>{runtime?.executable || runtime?.detail || '尚未读取安装信息'}</code>{!runtime?.available && <a href={CONNECTION_INSTALL_URLS[kind]} target="_blank" rel="noreferrer">官方安装说明 <ExternalLink size={12} /></a>}</article>; })}<WorkBuddyInstallationCards discovery={installations.value} failed={!!installations.error} onConfigure={configureEdition} /></div>
    <Feedback error={installations.error} />
    {installations.value && <p className="field-note">WorkBuddy 安装信息检测时间：{localTime(installations.value.checkedAt)}</p>}
    <Feedback error={data.error} loading={data.loading && !data.value} />
    {editing ? <ConnectionEditor key={editing === 'new' ? `new:${newEdition ?? ''}` : `${editing.id}:${editing.revision}`} initialEdition={editing === 'new' ? newEdition : undefined} profile={editing === 'new' ? undefined : editing} onCancel={() => setEditing(undefined)} onSaved={profile => { setSelectedId(profile.id); setEditing(undefined); refresh(); }} /> : <div className="connection-layout"><nav className="connection-list" aria-label="连接配置">{data.value?.map(profile => <button key={profile.id} className={profile.id === selected?.id ? 'selected' : ''} onClick={() => setSelectedId(profile.id)}><Plug size={17} /><span><strong>{profile.name}</strong><small>{workbuddyEditionLabel(profile)} · {modeNames[profile.mode]}</small><small>{profile.mode === 'native' ? <NativeLoginStatus profile={profile} /> : connectionStateNames[profile.status?.state ?? 'unconfigured']}</small></span></button>)}{data.value?.length === 0 && <NoRecords title="尚无连接">添加连接后，检查认证并进行一次明确的调用验证。</NoRecords>}</nav>{selected && <ConnectionDetails key={`${selected.id}:${selected.revision}:${projectId}`} profile={selected} installations={installations.value?.installations} agents={snapshot.agents} projectId={projectId} onEdit={() => setEditing(selected)} onChanged={refresh} />}</div>}
  </section>;
}

export function ConnectionEditor({ profile, initialEdition, onCancel, onSaved }: { profile?: ConnectionProfile; initialEdition?: WorkBuddyEdition; onCancel: () => void; onSaved: (value: ConnectionProfile) => void }) {
  const [runtime, setRuntime] = useState<RuntimeKind>(profile?.runtime ?? (initialEdition ? 'workbuddy' : 'codex'));
  const [mode, setMode] = useState<ConnectionMode>(profile?.mode ?? 'native');
  const [edition, setEdition] = useState<WorkBuddyEdition | ''>(profile ? profile.workbuddyEdition ?? '' : initialEdition ?? 'china');
  const [protocol, setProtocol] = useState<ConnectionProtocol>(profile?.protocol ?? 'responses');
  const [key, setKey] = useState('');
  const action = useAction();
  const protocols: ConnectionProtocol[] = runtime === 'codex' ? ['responses'] : runtime === 'claude' ? ['anthropic-messages'] : ['anthropic-messages', 'openai-chat'];
  const chosenProtocol = protocols.includes(protocol) ? protocol : protocols[0]!;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const field = (name: string) => String(values.get(name) ?? '').trim();
    const input: ConnectionInput = { name: field('name'), runtime, mode, protocol: mode === 'native' ? 'native' : mode === 'gateway' ? chosenProtocol : runtime === 'codex' ? 'responses' : runtime === 'claude' ? 'anthropic-messages' : 'codebuddy', provider: field('provider'), region: field('region') as ConnectionInput['region'] || undefined, ...(runtime === 'workbuddy' && mode === 'native' && edition ? { workbuddyEdition: edition } : {}), baseUrl: field('baseUrl') || undefined, defaultModel: field('model'), executable: field('executable') || undefined, ...(key ? { apiKey: key } : {}) };
    const saved = await action.execute<ConnectionProfile>(profile ? `/api/connections/${profile.id}` : '/api/connections', input, profile ? 'PATCH' : 'POST');
    if (saved) { setKey(''); onSaved(saved); }
  };
  return <form className="editor-form upgrade-card connection-editor" onSubmit={event => void submit(event)} autoComplete="off"><header><h3>{profile ? '编辑连接' : '新增连接'}</h3><button type="button" className="icon-button" aria-label="取消编辑连接" disabled={action.busy} onClick={onCancel}><X size={16} /></button></header>
    <div className="form-row"><label>连接名称<input name="name" required maxLength={100} defaultValue={profile?.name ?? ''} placeholder="例如：开发专用 API" /></label><label>执行工具<select value={runtime} disabled={!!profile} onChange={event => { setRuntime(event.target.value as RuntimeKind); setKey(''); }}>{Object.entries(runtimeLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div>
    <label>接入方式<select value={mode} onChange={event => { setMode(event.target.value as ConnectionMode); if (event.target.value === 'native') setKey(''); }}>{Object.entries(modeNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
    {mode === 'native' ? <p className="field-note">原生工具负责保存和刷新认证。同一原生认证范围的成员共享登录；工作台不会读取密码或复制订阅令牌。</p> : <><div className="form-row"><label>提供方名称<input name="provider" defaultValue={profile?.provider ?? ''} placeholder={runtime === 'codex' ? 'OpenAI' : runtime === 'claude' ? 'Anthropic' : 'CodeBuddy'} /></label>{mode === 'gateway' && <label>请求协议<select value={chosenProtocol} onChange={event => setProtocol(event.target.value as ConnectionProtocol)}>{protocols.map(value => <option key={value} value={value}>{protocolNames[value]}</option>)}</select></label>}</div><label>服务地址<input name="baseUrl" type="url" required={mode === 'gateway'} defaultValue={profile?.baseUrl ?? ''} placeholder={mode === 'official-api' ? '留空使用官方端点' : chosenProtocol === 'openai-chat' ? 'https://gateway.example/v1/chat/completions' : 'https://gateway.example/v1'} spellCheck={false} /></label><label>API Key<input type="password" aria-label="API Key" value={key} onChange={event => setKey(event.target.value)} autoComplete="new-password" placeholder={profile?.hasCredential ? '已保存凭据，留空保留原凭据' : '输入凭据，仅提交给本机后端'} /></label><p className="field-note"><KeyRound size={12} /> 凭据在本机加密保存；此页面不显示已保存的 Key。</p></>}
    {runtime === 'workbuddy' && (mode === 'native' ? <><label>WorkBuddy 登录版本<select name="workbuddyEdition" required={!profile} value={edition} onChange={event => setEdition(event.target.value as WorkBuddyEdition | '')}>{profile && !profile.workbuddyEdition && <option value="">保留旧配置 / 自动发现（未指定版本）</option>}<option value="china">国内版 · WorkBuddy</option><option value="international">国际版 · WorkBuddyAI</option></select></label><p className="field-note">每个版本单独检测内置 CLI 的登录。指定程序路径会保留；路径与所选版本不一致时，后端会拒绝保存。旧连接仅在你明确选择版本后更改。</p><WorkBuddyBundledLoginNotice />{profile?.region && <input type="hidden" name="region" value={profile.region} />}</> : <label>CodeBuddy API 环境<select key={mode} name="region" defaultValue={profile?.region === 'existing' ? 'china' : profile?.region ?? 'china'}><option value="china">中国站</option><option value="international">国际站</option></select></label>)}
    <div className="form-row"><label>默认模型 ID<input name="model" defaultValue={profile?.defaultModel ?? ''} placeholder="留空使用该连接默认模型" spellCheck={false} /></label><label>执行程序路径（可选）<input name="executable" defaultValue={profile?.executable ?? ''} placeholder="自动检测，或填写绝对路径" spellCheck={false} /></label></div>
    {profile && <p className="field-note">变更配置会产生新版本。已有会话保留，重新绑定时建立新会话；旧验证不作为新配置的调用依据。</p>}
    <Feedback {...action} /><div className="form-actions"><button type="button" className="secondary-button" disabled={action.busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={action.busy}>保存连接</button></div></form>;
}

function ConnectionDetails({ profile, installations, projectId, agents, onEdit, onChanged }: { profile: ConnectionProfile; installations?: WorkBuddyInstallation[]; projectId: string; agents: Agent[]; onEdit: () => void; onChanged: () => void }) {
  const action = useAction(onChanged);
  const [model, setModel] = useState(profile.defaultModel);
  const [catalog, setCatalog] = useState<RuntimeModelCatalog>();
  const [login, setLogin] = useState<LoginAttempt>();
  const [memberId, setMemberId] = useState('');
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [recoveryReason, setRecoveryReason] = useState('');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [nativeAction, setNativeAction] = useState<'browser' | 'device-code' | 'native-terminal' | 'logout'>();
  const affected = useResource<Agent[]>(nativeAction ? `/api/connections/${profile.id}/members` : undefined);
  const bound = agents.filter(agent => agent.connectionId === profile.id);
  const identityBusy = profile.mode === 'native' && loginNeedsResolution(login?.state);
  const latest = profile.verifications.find(item => item.revision === profile.revision && item.requestedModel === model);
  useEffect(() => { setModel(profile.defaultModel); }, [profile.defaultModel]);
  useEffect(() => {
    if (profile.mode !== 'native') return;
    const controller = new AbortController();
    void query<LoginAttempt | null>(`/api/connections/${profile.id}/login`, controller.signal).then(result => { if (!controller.signal.aborted) setLogin(result ?? undefined); }).catch(() => {});
    return () => controller.abort();
  }, [profile.id, profile.revision, profile.mode]);
  useEffect(() => {
    if (!loginNeedsResolution(login?.state)) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void query<LoginAttempt | undefined>(`/api/connections/${profile.id}/login`, controller.signal).then(result => { if (!controller.signal.aborted && result) { setLogin(result); if (!loginNeedsResolution(result.state)) onChanged(); } }).catch(() => {}); }, 2500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [login?.state, profile.id, onChanged]);
  const loadModels = async () => { setMetadataBusy(true); action.setError(''); try { setCatalog(await query<RuntimeModelCatalog>(`/api/connections/${profile.id}/models?projectId=${encodeURIComponent(projectId)}`)); } catch (reason) { action.setError(String(reason instanceof Error ? reason.message : reason)); } finally { setMetadataBusy(false); } };
  const loginUrl = safeExternal(login?.authUrl);
  const recoveryForm = login?.recoveryRequired && <form className="upgrade-subcard editor-form" onSubmit={async event => {
    event.preventDefault();
    if (!recoveryConfirmed || !recoveryReason.trim()) return;
    const result = await action.execute<LoginAttempt>(`/api/connections/${profile.id}/login/reconcile`, { confirmedStopped: true, reason: recoveryReason.trim() }, 'POST', '人工核对已记录，请重新检查认证并验证调用。');
    if (result) { setLogin(result); setRecoveryConfirmed(false); setRecoveryReason(''); }
  }}>
    <h4>恢复中断的原生流程</h4>
    <p className="field-note">服务重启后无法自动确认旧原生进程是否退出。先在原生终端核对并结束登录、退出或验证流程，再记录依据；此操作不终止进程，也不代表认证或调用成功。</p>
    <label>原生流程恢复核对依据<textarea value={recoveryReason} onChange={event => setRecoveryReason(event.target.value)} required maxLength={2000} rows={3} placeholder="说明已核对的登录终端、进程退出情况及时间；不要填写密钥或授权码。" /></label>
    <label className="checkbox-label"><input type="checkbox" checked={recoveryConfirmed} onChange={event => setRecoveryConfirmed(event.target.checked)} />我已在原生环境确认旧原生流程及相关进程已结束。</label>
    <button className="secondary-button" disabled={action.busy || !recoveryConfirmed || !recoveryReason.trim()}>记录核对并解除原生调用阻塞</button>
  </form>;
  return <div className="connection-detail upgrade-card"><header><div><h3>{profile.name}</h3><small>{runtimeLabels[profile.runtime]} · 配置 v{profile.revision}</small></div><button className="secondary-button" disabled={action.busy} onClick={onEdit}>编辑连接</button></header>
    <dl className="upgrade-facts">{profile.mode === 'native' && <><div><dt>原生登录</dt><dd><NativeLoginStatus profile={profile} /></dd></div><div><dt>最近登录检测</dt><dd>{localTime(profile.authenticationStatus?.checkedAt)}</dd></div>{profile.runtime === 'workbuddy' && <div><dt>登录版本</dt><dd>{workbuddyEditionLabel(profile)}</dd></div>}</>}<div><dt>连接与调用</dt><dd>{connectionStateNames[profile.status?.state ?? 'unconfigured']}</dd></div><div><dt>来源</dt><dd>{profile.authenticationStatus?.credentialSource || profile.status?.credentialSource || '尚未确认'}</dd></div><div><dt>提供方</dt><dd>{profile.authenticationStatus?.provider || profile.status?.provider || profile.provider || '未知'}</dd></div><div><dt>协议</dt><dd>{protocolNames[profile.protocol]}</dd></div><div><dt>服务地址</dt><dd>{profile.baseUrl || (profile.mode === 'native' ? '原生配置' : '官方端点')}</dd></div><div><dt>调用/配置检查</dt><dd>{localTime(profile.status?.checkedAt)}</dd></div></dl>{profile.mode === 'native' && <p className="field-note">登录检测：{profile.authenticationStatus?.detail || '尚无独立登录状态记录；等待后台检查或点击“刷新登录状态”。'} 检测到登录不代表调用已验证。</p>}<p className="field-note">{profile.status?.detail || '安装和模型目录不代表当前连接已能执行。请先检查认证，再验证调用。'}</p>
    {profile.runtime === 'workbuddy' && profile.mode === 'native' && <WorkBuddyBundledLoginNotice profile={profile} installations={installations} />}
    <div className="upgrade-actions"><button className="secondary-button" disabled={action.busy} onClick={() => void action.execute(`/api/connections/${profile.id}/check`, { projectId: projectId || undefined }, 'POST', '认证检查已完成。')}>检查认证</button>{profile.mode === 'native' && <><NativeLoginButton profile={profile} installations={installations} busy={action.busy || identityBusy} onClick={() => setNativeAction(profile.runtime === 'codex' ? 'browser' : 'native-terminal')} onMemoryAuthorize={() => void action.execute(`/api/connections/${profile.id}/verify`, { projectId: projectId || undefined, model, capabilities: defaultVerificationCapabilities }, 'POST', '原生执行进程的授权和调用验证已结束，请查看实际回执。')} />{profile.runtime === 'codex' && <button className="text-button" disabled={action.busy || identityBusy} onClick={() => setNativeAction('device-code')}>设备码登录</button>}<button className="text-button" disabled={action.busy || identityBusy} onClick={() => setNativeAction('logout')}>退出共享原生账号</button></>}</div>
    {nativeAction && <div className="upgrade-subcard native-account-action" aria-label="共享原生账号变更"><h4>{nativeAction === 'logout' ? '退出共享原生账号' : '打开共享原生登录'}</h4><p>共享同一原生认证范围的连接会受影响{profile.runtime === 'workbuddy' ? `（${workbuddyEditionLabel(profile)}）` : ''}。此操作会结束相关空闲会话，并使旧验证失效；历史成果保留。</p><Feedback error={affected.error} loading={affected.loading} /><ul>{affected.value?.map(agent => <li key={agent.id}>{agent.name} · {agent.state}{agent.controlMode === 'human' && ' · 人工接管'}</li>)}</ul>{affected.value?.length === 0 && <p>当前没有受影响成员。</p>}<p className="field-note">执行中、排队或状态未知的成员需先停止并核对。解除成员的工作台绑定与退出账号是不同操作。</p><div className="upgrade-actions"><button className="secondary-button" disabled={action.busy} onClick={() => setNativeAction(undefined)}>取消</button><button className="primary-button" disabled={action.busy || affected.loading || !affected.value || !!affected.error} onClick={async () => { const result = await action.execute<LoginAttempt | ConnectionProfile>(`/api/connections/${profile.id}/${nativeAction === 'logout' ? 'logout' : 'login'}`, { method: nativeAction === 'logout' ? undefined : nativeAction, projectId: projectId || undefined }, 'POST', nativeAction === 'logout' ? '已退出共享原生账号，请重新检查认证。' : '请在原生界面完成登录。'); if (result) { if ('method' in result) setLogin(result); else setLogin(undefined); setNativeAction(undefined); } }}>{nativeAction === 'logout' ? '确认退出账号' : '继续打开原生登录'}</button></div></div>}
    {login && <div className="upgrade-subcard"><strong>登录：{({ starting: '正在启动', waiting: '等待用户操作', stopping: '正在停止', unknown: '停止待核对', resolved: '人工核对已结束', completed: '已完成', cancelled: '已取消', failed: '失败' })[login.state]}</strong><p>{login.detail}</p>{loginUrl && <a href={loginUrl} target="_blank" rel="noreferrer">打开官方授权页 <ExternalLink size={13} /></a>}{login.userCode && <p>设备码：<code>{login.userCode}</code></p>}{identityBusy && !login.recoveryRequired && !loginNeedsRestart(login) && <button className="text-button" disabled={action.busy || login.state === 'stopping'} onClick={async () => { const result = await action.execute<LoginAttempt>(`/api/connections/${profile.id}/login/cancel`); if (result) setLogin(result); }}>{login.state === 'unknown' ? '重新核对并停止登录' : login.state === 'stopping' ? '正在确认停止…' : '取消本次登录'}</button>}</div>}
    {login && <LoginRecoveryNotice attempt={login} />}
    {recoveryForm}
    <div className="upgrade-subcard editor-form"><header><h4>模型与调用验证</h4><button type="button" className="text-button" disabled={metadataBusy || identityBusy} onClick={() => void loadModels()}>读取模型目录</button></header>{catalog && <><label>检测到的模型<select value={catalog.models.some(item => item.id === model) ? model : ''} onChange={event => { if (event.target.value) setModel(event.target.value); }}><option value="">选择模型</option>{catalog.models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label><p className="field-note">{catalog.detail}</p></>}<label>验证模型 ID<input value={model} onChange={event => setModel(event.target.value)} placeholder="可手动填写；留空使用原生默认" spellCheck={false} /></label><p className="field-note">点击下方按钮将发送一轮真实请求，产生模型用量；原生系统上下文也计入。常规刷新只读取状态。必需验证推理、流式输出和工具调用；Token 按实际回执单独记录。</p>{identityBusy && <p role="status" className="field-note">共享账号正在变更或等待停止核对，请先完成登录处理，再验证和派发任务。</p>}<button className="primary-button" disabled={action.busy || identityBusy} onClick={() => void action.execute(`/api/connections/${profile.id}/verify`, { projectId: projectId || undefined, model, capabilities: defaultVerificationCapabilities }, 'POST', '调用验证已结束，请查看回执。')}><ShieldCheck size={14} />发起真实调用验证</button>{latest && <div className="verification-receipt"><strong>{latest.success ? '验证成功' : '验证未通过'} · {localTime(latest.checkedAt)}</strong><p>{latest.detail}</p><p>模型回执：{latest.observedModel || '未提供'} · 提供方回执：{latest.observedProvider || '未提供'}</p><p>已验证能力：{latest.capabilities.join('、') || '无'}</p><VerificationUsage usage={latest.usage} /></div>}</div>
    <div className="upgrade-subcard editor-form"><h4>绑定成员</h4><p className="field-note">当前绑定：{bound.map(agent => agent.name).join('、') || '无'}。切换连接将保留旧会话并建立新会话。</p><div className="form-row"><label>成员<select value={memberId} onChange={event => setMemberId(event.target.value)}><option value="">选择同一工具的成员</option>{agents.filter(agent => agent.runtime === profile.runtime && (!projectId || agent.projectId === projectId)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><button className="secondary-button" disabled={action.busy || identityBusy || !memberId} onClick={() => void action.execute(`/api/agents/${memberId}`, { connectionId: profile.id, model }, 'PATCH', '成员连接已更新。')}><Check size={14} />应用连接与模型</button></div></div><Feedback {...action} />
  </div>;
}
