import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { canAuthorizeRuntime, canCancelRuntimeAuthentication, runtimeAuthenticationPending, RuntimeAuthenticationCard, RuntimeAuthenticationView } from '../src/client/runtime-authentication.js';
import type { Agent, ConnectionProfile, RuntimeAuthenticationSession } from '../src/shared/types.js';

const session = (overrides: Partial<RuntimeAuthenticationSession> = {}): RuntimeAuthenticationSession => ({ id: 'owned-process', agentId: 'worker', connectionId: 'china-connection', connectionRevision: 3, edition: 'china', cwd: 'D:/controlled/fixed-worktree', state: 'waiting', createdAt: '2026-10-21T07:00:00Z', updatedAt: '2026-10-21T07:00:01Z', detail: '等待此原生进程授权', canAuthorize: true, ...overrides });
const agents = [{ id: 'worker', name: 'IoT 接口实施' }] as Agent[];
const connections = [{ id: 'china-connection', name: 'WorkBuddy 国内执行连接' }] as ConnectionProfile[];
const render = (sessions?: RuntimeAuthenticationSession[], options: { loading?: boolean; error?: string } = {}) => renderToStaticMarkup(createElement(RuntimeAuthenticationView, { sessions, agents, connections, ...options, onRefresh() {} }));

describe('native runtime authorization panel', () => {
  it('shows actual loading and empty records without inventing pending execution or success', () => {
    expect(render(undefined, { loading: true })).toContain('正在读取原生授权记录');
    const html = render([]);
    expect(html).toContain('当前没有待处理的执行授权');
    expect(html).not.toContain('打开原生授权');
    expect(html).not.toContain('本进程已授权');
    expect(html).not.toContain('等待原生授权');
  });
  it('shows member, exact connection revision, edition and fixed cwd for concurrent authorizations', () => {
    const html = render([session(), session({ id: 'international-process', agentId: 'verify-probe', edition: 'international', connectionId: 'international-connection', connectionRevision: 7, cwd: 'D:/different/fixed-worktree' })]);
    expect(html).toContain('2 个执行进程等待处理');
    expect(html).toContain('WorkBuddy 国内版'); expect(html).toContain('WorkBuddy 国际版');
    expect(html).toContain('IoT 接口实施'); expect(html).toContain('连接验证会话');
    expect(html).toContain('WorkBuddy 国内执行连接 · v3'); expect(html).toContain('international-connection · v7');
    expect(html).toContain('D:/controlled/fixed-worktree'); expect(html).toContain('D:/different/fixed-worktree');
    expect(html).toContain('每个执行进程独立进行原生授权');
    expect(html).toContain('在原生页面完成登录和授权；各版本按实际页面操作');
    expect(html).toContain('国内版显示二维码时可扫码完成');
    expect(html).toContain('关闭服务后需重新授权'); expect(html).toContain('不会退出 WorkBuddy 桌面账号');
  });
  it('uses authorization rather than QR-specific status for the international native login page', () => {
    const html = renderToStaticMarkup(createElement(RuntimeAuthenticationCard, { session: session({ edition: 'international' }), agents, connections, onChanged() {} }));
    expect(html).toContain('WorkBuddy 国际版');
    expect(html).toContain('等待原生授权');
    expect(html).not.toContain('扫码');
  });
  it('opens only a relative owning-server redirect without exposing native URLs or credentials', () => {
    const value = { ...session({ id: 'owned/id with spaces' }), authUrl: 'https://not-for-the-browser.invalid/secret-auth', token: 'sentinel-native-secret' };
    const html = render([value]);
    expect(html).toContain('href="/api/runtime-auth/owned%2Fid%20with%20spaces/open"');
    expect(html).toContain('target="_blank"'); expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain('https://not-for-the-browser.invalid'); expect(html).not.toContain('sentinel-native-secret');
  });
  it('requires a waiting native request before opening and keeps unknown cancellation distinct from authentication', () => {
    expect(canAuthorizeRuntime(session())).toBe(true);
    expect(canAuthorizeRuntime(session({ canAuthorize: false }))).toBe(false);
    for (const state of ['starting', 'authenticated', 'failed', 'stopping', 'stopped', 'unknown'] as const) expect(canAuthorizeRuntime(session({ state }))).toBe(false);
    for (const state of ['starting', 'waiting', 'unknown'] as const) expect(canCancelRuntimeAuthentication(session({ state }))).toBe(true);
    for (const state of ['authenticated', 'failed', 'stopping', 'stopped'] as const) expect(canCancelRuntimeAuthentication(session({ state }))).toBe(false);
    const html = render([session({ state: 'unknown' })]);
    expect(html).toContain('重试取消此进程'); expect(html).toContain('不能据此启动第二个写者');
    expect(html).not.toContain('href="/api/runtime-auth/');
  });
  it('keeps stopped, failed and authenticated outcomes in recent records and does not offer process cancellation after authentication', () => {
    const html = render([session({ id: 'success', state: 'authenticated' }), session({ id: 'failed', state: 'failed' }), session({ id: 'stopped', state: 'stopped' })]);
    expect(html).toContain('<details class="runtime-auth-recent">'); expect(html).toContain('最近授权记录 · 3');
    expect(html).toContain('本进程已授权'); expect(html).toContain('任务和调用结果仍以各自回执为准');
    expect(html).not.toContain('取消此进程授权'); expect(html).not.toContain('打开原生授权');
    expect(runtimeAuthenticationPending(session({ state: 'authenticated' }))).toBe(false);
    expect(runtimeAuthenticationPending(session({ state: 'stopping' }))).toBe(true);
  });
  it('preserves old records but withholds stale authorization links after polling fails', () => {
    const html = render([session()], { error: '服务连接中断' });
    expect(html).toContain('授权状态读取失败'); expect(html).toContain('IoT 接口实施'); expect(html).toContain('请刷新授权状态');
    expect(html).not.toContain('href="/api/runtime-auth/');
    const card = renderToStaticMarkup(createElement(RuntimeAuthenticationCard, { session: session({ state: 'stopping' }), agents, connections, onChanged() {} }));
    expect(card).toContain('正在确认停止'); expect(card).not.toContain('取消此进程授权');
  });
});
