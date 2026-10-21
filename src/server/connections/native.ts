import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionProfile, ConnectionStatus, LoginAttempt, LoginRecoveryAction, RuntimeOverrides } from '../../shared/connections.js';
import { executableFor, exec, JsonProcess, pause, timeout, type Json } from '../runtime/process.js';
import { launchWorkbuddyLogin, preflightWorkbuddyLogin, readWorkbuddyAuthentication, WorkbuddyAuthStopError, WorkbuddyLoginUnavailableError, type WorkbuddyLoginPreflight } from './workbuddy-auth.js';

const now = () => new Date().toISOString();
async function codexServer(cwd: string, config: RuntimeOverrides): Promise<{child:JsonProcess;rpc:(method:string,params:Json)=>Promise<Json>}> {
  const executable = config.executable ?? await executableFor('codex'); if (!executable) throw new Error('未找到 Codex');
  const child = new JsonProcess(executable, ['app-server','--stdio'], cwd, config.env);
  const rpc = (method:string,params:Json) => { const id=randomUUID(); return child.request(id,{id,method,params}); };
  try { await rpc('initialize',{clientInfo:{name:'agent_workbench_auth',version:'0.1.0'},capabilities:{experimentalApi:true}}); await child.write({method:'initialized'}); return {child,rpc}; }
  catch(error) { try{await child.close();}catch{throw new UnconfirmedLoginStop('原生登录控制进程初始化失败，且未确认停止。');}throw error; }
}
export async function readNativeAuthentication(profile: ConnectionProfile, cwd: string, config: RuntimeOverrides): Promise<ConnectionStatus> {
  const observed = (source:string,provider?:string):ConnectionStatus => ({state:'authentication-observed',checkedAt:now(),detail:'检测到原生凭据；尚未验证实际调用、模型权限或余额。',credentialSource:source,provider});
  const missing = ():ConnectionStatus => ({state:'unconfigured',checkedAt:now(),detail:'原生工具未报告可用认证，请打开原生登录。'});
  if (profile.runtime === 'codex') {
    const {child,rpc} = await codexServer(cwd,config);
    try { const response = await rpc('account/read',{refreshToken:false});
      if (!response.account) return response.requiresOpenaiAuth === false ? {state:'unknown',checkedAt:now(),detail:'原生配置无需 OpenAI 账号，可能采用外部提供方；请验证实际调用。',credentialSource:'native-provider'} : missing();
      return observed(response.account.type === 'chatgpt' ? 'native-chatgpt' : response.account.type === 'apiKey' ? 'native-api-key' : 'native-account','OpenAI');
    } finally { await child.close(); }
  }
  if (profile.runtime === 'workbuddy') {
    try { return await readWorkbuddyAuthentication(cwd, config); }
    catch (error) { if (error instanceof WorkbuddyAuthStopError) throw new NativeIdentityError(error.message, false, error.retryStop); throw error; }
  }
  const executable = config.executable ?? await executableFor(profile.runtime); if (!executable) throw new Error('未找到原生执行程序');
  if (profile.runtime === 'claude') {
    try { const {stdout} = await exec(executable,['auth','status'],{cwd,env:config.env,windowsHide:true,timeout:20_000,maxBuffer:1024*1024});
      const value = JSON.parse(stdout); if (value.loggedIn === false) return missing();
      if (value.loggedIn === true) return observed(typeof value.authMethod === 'string' ? value.authMethod.replace(/[^\w .-]/g,'').slice(0,80) : 'native-account',typeof value.apiProvider === 'string' ? value.apiProvider.replace(/[^\w .-]/g,'').slice(0,80) : undefined);
      return {state:'unknown',checkedAt:now(),detail:'原生认证状态未返回已登录证据，请打开原生登录或验证调用。'};
    } catch { return {state:'unknown',checkedAt:now(),detail:'无法读取 Claude 原生认证状态；请在原生登录中检查后重新检测。'}; }
  }
  return {state:'unknown',checkedAt:now(),detail:'未识别的原生认证状态。'};
}

export async function logoutNative(profile:ConnectionProfile,cwd:string,config:RuntimeOverrides):Promise<ConnectionStatus> {
  if(profile.mode!=='native')throw new NativeIdentityError('API 连接解除绑定或删除凭据即可，不执行原生账号退出',true);
  if(profile.runtime==='codex'){
    const {child,rpc}=await codexServer(cwd,config);let failure:unknown;
    try{await rpc('account/logout',{});}catch(error){failure=error;}
    try{await child.close();}catch{throw new NativeIdentityError('退出原生账号后未确认控制进程停止；共享原生连接继续暂停。',false,()=>child.close());}
    if(failure)throw new NativeIdentityError(failure instanceof Error?failure.message:'原生退出失败',true);
    return {state:'unconfigured',checkedAt:now(),detail:'已执行 Codex 原生退出；所有沿用本机登录的成员受影响。'};
  }
  if(profile.runtime==='claude'){
    const executable=config.executable??await executableFor('claude');if(!executable)throw new NativeIdentityError('未找到 Claude Code',true);
    const child=new JsonProcess(executable,['auth','logout'],cwd,config.env);let failure:unknown;
    try{await timeout(new Promise<void>((resolve,reject)=>{child.on('exit',({code}:{code:number|null})=>code===0?resolve():reject(new Error('Claude 原生退出失败')));child.on('failure',error=>{if(!child.pid||!child.exited)reject(error);});}),20_000,'退出原生账号');}catch(error){failure=error;}
    try{await child.close();}catch{throw new NativeIdentityError('退出 Claude 原生账号后未确认进程停止；共享原生连接继续暂停。',false,()=>child.close());}
    if(failure)throw new NativeIdentityError(failure instanceof Error?failure.message:'Claude 原生退出失败',true);
    return {state:'unconfigured',checkedAt:now(),detail:'已执行 Claude Code 原生退出；所有沿用本机登录的成员受影响。'};
  }
  throw new NativeIdentityError('此 CodeBuddy 版本仅支持原生交互式 /logout；请打开原生终端退出后重新检测。工作台不会伪报已退出。',true);
}

export const loginPending=(attempt:LoginAttempt)=>['starting','waiting','stopping','unknown'].includes(attempt.state);
type LoginOutcome={state:'completed'|'failed';detail:string};
export interface NativeLoginHandle {
  authUrl?:string;userCode?:string;detail?:string;
  /** Safe dynamic browser-link state; never returns raw native frames. */
  getState?():{authUrl?:string;detail?:string};
  poll():Promise<LoginOutcome|undefined>;
  /** Resolves only after all owned login processes have stopped. */
  close(cancel:boolean):Promise<void>;
}
export interface NativeLoginOptions {
  launch?:(profile:ConnectionProfile,cwd:string,config:RuntimeOverrides,attempt:LoginAttempt)=>Promise<NativeLoginHandle>;
  preflight?:(profile:ConnectionProfile,cwd:string,config:RuntimeOverrides)=>Promise<WorkbuddyLoginPreflight>;
  onChange?:(attempt:LoginAttempt)=>void;
}
interface NativeLogin {attempt:LoginAttempt;startup:Promise<void>;handle?:NativeLoginHandle;cancelRequested:boolean;operation?:Promise<void>;}
export class NativeIdentityError extends Error {
  constructor(message:string,readonly stopConfirmed:boolean,readonly retryStop?:()=>Promise<void>){super(message);}
}
class UnconfirmedLoginStop extends NativeIdentityError {
  constructor(message:string,readonly recovery:LoginRecoveryAction='retry-stop',retryStop?:()=>Promise<void>){super(message,false,retryStop);}
}

/** Kept injectable so lifecycle checks never open an actual account login. */
export interface TerminalLoginDependencies {
  spawn:typeof spawn;readFile:typeof readFile;writeFile:typeof writeFile;exec:typeof exec;
  alive:(pid:number)=>boolean;stopTimeoutMs:number;
}
const terminalDependencies:TerminalLoginDependencies={spawn,readFile,writeFile,exec,alive:(pid)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}},stopTimeoutMs:5_000};
export async function launchTerminalLogin(profile:ConnectionProfile,cwd:string,config:RuntimeOverrides,attempt:LoginAttempt,directory:string,dependencies:Partial<TerminalLoginDependencies>={}):Promise<NativeLoginHandle> {
  const deps={...terminalDependencies,...dependencies};
  const executable=config.executable??await executableFor(profile.runtime);if(!executable)throw new Error('未找到原生执行程序');
  await mkdir(directory,{recursive:true});
  const marker=join(directory,'completed.json'),pidFile=join(directory,'process.txt'),cancelFile=join(directory,'cancelled');
  const ps=(value:string)=>`'${value.replaceAll("'","''")}'`;
  const command=profile.runtime==='claude'?`& ${ps(executable)} auth login`:`& ${ps(process.execPath)} ${ps(executable)}`;
  // The interactive child records ownership before it can mutate native auth.
  // A cancellation during Start-Process is noticed before the native command.
  const inner=`$ErrorActionPreference='Stop'; $PID|Set-Content -LiteralPath ${ps(pidFile)}; try { if(Test-Path -LiteralPath ${ps(cancelFile)}) { exit 1 }; Set-Location -LiteralPath ${ps(cwd)}; ${command}; @{exitCode=$LASTEXITCODE}|ConvertTo-Json|Set-Content -LiteralPath ${ps(marker)} -Encoding UTF8 } catch { @{exitCode=1}|ConvertTo-Json|Set-Content -LiteralPath ${ps(marker)} -Encoding UTF8 }`;
  const encoded=Buffer.from(inner,'utf16le').toString('base64');
  // The visible terminal is explicitly requested by the native-login action.
  const outer=`$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-EncodedCommand',${ps(encoded)}) -WindowStyle Normal -PassThru; $p.Id|Set-Content -LiteralPath ${ps(pidFile)}; $p.WaitForExit(); exit $p.ExitCode } catch { exit 1 }`;
  const child=deps.spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(outer,'utf16le').toString('base64')],{windowsHide:true,shell:false,env:config.env,stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
  let spawnFailed=false,exited=false,ownedPid:number|undefined;
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  child.on('error',()=>{if(!child.pid){spawnFailed=true;exited=true;}});
  child.on('exit',()=>{exited=true;});
  const wrapperExited=()=>exited||child.exitCode!==null||child.signalCode!==null;
  const readPid=async()=>{if(ownedPid)return ownedPid;try{const value=Number(String(await deps.readFile(pidFile,'utf8')).replace(/^\uFEFF/,'').trim());if(Number.isSafeInteger(value)&&value>0&&value!==child.pid)ownedPid=value;}catch{}return ownedPid;};
  // A stop attempt that fails to produce a tree receipt is remembered per owned
  // PID. A later cancel must not read "root PID gone" as "whole tree stopped":
  // the root can exit while children survive, and nothing proves the tree ended.
  const unconfirmedTrees=new Set<number>();
  const stopPid=async(pid:number)=>{
    if(!deps.alive(pid)){
      // The root is gone and nothing proves its children stopped, so retrying in
      // this process cannot produce evidence. Only a restart plus a human check can.
      if(unconfirmedTrees.has(pid))throw new UnconfirmedLoginStop('未确认原生登录进程树已停止：根进程已退出，但此前未收到整树停止回执；当前流程内重试无法清除，请核对终端后受控重启工作台并人工核对。','restart-reconcile');
      return;
    }
    try{await deps.exec('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:deps.stopTimeoutMs});}
    catch{unconfirmedTrees.add(pid);throw new UnconfirmedLoginStop('未收到原生登录进程树的停止回执；相关原生连接继续暂停，请检查终端后重试取消。','retry-stop');}
    const end=Date.now()+deps.stopTimeoutMs;while(deps.alive(pid)&&Date.now()<end)await pause(25);
    if(deps.alive(pid)){unconfirmedTrees.add(pid);throw new UnconfirmedLoginStop('未确认原生登录进程树已停止；相关原生连接继续暂停，请重试取消并检查终端。','retry-stop');}
    unconfirmedTrees.delete(pid);
  };
  return {
    detail:profile.runtime==='workbuddy'?'已打开内置 CLI；请在原生终端选择站点并登录（必要时输入 /login），完成后退出终端并重新检测。':'已打开 Claude 原生登录终端；请完成浏览器授权，随后重新检测。',
    poll:async()=>{
      const pid=await readPid();
      if(spawnFailed)return {state:'failed',detail:'无法打开原生登录终端，请检查执行程序。'};
      if(!wrapperExited())return;
      if(!pid||deps.alive(pid))throw new UnconfirmedLoginStop('登录窗口控制进程已退出，但未确认原生终端已停止；请取消并核对后台进程。');
      try{const result=JSON.parse(String(await deps.readFile(marker,'utf8')).replace(/^\uFEFF/,''));return {state:result.exitCode===0?'completed':'failed',detail:result.exitCode===0?'原生终端流程已结束，请重新检测认证并验证调用。':'原生终端登录失败，请重试。'};}
      catch{return {state:'failed',detail:'原生登录终端已退出，未返回完成回执；请重新检测认证或重试登录。'};}
    },
    close:async(cancel)=>{
      if(spawnFailed)return;
      if(cancel)await deps.writeFile(cancelFile,'cancel','utf8');
      let pid=await readPid();
      // Do not kill the launcher before it has published its child. Otherwise
      // a concurrent Start-Process could leave an untracked login alive.
      const deadline=Date.now()+deps.stopTimeoutMs;
      while(!pid&&!wrapperExited()&&Date.now()<deadline){await pause(25);pid=await readPid();}
      if(pid)await stopPid(pid);
      if(!wrapperExited()&&child.pid)await stopPid(child.pid);
      if(!wrapperExited())await timeout(new Promise<void>(resolve=>{if(wrapperExited())resolve();else child.once('exit',()=>resolve());}),deps.stopTimeoutMs,'等待原生登录控制进程退出');
      pid=pid??await readPid();
      if(!pid)throw new UnconfirmedLoginStop('未获得原生登录子进程的停止证据；相关原生连接继续暂停，请核对终端后重试取消。');
      if(deps.alive(pid))throw new UnconfirmedLoginStop('原生登录子进程仍在运行，请重试取消。');
      // A pid that exited after an unconfirmed tree stop is not evidence that
      // its children stopped; never report cancellation on that basis.
      if(unconfirmedTrees.size)throw new UnconfirmedLoginStop('未确认原生登录进程树已停止：根进程已退出，但整树停止未获回执；当前流程内重试无法清除，请核对终端后受控重启工作台并人工核对。','restart-reconcile');
    },
  };
}
async function launchLogin(dataDir:string,profile:ConnectionProfile,cwd:string,config:RuntimeOverrides,attempt:LoginAttempt):Promise<NativeLoginHandle> {
  if(profile.runtime==='workbuddy'){
    try{return await launchWorkbuddyLogin(cwd,config);}
    catch(error){if(error instanceof WorkbuddyAuthStopError)throw new UnconfirmedLoginStop(error.message,'retry-stop',error.retryStop);throw error;}
  }
  if(profile.runtime!=='codex'){
    if(process.platform!=='win32')throw new Error('此环境请在原生终端完成登录，再重新检测；工作台终端引导当前仅支持 Windows');
    return launchTerminalLogin(profile,cwd,config,attempt,join(dataDir,'login',attempt.id));
  }
  const {child,rpc}=await codexServer(cwd,config);let nativeLoginId:string|undefined,outcome:LoginOutcome|undefined;
  child.on('frame',(frame:Json)=>{if(frame.method==='account/login/completed'&&(!nativeLoginId||frame.params?.loginId===nativeLoginId))outcome={state:frame.params?.success===true?'completed':'failed',detail:frame.params?.success===true?'原生登录完成，请重新检测并验证调用。':'原生登录未完成，请重试。'};});
  child.on('failure',()=>{outcome??={state:'failed',detail:'原生登录进程结束，请重新检测认证或重试。'};});
  try{
    const response=await rpc('account/login/start',{type:attempt.method==='device-code'?'chatgptDeviceCode':'chatgpt'});nativeLoginId=response.loginId;
    let authUrl:string|undefined;const raw=response.authUrl??response.verificationUrl;if(typeof raw==='string'){const url=new URL(raw);if(url.protocol==='https:')authUrl=url.toString();}
    return {authUrl,userCode:typeof response.userCode==='string'?response.userCode.slice(0,80):undefined,poll:async()=>outcome,close:async(cancel)=>{try{if(cancel&&nativeLoginId&&!child.exited)await rpc('account/login/cancel',{loginId:nativeLoginId});}catch{/* The owned process must still be closed even if cancel RPC fails. */}await child.close();}};
  }catch(error){try{await child.close();}catch{throw new UnconfirmedLoginStop('原生登录启动失败，且未确认控制进程已停止。');}throw error;}
}
export class NativeLoginManager {
  private active=new Map<string,NativeLogin>();private closing=false;
  constructor(private dataDir:string,private options:NativeLoginOptions={}){}
  async preflight(profile:ConnectionProfile,cwd:string,config:RuntimeOverrides):Promise<WorkbuddyLoginPreflight>{
    if(this.options.preflight)return this.options.preflight(profile,cwd,config);
    // A custom launcher owns its transport in tests/embedders. Never pair it
    // with a real native probe unless its own preflight is explicitly supplied.
    if(profile.runtime!=='workbuddy'||this.options.launch)return {};
    try{return await preflightWorkbuddyLogin(cwd,config);}
    catch(error){if(error instanceof WorkbuddyAuthStopError)throw new NativeIdentityError(error.message,false,error.retryStop);throw error;}
  }
  private change(entry:NativeLogin,state:LoginAttempt['state'],detail:string):void {Object.assign(entry.attempt,{state,detail,updatedAt:now()});this.options.onChange?.({...entry.attempt});}
  /** Keeps a safe, structured next step instead of collapsing every stop failure into one retry hint. */
  private uncertain(entry:NativeLogin,error:unknown):void {
    const restart=error instanceof UnconfirmedLoginStop&&error.recovery==='restart-reconcile';
    Object.assign(entry.attempt,{recoveryAction:(restart?'restart-reconcile':'retry-stop') as LoginRecoveryAction});
    this.change(entry,'unknown',restart?'原生登录进程树停止未确认，且根进程已退出；当前流程内重试无法清除。请核对原生终端与相关进程，按受控方式重启工作台后台，再在接入中心填写核对依据。':'未确认原生登录进程树已停止；相关原生连接继续暂停，请检查终端并重试取消。');
  }
  private async settle(entry:NativeLogin,outcome:LoginOutcome):Promise<void> {
    if(entry.operation)return entry.operation;
    const work=(async()=>{try{await entry.handle!.close(false);Object.assign(entry.attempt,{recoveryAction:undefined});this.change(entry,entry.cancelRequested?'cancelled':outcome.state,entry.cancelRequested?'已确认登录进程停止；已有原生认证未被退出。':outcome.detail);}catch(error){this.uncertain(entry,error);}})();
    entry.operation=work;try{await work;}finally{entry.operation=undefined;}
  }
  async status(id:string):Promise<LoginAttempt|undefined> {const entry=this.active.get(id);if(!entry)return;if(entry.attempt.state==='waiting'&&!entry.operation){try{const outcome=await entry.handle?.poll();const state=entry.handle?.getState?.();if(state&&(state.authUrl!==entry.attempt.authUrl||state.detail&&state.detail!==entry.attempt.detail)){Object.assign(entry.attempt,{authUrl:state.authUrl});this.change(entry,'waiting',state.detail??entry.attempt.detail);}if(outcome)await this.settle(entry,outcome);}catch(error){this.uncertain(entry,error);}}return {...entry.attempt};}
  async cancel(id:string):Promise<LoginAttempt|undefined> {
    const entry=this.active.get(id);if(!entry)return;
    if(!loginPending(entry.attempt))return {...entry.attempt};
    entry.cancelRequested=true;this.change(entry,'stopping','正在停止原生登录；确认进程退出前相关原生连接继续暂停。');
    await entry.startup;
    if(!loginPending(entry.attempt))return {...entry.attempt};
    if(entry.operation){await entry.operation;return {...entry.attempt};}
    if(!entry.handle){if(entry.attempt.state!=='failed')this.change(entry,'unknown','登录启动状态未确认；相关原生连接继续暂停。');return {...entry.attempt};}
    const work=(async()=>{try{await entry.handle!.close(true);Object.assign(entry.attempt,{recoveryAction:undefined});this.change(entry,'cancelled','已确认登录进程停止；已有原生认证未被退出，请重新检测并验证调用。');}catch(error){this.uncertain(entry,error);}})();
    entry.operation=work;try{await work;}finally{entry.operation=undefined;}return {...entry.attempt};
  }
  async close():Promise<void>{this.closing=true;for(const id of this.active.keys())await this.cancel(id);if([...this.active.values()].some(entry=>loginPending(entry.attempt)))throw new Error('原生登录进程停止未确认；不能报告登录会话已关闭。');}
  async start(profile:ConnectionProfile,cwd:string,config:RuntimeOverrides,method?:LoginAttempt['method']):Promise<LoginAttempt>{
    if(this.closing)throw new Error('服务正在关闭');
    if(profile.mode!=='native')throw new Error('API 连接请配置 API Key，不使用原生登录');
    if([...this.active.values()].some(entry=>entry.attempt.runtime===profile.runtime&&loginPending(entry.attempt)))throw new Error('同一执行工具已有原生登录或停止核对，请先完成或取消');
    const attempt:LoginAttempt={id:randomUUID(),connectionId:profile.id,runtime:profile.runtime,state:'starting',startedAt:now(),updatedAt:now(),method:profile.runtime==='codex'?(method==='device-code'?'device-code':'browser'):profile.runtime==='workbuddy'?'browser':'native-terminal',detail:'正在启动原生登录，相关原生连接暂时暂停。'};
    const entry:NativeLogin={attempt,startup:Promise.resolve(),cancelRequested:false};this.active.set(profile.id,entry);this.options.onChange?.({...attempt});
    entry.startup=(async()=>{try{entry.handle=await (this.options.launch??((p,c,o,a)=>launchLogin(this.dataDir,p,c,o,a)))(profile,cwd,config,attempt);Object.assign(attempt,{authUrl:entry.handle.authUrl,userCode:entry.handle.userCode});if(!entry.cancelRequested)this.change(entry,'waiting',entry.handle.detail??'等待在原生界面完成认证。');}catch(error){if(error instanceof NativeIdentityError&&!error.stopConfirmed){const recovery=error instanceof UnconfirmedLoginStop?error.recovery:'retry-stop';if(error.retryStop)entry.handle={poll:async()=>undefined,close:error.retryStop};Object.assign(entry.attempt,{recoveryAction:recovery});this.change(entry,'unknown',recovery==='restart-reconcile'?'登录启动失败，根进程已退出但整树停止未确认；当前流程内重试无法清除，请核对终端后受控重启工作台并人工核对。':'登录启动失败，且未确认进程停止；相关原生连接继续暂停，请重试取消并检查终端。');}else this.change(entry,'failed',error instanceof WorkbuddyLoginUnavailableError?error.message:'无法启动原生登录，请检查执行程序后重试。');}})();
    await entry.startup;if(entry.cancelRequested)await this.cancel(profile.id);else await this.status(profile.id);return {...attempt};
  }
}
