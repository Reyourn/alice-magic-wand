import { useEffect, useState, type FormEvent } from 'react';
import type { DeliveryAction, DeliveryActionInput, DeliveryActionKind } from '../shared/delivery.js';
import type { WorkflowDetail } from '../shared/types.js';
import { Feedback, localTime, NoRecords, useAction, useResource } from './upgrade-common.js';

const kinds: Record<DeliveryActionKind, string> = { push: '推送提交', 'pull-request': '创建 PR', deploy: '实际部署' };
const states: Record<DeliveryAction['state'], string> = { prepared: '已准备 · 等待确认', running: '执行中', succeeded: '成功', failed: '已核对失败', unknown: '结果未知 · 需要核对' };
export function canPrepareDelivery(detail: WorkflowDetail): boolean {
  return ['completed', 'delivered'].includes(detail.workflow.status) && !!detail.integration && ['verified', 'delivered'].includes(detail.integration.state)
    && detail.nodes.every(node => node.accepted && (node.bundle?.kind !== 'code' || detail.integration!.integratedBundleIds.includes(node.bundle.id)));
}
export function deliveryActionInput(kind: DeliveryActionKind, values: FormData): DeliveryActionInput {
  const field = (name: string) => String(values.get(name) ?? '');
  if (kind === 'deploy') {
    let args: unknown;
    try { args = JSON.parse(field('args') || '[]'); } catch { throw new Error('部署参数必须是有效 JSON 字符串数组。'); }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('部署参数必须是 JSON 字符串数组。');
    return { kind, command: field('command').trim(), args };
  }
  const input: DeliveryActionInput = { kind, remote: field('remote').trim(), branch: field('branch').trim() };
  return kind === 'pull-request' ? { ...input, base: field('base').trim(), title: field('title').trim(), body: field('body'), draft: values.get('draft') === 'on' } : input;
}

export function DeliveryActionsPanel({ detail, refresh }: { detail: WorkflowDetail; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const records = useResource<DeliveryAction[]>(open ? `/api/workflows/${detail.workflow.id}/delivery-actions` : undefined);
  const [kind, setKind] = useState<DeliveryActionKind>('push');
  const action = useAction(() => { records.reload(); refresh(); });
  const ready = canPrepareDelivery(detail);
  useEffect(() => { if (!open) return; const timer = setInterval(records.reload, 5000); return () => clearInterval(timer); }, [open, records.reload]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); let input: DeliveryActionInput;
    try { input = deliveryActionInput(kind, new FormData(event.currentTarget)); } catch (error) { action.setError(error instanceof Error ? error.message : String(error)); return; }
    await action.execute(`/api/workflows/${detail.workflow.id}/delivery-actions`, input, 'POST', '动作预览已准备，请检查准确提交、命令及影响范围后确认执行。');
  };
  return <details className="upgrade-card outbound-delivery" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>后续交付动作 · 推送 / PR / 部署</summary>
    <p className="field-note">这些动作有独立的确认与执行回执。任务验收和本地目标分支交付不代表已经推送、创建 PR 或部署。</p>
    {!ready && <p className="upgrade-notice">先完成任务验收和当前整合版本的实际测试，再准备后续交付动作。</p>}
    <form className="editor-form" onSubmit={event => void submit(event)}>
      <label>动作类型<select value={kind} onChange={event => setKind(event.target.value as DeliveryActionKind)}><option value="push">推送固定提交</option><option value="pull-request">推送并创建 PR</option><option value="deploy">执行部署命令</option></select></label>
      {kind === 'deploy' ? <><label>部署执行程序<input name="command" required placeholder="例如已配置好的部署工具" spellCheck={false} /></label><label>部署参数（JSON 字符串数组）<textarea name="args" defaultValue="[]" required rows={3} spellCheck={false} /></label><p className="field-note">使用工具已有的本机认证。固定程序和参数将在预览所示工作区实际执行。</p></> : <>
        <div className="form-row"><label>Git 远端名称<input name="remote" required defaultValue="origin" spellCheck={false} /></label><label>推送目标分支{kind === 'pull-request' && ' / PR 源分支'}<input name="branch" required placeholder="例如 feature/report" spellCheck={false} /></label></div>
        {kind === 'pull-request' && <><label>PR 目标分支<input name="base" required defaultValue={detail.integration?.targetBranch} spellCheck={false} /></label><label>PR 标题<input name="title" required maxLength={300} /></label><label>PR 描述<textarea name="body" rows={5} /></label><label className="checkbox-label"><input type="checkbox" name="draft" defaultChecked />先创建草稿 PR</label></>}
      </>}
      <button className="secondary-button" disabled={!ready || action.busy}>准备动作预览</button><Feedback {...action} />
    </form>
    <Feedback error={records.error} loading={records.loading && !records.value} />
    {records.value?.slice().reverse().map(record => <DeliveryActionCard key={`${record.id}:${record.fingerprint}`} record={record} currentCommit={detail.integration?.headCommit} ready={ready} blocked={records.value!.some(other => other.id !== record.id && ['running', 'unknown'].includes(other.state))} refresh={() => { records.reload(); refresh(); }} />)}
    {open && records.value?.length === 0 && <NoRecords title="尚未准备后续交付动作">准备预览会读取本机配置和版本，确认执行后才产生实际推送、PR 或部署。</NoRecords>}
  </details>;
}

export function DeliveryActionCard({ record, currentCommit, ready, blocked, refresh }: { record: DeliveryAction; currentCommit?: string; ready: boolean; blocked: boolean; refresh: () => void }) {
  const action = useAction(refresh);
  const [confirmed, setConfirmed] = useState('');
  const [result, setResult] = useState<'succeeded' | 'failed'>('succeeded');
  const [reason, setReason] = useState('');
  const confirmation = `${record.commit}:${record.fingerprint}`;
  const stale = record.commit !== currentCommit;
  let url: string | undefined;
  try { if (record.url && new URL(record.url).protocol === 'https:') url = record.url; } catch { /* Invalid external receipts remain plain text. */ }
  return <article className="upgrade-subcard delivery-action-record"><header><strong>{kinds[record.kind]}</strong><span className="upgrade-tag">{states[record.state]}</span></header>
    <p>{localTime(record.createdAt)}</p><dl className="upgrade-facts"><div><dt>固定提交</dt><dd><code>{record.commit}</code></dd></div><div><dt>执行工作区</dt><dd><code>{record.worktree}</code></dd></div>{record.destination && <div><dt>实际远端地址</dt><dd><code>{record.destination}</code></dd></div>}</dl>
    <strong>实际执行顺序</strong><pre>{record.commands.map(command => [command.command, ...command.args].map(value => JSON.stringify(value)).join(' ')).join('\n')}</pre>
    {record.kind === 'pull-request' && <details><summary>已固定的 PR 标题与正文 · {record.input.draft !== false ? '草稿' : '正式 PR'}</summary><strong>{record.input.title}</strong><pre>{record.input.body || '（正文为空）'}</pre></details>}
    {record.detail && <p>{record.detail}</p>}{url && <a href={url} target="_blank" rel="noreferrer">打开 PR 回执</a>}
    {record.state === 'prepared' && <><label className="checkbox-label"><input type="checkbox" checked={confirmed === confirmation} disabled={stale || !ready || blocked} onChange={event => setConfirmed(event.target.checked ? confirmation : '')} />已核对以上固定提交、工作区和完整动作，确认实际执行。</label><button className="primary-button" disabled={action.busy || confirmed !== confirmation || stale || !ready || blocked} onClick={() => void action.execute(`/api/delivery-actions/${record.id}/execute`, { confirmedCommit: record.commit, fingerprint: record.fingerprint }, 'POST', '执行回执已返回，请按下面的实际状态核对结果。')}>确认执行{kinds[record.kind]}</button>{stale && <p className="upgrade-error">当前整合提交已变化，请重新准备动作预览。</p>}{blocked && <p className="upgrade-error">本工作流还有执行中或结果未知的动作，请先核对。</p>}</>}
    {record.state === 'unknown' && <form className="editor-form" onSubmit={event => { event.preventDefault(); void action.execute(`/api/delivery-actions/${record.id}/reconcile`, { result, reason }, 'POST', '已保存人工核对结论，未重新执行外部动作。'); }}><p className="upgrade-notice">请先检查远端或部署环境；结果未知时不能直接重跑。</p><label>核对后的实际结果<select value={result} onChange={event => setResult(event.target.value as typeof result)}><option value="succeeded">确认成功</option><option value="failed">确认失败</option></select></label><label>核对依据<textarea required value={reason} onChange={event => setReason(event.target.value)} rows={3} placeholder="记录远端提交、PR 链接或部署检查依据" /></label><button className="secondary-button" disabled={action.busy || !reason.trim()}>记录人工核对结论</button></form>}
    {record.reconciliation && <p>人工核对：{record.reconciliation.reason} · {localTime(record.reconciliation.at)}</p>}
    {!!record.receipts.length && <details><summary>实际命令回执 · {record.receipts.length}</summary>{record.receipts.map((receipt, index) => <div key={index}><code>{receipt.command.command} · 退出码 {receipt.exitCode}</code><pre>{receipt.log}</pre></div>)}</details>}
    <Feedback {...action} />
  </article>;
}
