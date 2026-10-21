import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { RuntimeOverrides } from '../src/shared/connections.js';
import { launchWorkbuddyLogin, preflightWorkbuddyLogin, readWorkbuddyAuthentication, WorkbuddyAuthStopError, WorkbuddyLoginUnavailableError, type WorkbuddyAuthDependencies } from '../src/server/connections/workbuddy-auth.js';
import type { Json } from '../src/server/runtime/process.js';

function gate<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class NativeDouble extends EventEmitter {
  exited = false;
  initialization: Json = { account: null };
  methods = ['workbuddy-desktop'];
  authentication = gate<Json>();
  request = vi.fn(async (_id: string, frame: Json) => {
    const subtype = frame.request.subtype;
    if (subtype === 'initialize') return this.initialization;
    if (subtype === 'get_auth_methods') return { authMethods: this.methods.map(id => ({ id, name: 'Native provider' })) };
    if (subtype === 'authenticate') return this.authentication.promise;
    throw new Error('Unexpected request');
  });
  write = vi.fn(async (_frame: Json) => {});
  close = vi.fn(async () => { this.exited = true; });
  callback(subtype: string, values: Json = {}) { this.emit('frame', { type: 'control_request', request_id: `callback-${subtype}`, request: { subtype, ...values } }); }
}
function fixture(edition: 'china' | 'international' = 'china', processes = [new NativeDouble()]) {
  const config: RuntimeOverrides = { connectionId: `native-${edition}`, revision: 1, env: {}, executable: `${edition}-cli`, workbuddyEdition: edition };
  const deps: WorkbuddyAuthDependencies = {
    executable: vi.fn(async value => value.executable),
    inspectLaunch: vi.fn(async () => 'standalone-or-unknown' as const),
    open: vi.fn(() => { const child = processes.shift(); if (!child) throw new Error('Unexpected extra child'); return child; }),
  };
  return { config, deps };
}
const requests = (child: NativeDouble) => child.request.mock.calls.map(([, frame]) => frame.request);
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const work of cleanups.splice(0).reverse())await work();});

describe('WorkBuddy native authentication metadata, without inference or credential copying', () => {
  it.each(['china', 'international'] as const)('reads %s authentication without returning native account data', async edition => {
    const child = new NativeDouble(), f = fixture(edition, [child]);
    child.initialization = { account: { token: 'NATIVE-PRIVATE-TOKEN', nickname: 'PRIVATE-NAME', uid: 'PRIVATE-ID' }, models: [{ id: 'unrelated' }] };
    const result = await readWorkbuddyAuthentication('.', f.config, f.deps);
    expect(result).toMatchObject({ state: 'authentication-observed', credentialSource: 'native-codebuddy-account' });
    expect(result.provider).toContain(edition === 'china' ? '中国站' : '国际站');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|nickname|uid|models/);
    expect(requests(child)).toEqual([{ subtype: 'initialize', hasPrompt: true, capabilities: {} }]);
    expect(child.write).not.toHaveBeenCalled(); expect(child.close).toHaveBeenCalledOnce();
  });
  it('distinguishes an explicitly missing CLI account from an unsupported state schema', async () => {
    const missing = new NativeDouble(), unknown = new NativeDouble(); unknown.initialization = { account: { uid: 'identity-without-credential' } };
    const f = fixture('china', [missing, unknown]);
    expect((await readWorkbuddyAuthentication('.', f.config, f.deps)).state).toBe('unconfigured');
    expect((await readWorkbuddyAuthentication('.', f.config, f.deps)).state).toBe('unknown');
  });
  it.each(['china', 'international'] as const)('does not treat the %s identity-only summary as usable authentication', async edition => {
    const child = new NativeDouble(), f = fixture(edition, [child]);
    child.initialization = { account: { uid: 'PRIVATE-UID', userId: 'PRIVATE-USER', type: 'native-account' } };
    const result = await readWorkbuddyAuthentication('.', f.config, f.deps);
    expect(result.state).toBe('unconfigured');
    expect(result.credentialSource).toBe('native-codebuddy-identity');
    expect(result.detail).toContain('未报告执行所需的认证凭据');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|native-account/);
    expect(requests(child).map(row => row.subtype)).toEqual(['initialize']);
  });
  it('shows inherited environment evidence separately and never returns its value', async () => {
    const child = new NativeDouble(), f = fixture('china', [child]); f.config.env.CODEBUDDY_AUTH_TOKEN = 'ENVIRONMENT-PRIVATE';
    const result = await readWorkbuddyAuthentication('.', f.config, f.deps);
    expect(result.credentialSource).toBe('native-environment'); expect(JSON.stringify(result)).not.toContain('ENVIRONMENT-PRIVATE');
  });
  it.each(['china', 'international'] as const)('directs an unauthenticated %s memory channel to per-process authorization without initiating it', async edition => {
    for (const account of [null, { uid: 'PRIVATE-IDENTITY', type: 'desktop' }]) {
      const child = new NativeDouble(), f = fixture(edition, [child]);
      f.config.nativeMemoryAuthentication = true;
      f.deps.inspectLaunch = vi.fn(async () => 'unsupported-2.161-lite' as const);
      child.initialization = { account };
      const result = await readWorkbuddyAuthentication('.', f.config, f.deps);
      expect(result).toMatchObject({ state: 'unconfigured', credentialSource: 'native-memory-authorization-required' });
      expect(result.provider).toContain(edition === 'china' ? '中国站' : '国际站');
      expect(result.detail).toContain('每个执行进程独立');
      expect(result.detail).toContain('顶部“执行授权”');
      expect(result.detail).toContain('授权并验证CLI');
      expect(result.detail).toContain('会产生少量 Token');
      expect(result.detail).toContain('不会退出桌面客户端账号');
      expect(result.detail).not.toMatch(/尚不支持|无需.*扫码/);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(requests(child)).toEqual([{ subtype: 'initialize', hasPrompt: true, capabilities: {} }]);
      expect(child.write).not.toHaveBeenCalled(); expect(child.close).toHaveBeenCalledOnce();
    }
  });
  it.each(['account', 'environment'] as const)('keeps actual native %s evidence ahead of the memory authorization guidance', async source => {
    const child = new NativeDouble(), f = fixture('china', [child]);
    f.config.nativeMemoryAuthentication = true;
    f.deps.inspectLaunch = vi.fn(async () => 'unsupported-2.161-lite' as const);
    if (source === 'account') child.initialization = { account: { token: 'PRIVATE-NATIVE-TOKEN' } };
    else f.config.env.CODEBUDDY_AUTH_TOKEN = 'PRIVATE-NATIVE-ENVIRONMENT';
    const result = await readWorkbuddyAuthentication('.', f.config, f.deps);
    expect(result).toMatchObject({ state: 'authentication-observed', credentialSource: source === 'account' ? 'native-codebuddy-account' : 'native-environment' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(requests(child).map(row => row.subtype)).toEqual(['initialize']);
    expect(child.write).not.toHaveBeenCalled(); expect(child.close).toHaveBeenCalledOnce();
  });
  it('does not turn an initialization/network error into rejected credentials or expose vendor diagnostics', async () => {
    const child = new NativeDouble(), f = fixture('china', [child]); child.request.mockRejectedValueOnce(new Error('token=PRIVATE-NATIVE-DIAGNOSTIC'));
    const result = await readWorkbuddyAuthentication('.', f.config, f.deps);
    expect(result.state).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(child.close).toHaveBeenCalledOnce();
  });
  it('retains a retry stop handle when a metadata process cannot be confirmed stopped', async () => {
    const child = new NativeDouble(), f = fixture('china', [child]); child.close.mockRejectedValueOnce(new Error('Still running'));
    let failure: unknown; try { await readWorkbuddyAuthentication('.', f.config, f.deps); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WorkbuddyAuthStopError); await (failure as WorkbuddyAuthStopError).retryStop(); expect(child.close).toHaveBeenCalledTimes(2);
  });
});

describe('WorkBuddy native browser authorization over stream-json', () => {
  it.each(['china', 'international'] as const)('blocks new authorization in the diagnosed %s 2.161 lite bundle after a read-only credential check',async edition=>{
    const directory=await mkdtemp(join(tmpdir(),'awb-desktop-auth-guard-'));
    cleanups.push(async()=>{if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe test cleanup');await rm(directory,{recursive:true,force:true});});
    const cli=join(directory,'resources/app.asar.unpacked/cli'),executable=join(cli,'bin/codebuddy');
    await mkdir(dirname(executable),{recursive:true});await writeFile(executable,'// Metadata fixture; never executable');
    await writeFile(join(cli,'product.json'),JSON.stringify({authentication:{id:edition==='china'?'workbuddy-desktop':'workbuddy-desktop-ai'}}));
    await writeFile(join(cli,'package.json'),JSON.stringify({version:'0.0.0',publishConfig:{customPackage:{version:'2.161.0'}}}));
    await mkdir(join(cli,'dist'),{recursive:true});await writeFile(join(cli,'dist/codebuddy-lite-wb.mjs'),'// Public execution package metadata fixture');
    const child=new NativeDouble(),f=fixture(edition,[child]);f.config.executable=executable;
    await expect(launchWorkbuddyLogin('.',f.config,{executable:f.deps.executable,open:f.deps.open})).rejects.toBeInstanceOf(WorkbuddyLoginUnavailableError);
    expect(f.deps.open).toHaveBeenCalledOnce();expect(requests(child).map(row=>row.subtype)).toEqual(['initialize']);expect(child.write).not.toHaveBeenCalled();expect(child.close).toHaveBeenCalledOnce();
  });
  it('reports a desktop identity-only state without asking for another ineffective scan',async()=>{
    const child=new NativeDouble(),f=fixture('china',[child]);f.deps.inspectLaunch=vi.fn(async()=>'unsupported-2.161-lite' as const);
    child.initialization={account:{uid:'PRIVATE-IDENTITY',type:'desktop'}};
    const result=await readWorkbuddyAuthentication('.',f.config,f.deps);
    expect(result).toMatchObject({state:'unconfigured',credentialSource:'native-codebuddy-identity'});
    expect(result.detail).toContain('原生凭据引导');expect(result.detail).toContain('无需重复扫码');expect(result.detail).toContain('工作台尚不支持');expect(result.detail).not.toContain('请使用对应版本的 CLI 原生登录');expect(result.detail).not.toContain('独立 CodeBuddy');
    expect(requests(child).map(row=>row.subtype)).toEqual(['initialize']);expect(JSON.stringify(result)).not.toContain('PRIVATE-IDENTITY');
  });
  it('does not block an already authenticated 2.161 lite process or send a second authorization',async()=>{
    const child=new NativeDouble(),f=fixture('china',[child]);f.deps.inspectLaunch=vi.fn(async()=>'unsupported-2.161-lite' as const);child.initialization={account:{token:'PRIVATE'}};
    const handle=await launchWorkbuddyLogin('.',f.config,f.deps);
    expect((await handle.poll())?.state).toBe('completed');expect(requests(child).map(row=>row.subtype)).toEqual(['initialize']);await handle.close(false);
  });
  it('admits an existing credential during read-only preflight without calling authenticate',async()=>{
    const child=new NativeDouble(),f=fixture('china',[child]);f.deps.inspectLaunch=vi.fn(async()=>'unsupported-2.161-lite' as const);child.initialization={account:{token:'PRIVATE'}};
    const result=await preflightWorkbuddyLogin('.',f.config,f.deps);
    expect(result.alreadyAuthenticated).toBe(true);expect(result.detail).toContain('没有发起新授权');expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(requests(child).map(row=>row.subtype)).toEqual(['initialize']);expect(child.close).toHaveBeenCalledOnce();
  });
  it.each([
    {version:'2.137.1',artifact:'codebuddy-lite-wb.mjs'},
    {version:'2.161.0',artifact:'codebuddy.js'},
    {version:undefined,artifact:'codebuddy-lite-wb.mjs'},
  ])('preserves the unverified historical/unknown desktop path for $version / $artifact',async({version,artifact})=>{
    const directory=await mkdtemp(join(tmpdir(),'awb-historical-auth-'));
    cleanups.push(async()=>{if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe test cleanup');await rm(directory,{recursive:true,force:true});});
    const cli=join(directory,'cli'),executable=join(cli,'bin/codebuddy');await mkdir(dirname(executable),{recursive:true});await writeFile(executable,'// Metadata fixture');
    await writeFile(join(cli,'product.json'),JSON.stringify({authentication:{id:'workbuddy-desktop'}}));await writeFile(join(cli,'package.json'),JSON.stringify({publishConfig:{customPackage:{version}}}));
    await mkdir(join(cli,'dist'),{recursive:true});await writeFile(join(cli,'dist',artifact),'// Public package metadata fixture');
    const child=new NativeDouble(),f=fixture('china',[child]);f.config.executable=executable;
    const handle=await launchWorkbuddyLogin('.',f.config,{executable:f.deps.executable,open:f.deps.open});
    expect(handle.detail).toContain('尚未在本机验收');expect(requests(child).some(row=>row.subtype==='authenticate')).toBe(true);await handle.close(true);
  });
  it.each(['china', 'international'] as const)('uses only the %s executable native method and receives a dynamic URL', async edition => {
    const child = new NativeDouble(), f = fixture(edition, [child]); child.methods = [edition === 'china' ? 'workbuddy-desktop' : 'workbuddy-desktop-ai'];
    const handle = await launchWorkbuddyLogin('.', f.config, f.deps);
    expect(await handle.poll()).toBeUndefined(); expect(handle.getState().authUrl).toBeUndefined();
    child.callback('auth_url_callback', { authState: { authUrl: 'https://www.workbuddy.ai/native-login?state=ephemeral' } });
    expect(handle.getState().authUrl).toContain('https://www.workbuddy.ai/');
    const authentication = requests(child).find(row => row.subtype === 'authenticate');
    expect(authentication).toEqual({ subtype: 'authenticate', methodId: child.methods[0] });
    expect(authentication).not.toHaveProperty('endpoint'); expect(authentication).not.toHaveProperty('environment');
    child.callback('auth_result_callback', { success: true, userinfo: { token: 'PRIVATE-RESULT', userName: 'PRIVATE-USER' } });
    expect(await handle.poll()).toMatchObject({ state: 'completed' });
    expect(JSON.stringify([handle.getState(), await handle.poll()])).not.toContain('PRIVATE');
    await handle.close(false); expect(child.close).toHaveBeenCalledOnce(); expect(handle.getState().authUrl).toBeUndefined();
  });
  it('does not restart authentication when this exact CLI already reports a usable native account', async () => {
    const child = new NativeDouble(), f = fixture('china', [child]); child.initialization = { account: { token: 'EXISTING-PRIVATE' } };
    const handle = await launchWorkbuddyLogin('.', f.config, f.deps);
    expect((await handle.poll())?.state).toBe('completed'); expect(requests(child).map(row => row.subtype)).toEqual(['initialize']); await handle.close(false);
  });
  it('rejects a version/method mismatch without switching sites or attempting login', async () => {
    const child = new NativeDouble(), f = fixture('international', [child]);
    await expect(launchWorkbuddyLogin('.', f.config, f.deps)).rejects.toThrow('版本与原生认证方法不一致');
    expect(requests(child).some(row => row.subtype === 'authenticate')).toBe(false); expect(child.close).toHaveBeenCalledOnce();
  });
  it.each(['http://login.example.test', 'javascript:alert(1)', 'https://user:private@example.test'])('does not expose an unsafe authorization URL: %s', async url => {
    const child = new NativeDouble(), f = fixture('china', [child]), handle = await launchWorkbuddyLogin('.', f.config, f.deps);
    child.callback('auth_url_callback', { authState: { authUrl: url, token: 'PRIVATE' } });
    expect(handle.getState().authUrl).toBeUndefined(); expect((await handle.poll())?.state).toBe('failed'); await handle.close(true);
  });
  it('rechecks the same CLI after an uncertain timeout, accepting only newly observed authentication evidence', async () => {
    const login = new NativeDouble(), probe = new NativeDouble(), f = fixture('international', [login, probe]); login.methods = ['workbuddy-desktop-ai']; probe.initialization = { account: { token: 'SAVED-LATE-PRIVATE' } };
    const handle = await launchWorkbuddyLogin('.', f.config, f.deps); login.authentication.reject(new Error('Request timeout token=PRIVATE'));
    await vi.waitFor(async () => expect((await handle.poll())?.state).toBe('completed'));
    expect(f.deps.open).toHaveBeenCalledTimes(2); for (const call of vi.mocked(f.deps.open).mock.calls) expect(call[2]).toBe(f.config);
    expect(requests(probe).map(row => row.subtype)).toEqual(['initialize']);
    expect(JSON.stringify(await handle.poll())).not.toContain('PRIVATE'); await handle.close(false); expect(probe.close).toHaveBeenCalledOnce();
  });
  it('does not call an unobserved late scan successful when the native request times out', async () => {
    const login = new NativeDouble(), probe = new NativeDouble(), f = fixture('china', [login, probe]); const handle = await launchWorkbuddyLogin('.', f.config, f.deps);
    login.authentication.reject(new Error('Request timeout'));
    await vi.waitFor(async () => expect((await handle.poll())?.state).toBe('failed')); expect((await handle.poll())?.detail).toContain('未能确认 CLI 登录'); await handle.close(false);
  });
  it('cancels only the owned request and closes the process, without triggering another login or probe', async () => {
    const child = new NativeDouble(), f = fixture('china', [child]), handle = await launchWorkbuddyLogin('.', f.config, f.deps);
    await handle.close(true); child.authentication.reject(new Error('Cancelled'));
    await Promise.resolve(); expect(f.deps.open).toHaveBeenCalledOnce();
    expect(child.write.mock.calls[0]?.[0]).toEqual({ type: 'control_cancel_request', request_id: child.request.mock.calls.find(([, frame]) => frame.request.subtype === 'authenticate')?.[0] });
    expect(child.close).toHaveBeenCalledOnce();
  });
  it('cannot complete a timed-out login while the follow-up authentication process stop remains unconfirmed', async () => {
    const login = new NativeDouble(), probe = new NativeDouble(), f = fixture('china', [login, probe]); let stopFailed = true;
    probe.initialization = { account: { token: 'PRIVATE' } }; probe.close.mockImplementation(async () => { if (stopFailed) throw new Error('Still running'); probe.exited = true; });
    const handle = await launchWorkbuddyLogin('.', f.config, f.deps); login.authentication.reject(new Error('Request timeout'));
    await vi.waitFor(async () => expect(await handle.poll()).toBeDefined());
    await expect(handle.close(false)).rejects.toThrow('Still running'); stopFailed = false; await handle.close(false); expect(probe.exited).toBe(true);
  });
});
