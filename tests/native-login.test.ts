import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NativeLoginManager, NativeIdentityError, launchTerminalLogin, type NativeLoginHandle, type TerminalLoginDependencies } from '../src/server/connections/native.js';
import { WorkbuddyLoginUnavailableError } from '../src/server/connections/workbuddy-auth.js';
import { ConnectionManager, type ConnectionManagerOptions } from '../src/server/connections/manager.js';
import { WorkbenchService } from '../src/server/service.js';
import type { ConnectionProfile, LoginAttempt, RuntimeOverrides } from '../src/shared/connections.js';
import type { Agent, Project, RuntimeAdapter, RuntimeOptions } from '../src/shared/types.js';
import type { GitRepository, TaskRepository } from '../src/server/repositories.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function directory(){const path=await mkdtemp(join(tmpdir(),'awb-native-login-'));cleanups.push(async()=>{if(!resolve(path).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe fixture cleanup');await rm(path,{recursive:true,force:true,maxRetries:3});});return path;}
function gate<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function profile(runtime:ConnectionProfile['runtime']='claude',id=`native-${runtime}`):ConnectionProfile {return {id,runtime,name:id,mode:'native',protocol:'native',provider:'native',defaultModel:'',revision:1,hasCredential:false,createdAt:'2026-10-20',updatedAt:'2026-10-20',verifications:[]};}
function attempt(p=profile()):LoginAttempt {return {id:randomUUID(),connectionId:p.id,runtime:p.runtime,state:'starting',startedAt:'2026-10-20',updatedAt:'2026-10-20',method:'native-terminal',detail:''};}
function overrides(p=profile()):RuntimeOverrides{return {connectionId:p.id,revision:p.revision,env:{},executable:'synthetic-executable'};}
function handle(){let outcome:Awaited<ReturnType<NativeLoginHandle['poll']>>;const close=vi.fn(async(_cancel:boolean)=>{});return {handle:{poll:async()=>outcome,close} satisfies NativeLoginHandle,close,complete:(state:'completed'|'failed'='completed')=>{outcome={state,detail:'Native terminal receipt'};}};}
class MemoryStore {rows=new Map<string,unknown>();get<T>(c:string,id:string):T|undefined{return structuredClone(this.rows.get(`${c}:${id}`)) as T|undefined;}all<T>(c:string):T[]{return [...this.rows].filter(([key])=>key.startsWith(`${c}:`)).map(([,value])=>structuredClone(value)) as T[];}put(c:string,id:string,value:unknown){this.rows.set(`${c}:${id}`,structuredClone(value));}remove(c:string,id:string){this.rows.delete(`${c}:${id}`);}}
function transport(kind:RuntimeAdapter['kind']='codex'){
  const launches:RuntimeOptions[]=[];
  const adapter:RuntimeAdapter={kind,discover:async()=>({kind,available:true,detail:'Synthetic adapter',capabilities:{approvals:true,interrupt:true,resume:true,steer:false}}),connect:async(options,emit)=>{
    launches.push(options);return {nativeSessionId:randomUUID(),pid:undefined,send:async()=>{emit({type:'delta',text:'连接验证成功'});const probe=options.mcpServers?.workbench_probe;if(probe)await writeFile(probe.args[1]!,JSON.stringify({nonce:probe.args[2]}));emit({type:'result',text:'连接验证成功'});},interrupt:async()=>{},respondApproval:async()=>{},close:async()=>{}};
  }};return {adapter,launches};
}
async function managerFixture(extra:Partial<ConnectionManagerOptions>={}){
  const dir=await directory(),store=new MemoryStore(),codex=transport(),claude=transport('claude'),workbuddy=transport('workbuddy'),login=handle();
  const options:ConnectionManagerOptions={dataDir:dir,store,adapters:{codex:codex.adapter,claude:claude.adapter,workbuddy:workbuddy.adapter},secrets:{protect:async value=>`cipher:${value}`,unprotect:async value=>value.slice(7)},nativeLogin:{launch:async()=>login.handle},...extra};
  const manager=new ConnectionManager(options);cleanups.push(()=>manager.close());return {dir,store,codex,claude,workbuddy,login,manager,options};
}

describe('native login lifecycle without changing a real account',()=>{
  it('keeps the safe desktop-bootstrap limitation visible instead of inviting another scan',async()=>{
    const dir=await directory(),p=profile('workbuddy'),manager=new NativeLoginManager(dir,{launch:async()=>{throw new WorkbuddyLoginUnavailableError();}});
    const blocked=await manager.start(p,dir,overrides(p));
    expect(blocked.state).toBe('failed');expect(blocked.authUrl).toBeUndefined();expect(blocked.detail).toContain('已阻止再次无效扫码');expect(blocked.detail).toContain('原生凭据保护');expect(blocked.detail).toContain('当前不能恢复执行认证');expect(blocked.detail).not.toContain('独立 CodeBuddy');
    await manager.close();
  });
  it('reserves the runtime during startup and cancellation waits for the owned handle to stop',async()=>{
    const dir=await directory(),startup=gate<NativeLoginHandle>(),stopped=gate(),session=handle();
    session.close.mockImplementation(async()=>stopped.promise);
    const manager=new NativeLoginManager(dir,{launch:()=>startup.promise}),p=profile();
    const starting=manager.start(p,dir,overrides(p));
    expect((await manager.status(p.id))?.state).toBe('starting');
    await expect(manager.start(profile('claude','second'),dir,overrides(p))).rejects.toThrow('已有原生登录');
    const cancelling=manager.cancel(p.id);
    expect((await manager.status(p.id))?.state).toBe('stopping');
    expect(session.close).not.toHaveBeenCalled();
    startup.resolve(session.handle);
    await vi.waitFor(()=>expect(session.close).toHaveBeenCalledOnce());
    expect((await manager.status(p.id))?.state).toBe('stopping');
    stopped.resolve();
    expect((await cancelling)?.state).toBe('cancelled');
    expect((await starting).state).toBe('cancelled');
    expect(session.close).toHaveBeenCalledOnce();
    await manager.close();
  });
  it('keeps failed cancellation unknown and retries without launching a second native process',async()=>{
    const dir=await directory(),session=handle(),launch=vi.fn(async()=>session.handle),manager=new NativeLoginManager(dir,{launch}),p=profile();
    await manager.start(p,dir,overrides(p));session.close.mockRejectedValueOnce(new Error('Still alive'));
    expect((await manager.cancel(p.id))?.state).toBe('unknown');
    await expect(manager.start(p,dir,overrides(p))).rejects.toThrow('已有原生登录');
    expect((await manager.cancel(p.id))?.state).toBe('cancelled');expect(launch).toHaveBeenCalledOnce();
    await manager.close();
  });
  it('an unconfirmed tree stop keeps the runtime blocked and repeated cancel stays unknown',async()=>{
    const dir=await directory(),session=handle(),manager=new NativeLoginManager(dir,{launch:async()=>session.handle}),p=profile();
    await manager.start(p,dir,overrides(p));session.close.mockRejectedValue(new Error('未确认原生登录进程树已停止'));
    expect((await manager.cancel(p.id))?.state).toBe('unknown');
    await expect(manager.start(profile('claude','second'),dir,overrides(p))).rejects.toThrow('已有原生登录');
    expect((await manager.cancel(p.id))?.state).toBe('unknown');
    await expect(manager.start(profile('claude','second'),dir,overrides(p))).rejects.toThrow('已有原生登录');
    await expect(manager.close()).rejects.toThrow('停止未确认');
  });
  it('does not call a completed login finished until its owned process has exited',async()=>{
    const dir=await directory(),session=handle(),stopped=gate(),manager=new NativeLoginManager(dir,{launch:async()=>session.handle}),p=profile();
    await manager.start(p,dir,overrides(p));session.complete();session.close.mockImplementation(async()=>stopped.promise);
    const poll=manager.status(p.id);await vi.waitFor(()=>expect(session.close).toHaveBeenCalledOnce());
    expect((await manager.status(p.id))?.state).toBe('waiting');
    stopped.resolve();expect((await poll)?.state).toBe('completed');await manager.close();
  });
  it('close waits for startup and never leaves a subsequently launched login behind',async()=>{
    const dir=await directory(),startup=gate<NativeLoginHandle>(),session=handle(),manager=new NativeLoginManager(dir,{launch:()=>startup.promise}),p=profile();
    const starting=manager.start(p,dir,overrides(p)),closing=manager.close();startup.resolve(session.handle);await closing;await starting;
    expect(session.close).toHaveBeenCalledOnce();expect((await manager.status(p.id))?.state).toBe('cancelled');
    await expect(manager.start(p,dir,overrides(p))).rejects.toThrow('服务正在关闭');
  });
  it('startup failure has a terminal status even when cancellation was requested during startup',async()=>{
    const dir=await directory(),startup=gate<NativeLoginHandle>(),p=profile(),manager=new NativeLoginManager(dir,{launch:()=>startup.promise.then(()=>{throw new Error('Executable absent');})});
    const starting=manager.start(p,dir,overrides(p)),cancel=manager.cancel(p.id);startup.resolve(handle().handle);
    expect((await starting).state).toBe('failed');expect((await cancel)?.state).toBe('failed');await manager.close();
  });
  it('polls a dynamic native browser link without persisting or exposing arbitrary native fields',async()=>{
    const dir=await directory(),p=profile('workbuddy'),session=handle(),changes:LoginAttempt[]=[];
    let dynamic:{authUrl?:string;detail?:string}={detail:'等待原生授权链接'};
    const manager=new NativeLoginManager(dir,{launch:async()=>({...session.handle,getState:()=>dynamic}),onChange:value=>changes.push(value)});
    expect((await manager.start(p,dir,overrides(p))).method).toBe('browser');
    dynamic={authUrl:'https://www.workbuddy.ai/native-login?state=temporary',detail:'请打开原生授权链接'};
    expect(await manager.status(p.id)).toMatchObject({state:'waiting',authUrl:dynamic.authUrl,detail:dynamic.detail});
    expect(changes.at(-1)?.authUrl).toBe(dynamic.authUrl);
    session.complete();expect((await manager.status(p.id))?.state).toBe('completed');await manager.close();
  });
  it('retains startup stop ownership and allows cancellation to retry only the same process',async()=>{
    const dir=await directory(),p=profile('workbuddy'),retryStop=vi.fn(async()=>{}),launch=vi.fn(async()=>{throw new NativeIdentityError('Process stop not confirmed',false,retryStop);});
    const manager=new NativeLoginManager(dir,{launch});
    expect(await manager.start(p,dir,overrides(p))).toMatchObject({state:'unknown',recoveryAction:'retry-stop'});
    await expect(manager.start(p,dir,overrides(p))).rejects.toThrow('已有原生登录');
    expect((await manager.cancel(p.id))?.state).toBe('cancelled');expect(retryStop).toHaveBeenCalledOnce();expect(launch).toHaveBeenCalledOnce();await manager.close();
  });
});

function terminalDoubles(){
  const files=new Map<string,string>(),alive=new Set<number>([41001,41002]);
  const child=Object.assign(new EventEmitter(),{pid:41001,exitCode:null as number|null,signalCode:null as string|null,stdout:new EventEmitter(),stderr:new EventEmitter()}) as unknown as ChildProcessWithoutNullStreams;
  const exit=()=>{alive.delete(41001);Object.assign(child,{exitCode:0});child.emit('exit',0,null);};
  const kill=vi.fn(async(_command:string,args:string[])=>{const pid=Number(args[1]);alive.delete(pid);if(pid===41001)exit();return {stdout:'',stderr:''};});
  const deps:Partial<TerminalLoginDependencies>={spawn:vi.fn(()=>child) as unknown as TerminalLoginDependencies['spawn'],readFile:vi.fn(async(path:unknown)=>{if(!files.has(String(path)))throw new Error('ENOENT');return files.get(String(path));}) as unknown as typeof readFile,writeFile:vi.fn(async(path:unknown,value:unknown)=>{files.set(String(path),String(value));}) as unknown as typeof writeFile,exec:kill as unknown as TerminalLoginDependencies['exec'],alive:pid=>alive.has(pid),stopTimeoutMs:100};
  return {files,alive,child,kill,exit,deps};
}
async function terminalFixture(){
  const dir=await directory(),p=profile(),a=attempt(p),{files,alive,child,kill,exit,deps}=terminalDoubles();
  const session=await launchTerminalLogin(p,dir,overrides(p),a,dir,deps);
  return {dir,session,files,alive,child,kill,exit,pidFile:join(dir,'process.txt'),marker:join(dir,'completed.json')};
}
/** Wires the real terminal launcher into the connection manager so the reason travels the whole chain. */
async function terminalManagerFixture(){
  const dir=await directory(),store=new MemoryStore(),{files,alive,child,kill,exit,deps}=terminalDoubles();
  // The terminal double owns execution; never depend on a real CLI being installed.
  const manager=new ConnectionManager({dataDir:dir,store,adapters:{codex:transport().adapter,claude:transport('claude').adapter,workbuddy:transport('workbuddy').adapter},secrets:{protect:async value=>`cipher:${value}`,unprotect:async value=>value.slice(7)},nativeLogin:{launch:(prof,cwd,config,attemptValue)=>launchTerminalLogin(prof,cwd,{...config,executable:'synthetic-executable'},attemptValue,dir,deps)}});
  cleanups.push(async()=>{try{await manager.close();}catch{/* An unconfirmed stop is expected to refuse a clean close. */}});
  return {manager,store,dir,files,alive,child,kill,exit,pidFile:join(dir,'process.txt'),profile:manager.ensureNative('claude')};
}
describe('native login recovery reason survives the connection manager',()=>{
  it('keeps retry-stop while the root is alive and switches to restart-reconcile once it vanished',async()=>{
    const f=await terminalManagerFixture();
    expect((await f.manager.startLogin(f.profile.id,{cwd:f.dir})).state).toBe('waiting');
    f.files.set(f.pidFile,'41002');
    f.kill.mockImplementationOnce(async(_command:string,args:string[])=>{f.alive.delete(Number(args[1]));throw new Error('No tree receipt');});
    const first=await f.manager.cancelLogin(f.profile.id);
    expect(first?.state).toBe('unknown');expect(first?.recoveryAction).toBe('retry-stop');
    const second=await f.manager.cancelLogin(f.profile.id);
    expect(second?.state).toBe('unknown');expect(second?.recoveryAction).toBe('restart-reconcile');
    expect(second?.detail).toContain('重启');
    const third=await f.manager.cancelLogin(f.profile.id);
    expect(third?.state).toBe('unknown');expect(third?.recoveryAction).toBe('restart-reconcile');
    const stored=f.store.all<{attempt:LoginAttempt}>('native_identity')[0];
    expect(stored?.attempt.recoveryAction).toBe('restart-reconcile');
    await expect(f.manager.startLogin(f.profile.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    await expect(f.manager.verify(f.profile.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    await expect(f.manager.reconcileLogin(f.profile.id,{confirmedStopped:true,reason:'checked the terminal'})).rejects.toThrow('只有服务重启后');
  });
  it('persists the restart-only reason so the recovered instance asks for a human check',async()=>{
    const f=await terminalManagerFixture();
    await f.manager.startLogin(f.profile.id,{cwd:f.dir});f.files.set(f.pidFile,'41002');
    f.kill.mockImplementationOnce(async(_command:string,args:string[])=>{f.alive.delete(Number(args[1]));throw new Error('No tree receipt');});
    await f.manager.cancelLogin(f.profile.id);await f.manager.cancelLogin(f.profile.id);
    const restarted=new ConnectionManager({dataDir:f.dir,store:f.store,adapters:{codex:transport().adapter,claude:transport('claude').adapter,workbuddy:transport('workbuddy').adapter},secrets:{protect:async value=>`cipher:${value}`,unprotect:async value=>value.slice(7)},nativeLogin:{launch:async()=>{throw new Error('No second native process');}}});
    cleanups.push(async()=>{try{await restarted.close();}catch{/* Expected: the recovered gate refuses a clean close. */}});
    const recovered=await restarted.loginStatus(f.profile.id);
    expect(recovered?.state).toBe('unknown');expect(recovered?.recoveryRequired).toBe(true);expect(recovered?.recoveryAction).toBe('restart-reconcile');
    await expect(restarted.cancelLogin(f.profile.id)).resolves.toMatchObject({state:'unknown'});
    const resolved=await restarted.reconcileLogin(f.profile.id,{confirmedStopped:true,reason:'Verified the login terminal and child processes are gone'});
    expect(resolved.state).toBe('resolved');expect(resolved.recoveryAction).toBeUndefined();
  });
  it('still cancels normally when a later stop attempt is confirmed',async()=>{
    const f=await terminalManagerFixture();
    await f.manager.startLogin(f.profile.id,{cwd:f.dir});f.files.set(f.pidFile,'41002');
    f.kill.mockImplementationOnce(async()=>{throw new Error('No tree receipt');});
    expect((await f.manager.cancelLogin(f.profile.id))?.recoveryAction).toBe('retry-stop');
    const cancelled=await f.manager.cancelLogin(f.profile.id);
    expect(cancelled?.state).toBe('cancelled');expect(cancelled?.recoveryAction).toBeUndefined();
    expect(f.store.all('native_identity')).toEqual([]);
  });
});

describe('owned Windows login terminal receipts with process doubles',()=>{
  it('a wrapper exit with no completion marker is failed, not an endless waiting login',async()=>{
    const f=await terminalFixture();f.files.set(f.pidFile,'41002');f.alive.delete(41002);f.exit();
    expect(await f.session.poll()).toMatchObject({state:'failed'});await f.session.close(false);
  });
  it('a wrapper exit cannot claim completion while the native terminal is still alive',async()=>{
    const f=await terminalFixture();f.files.set(f.pidFile,'41002');f.files.set(f.marker,'{"exitCode":0}');f.exit();
    await expect(f.session.poll()).rejects.toThrow('未确认');
    await f.session.close(true);expect(f.kill).toHaveBeenCalledWith('taskkill.exe',['/PID','41002','/T','/F'],expect.anything());
  });
  it('waits for a startup PID receipt before cancelling, then stops both owned processes',async()=>{
    const f=await terminalFixture(),closing=f.session.close(true);expect(f.kill).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(f.files.has(join(f.dir,'cancelled'))).toBe(true));f.files.set(f.pidFile,'41002');await closing;
    expect(f.kill.mock.calls.map(call=>call[1][1])).toEqual(['41002','41001']);expect(f.alive.size).toBe(0);
  });
  it('does not report cancellation if the tree-stop command fails even when its root exits',async()=>{
    const f=await terminalFixture();f.files.set(f.pidFile,'41002');f.kill.mockImplementationOnce(async()=>{f.alive.delete(41002);throw new Error('No tree receipt');});
    await expect(f.session.close(true)).rejects.toThrow('未收到');expect(f.alive.has(41001)).toBe(true);
  });
  it('keeps an untracked startup unknown rather than assuming wrapper termination stopped everything',async()=>{
    const f=await terminalFixture();f.exit();await expect(f.session.close(true)).rejects.toThrow('未获得');
  });
  it('a second cancel cannot treat a vanished root PID as a stopped process tree',async()=>{
    const f=await terminalFixture();f.files.set(f.pidFile,'41002');
    f.kill.mockImplementationOnce(async(_command:string,args:string[])=>{f.alive.delete(Number(args[1]));throw new Error('No tree receipt');});
    await expect(f.session.close(true)).rejects.toThrow('未收到');
    expect(f.alive.has(41002)).toBe(false);
    await expect(f.session.close(true)).rejects.toThrow('未确认原生登录进程树已停止');
    await expect(f.session.close(true)).rejects.toThrow('未确认原生登录进程树已停止');
  });
  it('a later confirmed tree stop clears the unconfirmed state instead of blocking forever',async()=>{
    const f=await terminalFixture();f.files.set(f.pidFile,'41002');
    f.kill.mockImplementationOnce(async()=>{throw new Error('No tree receipt');});
    await expect(f.session.close(true)).rejects.toThrow('未收到');expect(f.alive.has(41002)).toBe(true);
    await f.session.close(true);expect(f.alive.size).toBe(0);
  });
});

describe('shared native identity gate and proof versioning',()=>{
  it('refuses a busy native member before launching even a read-only login preflight',async()=>{
    const preflight=vi.fn(async()=>({alreadyAuthenticated:true})),launch=vi.fn(async()=>handle().handle),f=await managerFixture({nativeLogin:{preflight,launch}}),p=f.manager.ensureNative('workbuddy'),before=f.manager.get(p.id),prepare=vi.fn(async()=>{});
    await expect(f.manager.startLogin(p.id,{cwd:f.dir,assertIdle:()=>{throw new Error('Active member has not stopped');},prepare})).rejects.toThrow('Active member has not stopped');
    expect(preflight).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(f.manager.get(p.id)).toEqual(before);expect(f.store.all('native_identity')).toEqual([]);
  });
  it('rejects an unsupported WorkBuddy login before invalidating proof, catalogs or preparing member sessions',async()=>{
    const preflight=vi.fn(async()=>{throw new WorkbuddyLoginUnavailableError();}),launch=vi.fn(async()=>handle().handle),f=await managerFixture({nativeLogin:{preflight,launch}}),p=f.manager.ensureNative('workbuddy');
    f.store.put('connections',p.id,{...p,status:{state:'verified',checkedAt:'before',detail:'Earlier proof'},authenticationStatus:{state:'unconfigured',checkedAt:'before',detail:'Identity only'},catalog:{models:[{id:'kept'}]},verifications:[{id:'kept-proof',revision:p.revision}]});
    const before=f.manager.get(p.id),prepare=vi.fn(async()=>{});
    await expect(f.manager.startLogin(p.id,{cwd:f.dir,prepare})).rejects.toThrow('已阻止再次无效扫码');
    expect(f.manager.get(p.id)).toEqual(before);expect(prepare).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(f.store.all('native_identity')).toEqual([]);
  });
  it('coalesces WorkBuddy login preflight and returns an already-authenticated no-op without changing revisions',async()=>{
    const ready=gate<{alreadyAuthenticated:boolean;detail:string}>(),preflight=vi.fn(()=>ready.promise),launch=vi.fn(async()=>handle().handle),f=await managerFixture({nativeLogin:{preflight,launch}}),p=f.manager.ensureNative('workbuddy'),prepare=vi.fn(async()=>{});
    const before=f.manager.get(p.id),one=f.manager.startLogin(p.id,{cwd:f.dir,prepare}),two=f.manager.startLogin(p.id,{cwd:f.dir,prepare});
    await vi.waitFor(()=>expect(preflight).toHaveBeenCalledOnce());ready.resolve({alreadyAuthenticated:true,detail:'已观察凭据；没有发起新授权，实际调用仍需验证'});
    expect((await one).state).toBe('completed');expect((await two).state).toBe('completed');expect(f.manager.get(p.id)).toEqual(before);expect(prepare).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();
  });
  it('refuses a stale preflight after the connection revision changes and never prepares the new configuration',async()=>{
    const ready=gate<{alreadyAuthenticated:boolean}>(),preflight=vi.fn(()=>ready.promise),launch=vi.fn(async()=>handle().handle),f=await managerFixture({nativeLogin:{preflight,launch}}),p=f.manager.ensureNative('workbuddy'),prepare=vi.fn(async()=>{});
    const pending=f.manager.startLogin(p.id,{cwd:f.dir,prepare});await vi.waitFor(()=>expect(preflight).toHaveBeenCalledOnce());
    const updated=await f.manager.update(p.id,{name:'Changed while checking',runtime:'workbuddy',mode:'native'});ready.resolve({alreadyAuthenticated:false});
    await expect(pending).rejects.toThrow('登录预检期间已变化');expect(f.manager.get(p.id)).toEqual(updated);expect(prepare).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();
  });
  it('does not apply a late unsupported-channel error to a newly revised connection',async()=>{
    const ready=gate(),preflight=vi.fn(async()=>{await ready.promise;throw new WorkbuddyLoginUnavailableError();}),f=await managerFixture({nativeLogin:{preflight,launch:async()=>handle().handle}}),p=f.manager.ensureNative('workbuddy'),prepare=vi.fn(async()=>{});
    const pending=f.manager.startLogin(p.id,{cwd:f.dir,prepare});await vi.waitFor(()=>expect(preflight).toHaveBeenCalledOnce());
    const updated=await f.manager.update(p.id,{name:'Revised during old check',runtime:'workbuddy',mode:'native'});ready.resolve();
    await expect(pending).rejects.toThrow('登录预检期间已变化');expect(f.manager.get(p.id)).toEqual(updated);expect(prepare).not.toHaveBeenCalled();
  });
  it('waits for a pending read-only preflight during shutdown without launching authorization afterward',async()=>{
    const ready=gate<{alreadyAuthenticated:boolean}>(),preflight=vi.fn(()=>ready.promise),launch=vi.fn(async()=>handle().handle),f=await managerFixture({nativeLogin:{preflight,launch}}),p=f.manager.ensureNative('workbuddy');
    const pending=f.manager.startLogin(p.id,{cwd:f.dir}),failed=expect(pending).rejects.toThrow('服务正在关闭');await vi.waitFor(()=>expect(preflight).toHaveBeenCalledOnce());
    let closed=false;const closing=f.manager.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
    ready.resolve({alreadyAuthenticated:false});await failed;await closing;expect(launch).not.toHaveBeenCalled();expect(f.manager.get(p.id).revision).toBe(p.revision);
  });
  it('keeps the stop gate when a read-only WorkBuddy login preflight cannot confirm its process stopped',async()=>{
    const stop=vi.fn(async()=>{}),preflight=vi.fn(async()=>{throw new NativeIdentityError('Preflight stop unconfirmed',false,stop);}),launch=vi.fn(async()=>handle().handle),f=await managerFixture({nativeLogin:{preflight,launch}}),p=f.manager.ensureNative('workbuddy');
    await expect(f.manager.startLogin(p.id,{cwd:f.dir})).rejects.toThrow('stop unconfirmed');expect(()=>f.manager.assertIdentityAvailable(p.id)).toThrow('暂停调用');
    expect((await f.manager.loginStatus(p.id))?.detail).toContain('预检进程停止未确认');expect(launch).not.toHaveBeenCalled();await f.manager.cancelLogin(p.id);expect(stop).toHaveBeenCalledOnce();
  });
  it('default streaming/tool verification succeeds without a usage receipt and leaves usage unknown',async()=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex'),result=await f.manager.verify(p.id,{cwd:f.dir});
    expect(result.success).toBe(true);expect(result.capabilities).toEqual(expect.arrayContaining(['inference','streaming','tools']));
    expect(result.capabilities).not.toContain('usage');expect(result.usage).toEqual([]);await f.manager.assertReady(p.id,'',f.dir,['inference','streaming','tools']);
    const explicit=await f.manager.verify(p.id,{cwd:f.dir,capabilities:['inference','usage']});
    expect(explicit.success).toBe(false);expect(explicit.usage).toEqual([]);expect(explicit.detail).toContain('usage');
  });
  it('blocks all same-runtime native profiles from startup through waiting/stopping, but allows API and other runtimes',async()=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex'),sibling=await f.manager.create({name:'Native sibling',runtime:'codex',mode:'native'}),other=f.manager.ensureNative('claude');
    const api=await f.manager.create({name:'API remains separate',runtime:'codex',mode:'official-api',apiKey:'synthetic'});
    await f.manager.verify(p.id,{cwd:f.dir});await f.manager.verify(sibling.id,{cwd:f.dir});const before=f.manager.get(p.id).revision,prepared=gate();
    const pending=f.manager.startLogin(p.id,{cwd:f.dir,prepare:()=>prepared.promise});
    expect((await f.manager.loginStatus(sibling.id))?.state).toBe('starting');
    await expect(f.manager.verify(sibling.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    await expect(f.manager.assertReady(sibling.id,'',f.dir)).rejects.toThrow('共享原生账号');
    await expect(f.manager.resolveRuntime(sibling.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    await expect(f.manager.startLogin(sibling.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    expect((await f.manager.verify(api.id,{cwd:f.dir})).success).toBe(true);
    expect((await f.manager.verify(other.id,{cwd:f.dir})).success).toBe(true);
    prepared.resolve();expect((await pending).state).toBe('waiting');
    const stopped=gate();f.login.close.mockImplementation(async()=>stopped.promise);const cancel=f.manager.cancelLogin(sibling.id);
    await vi.waitFor(async()=>expect((await f.manager.loginStatus(p.id))?.state).toBe('stopping'));
    await expect(f.manager.verify(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    stopped.resolve();expect((await cancel)?.state).toBe('cancelled');expect(f.manager.get(p.id).revision).toBe(before+1);
    expect(()=>f.manager.assertVerified(p.id,'')).toThrow('尚未通过');expect(()=>f.manager.assertVerified(sibling.id,'')).toThrow('尚未通过');
    expect(f.manager.get(p.id).verifications).toHaveLength(1);expect(f.store.all('native_identity')).toEqual([]);
  });
  it.each(['completed','failed'] as const)('%s login still invalidates historical proof',async state=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex');await f.manager.verify(p.id,{cwd:f.dir});await f.manager.startLogin(p.id,{cwd:f.dir});
    f.login.complete(state);expect((await f.manager.loginStatus(p.id))?.state).toBe(state);
    expect(()=>f.manager.assertVerified(p.id,'')).toThrow('尚未通过');expect((await f.manager.verify(p.id,{cwd:f.dir})).success).toBe(true);
  });
  it('native verification holds the gate in the opposite direction until its connection is closed',async()=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex'),release=gate(),close=vi.fn(async()=>release.promise);
    const connect=f.codex.adapter.connect;f.codex.adapter.connect=async(...args)=>({...await connect(...args),close});
    const verify=f.manager.verify(p.id,{cwd:f.dir});await vi.waitFor(()=>expect(close).toHaveBeenCalledOnce());
    await expect(f.manager.startLogin(p.id,{cwd:f.dir})).rejects.toThrow('正在执行连接或能力验证');
    release.resolve();await verify;await f.manager.startLogin(p.id,{cwd:f.dir});await f.manager.cancelLogin(p.id);
  });
  it('persists a credential-free pending marker and restarts blocked instead of guessing the old login stopped',async()=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex');
    f.options.nativeLogin!.launch=async()=>({...f.login.handle,authUrl:'https://native.test/secret-login',userCode:'PRIVATE-CODE'});
    const original=new ConnectionManager(f.options);await original.startLogin(p.id,{cwd:f.dir});
    expect(JSON.stringify(f.store.all('native_identity'))).not.toContain('PRIVATE-CODE');expect(JSON.stringify(f.store.all('native_identity'))).not.toContain('secret-login');
    const restarted=new ConnectionManager(f.options);expect((await restarted.loginStatus(p.id))?.state).toBe('unknown');
    await expect(restarted.verify(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    expect((await restarted.cancelLogin(p.id))?.state).toBe('unknown');
    expect(()=>restarted.assertIdentityAvailable(p.id)).toThrow('共享原生账号');
    await expect(restarted.reconcileLogin(p.id,{confirmedStopped:false,reason:'Checked old terminal'})).rejects.toThrow('明确确认');
    await expect(restarted.reconcileLogin(p.id,{confirmedStopped:true,reason:' '})).rejects.toThrow('填写核对依据');
    const calls=f.codex.launches.length;
    const resolved=await restarted.reconcileLogin(p.id,{confirmedStopped:true,reason:'Manually confirmed the old native login terminal is closed'});
    expect(resolved).toMatchObject({state:'resolved',recoveryRequired:false});expect(resolved.detail).toContain('不是原生登录成功');
    expect(f.codex.launches).toHaveLength(calls);
    expect(f.store.all('native_identity_audits')).toHaveLength(1);expect(f.store.all('native_identity')).toEqual([]);
    expect((await restarted.loginStatus(p.id))?.state).toBe('resolved');
    expect(()=>restarted.assertVerified(p.id,'')).toThrow('尚未通过');
    expect((await restarted.verify(p.id,{cwd:f.dir})).success).toBe(true);
    await original.cancelLogin(p.id);await original.close();await restarted.close();
  });
  it('logout blocks shared probes and failure never restores an old verified account proof',async()=>{
    const logout=gate(),f=await managerFixture({nativeLogout:async()=>{await logout.promise;throw new NativeIdentityError('Native logout failed',true);}}),p=f.manager.ensureNative('codex');
    await f.manager.verify(p.id,{cwd:f.dir});const pending=f.manager.logout(p.id,f.dir);const failed=expect(pending).rejects.toThrow('Native logout failed');
    await expect(f.manager.verify(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');logout.resolve();await failed;expect(()=>f.manager.assertVerified(p.id,'')).toThrow('尚未通过');
  });
  it('an unconfirmed logout keeps its shared gate until a later owned stop receipt',async()=>{
    let stopFailed=true;const stop=vi.fn(async()=>{if(stopFailed)throw new Error('Process still alive');});
    const f=await managerFixture({nativeLogout:async()=>{throw new NativeIdentityError('Logout process stop unconfirmed',false,stop);}}),p=f.manager.ensureNative('codex');
    await f.manager.verify(p.id,{cwd:f.dir});
    await expect(f.manager.logout(p.id,f.dir)).rejects.toThrow('stop unconfirmed');
    expect((await f.manager.loginStatus(p.id))?.state).toBe('unknown');
    await expect(f.manager.startLogin(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    expect((await f.manager.cancelLogin(p.id))?.state).toBe('unknown');
    await expect(f.manager.reconcileLogin(p.id,{confirmedStopped:true,reason:'Cannot bypass a live uncertain process'})).rejects.toThrow('只有服务重启');
    stopFailed=false;expect((await f.manager.cancelLogin(p.id))?.state).toBe('cancelled');
    expect(()=>f.manager.assertVerified(p.id,'')).toThrow('尚未通过');
  });
  it.each([false,true])('a probe with prior inference error=%s never releases the native gate on close failure',async inferenceError=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex');let stopFailed=true;
    const close=vi.fn(async()=>{if(stopFailed)throw new Error('Probe process still alive');});
    f.codex.adapter.connect=async(_options,emit)=>({nativeSessionId:'unknown-stop-probe',pid:undefined,send:async()=>{emit(inferenceError?{type:'error',text:'Original inference failure'}:{type:'result',text:'Success'});},interrupt:async()=>{},respondApproval:async()=>{},close});
    const result=await f.manager.verify(p.id,{cwd:f.dir,capabilities:['inference']});
    expect(result.success).toBe(false);expect(result.status.state).toBe('unknown');expect(result.detail).toContain('无法确认');
    if(inferenceError)expect(result.detail).toContain('Original inference failure');
    await expect(f.manager.startLogin(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    await expect(f.manager.verify(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    expect((await f.manager.loginStatus(p.id))?.detail).toContain('验证进程停止未确认');
    expect((await f.manager.cancelLogin(p.id))?.state).toBe('unknown');
    stopFailed=false;expect((await f.manager.cancelLogin(p.id))?.state).toBe('cancelled');
    expect(()=>f.manager.assertVerified(p.id,'')).toThrow('尚未通过');
  });
  it('aggregates two unconfirmed native probes and coalesces retry cancellation until both stop',async()=>{
    const f=await managerFixture(),p=f.manager.ensureNative('codex'),other=await f.manager.create({name:'Shared native',runtime:'codex',mode:'native'}),failed=new Set([p.id,other.id]),closes=new Map<string,ReturnType<typeof vi.fn>>();
    f.codex.adapter.connect=async(options,emit)=>{const id=options.connection!.connectionId,close=vi.fn(async()=>{if(failed.has(id))throw new Error('Still alive');});closes.set(id,close);return {nativeSessionId:id,pid:undefined,send:async()=>emit({type:'result'}),interrupt:async()=>{},respondApproval:async()=>{},close};};
    const results=await Promise.all([f.manager.verify(p.id,{cwd:f.dir,capabilities:['inference']}),f.manager.verify(other.id,{cwd:f.dir,capabilities:['inference']})]);
    expect(results.every(result=>!result.success)).toBe(true);failed.delete(p.id);
    const [one,two]=await Promise.all([f.manager.cancelLogin(p.id),f.manager.cancelLogin(other.id)]);
    expect(one?.state).toBe('unknown');expect(two?.state).toBe('unknown');expect(closes.get(p.id)).toHaveBeenCalledTimes(2);expect(closes.get(other.id)).toHaveBeenCalledTimes(2);
    await expect(f.manager.startLogin(p.id,{cwd:f.dir})).rejects.toThrow('共享原生账号');
    failed.clear();expect((await f.manager.cancelLogin(p.id))?.state).toBe('cancelled');
    expect(closes.get(p.id)).toHaveBeenCalledTimes(2);expect(closes.get(other.id)).toHaveBeenCalledTimes(3);
  });
});

describe('service login preparation and dispatch use the same gate',()=>{
  it('preserves an idle WorkBuddy member session when local login preflight refuses authorization',async()=>{
    const dir=await directory(),base=transport('workbuddy'),connect=base.adapter.connect,closed=vi.fn(async()=>{}),launch=vi.fn(async()=>handle().handle);
    base.adapter.connect=async(...args)=>({...await connect(...args),close:closed});
    const service=new WorkbenchService({dataDir:dir,adapters:[base.adapter],tasks:{list:async()=>[]} as unknown as TaskRepository,git:{inspect:async()=>({commit:'a'.repeat(40),dirty:false,diff:''})} as unknown as GitRepository,connectionOptions:{nativeLogin:{preflight:async()=>{throw new WorkbuddyLoginUnavailableError();},launch}}});
    cleanups.push(()=>service.close());
    const project:Project={id:randomUUID(),kind:'code',name:'Preflight refusal fixture',path:dir,createdAt:new Date().toISOString()};service.store.put('projects',project.id,project);
    const member=await service.createAgent({projectId:project.id,name:'WB member',role:'Controlled worker',runtime:'workbuddy'});
    service.store.put('agents',member.id,{...member,worktree:dir});
    await service.message(member.id,{text:'Create a controlled cached member connection'},'warm');await vi.waitFor(()=>expect(service.agents()[0]?.state).toBe('idle'));
    const beforeAgent=service.agents()[0],beforeProfile=service.connectionManager.get(member.connectionId!);
    await expect(service.startNativeLogin(member.connectionId!,{})).rejects.toThrow('已阻止再次无效扫码');
    expect(service.agents()[0]).toEqual(beforeAgent);expect(service.connectionManager.get(member.connectionId!)).toEqual(beforeProfile);expect(closed).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();
  });
  it('reserves before waiting for an idle cached connection to close, blocking messages and native capability verification',async()=>{
    const dir=await directory(),login=handle(),oldClose=gate(),closed=vi.fn(async()=>oldClose.promise),base=transport(),connect=base.adapter.connect;
    base.adapter.connect=async(...args)=>({...await connect(...args),close:closed});
    const service=new WorkbenchService({dataDir:dir,adapters:[base.adapter],tasks:{list:async()=>[],get:async()=>{throw new Error('No tasks');}} as unknown as TaskRepository,git:{inspect:async()=>({commit:'a'.repeat(40),dirty:false,diff:''})} as unknown as GitRepository,connectionOptions:{nativeLogin:{launch:async()=>login.handle}}});
    cleanups.push(async()=>{oldClose.resolve();await service.close();});
    const project:Project={id:randomUUID(),kind:'code',name:'Identity gate fixture',path:dir,createdAt:new Date().toISOString()};service.store.put('projects',project.id,project);
    const lead=await service.createAgent({projectId:project.id,name:'Lead',role:'controller',memberKind:'controller',runtime:'codex'});
    await service.message(lead.id,{text:'Create a controlled cached session'},'warmup');
    await vi.waitFor(()=>expect(service.agents().find(a=>a.id===lead.id)?.state).toBe('idle'));
    const capability=service.capabilities.save({name:'Never launch this MCP',kind:'mcp',command:process.execPath,args:[]});
    const agent=service.agents().find(a=>a.id===lead.id)!;service.store.put('agents',lead.id,{...agent,capabilityIds:[capability.id]});
    const starting=service.startNativeLogin(lead.connectionId!,{projectId:project.id});
    await vi.waitFor(()=>expect(closed).toHaveBeenCalledOnce());
    await expect(service.message(lead.id,{text:'Must not send'},'during-login')).rejects.toThrow('共享原生账号');
    await expect(service.verifyMemberCapability(capability.id,{agentId:lead.id,tool:'never'})).rejects.toThrow('共享原生账号');
    await expect(service.startNativeLogin(lead.connectionId!,{})).rejects.toThrow('共享原生账号');
    oldClose.resolve();expect(await starting).toMatchObject({state:'waiting'});
    expect(service.store.all<Agent>('agents')[0]?.nativeSessionId).toBeUndefined();
    await service.connectionManager.cancelLogin(lead.connectionId!);
    expect(service.agents()[0]?.connectionRevision).toBe(service.connectionManager.get(lead.connectionId!).revision);
  });
  it('does not unlock login after an existing native session fails to stop during preparation',async()=>{
    const dir=await directory(),login=handle(),launch=vi.fn(async()=>login.handle),base=transport(),connect=base.adapter.connect;let stopFailed=true;
    base.adapter.connect=async(...args)=>({...await connect(...args),close:async()=>{if(stopFailed)throw new Error('Old session still alive');}});
    const service=new WorkbenchService({dataDir:dir,adapters:[base.adapter],tasks:{list:async()=>[]} as unknown as TaskRepository,git:{inspect:async()=>({commit:'a'.repeat(40),dirty:false,diff:''})} as unknown as GitRepository,connectionOptions:{nativeLogin:{launch}}});
    cleanups.push(async()=>{stopFailed=false;await service.close();});
    const project:Project={id:randomUUID(),kind:'code',name:'Failed preparation fixture',path:dir,createdAt:new Date().toISOString()};service.store.put('projects',project.id,project);
    const lead=await service.createAgent({projectId:project.id,name:'Lead',role:'controller',memberKind:'controller',runtime:'codex'});
    await service.message(lead.id,{text:'Warm cache'},'warm');await vi.waitFor(()=>expect(service.agents()[0]?.state).toBe('idle'));
    await expect(service.startNativeLogin(lead.connectionId!,{})).rejects.toThrow('尚未确认停止');
    expect(launch).not.toHaveBeenCalled();expect((await service.connectionManager.loginStatus(lead.connectionId!))?.state).toBe('unknown');
    await expect(service.message(lead.id,{text:'Must still block'},'blocked')).rejects.toThrow('共享原生账号');
    stopFailed=false;expect((await service.connectionManager.cancelLogin(lead.connectionId!))?.state).toBe('cancelled');expect(launch).not.toHaveBeenCalled();
  });
});
