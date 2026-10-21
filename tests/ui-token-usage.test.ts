import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent, Task, TokenUsageSummary } from '../src/shared/types.js';
import { AgentTokenUsage, findUsageSummary, formatTokenCount, TaskTokenUsage, UsageBreakdown } from '../src/client/token-usage.js';

const agent: Agent = { id: 'agent1', projectId: 'project1', name: '开发', role: 'developer', runtime: 'workbuddy', model: '', nativeSessionId: 'session1', instructions: '', permissionMode: 'workspace-write', controlMode: 'auto', state: 'idle', createdAt: '2026-10-09T00:00:00Z' };
const task: Task = { id: 'task1', projectId: 'project1', title: '实现', description: '', acceptance: '', dependencies: [], status: 'open' };
const summary = (overrides: Partial<TokenUsageSummary> = {}): TokenUsageSummary => ({ scope: 'agent', projectId: 'project1', agentId: 'agent1', counts: { inputTokens: 1200, outputTokens: 34, totalTokens: 1234, cachedInputTokens: 600 }, reportedTurns: 1, totalTurns: 2, partial: true, ...overrides });

describe('token consumption display', () => {
  it('distinguishes a provided zero from an absent value and preserves large exact counts', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(undefined)).toBe('未提供');
    expect(formatTokenCount(Number.NaN)).toBe('未提供');
    expect(formatTokenCount(1.5)).toBe('未提供');
    expect(formatTokenCount(12345678)).toBe('12,345,678');
  });

  it('matches project, member and exact session rather than reusing an old session', () => {
    const rows = [summary({ scope: 'session', nativeSessionId: 'old', counts: { totalTokens: 999 } }), summary({ scope: 'session', nativeSessionId: 'session1', counts: { totalTokens: 200 } }), summary({ scope: 'session', projectId: 'other', nativeSessionId: 'session1' })];
    expect(findUsageSummary(rows, 'session', 'project1', { agentId: 'agent1', nativeSessionId: 'session1' })?.counts.totalTokens).toBe(200);
    expect(findUsageSummary(rows, 'session', 'project1', { agentId: 'agent1' })).toBeUndefined();
    expect(findUsageSummary(rows, 'session', 'project1', { agentId: 'other', nativeSessionId: 'session1' })).toBeUndefined();
  });

  it('renders authoritative member and session totals independently without adding cache subcounts again', () => {
    const html = renderToStaticMarkup(createElement(AgentTokenUsage, { agent, summaries: [summary(), summary({ scope: 'session', nativeSessionId: 'session1', counts: { inputTokens: 160, outputTokens: 40, totalTokens: 200, cachedInputTokens: 80, reasoningOutputTokens: 10 } })] }));
    expect(html).toContain('1,234');
    expect(html).toContain('200');
    expect(html).not.toContain('1,434');
    expect(html).not.toContain('1,834');
    expect(html).toContain('输入（含缓存）');
    expect(html).toContain('输出（含推理）');
    expect(html).toContain('部分统计');
    expect(html).toContain('已报告 1 / 2 个工作台轮次');
  });

  it('does not fabricate a total or missing cache-write counter from the provided fields', () => {
    const html = renderToStaticMarkup(createElement(UsageBreakdown, { title: '测试', summary: summary({ counts: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 0 } }) }));
    expect(html).toContain('总量 <b>未提供</b>');
    expect(html).toContain('<dt>缓存读取</dt><dd>0</dd>');
    expect(html).toContain('<dt>缓存写入</dt><dd>未提供</dd>');
    expect(html).not.toContain('<b>23</b>');
  });

  it('keeps task totals scoped to the correct project and reports absent usage honestly', () => {
    const rows = [summary({ scope: 'task', projectId: 'other-project', taskId: 'task1', counts: { totalTokens: 999 } })];
    const html = renderToStaticMarkup(createElement(TaskTokenUsage, { task, summaries: rows }));
    expect(html).not.toContain('999');
    expect(html).toContain('尚未收到对应统计');
    expect(html).toContain('未提供');
  });
});
