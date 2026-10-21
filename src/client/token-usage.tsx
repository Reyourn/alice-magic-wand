import { useEffect, useRef } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import type { Agent, Task, TokenCounts, TokenUsageSummary } from '../shared/types.js';

export function formatTokenCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未提供';
}

export function findUsageSummary(summaries: TokenUsageSummary[], scope: TokenUsageSummary['scope'], projectId: string, identity: { agentId?: string; taskId?: string; nativeSessionId?: string }): TokenUsageSummary | undefined {
  if (scope === 'session' && !identity.nativeSessionId) return;
  return summaries.find(summary => summary.scope === scope && summary.projectId === projectId
    && (scope === 'task' ? summary.taskId === identity.taskId : summary.agentId === identity.agentId)
    && (scope !== 'session' || summary.nativeSessionId === identity.nativeSessionId));
}

const fields: { key: keyof TokenCounts; label: string }[] = [
  { key: 'inputTokens', label: '输入（含缓存）' },
  { key: 'outputTokens', label: '输出（含推理）' },
  { key: 'cachedInputTokens', label: '缓存读取' },
  { key: 'cacheCreationInputTokens', label: '缓存写入' },
  { key: 'reasoningOutputTokens', label: '推理输出' },
];

function Coverage({ summary }: { summary?: TokenUsageSummary }) {
  if (!summary) return <span className="usage-coverage">尚未收到对应统计</span>;
  return <span className="usage-coverage">已报告 {summary.reportedTurns} / {summary.totalTurns} 个工作台轮次{summary.partial && <strong>部分统计</strong>}</span>;
}

export function UsageBreakdown({ title, summary }: { title: string; summary?: TokenUsageSummary }) {
  return <section className="usage-breakdown" aria-label={`${title} Token 明细`}>
    <header><strong>{title}</strong><span>总量 <b>{formatTokenCount(summary?.counts.totalTokens)}</b></span></header>
    <Coverage summary={summary} />
    <dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{formatTokenCount(summary?.counts[field.key])}</dd></div>)}</dl>
  </section>;
}

export function AgentTokenUsage({ agent, summaries, compact = false }: { agent: Agent; summaries: TokenUsageSummary[]; compact?: boolean }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;
    details.open = false;
    if (!compact) return;
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
  }, [agent.id, compact]);
  const member = findUsageSummary(summaries, 'agent', agent.projectId, { agentId: agent.id });
  const session = findUsageSummary(summaries, 'session', agent.projectId, { agentId: agent.id, nativeSessionId: agent.nativeSessionId });
  return <details ref={detailsRef} className={`agent-token-usage${compact ? ' agent-token-usage--compact' : ''}`}>
    <summary><span className="usage-title"><Activity size={13} />Token 用量</span>{compact ? <span className="usage-session-total" title="当前原生会话 Token 总量" aria-label={`当前会话 ${formatTokenCount(session?.counts.totalTokens)}`}>{formatTokenCount(session?.counts.totalTokens)}</span> : <span className="usage-totals"><span>成员累计 <b>{formatTokenCount(member?.counts.totalTokens)}</b></span><span>当前会话 <b>{formatTokenCount(session?.counts.totalTokens)}</b></span>{(member?.partial || session?.partial) && <span className="usage-partial">部分统计</span>}</span>}<ChevronDown size={13} /></summary>
    <div className="usage-content"><div className="usage-comparison"><UsageBreakdown title="成员累计" summary={member} /><UsageBreakdown title="当前原生会话" summary={session} /></div><p className="usage-note">缓存属于输入子项，推理属于输出子项，不重复相加。缺失字段显示「未提供」；成员或会话中的原生历史用量可能无法归属到当前任务。</p></div>
  </details>;
}

export function TaskTokenUsage({ task, summaries }: { task: Task; summaries: TokenUsageSummary[] }) {
  const summary = findUsageSummary(summaries, 'task', task.projectId, { taskId: task.id });
  return <div className="task-token-usage"><UsageBreakdown title="任务 Token 用量" summary={summary} /><p className="usage-note">仅计入已归属该任务的回执。缓存与推理为子项，不额外叠加。</p></div>;
}
