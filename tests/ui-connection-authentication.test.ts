import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionEditor, NativeLoginButton, NativeLoginStatus, WorkBuddyInstallationCards, WorkBuddyBundledLoginNotice, workbuddyBundledLoginLimited, workbuddyMemoryAuthenticationSupported, workbuddyEditionLabel, type WorkBuddyInstallation } from '../src/client/connection-center.js';
import type { ConnectionProfile, ConnectionStatus } from '../src/shared/types.js';

const status = (state: ConnectionStatus['state']): ConnectionStatus => ({ state, checkedAt: '2026-10-21T06:00:00Z', detail: '安全认证检测' });
const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'native-workbuddy', name: '本机 WorkBuddy', runtime: 'workbuddy', mode: 'native', protocol: 'native', provider: '原生配置', defaultModel: '',
  revision: 1, hasCredential: false, createdAt: '2026-10-21', updatedAt: '2026-10-21', verifications: [], ...overrides,
});
const renderStatus = (value: ConnectionProfile) => renderToStaticMarkup(createElement(NativeLoginStatus, { profile: value }));
const renderEditor = (value?: ConnectionProfile, initialEdition?: 'china' | 'international') => renderToStaticMarkup(createElement(ConnectionEditor, { profile: value, initialEdition, onSaved() {}, onCancel() {} }));

describe('native authentication observations stay separate from model verification', () => {
  it('prefers the new login observation even if an older model call was verified or failed', () => {
    expect(renderStatus(profile({ status: status('verified'), authenticationStatus: status('authentication-failed') }))).toContain('未登录 / 认证失效');
    expect(renderStatus(profile({ status: status('quota-exceeded'), authenticationStatus: status('authentication-observed') }))).toContain('已检测到登录');
    expect(renderStatus(profile({ status: status('network-failed'), authenticationStatus: status('unconfigured') }))).toContain('未检测到登录');
  });
  it('does not infer a current login or logout from model, quota, or network receipts', () => {
    for (const state of ['verified', 'quota-exceeded', 'network-failed', 'model-unavailable'] as const) {
      expect(renderStatus(profile({ status: status(state) }))).toContain('登录状态待核对');
    }
    expect(renderStatus(profile())).toContain('登录状态待核对');
    expect(renderStatus(profile({ authenticationStatus: status('not-installed') }))).toContain('无法检测登录');
    expect(renderStatus(profile({ mode: 'official-api', authenticationStatus: status('authentication-observed') }))).toBe('');
  });
  it('reads explicit historical authentication results without fabricating a new observation', () => {
    expect(renderStatus(profile({ status: status('authentication-observed') }))).toContain('已检测到登录');
    expect(renderStatus(profile({ status: status('authentication-failed') }))).toContain('CLI 调用认证失败');
  });
  it('distinguishes a stored identity from usable CLI authentication and preserves a real rejection', () => {
    const identity={...status('unconfigured'),credentialSource:'native-codebuddy-identity'};
    expect(renderStatus(profile({authenticationStatus:identity}))).toContain('账号身份存在，CLI 未就绪');
    const rejected=renderStatus(profile({authenticationStatus:status('authentication-observed'),status:status('authentication-failed')}));
    expect(rejected).toContain('CLI 调用认证失败');expect(rejected).not.toContain('已检测到登录');
  });
});

describe('WorkBuddy domestic and international connections are explicit', () => {
  it('shows separate installation evidence, edition controls and the desktop-versus-CLI distinction', () => {
    const html = renderToStaticMarkup(createElement(WorkBuddyInstallationCards, { discovery: { checkedAt: '2026-10-21', installations: [
      { edition: 'china', label: '国内版', executable: 'D:/WorkBuddy/codebuddy.js', version: '2.161.0', available: true, detail: '国内版执行包' },
      { edition: 'international', label: '国际版', executable: '', available: false, detail: '未发现国际版' },
    ] }, onConfigure() {} }));
    expect(html.match(/<article /g)).toHaveLength(2);
    expect(html).toContain('aria-label="WorkBuddy 国内版"');
    expect(html).toContain('aria-label="WorkBuddy 国际版"');
    expect(html).toContain('D:/WorkBuddy/codebuddy.js');
    expect(html).toContain('未发现国际版');
    expect(html).toContain('选择国内版连接与登录');
    expect(html).toContain('选择国际版连接与登录');
    expect(html).toContain('桌面客户端登录不代表 CLI 已登录');
    expect(html).toContain('以选中连接的安装版本和当前认证证据为准');
    expect(html).not.toContain('已检测到登录');
  });
  it('keeps failed discovery distinct from loading and still allows explicit setup', () => {
    const html = renderToStaticMarkup(createElement(WorkBuddyInstallationCards, { failed: true, onConfigure() {} }));
    expect(html).toContain('无法检测');
    expect(html).toContain('可指定执行程序路径');
    expect(html).toContain('选择国际版连接与登录');
    expect(html).not.toContain('检测中');
  });
  it('shows an absent edition as missing when discovery only returns installed distributions', () => {
    const html = renderToStaticMarkup(createElement(WorkBuddyInstallationCards, { discovery: { checkedAt: '2026-10-21', installations: [] }, onConfigure() {} }));
    expect(html).toContain('未检测到');
    expect(html).toContain('未发现此版本');
    expect(html).not.toContain('检测中');
  });
  it('preserves an unassigned legacy connection and its explicit path while editing', () => {
    const legacy = profile({ executable: 'D:/custom WorkBuddy/codebuddy.js', region: 'existing' });
    // A previously selected new-connection edition must not migrate an old connection on edit.
    const html = renderEditor(legacy, 'international');
    expect(workbuddyEditionLabel(legacy)).toContain('旧配置 / 自动发现');
    expect(html).toContain('<option value="" selected="">保留旧配置 / 自动发现');
    expect(html).toContain('value="D:/custom WorkBuddy/codebuddy.js"');
    expect(html).toContain('name="region" value="existing"');
    expect(html).not.toContain('value="china" selected=""');
    expect(html).not.toContain('value="international" selected=""');
  });
  it('preselects the requested new edition and preserves an existing explicit edition', () => {
    const created = renderEditor(undefined, 'international');
    expect(created).toContain('<option value="workbuddy" selected="">');
    expect(created).toContain('<option value="international" selected="">国际版');
    expect(created).toContain('name="workbuddyEdition" required=""');
    const china = profile({ workbuddyEdition: 'china' });
    expect(workbuddyEditionLabel(china)).toBe('WorkBuddy 国内版');
    expect(renderEditor(china, 'international')).toContain('<option value="china" selected="">国内版');
    expect(workbuddyEditionLabel(profile({ mode: 'gateway' }))).toBe('WorkBuddy');
  });
});

describe('bundled WorkBuddy CLI authentication limitations are explicit', () => {
  const installation: WorkBuddyInstallation = { edition: 'china', label: 'WorkBuddy 国内版', executable: 'D:/WorkBuddy/bin/codebuddy', version: '5.8.3', cliVersion: '2.161.0', executionPackage: 'lite', available: true, detail: 'Controlled installation evidence' };
  const missing = (overrides: Partial<ConnectionProfile> = {}) => profile({ workbuddyEdition: 'china', authenticationStatus: status('unconfigured'), ...overrides });
  it('explains missing desktop credential bootstrap without recommending another billing route', () => {
    const html = renderToStaticMarkup(createElement(WorkBuddyBundledLoginNotice, { profile: missing(), installations: [installation] }));
    expect(html).toContain('原生内存会话');
    expect(html).toContain('每个执行进程独立授权');
    expect(html).toContain('产生少量 Token');
    expect(html).toContain('不会退出桌面账号');
    expect(html).not.toContain('独立 CodeBuddy CLI');
  });
  it('offers authorization and real verification in the same confirmed lite process instead of a disposable login', () => {
    const renderButton = (value: ConnectionProfile, busy = false) => renderToStaticMarkup(createElement(NativeLoginButton, { profile: value, installations: [installation], busy, onClick() {}, onMemoryAuthorize() {} }));
    expect(renderButton(missing())).not.toContain('disabled=""');
    expect(renderButton(missing())).toContain('授权并验证CLI');
    expect(renderButton(missing())).toContain('少量 Token');
    expect(renderButton(profile())).not.toContain('disabled=""');
    expect(renderButton(profile({ runtime: 'codex' }))).not.toContain('disabled=""');
    expect(renderButton(profile({ runtime: 'claude' }), true)).toContain('disabled=""');
  });
  it('routes the confirmed bundle to authorization+verification even with existing observed credentials', () => {
    const onClick = vi.fn(), onMemoryAuthorize = vi.fn();
    const value = missing({ authenticationStatus: status('authentication-observed') });
    expect(workbuddyMemoryAuthenticationSupported(value, [installation])).toBe(true);
    const button = NativeLoginButton({ profile: value, installations: [installation], onClick, onMemoryAuthorize });
    button.props.onClick();
    expect(onMemoryAuthorize).toHaveBeenCalledOnce(); expect(onClick).not.toHaveBeenCalled();
    const legacy = NativeLoginButton({ profile: profile(), installations: [installation], onClick, onMemoryAuthorize });
    legacy.props.onClick(); expect(onClick).toHaveBeenCalledOnce();
  });
  it('does not block historical, unknown, full-package or incomplete installation evidence', () => {
    for (const evidence of [undefined, [], [{ ...installation, version: '5.5.6', cliVersion: '2.137.1' }], [{ ...installation, cliVersion: '2.161.1' }], [{ ...installation, cliVersion: undefined }], [{ ...installation, executionPackage: undefined }], [{ ...installation, executionPackage: 'full' as const }], [{ ...installation, available: false }]]) {
      expect(workbuddyBundledLoginLimited(missing(), evidence)).toBe(false);
    }
    const html = renderToStaticMarkup(createElement(WorkBuddyBundledLoginNotice, { profile: missing() }));
    expect(html).toContain('旧版本、未知安装或已有可用原生凭据不据此判为不支持');
    expect(html).not.toContain('等待受管登录入口适配');
  });
  it('requires the selected path or explicit edition to match rather than assuming automatic discovery', () => {
    expect(workbuddyBundledLoginLimited(missing({ executable: 'd:\\WORKBUDDY\\bin\\codebuddy' }), [installation])).toBe(true);
    expect(workbuddyBundledLoginLimited(missing({ executable: 'D:/old/2.137/codebuddy' }), [installation])).toBe(false);
    expect(workbuddyBundledLoginLimited(missing({ workbuddyEdition: 'international' }), [installation])).toBe(false);
    expect(workbuddyBundledLoginLimited(missing({ workbuddyEdition: undefined }), [installation])).toBe(false);
  });
  it('allows an affected installation with usable or undetermined credentials and does not infer absence from historical calls', () => {
    for (const state of ['authentication-observed', 'verified', 'unknown', 'network-failed'] as const) {
      const value = missing({ authenticationStatus: status(state) });
      expect(workbuddyBundledLoginLimited(value, [installation])).toBe(false);
      const html = renderToStaticMarkup(createElement(NativeLoginButton, { profile: value, installations: [installation], onClick() {}, onMemoryAuthorize() {} }));
      expect(html).not.toContain('disabled=""');
    }
    expect(workbuddyBundledLoginLimited(missing({ authenticationStatus: undefined, status: status('authentication-failed') }), [installation])).toBe(false);
  });
});
