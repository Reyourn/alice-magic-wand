import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { RuntimeAuthenticationControl, RuntimeAuthenticationSession, RuntimeOptions } from '../../shared/types.js';
import { JsonProcess, timeout, type Json } from './process.js';

export class WorkbuddyAuthenticationError extends Error {
  readonly statusCode=409;
  constructor(readonly code:'WORKBUDDY_AUTHENTICATION_CANCELLED'|'WORKBUDDY_AUTHENTICATION_FAILED'|'WORKBUDDY_AUTHENTICATION_STOP_UNCONFIRMED'|'WORKBUDDY_AUTHENTICATION_BUSY',message:string,readonly sessionId:string,readonly stopConfirmed:boolean){super(message);}
}
const authenticationStages={
  spawn:'创建原生进程',initialize:'初始化原生协议',initialCredentials:'检查初始认证隔离',
  methods:'读取原生登录方式',product:'核对所选版本',authenticate:'等待原生授权',
  callback:'确认授权回调',receipt:'核对授权回执',authenticatedInitialize:'读取授权后状态',
  authenticatedCredentials:'确认进程内认证',authenticatedMethods:'读取授权后登录方式',authenticatedProduct:'核对授权后版本',
} as const;
const authenticationFailures={invalid_method:'原生登录方式不可用',timeout:'原生授权等待超时',cancelled:'原生授权被取消',auth_failed:'原生授权未成功'} as const;
interface OwnedSession {
  snapshot:RuntimeAuthenticationSession;
  stage?:keyof typeof authenticationStages;
  failure?:keyof typeof authenticationFailures;
  implicitNativeProvider:boolean;
  child?:JsonProcess;
  startup?:Promise<unknown>;
  stopWait?:Promise<void>;
  runtimeClose?:()=>Promise<void>;
  authUrl?:string;
  requestId?:string;
  cancelled:boolean;
  stopped:boolean;
  stopUnconfirmed:boolean;
  detach?:()=>void;
}
const now=()=>new Date().toISOString();
function workspace(path:string){const value=resolve(path);return process.platform==='win32'?value.toLowerCase():value;}
function authorizationUrl(raw:unknown):string|undefined {
  if(typeof raw!=='string'||raw.length>8192)return;
  try{const value=new URL(raw);if(value.protocol==='https:'&&!value.username&&!value.password)return value.toString();}catch{}
}
function nativeCredentials(response:Json):boolean {
  const account=response.account;
  return !!account&&['token','accessToken','access_token'].some(key=>typeof account[key]==='string'&&account[key].length>0);
}
function nativeMethod(response:Json,expected:string):boolean {
  const methods=Array.isArray(response.authMethods)?response.authMethods:Array.isArray(response.methods)?response.methods:[];
  return methods.some((method:unknown)=>!!method&&typeof method==='object'&&(method as Json).id===expected);
}

/** Owns each authenticated process for its whole lifetime; there is no token handoff or process borrowing. */
export class WorkbuddySessionRegistry implements RuntimeAuthenticationControl {
  private sessions=new Map<string,OwnedSession>();
  private closing=false;
  constructor(private options:{authenticationTimeoutMs?:number;maxRetained?:number;maxActive?:number}={}){}
  list():RuntimeAuthenticationSession[]{return [...this.sessions.values()].map(({snapshot,authUrl})=>({
    id:snapshot.id,agentId:snapshot.agentId,connectionId:snapshot.connectionId,connectionRevision:snapshot.connectionRevision,
    pid:snapshot.pid,edition:snapshot.edition,cwd:snapshot.cwd,state:snapshot.state,createdAt:snapshot.createdAt,updatedAt:snapshot.updatedAt,detail:snapshot.detail,
    canAuthorize:snapshot.state==='waiting'&&!!authUrl,
  }));}
  url(id:string):string|undefined {const entry=this.sessions.get(id);return entry?.snapshot.state==='waiting'?entry.authUrl:undefined;}
  private change(entry:OwnedSession,state:RuntimeAuthenticationSession['state'],detail:string){Object.assign(entry.snapshot,{state,detail,updatedAt:now(),canAuthorize:false});if(state!=='waiting')entry.authUrl=undefined;}
  private trim(){const terminal=[...this.sessions.values()].filter(row=>row.stopped).sort((a,b)=>a.snapshot.updatedAt.localeCompare(b.snapshot.updatedAt));while(terminal.length>(this.options.maxRetained??32)){const entry=terminal.shift()!;this.sessions.delete(entry.snapshot.id);}}
  private error(entry:OwnedSession,kind:'cancelled'|'failed'|'unknown'):WorkbuddyAuthenticationError {
    return kind==='unknown'
      ?new WorkbuddyAuthenticationError('WORKBUDDY_AUTHENTICATION_STOP_UNCONFIRMED','WorkBuddy 原生进程停止未确认；请核对该会话后重试停止，已暂停创建新的执行进程。',entry.snapshot.id,false)
      :kind==='cancelled'
        ?new WorkbuddyAuthenticationError('WORKBUDDY_AUTHENTICATION_CANCELLED','WorkBuddy 内存授权已取消；已确认对应原生进程停止。',entry.snapshot.id,true)
        :new WorkbuddyAuthenticationError('WORKBUDDY_AUTHENTICATION_FAILED',`WorkBuddy 内存授权在「${authenticationStages[entry.stage??'spawn']}」阶段未成功完成${entry.failure?`（${authenticationFailures[entry.failure]}）`:''}；没有重发授权或任务，已确认对应原生进程停止。`,entry.snapshot.id,true);
  }
  /** Every call creates a process for this exact member/cwd/config. Authenticated contexts are never reused here. */
  authorize(options:RuntimeOptions,open:()=>JsonProcess,onSpawn?:(pid:number|undefined)=>void):Promise<{id:string;child:JsonProcess;initialization:Json}> {
    const connection=options.connection,edition=connection?.workbuddyEdition;
    if(this.closing)throw new Error('工作台正在关闭，不能创建 WorkBuddy 内存授权会话');
    if(!connection||!['china','international'].includes(edition??''))throw new Error('WorkBuddy 内存授权必须绑定已核对的国内或国际版本');
    const live=[...this.sessions.values()].filter(entry=>!entry.stopped);
    if(live.some(entry=>entry.snapshot.state==='unknown'))throw new WorkbuddyAuthenticationError('WORKBUDDY_AUTHENTICATION_BUSY','已有 WorkBuddy 进程停止未确认，请先核对停止。','',false);
    if(live.length>=(this.options.maxActive??4)||live.some(entry=>entry.snapshot.agentId===options.agentId))throw new WorkbuddyAuthenticationError('WORKBUDDY_AUTHENTICATION_BUSY','此成员已有 WorkBuddy 原生会话，或已达到会话并行上限；请先结束原会话。','',true);
    if(options.permissionMode==='workspace-write'&&live.some(entry=>workspace(entry.snapshot.cwd)===workspace(options.cwd)))throw new WorkbuddyAuthenticationError('WORKBUDDY_AUTHENTICATION_BUSY','该工作区仍有 WorkBuddy 会话，请先确认原写者停止，不能创建第二个写者。','',true);
    const timestamp=now(),entry:OwnedSession={snapshot:{id:randomUUID(),agentId:options.agentId,connectionId:connection.connectionId,connectionRevision:connection.revision,edition:edition!,cwd:resolve(options.cwd),state:'starting',createdAt:timestamp,updatedAt:timestamp,detail:'正在创建固定工作区的 WorkBuddy 原生内存授权进程。',canAuthorize:false},implicitNativeProvider:connection.nativeMemoryAuthentication===true&&edition==='international',cancelled:false,stopped:false,stopUnconfirmed:false};
    this.sessions.set(entry.snapshot.id,entry);this.trim();
    const work=this.authorizeOwned(entry,open,onSpawn);entry.startup=work;void work.finally(()=>{if(entry.startup===work)entry.startup=undefined;}).catch(()=>{});return work;
  }
  private async authorizeOwned(entry:OwnedSession,open:()=>JsonProcess,onSpawn?:((pid:number|undefined)=>void)):Promise<{id:string;child:JsonProcess;initialization:Json}>{
    let detachAuth=()=>{};
    try{
      entry.stage='spawn';
      const child=open();entry.child=child;entry.snapshot.pid=child.pid;
      const exited=()=>{if(!entry.stopped&&entry.snapshot.state!=='stopping'){entry.stopUnconfirmed=!!child.pid;this.change(entry,entry.stopUnconfirmed?'unknown':'failed','WorkBuddy 原生进程意外退出；尚未核对其工具子进程状态。');}};
      child.on('exit',exited);entry.detach=()=>child.off('exit',exited);
      onSpawn?.(child.pid);
      const control=(subtype:string,params:Json={},ms=30_000)=>{const id=randomUUID();return child.request(id,{type:'control_request',request_id:id,request:{subtype,...params}},ms);};
      const acknowledgements:Promise<void>[]=[];
      let unsafeUrl=false,callbackRejected=false;
      const frame=(value:Json)=>{
        if(value.type!=='control_request'||typeof value.request_id!=='string')return;
        const request=value.request??{};
        if(request.subtype==='auth_url_callback'){
          const url=authorizationUrl(request.authState?.authUrl);
          if(url&&!entry.cancelled){entry.authUrl=url;this.change(entry,'waiting','请打开此会话的原生浏览器授权链接，按对应页面及时完成登录和授权；当前版本的原生授权请求约有 60 秒窗口，后台 300 秒等待不延长原生时限。认证只保留在当前执行进程中，进程结束后需重新授权。');entry.authUrl=url;}
          else unsafeUrl=true;
        }
        if(request.subtype==='auth_result_callback'&&request.success===false){
          callbackRejected=true;
          // The native error message may contain credentials or URL state.
          // Only these documented protocol types can become a fixed label.
          const reason=request.error?.type;if(typeof reason==='string'&&Object.hasOwn(authenticationFailures,reason))entry.failure=reason as keyof typeof authenticationFailures;
        }
        // Never inspect or retain request.userinfo/account/error.message; callback success
        // alone is not the final control receipt needed for protocol handoff.
        const supported=request.subtype==='auth_url_callback'||request.subtype==='auth_result_callback';
        const reply=child.write({type:'control_response',response:{request_id:value.request_id,subtype:supported?'success':'error',...(supported?{response:{}}:{error:'授权阶段不允许执行其他操作'})}});
        acknowledgements.push(reply);void reply.catch(()=>{});
      };
      child.on('frame',frame);detachAuth=()=>child.off('frame',frame);
      entry.stage='initialize';const initial=await control('initialize',{hasPrompt:true,capabilities:{}});
      // An isolated memory process must start unauthenticated. Do not silently
      // inherit a different credential channel or declare it a verified call.
      entry.stage='initialCredentials';if(nativeCredentials(initial))throw new Error('Unexpected inherited native credentials');
      if(entry.cancelled||this.closing)throw new Error('Cancelled');
      entry.stage='methods';const methods=await control('get_auth_methods');
      const expected=entry.snapshot.edition==='international'?'workbuddy-desktop-ai':'workbuddy-desktop';
      entry.stage='product';if(!nativeMethod(methods,expected))throw new Error('Native authentication product mismatch');
      if(entry.cancelled||this.closing)throw new Error('Cancelled');
      entry.requestId=randomUUID();this.change(entry,'waiting','正在等待所选 WorkBuddy 版本返回原生授权链接；当前版本原生请求约有 60 秒窗口，后台等待不延长原生时限，不会更换站点或供应商。');
      // 2.161.0's international cli-external-link provider has a native
      // getAuthenticationType mismatch. Let its own support() choose the
      // unchanged vendor provider, while retaining both product ID guards.
      const selection=entry.implicitNativeProvider?{}:{methodId:expected};
      entry.stage='authenticate';const result=await child.request(entry.requestId,{type:'control_request',request_id:entry.requestId,request:{subtype:'authenticate',...selection}},this.options.authenticationTimeoutMs??300_000);
      entry.stage='callback';await Promise.all(acknowledgements);
      entry.stage='receipt';
      if(result.success!==true||unsafeUrl||callbackRejected||entry.cancelled||this.closing)throw new Error('Native authentication not confirmed');
      entry.stage='authenticatedInitialize';const initialized=await control('initialize',{hasPrompt:true,capabilities:{}});
      entry.stage='authenticatedCredentials';if(!nativeCredentials(initialized))throw new Error('Native credential confirmation missing');
      entry.stage='authenticatedMethods';const confirmedMethods=await control('get_auth_methods');
      entry.stage='authenticatedProduct';if(!nativeMethod(confirmedMethods,expected)||entry.cancelled||this.closing)throw new Error('Native product confirmation missing');
      entry.requestId=undefined;
      detachAuth();detachAuth=()=>{};
      this.change(entry,'authenticated','当前固定工作区的原生内存授权已完成；实际执行继续使用同一进程，未复制或持久化订阅凭据。');
      // Return only the model field used by runtime initialization, never the
      // account object from either native response.
      return {id:entry.snapshot.id,child,initialization:{currentModelId:typeof initialized.currentModelId==='string'?initialized.currentModelId:undefined}};
    }catch(error){
      if(entry.snapshot.state==='unknown')throw this.error(entry,'unknown');
      // Native stream-json has its own hard 60s control timer. Extending our
      // transport wait cannot change it, and no native timeout field is read.
      if(entry.stage==='authenticate'&&error instanceof Error&&(error.message==='Request timeout'||error.message==='运行程序未返回控制请求回执'))entry.failure='timeout';
      const cancelled=entry.cancelled||this.closing;
      try{await this.stop(entry);}catch{throw this.error(entry,'unknown');}
      if(cancelled)throw this.error(entry,'cancelled');
      this.change(entry,'failed',`原生授权在「${authenticationStages[entry.stage??'spawn']}」阶段未成功完成${entry.failure?`（${authenticationFailures[entry.failure]}）`:''}；已确认进程停止，未重发授权或任务。`);throw this.error(entry,'failed');
    }finally{detachAuth();this.trim();}
  }
  /** Keeps close() a real stop after the same process has become an execution connection. */
  attach(id:string,close:()=>Promise<void>):void {const entry=this.sessions.get(id);if(!entry||entry.stopped||entry.cancelled||this.closing)throw new Error('原生授权会话已关闭，不能移交执行');entry.runtimeClose=close;}
  assertActive(id:string):void {const entry=this.sessions.get(id);if(!entry||entry.stopped||entry.cancelled||entry.snapshot.state!=='authenticated')throw entry?this.error(entry,entry.snapshot.state==='unknown'?'unknown':'cancelled'):new Error('原生授权会话不存在');}
  private async stop(entry:OwnedSession):Promise<void>{
    if(entry.stopped)return;
    if(entry.stopWait)return entry.stopWait;
    if(entry.stopUnconfirmed&&entry.child?.exited){this.change(entry,'unknown','根进程已退出，但此前整树停止未获确认；请人工核对，不能根据 PID 消失解除。');throw this.error(entry,'unknown');}
    this.change(entry,'stopping','正在停止此 WorkBuddy 原生进程；取得停止确认前不复用其工作区或认证。');
    const work=(async()=>{
      try{
        if(entry.runtimeClose)await entry.runtimeClose();else if(entry.child)await entry.child.close();
        entry.stopped=true;entry.stopUnconfirmed=false;entry.detach?.();entry.detach=undefined;entry.child=undefined;entry.runtimeClose=undefined;
        this.change(entry,'stopped','已确认对应 WorkBuddy 原生进程停止，内存认证已结束。');
      }catch{entry.stopUnconfirmed=true;this.change(entry,'unknown','未确认此 WorkBuddy 原生进程停止；工作区和认证会话继续暂停，请重试停止。');throw this.error(entry,'unknown');}
    })();entry.stopWait=work;try{await work;}finally{entry.stopWait=undefined;this.trim();}
  }
  async cancel(id:string):Promise<void>{const entry=this.sessions.get(id);if(!entry)return;entry.cancelled=true;entry.authUrl=undefined;if(entry.requestId&&entry.child&&!entry.child.exited){try{await timeout(entry.child.write({type:'control_cancel_request',request_id:entry.requestId}),2000,'取消原生授权');}catch{}}
    await this.stop(entry);await entry.startup?.catch(()=>{});
  }
  async close():Promise<void>{this.closing=true;const entries=[...this.sessions.values()];const stopped=await Promise.allSettled(entries.map(entry=>this.cancel(entry.snapshot.id)));await Promise.allSettled(entries.map(entry=>entry.startup));if(stopped.some(row=>row.status==='rejected')||entries.some(entry=>!entry.stopped))throw new Error('仍有 WorkBuddy 原生进程停止未确认；不能报告认证会话已关闭。');}
}
