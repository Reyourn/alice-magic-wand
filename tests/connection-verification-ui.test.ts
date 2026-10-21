import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultVerificationCapabilities, loginNeedsResolution, loginNeedsRestart, LoginRecoveryNotice, VerificationUsage } from '../src/client/connection-verification.js';
import type { LoginAttempt, RuntimeTokenUsage } from '../src/shared/types.js';
import type { WorkflowDetail } from '../src/shared/workflows.js';
import { canDeliverOffice } from '../src/client/artifact-explorer.js';

const render = (usage: RuntimeTokenUsage[]) => renderToStaticMarkup(createElement(VerificationUsage, { usage }));
describe('connection verification and metering are separate', () => {
  it('requires streaming and tools without making absent metering a connection failure', () => {
    expect(defaultVerificationCapabilities).toEqual(['inference', 'streaming', 'tools']);
    const html = render([]);
    expect(html).toContain('未提供用量回执');
    expect(html).toContain('不影响已验证的执行能力');
    expect(html).not.toContain('>0<');
  });
  it('preserves zero, missing totals and subset counters without manufacturing a total', () => {
    const html = render([{ source: 'test-native', scope: 'turn', inputTokens: 7, outputTokens: 0, cachedInputTokens: 4, reasoningOutputTokens: 0, partial: true }]);
    expect(html).toContain('输入 7');
    expect(html).toContain('输出 0');
    expect(html).toContain('总量 未提供');
    expect(html).toContain('缓存读取 4');
    expect(html).toContain('推理 0');
    expect(html).toContain('部分统计');
  });
  it('shows the latest cumulative receipt rather than adding session snapshots', () => {
    const html = render([
      { source: 'native', scope: 'session', totalTokens: 10 },
      { source: 'native', scope: 'session', totalTokens: 15 },
    ]);
    expect(html).toContain('总量 15');
    expect(html).toContain('会话累计');
    expect(html).not.toContain('25');
  });
  it('keeps identity changes gated until completed, cancelled or failed', () => {
    for (const state of ['starting', 'waiting', 'stopping', 'unknown']) expect(loginNeedsResolution(state as LoginAttempt['state'])).toBe(true);
    for (const state of ['completed', 'cancelled', 'failed', 'resolved']) expect(loginNeedsResolution(state as LoginAttempt['state'])).toBe(false);
    expect(loginNeedsResolution()).toBe(false);
  });
});

describe('unconfirmed native stop shows a reachable recovery path', () => {
  const unknown = (overrides: Partial<LoginAttempt> = {}): LoginAttempt => ({ id: 'attempt', connectionId: 'native-claude', runtime: 'claude', state: 'unknown', startedAt: '2026-10-20', updatedAt: '2026-10-20', method: 'native-terminal', detail: '停止未确认', ...overrides });
  const renderNotice = (attempt: LoginAttempt) => renderToStaticMarkup(createElement(LoginRecoveryNotice, { attempt }));
  it('explains the controlled restart and human check instead of offering another retry', () => {
    const html = renderNotice(unknown({ recoveryAction: 'restart-reconcile' }));
    expect(html).toContain('需要重启后核对');
    expect(html).toContain('核对该次登录的终端及相关进程');
    expect(html).toContain('受控方式重启工作台后台');
    expect(html).toContain('填写核对依据');
    expect(html).toContain('重新检查认证');
    expect(html).toContain('不代表原生登录成功');
    expect(html).not.toContain('重试取消');
    expect(html).not.toContain('重新核对并停止登录');
  });
  it('keeps the retry path only while retrying can still produce evidence', () => {
    expect(renderNotice(unknown({ recoveryAction: 'retry-stop' }))).toBe('');
    expect(renderNotice(unknown())).toBe('');
    expect(loginNeedsRestart(unknown({ recoveryAction: 'retry-stop' }))).toBe(false);
    expect(loginNeedsRestart(unknown({ recoveryAction: 'restart-reconcile' }))).toBe(true);
  });
  it('hands the flow back to the human reconciliation form after the restart', () => {
    expect(loginNeedsRestart(unknown({ recoveryAction: 'restart-reconcile', recoveryRequired: true }))).toBe(false);
    expect(renderNotice(unknown({ recoveryAction: 'restart-reconcile', recoveryRequired: true }))).toBe('');
  });
});

describe('office delivery reflects reopened task state', () => {
  it('does not offer delivery based solely on a cached completed workflow', () => {
    const detail = { workflow: { status: 'completed' }, nodes: [{ accepted: true }, { accepted: true }] } as WorkflowDetail;
    expect(canDeliverOffice(detail)).toBe(true);
    const reopened = { ...detail, nodes: [detail.nodes[0]!, { ...detail.nodes[1]!, accepted: false }] };
    expect(canDeliverOffice(reopened)).toBe(false);
    expect(canDeliverOffice({ ...detail, nodes: [] })).toBe(false);
  });
});
