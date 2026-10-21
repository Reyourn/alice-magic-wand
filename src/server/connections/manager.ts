import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionInput, ConnectionProfile, ConnectionStatus, ConnectionVerification, LoginAttempt, LoginRecoveryAction, RuntimeOverrides, VerifiedCapability } from '../../shared/connections.js';
import type { RuntimeAdapter, RuntimeConnection, RuntimeEvent, RuntimeKind, RuntimeModelCatalog, RuntimeTokenUsage } from '../../shared/types.js';
import { connectionContextFingerprint, normalizeConnection, profileOverrides } from './configuration.js';
import { WindowsDpapiProtector, type SecretProtector } from './secrets.js';
import { NativeLoginManager, NativeIdentityError, readNativeAuthentication, logoutNative, loginPending, type NativeLoginOptions } from './native.js';
import { discoverRuntime, safeText, timeout } from '../runtime/process.js';
import { createImageProbe, imageProbePassed } from './image-probe.js';

export interface ConnectionStore { get<T>(collection:string,id:string):T|undefined; all<T>(collection:string):T[]; put(collection:string,id:string,value:unknown):void; remove(collection:string,id:string):void; }
interface StoredConnection extends ConnectionProfile { credentialCiphertext?:string; }
export interface ConnectionManagerOptions { dataDir:string; store:ConnectionStore; adapters:Record<RuntimeKind,RuntimeAdapter>; secrets?:SecretProtector; verificationTimeoutMs?:number; nativeLogin?:NativeLoginOptions; nativeLogout?:typeof logoutNative; nativeAuthentication?:typeof readNativeAuthentication; }
interface IdentityOperation {connectionId:string;identityScope?:string;kind:'login'|'logout'|'verification';attempt:LoginAttempt;startup?:Promise<unknown>;cancelRequested?:boolean;recovered?:boolean;reconciling?:boolean;retryStop?:()=>Promise<void>;stopWait?:Promise<LoginAttempt>;}
interface StoredLoginHistory extends LoginAttempt {identityScope?:string;}
interface IdentityPreparation {assertIdle?:()=>void;prepare?:()=>Promise<void>;}
const now=()=>new Date().toISOString();
export function classifyConnectionError(error:unknown):ConnectionStatus {
  const text=safeText(error instanceof Error?error.message:String(error));
  const state:ConnectionStatus['state']=/覆盖所选连接|配置.*冲突/i.test(text)?'conflict':/未找到|not found.*executable/i.test(text)?'not-installed':/quota|usage limit|额度|insufficient|credit|billing|rate.?limit|429/i.test(text)?'quota-exceeded':/401|403|unauthorized|authentication|invalid.{0,6}(?:api.?key|key|token)|登录|认证/i.test(text)?'authentication-failed':/尚未配置 API Key|未配置|not configured/i.test(text)?'unconfigured':/model.*(?:not found|not support|unavailable|invalid)|模型.*(?:不可用|不支持|不存在)|issue with the selected model|selected model[^\n]{0,80}(?:may not exist|no access|not have access)/i.test(text)?'model-unavailable':/network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|网络|超时|timed? ?out/i.test(text)?'network-failed':'unknown';
  return {state,checkedAt:now(),detail:text.slice(0,800)};
}
function publicProfile(record:StoredConnection):ConnectionProfile {const {credentialCiphertext:_,...profile}=record;return structuredClone(profile);}
const probeServer=`import readline from 'node:readline';import fs from 'node:fs';const [marker,nonce]=process.argv.slice(2);const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{try{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==='initialize')result={protocolVersion:r.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'workbench-connection-probe',version:'1'}};else if(r.method==='ping')result={};else if(r.method==='tools/list')result={tools:[{name:'connection_probe',description:'Read the one-time connectivity verification code. Read-only local test.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};else if(r.method==='tools/call'&&r.params?.name==='connection_probe'){fs.writeFileSync(marker,JSON.stringify({nonce,at:new Date().toISOString()}));result={content:[{type:'text',text:'Verification code: '+nonce}]};}else return send({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unknown method'}});send({jsonrpc:'2.0',id:r.id,result});}catch{}});`;

export class ConnectionManager {
  private store:ConnectionStore;private secrets:SecretProtector;private login:NativeLoginManager;private verifying=new Set<string>();private knownSecrets=new Set<string>();private closing=false;
  private verificationWaits=new Map<string,Promise<void>>();private verificationAborts=new Map<string,()=>void>();
  private authenticationReads=new Map<string,Promise<ConnectionProfile>>();
  private loginPreflights=new Map<string,Promise<{alreadyAuthenticated?:boolean;detail?:string;authenticationStatus?:ConnectionStatus}>>();
  private identityOperations=new Map<RuntimeKind,IdentityOperation>();private nativeUses=new Map<RuntimeKind,number>();private runtimeLoginIds=new Map<string,string>();
  private uncertainProbeStops=new Map<RuntimeKind,Set<()=>Promise<void>>>();
  constructor(private options:ConnectionManagerOptions){
    this.store=options.store;this.secrets=options.secrets??new WindowsDpapiProtector();this.login=new NativeLoginManager(options.dataDir,{...options.nativeLogin,onChange:attempt=>{this.observeLogin(attempt);options.nativeLogin?.onChange?.(attempt);}});
    for(const stored of this.store.all<IdentityOperation>('native_identity')){
      if(!stored.attempt||!loginPending(stored.attempt))continue;
      const operation:IdentityOperation={connectionId:stored.connectionId,identityScope:stored.identityScope,kind:stored.kind,attempt:{...stored.attempt,state:'unknown',updatedAt:now(),recoveryRequired:true,recoveryAction:'restart-reconcile',detail:'服务重启前的原生账号操作未确认停止；请在原生终端核对旧登录进程已退出，再填写人工核对依据。工作台不会根据旧 PID 自动取消或继续派发。'},recovered:true};
      this.identityOperations.set(operation.attempt.runtime,operation);this.persistIdentity(operation);
    }
  }
  private persistIdentity(operation:IdentityOperation):void {
    const {authUrl:_,userCode:__,...attempt}=operation.attempt;
    this.store.put('native_identity',attempt.runtime,{connectionId:operation.connectionId,identityScope:operation.identityScope,kind:operation.kind,attempt});
  }
  assertIdentityAvailable(id:string):void {const profile=this.get(id);if(profile.mode==='native'&&this.identityOperations.has(profile.runtime))throw new Error('此执行工具正在登录、退出或核对登录进程停止；共享原生账号的连接暂停调用，请先完成或取消登录');if(profile.mode==='native'&&this.options.adapters[profile.runtime]?.authentication?.list().some(row=>row.connectionId===id&&row.state==='unknown'))throw new Error('此连接仍有未确认停止的原生会话，请在授权面板重试停止并核对成员后恢复');}
  /** An account-changing operation cannot race a verification not tracked as an agent run. */
  async withConnectionUse<T>(id:string,work:()=>Promise<T>):Promise<T>{this.assertIdentityAvailable(id);const profile=this.get(id);if(profile.mode!=='native')return work();this.nativeUses.set(profile.runtime,(this.nativeUses.get(profile.runtime)??0)+1);try{return await work();}finally{const count=(this.nativeUses.get(profile.runtime)??1)-1;if(count)this.nativeUses.set(profile.runtime,count);else this.nativeUses.delete(profile.runtime);}}
  private nativeScope(profile:ConnectionProfile):string{return profile.runtime==='workbuddy'?`workbuddy:${profile.workbuddyEdition??'legacy'}`:profile.runtime;}
  affectedNativeConnections(id:string):ConnectionProfile[]{const profile=this.get(id);return profile.mode==='native'?this.list().filter(row=>this.affectedNative(row,profile.runtime,this.nativeScope(profile))):[profile];}
  /** The runtime lock stays global, but an authorization URL belongs to its account source. */
  private visibleNativeAttempt(profile:ConnectionProfile,attempt:LoginAttempt,scope?:string):boolean {
    if(profile.mode!=='native'||profile.runtime!==attempt.runtime)return false;
    if(profile.runtime!=='workbuddy')return true;
    const target=this.nativeScope(profile),source=scope??'workbuddy:legacy';
    if(target!==source)return false;
    // Legacy installations may resolve to either distribution. Never share their
    // URL/history across connections or infer a historical edition from today's config.
    return source!=='workbuddy:legacy'||profile.id===attempt.connectionId;
  }
  private affectedNative(profile:ConnectionProfile,runtime:RuntimeKind,scope?:string):boolean {
    if(profile.mode!=='native'||profile.runtime!==runtime)return false;
    if(runtime!=='workbuddy')return true;
    const target=this.nativeScope(profile),source=scope??'workbuddy:legacy';
    return target==='workbuddy:legacy'||source==='workbuddy:legacy'||target===source;
  }
  private invalidateNative(runtime:RuntimeKind,detail:string,scope?:string):void {for(const profile of this.list().filter(row=>this.affectedNative(row,runtime,scope))){const record=this.record(profile.id);record.revision++;record.updatedAt=now();record.status={state:'unknown',checkedAt:now(),detail};record.authenticationStatus={...record.status};record.catalog=undefined;this.store.put('connections',record.id,record);}}
  private finishIdentity(runtime:RuntimeKind,operation:IdentityOperation,detail:string):void {if(this.identityOperations.get(runtime)!==operation)return;for(const profile of this.list().filter(row=>this.affectedNative(row,runtime,operation.identityScope)))this.status(profile.id,{state:'unknown',checkedAt:now(),detail});this.identityOperations.delete(runtime);this.store.remove('native_identity',runtime);}
  private saveLoginHistory(attempt:LoginAttempt,identityScope?:string):void {const {authUrl:_,userCode:__,...safe}=attempt;this.store.put('native_login_history',attempt.id,{...safe,identityScope});}
  private holdUnknown(operation:IdentityOperation,detail:string,retryStop?:()=>Promise<void>,recoveryAction:LoginRecoveryAction='retry-stop'):void {operation.attempt={...operation.attempt,state:'unknown',updatedAt:now(),detail,recoveryAction};operation.retryStop=retryStop;this.persistIdentity(operation);}
  private retainVerificationProcess(profile:ConnectionProfile,connection:RuntimeConnection):void {
    this.retainNativeStop(profile,()=>connection.close(),'连接验证进程停止未确认');
  }
  private retainNativeStop(profile:ConnectionProfile,stop:()=>Promise<void>,reason:string):void {
    if(profile.mode!=='native')return;
    let stops=this.uncertainProbeStops.get(profile.runtime);if(!stops){stops=new Set();this.uncertainProbeStops.set(profile.runtime,stops);}stops.add(stop);
    let operation=this.identityOperations.get(profile.runtime);
    if(!operation){operation={connectionId:profile.id,identityScope:this.nativeScope(profile),kind:'verification',attempt:{id:randomUUID(),connectionId:profile.id,runtime:profile.runtime,state:'unknown',startedAt:now(),updatedAt:now(),method:'native-terminal',detail:'连接验证已返回，但验证进程停止未确认；共享原生连接继续暂停，请重试停止。'}};this.identityOperations.set(profile.runtime,operation);this.invalidateNative(profile.runtime,operation.attempt.detail);}
    const pending=stops;
    this.holdUnknown(operation,`${reason}；共享原生连接继续暂停，请重试停止。`,async()=>{
      let failure:unknown;
      for(const stop of pending){try{await stop();pending.delete(stop);}catch(error){failure=error;}}
      if(failure||pending.size)throw new Error('仍有原生验证进程未确认停止');
      this.uncertainProbeStops.delete(profile.runtime);
    });
  }
  private observeLogin(attempt:LoginAttempt):void {const operation=this.identityOperations.get(attempt.runtime);if(!operation||operation.connectionId!==attempt.connectionId||operation.kind!=='login')return;operation.attempt={...attempt};if(operation.cancelRequested&&loginPending(attempt))operation.attempt.state=attempt.state==='unknown'?'unknown':'stopping';if(!loginPending(attempt)){this.saveLoginHistory(attempt,operation.identityScope);this.finishIdentity(attempt.runtime,operation,'原生登录流程已结束，账号可能已变化；请重新检测并验证当前模型。');}else this.persistIdentity(operation);}
  private beginIdentity(id:string,kind:IdentityOperation['kind'],preparation:IdentityPreparation,method?:LoginAttempt['method']):{profile:ConnectionProfile;operation:IdentityOperation} {
    if(this.closing)throw new Error('服务正在关闭');const profile=this.get(id);if(profile.mode!=='native')throw new Error('只有原生连接使用本机账号登录');this.assertIdentityAvailable(id);
    if(this.nativeUses.has(profile.runtime)||this.list().some(row=>row.runtime===profile.runtime&&row.mode==='native'&&this.verifying.has(row.id)))throw new Error('共享原生账号正在执行连接或能力验证，请等待调用及停止回执');
    const operation:IdentityOperation={connectionId:id,identityScope:this.nativeScope(profile),kind,attempt:{id:randomUUID(),connectionId:id,runtime:profile.runtime,state:'starting',startedAt:now(),updatedAt:now(),method:profile.runtime==='codex'?(method==='device-code'?'device-code':'browser'):profile.runtime==='workbuddy'?'browser':'native-terminal',detail:kind==='login'?'正在准备原生登录；共享原生账号的连接暂停调用。':'正在退出原生账号；共享原生账号的连接暂停调用。'}};
    // Reserve synchronously before the service checks active members or closes
    // old sessions. No second login or probe can enter during those awaits.
    this.identityOperations.set(profile.runtime,operation);
    try{preparation.assertIdle?.();}catch(error){this.identityOperations.delete(profile.runtime);throw error;}
    this.persistIdentity(operation);this.invalidateNative(profile.runtime,'原生账号操作开始，旧调用验证已失效；操作结束后请重新验证。',operation.identityScope);return {profile:this.get(id),operation};
  }
  list():ConnectionProfile[]{return this.store.all<StoredConnection>('connections').map(publicProfile);}
  get(id:string):ConnectionProfile{return publicProfile(this.record(id));}
  private record(id:string):StoredConnection{const value=this.store.get<StoredConnection>('connections',id);if(!value)throw new Error('连接配置不存在');return value;}
  ensureNative(runtime:RuntimeKind):ConnectionProfile {
    const id=`native-${runtime}`;const existing=this.store.get<StoredConnection>('connections',id);if(existing)return publicProfile(existing);
    const timestamp=now();const value:StoredConnection={...normalizeConnection({name:`${runtime==='codex'?'Codex':runtime==='claude'?'Claude Code':'WorkBuddy'} · 沿用本机配置`,runtime,mode:'native'}),id,revision:1,hasCredential:false,createdAt:timestamp,updatedAt:timestamp,verifications:[]};
    this.store.put('connections',id,value);return publicProfile(value);
  }
  async create(input:ConnectionInput):Promise<ConnectionProfile>{const base=normalizeConnection(input);const timestamp=now();const ciphertext=input.apiKey?await this.secrets.protect(this.validateKey(input.apiKey)):undefined;
    if(base.mode==='native'&&ciphertext)throw new Error('原生连接不保存 API Key');
    const value:StoredConnection={...base,id:randomUUID(),revision:1,hasCredential:!!ciphertext,credentialCiphertext:ciphertext,createdAt:timestamp,updatedAt:timestamp,verifications:[]};this.store.put('connections',value.id,value);return publicProfile(value);}
  async update(id:string,input:ConnectionInput):Promise<ConnectionProfile>{this.assertIdentityAvailable(id);if(this.verifying.has(id))throw new Error('此连接正在验证，请完成后修改');const old=this.record(id);const base=normalizeConnection(input);if(old.runtime!==base.runtime)throw new Error('不能更改已有连接的执行工具，请新增连接');
    const ciphertext=base.mode==='native'||input.clearCredential?undefined:input.apiKey?await this.secrets.protect(this.validateKey(input.apiKey)):old.credentialCiphertext;
    this.assertIdentityAvailable(id);if(this.record(id).revision!==old.revision)throw new Error('连接已被其他操作修改，请刷新后重试');const record:StoredConnection={...base,id,revision:old.revision+1,hasCredential:!!ciphertext,credentialCiphertext:ciphertext,createdAt:old.createdAt,updatedAt:now(),verifications:old.verifications};this.store.put('connections',id,record);return publicProfile(record);}
  async remove(id:string):Promise<void>{this.assertIdentityAvailable(id);if(this.verifying.has(id))throw new Error('此连接正在验证');this.store.remove('connections',id);}
  scrub(text:string):string{for(const secret of this.knownSecrets)text=text.replaceAll(secret,'[REDACTED]');return safeText(text);}
  private validateKey(value:string):string{if(!value.trim()||value.length>32_768||/[\r\n\0]/.test(value))throw new Error('API Key 格式无效');this.knownSecrets.add(value.trim());return value.trim();}
  async resolveRuntime(id:string,input:{cwd:string;model?:string;probeImages?:boolean}):Promise<RuntimeOverrides>{this.assertIdentityAvailable(id);const config=await this.runtimeOverrides(id,input);this.assertIdentityAvailable(id);if(this.get(id).revision!==config.revision)throw new Error('连接配置已变化，请重新核对');return config;}
  private async runtimeOverrides(id:string,{cwd,model,probeImages=false}:{cwd:string;model?:string;probeImages?:boolean}):Promise<RuntimeOverrides>{const record=this.record(id);if(record.runtime==='workbuddy'&&record.protocol==='openai-chat'&&model&&model!==record.defaultModel&&model!==`custom-local:${record.defaultModel}`)throw new Error('此 WorkBuddy 自定义模型连接仅绑定已配置模型，请为其他模型创建连接');const key=record.credentialCiphertext?await this.secrets.unprotect(record.credentialCiphertext):undefined;if(key)this.knownSecrets.add(key);return profileOverrides(this.options.dataDir,publicProfile(record),key,cwd,probeImages);}
  private status(id:string,status:ConnectionStatus,revision?:number):ConnectionProfile{const record=this.record(id);if(revision!==undefined&&record.revision!==revision)return publicProfile(record);record.status=status;this.store.put('connections',id,record);return publicProfile(record);}
  private authenticationStatus(id:string,status:ConnectionStatus,revision:number):ConnectionProfile{const record=this.record(id);if(record.revision!==revision)return publicProfile(record);record.authenticationStatus=status;this.store.put('connections',id,record);return publicProfile(record);}
  /** Read native account evidence only. No model request or login action is sent. */
  refreshAuthentication(id:string,cwd:string):Promise<ConnectionProfile>{
    if(this.closing)return Promise.reject(new Error('服务正在关闭'));
    const existing=this.authenticationReads.get(id);if(existing)return existing;
    this.assertIdentityAvailable(id);const profile=this.get(id);if(profile.mode!=='native')return Promise.resolve(profile);
    const work=this.withConnectionUse(id,async()=>{
      try{
        const sessions=this.options.adapters[profile.runtime]?.authentication?.list().filter(row=>row.connectionId===id&&row.connectionRevision===profile.revision);
        const authenticated=sessions?.find(row=>row.state==='authenticated');
        if(authenticated)return this.authenticationStatus(id,{state:'authentication-observed',checkedAt:now(),credentialSource:'native-memory-session',provider:authenticated.edition==='international'?'WorkBuddy 国际站':'WorkBuddy 中国站',detail:'本服务持有的原生进程已完成授权；只属于该成员和固定工作区。新进程或服务重启仍需授权，模型调用证据单独核对。'},profile.revision);
        if(sessions?.some(row=>['starting','waiting','stopping'].includes(row.state)))return this.authenticationStatus(id,{state:'unconfigured',checkedAt:now(),credentialSource:'native-memory-pending',detail:'当前原生进程正在准备、等待授权或停止，请查看工作台授权面板；未发起额外认证探测。'},profile.revision);
        const config=await this.resolveRuntime(id,{cwd});const status=await (this.options.nativeAuthentication??readNativeAuthentication)(profile,cwd,config);return this.authenticationStatus(id,status,profile.revision);
      }
      catch(error){
        if(error instanceof NativeIdentityError&&!error.stopConfirmed){this.retainNativeStop(profile,error.retryStop??(async()=>{throw new Error('原生认证检测进程停止仍未确认');}),'原生认证检测进程停止未确认');return this.get(id);}
        return this.authenticationStatus(id,classifyConnectionError(new Error(this.scrub(error instanceof Error?error.message:String(error)))),profile.revision);
      }
    });
    this.authenticationReads.set(id,work);void work.finally(()=>this.authenticationReads.delete(id)).catch(()=>{});return work;
  }
  async check(id:string,cwd:string):Promise<ConnectionProfile>{this.assertIdentityAvailable(id);return this.withConnectionUse(id,()=>this.checkConnection(id,cwd));}
  private async checkConnection(id:string,cwd:string):Promise<ConnectionProfile>{const profile=this.get(id);try{const installed=profile.executable?await discoverRuntime(profile.runtime,profile.executable):await this.options.adapters[profile.runtime].discover();if(!installed.available)return this.status(id,{state:'not-installed',checkedAt:now(),detail:installed.detail},profile.revision);
    const config=await this.resolveRuntime(id,{cwd});const status=profile.mode==='native'?await (this.options.nativeAuthentication??readNativeAuthentication)(profile,cwd,config):{state:'authentication-observed' as const,checkedAt:now(),detail:'已配置受保护的 API Key；尚未确认服务接受此 Key 或模型可用。',credentialSource:'workbench-dpapi',provider:profile.provider};if(profile.mode==='native')this.authenticationStatus(id,status,profile.revision);return this.status(id,status,profile.revision);
  }catch(error){if(error instanceof NativeIdentityError&&!error.stopConfirmed){this.retainNativeStop(profile,error.retryStop??(async()=>{throw new Error('原生认证检测进程停止仍未确认');}),'原生认证检测进程停止未确认');return this.get(id);}return this.status(id,classifyConnectionError(new Error(this.scrub(error instanceof Error?error.message:String(error)))),profile.revision);}}
  models(id:string,cwd:string):Promise<RuntimeModelCatalog>{return this.withConnectionUse(id,()=>this.readModels(id,cwd));}
  private async readModels(id:string,cwd:string):Promise<RuntimeModelCatalog>{const profile=this.get(id);try{const overrides=await this.resolveRuntime(id,{cwd});const adapter=this.options.adapters[profile.runtime];if(!adapter.listModels)throw new Error('此执行工具未提供模型目录，可手动输入模型 ID');const raw=await adapter.listModels(cwd,overrides);
    // Never persist a vendor payload: a native metadata reply may contain account fields.
    const clean=(value:unknown)=>this.scrub(typeof value==='string'?value:'');
    const catalog:RuntimeModelCatalog={runtime:profile.runtime,models:Array.isArray(raw.models)?raw.models.filter(row=>typeof row?.id==='string'&&row.id.trim()).map(row=>({id:clean(row.id),name:clean(row.name)||clean(row.id),...(typeof row.description==='string'?{description:clean(row.description)}:{}),...(typeof row.isDefault==='boolean'?{isDefault:row.isDefault}:{})})):[],source:clean(raw.source),status:raw.status==='ready'?'ready':'unavailable',checkedAt:clean(raw.checkedAt),detail:clean(raw.detail)};
    const record=this.record(id);if(record.revision===profile.revision){record.catalog=catalog;this.store.put('connections',id,record);}return catalog;}catch(error){throw new Error(this.scrub(error instanceof Error?error.message:'模型目录读取失败'));}}
  assertVerified(id:string,model:string,requirements:VerifiedCapability[]=['inference']):ConnectionVerification {this.assertIdentityAvailable(id);const profile=this.get(id);const selected=model||profile.defaultModel;const latest=profile.verifications.find(row=>row.revision===profile.revision&&row.requestedModel===selected);if(!latest?.success||requirements.some(capability=>!latest.capabilities.includes(capability)))throw new Error(`连接「${profile.name}」的当前配置／模型尚未通过所需真实验证，请在接入中心验证后确认计划`);return latest;}
  async assertReady(id:string,model:string,cwd:string,requirements:VerifiedCapability[]=['inference']):Promise<ConnectionVerification>{
    const profile=this.get(id),verified=this.assertVerified(id,model,requirements);
    const overrides=await this.resolveRuntime(id,{cwd,model});
    const perProcessAuthorization=profile.runtime==='workbuddy'&&profile.mode==='native'&&overrides.nativeMemoryAuthentication===true;
    if(profile.mode==='native'&&!perProcessAuthorization&&['unconfigured','authentication-failed'].includes(profile.authenticationStatus?.state??''))throw new Error(`连接「${profile.name}」当前未检测到有效原生认证，请重新检测或登录并验证调用`);
    const fingerprint=await connectionContextFingerprint(profile,cwd);
    if(!verified.contextFingerprint||verified.contextFingerprint!==fingerprint)throw new Error(`连接「${profile.name}」的项目或原生路由配置已变化，请在当前项目重新验证，工作台不会改用其他计费来源`);
    this.assertIdentityAvailable(id);if(this.get(id).revision!==profile.revision)throw new Error('连接配置已变化，请重新核对');
    return verified;
  }
  verify(id:string,input:{cwd:string;model?:string;capabilities?:VerifiedCapability[]}):Promise<ConnectionVerification>{return this.withConnectionUse(id,()=>this.verifyConnection(id,input));}
  private async verifyConnection(id:string,{cwd,model,capabilities=['inference','streaming','tools']}:{cwd:string;model?:string;capabilities?:VerifiedCapability[]}):Promise<ConnectionVerification>{if(this.closing)throw new Error('服务正在关闭');if(this.verifying.has(id))throw new Error('此连接已在验证中，请等待回执');const profile=this.get(id);if(!Array.isArray(capabilities)||capabilities.some(value=>!['inference','streaming','tools','images','usage'].includes(value)))throw new Error('验证能力列表无效');this.verifying.add(id);let release!:()=>void;this.verificationWaits.set(id,new Promise<void>(resolve=>{release=resolve;}));const selected=model??profile.defaultModel;const verificationId=randomUUID();let connection:RuntimeConnection|undefined;let stopped=true;const usage:RuntimeTokenUsage[]=[];const verified=new Set<VerifiedCapability>();let observedModel:string|undefined,observedProvider:string|undefined;let output='';let failure:unknown;
    const result:ConnectionVerification={id:verificationId,connectionId:id,revision:profile.revision,requestedModel:selected,checkedAt:now(),success:false,status:{state:'unknown',checkedAt:now(),detail:'验证尚未完成'},capabilities:[],usage,detail:''};
    try {const overrides=await this.resolveRuntime(id,{cwd,model:selected,probeImages:capabilities.includes('images')});const fingerprint=await connectionContextFingerprint(profile,cwd);const directory=join(this.options.dataDir,'probes',verificationId);await mkdir(directory,{recursive:true});const script=join(directory,'probe.mjs'),marker=join(directory,'tool-result.json'),nonce=randomUUID();await writeFile(script,probeServer,'utf8');const imageProbe=capabilities.includes('images')?await createImageProbe(directory):undefined;
      let complete!:(event:RuntimeEvent)=>void;let reject!:(error:unknown)=>void;const terminal=new Promise<RuntimeEvent>((yes,no)=>{complete=yes;reject=no;});void terminal.catch(()=>{});
      this.verificationAborts.set(id,()=>reject(new Error('服务关闭，已取消本次验证')));
      const emit=(event:RuntimeEvent)=>{if(event.type==='ready'){if(typeof event.data?.model==='string')observedModel=event.data.model;if(typeof event.data?.provider==='string')observedProvider=event.data.provider;}if(event.type==='delta'&&event.text){verified.add('streaming');output+=event.text;}if(event.type==='message'&&event.text)output=event.text;
        if(event.type==='usage'&&event.data){const value=event.data as unknown as RuntimeTokenUsage;if(value.source&&value.scope)usage.push(structuredClone(value));}
        if(event.type==='approval'&&event.approvalId){const json=JSON.stringify(event.data??{});void connection?.respondApproval(event.approvalId,json.includes('connection_probe')||json.includes('workbench_probe')).catch(reject);}
        if(event.type==='error')reject(new Error(event.text??'原生调用失败'));if(event.type==='result')complete(event);};
      connection=await this.options.adapters[profile.runtime].connect({agentId:`verify-${verificationId}`,cwd,model:selected||undefined,permissionMode:'read-only',instructions:'只执行连接验证。仅允许调用 workbench_probe 的 connection_probe，不读取项目、不执行命令、不修改文件。',verificationTools:capabilities.includes('tools')?['mcp__workbench_probe__connection_probe']:[],connection:overrides,mcpServers:capabilities.includes('tools')?{workbench_probe:{command:process.execPath,args:[script,marker,nonce]}}:{}},emit);if(this.closing)throw new Error('服务关闭，未发送验证请求');stopped=false;
      const prompt=(capabilities.includes('tools')?'请调用 workbench_probe 的 connection_probe 工具读取验证代码，然后用中文回复「连接验证成功」及工具返回的代码。不要调用其他工具。':'请只用中文回复「连接验证成功」，不要调用工具。')+(imageProbe?' 还请直接观察附带图片的主要颜色，另起一行严格回复 WORKBENCH_IMAGE_COLOR: red 或 green 或 blue，只选择你实际看到的一个颜色。不得通过读取文件或其他工具推断图片。':'');
      await connection.send(prompt,verificationId,imageProbe?[imageProbe.image]:[]);
      const terminalEvent=await timeout(terminal,this.options.verificationTimeoutMs??120_000,'连接真实调用验证');stopped=true;
      if(terminalEvent.data?.isError||terminalEvent.data?.interrupted)throw new Error(terminalEvent.text??'验证执行未成功完成');verified.add('inference');if(usage.length)verified.add('usage');
      if(imageProbe&&imageProbePassed(`${output}\n${terminalEvent.text??''}`,imageProbe.expected))verified.add('images');
      try{const tool=JSON.parse(await readFile(marker,'utf8'));if(tool.nonce===nonce)verified.add('tools');}catch{}
      if(await connectionContextFingerprint(profile,cwd)!==fingerprint)throw new Error('验证期间项目或原生路由配置发生变化，请重新验证');
      result.contextFingerprint=fingerprint;
      const missing=capabilities.filter(value=>!verified.has(value));result.success=missing.length===0;result.status={state:result.success?'verified':'unknown',checkedAt:now(),detail:missing.length?`真实请求完成，但未观察到：${missing.join('、')}；这些能力仍未验证。`:'当前配置和模型已通过本次真实调用验证。',provider:observedProvider??profile.provider};result.detail=result.status.detail;
    }catch(error){failure=error;result.status=classifyConnectionError(new Error(this.scrub(error instanceof Error?error.message:String(error))));result.detail=result.status.detail;}
    finally{if(connection){result.nativeSessionId=connection.nativeSessionId;try{if(!stopped)await connection.interrupt();}catch{}try{await connection.close();}catch{result.success=false;result.status={state:'unknown',checkedAt:now(),detail:`${failure?`${result.detail}；`:''}无法确认原生验证会话退出，请检查后台进程。${profile.mode==='native'?'共享原生连接继续暂停，可重试停止。':''}`};result.detail=result.status.detail;this.retainVerificationProcess(profile,connection);}}this.verifying.delete(id);}
    try{result.capabilities=[...verified];result.observedModel=observedModel;result.observedProvider=observedProvider;result.checkedAt=now();const record=this.record(id);record.verifications=[result,...record.verifications].slice(0,100);if(record.revision===profile.revision)record.status=result.status;this.store.put('connections',id,record);return structuredClone(result);}finally{this.verificationAborts.delete(id);this.verificationWaits.delete(id);release();}
  }
  async startLogin(id:string,{cwd,method,...preparation}:{cwd:string;method?:LoginAttempt['method']}&IdentityPreparation):Promise<LoginAttempt>{
    if(this.closing)throw new Error('服务正在关闭');
    const snapshot=this.get(id);
    if(snapshot.mode!=='native')throw new Error('只有原生连接使用本机账号登录');
    if(snapshot.runtime==='workbuddy'){
      this.assertIdentityAvailable(id);
      // Check admission before even a metadata subprocess can compete with an
      // active or unreconciled member. beginIdentity checks again after awaits.
      preparation.assertIdle?.();
      const key=JSON.stringify([id,snapshot.revision,cwd]);
      let pending=this.loginPreflights.get(key);
      if(!pending){
        pending=this.withConnectionUse(id,async()=>{
          try{return await this.login.preflight(snapshot,cwd,await this.resolveRuntime(id,{cwd}));}
          catch(error){
            if(error instanceof NativeIdentityError&&!error.stopConfirmed)this.retainNativeStop(snapshot,error.retryStop??(async()=>{throw new Error('原生登录预检进程停止仍未确认');}),'原生登录预检进程停止未确认');
            throw error;
          }
        });
        this.loginPreflights.set(key,pending);
        void pending.finally(()=>{if(this.loginPreflights.get(key)===pending)this.loginPreflights.delete(key);}).catch(()=>{});
      }
      let result:{alreadyAuthenticated?:boolean;detail?:string;authenticationStatus?:ConnectionStatus};
      try{result=await pending;}catch(error){
        if(!(error instanceof NativeIdentityError&&!error.stopConfirmed)&&this.get(id).revision!==snapshot.revision)throw new Error('连接配置在登录预检期间已变化，请刷新后重新核对');
        throw error;
      }
      if(this.closing)throw new Error('服务正在关闭');
      if(this.get(id).revision!==snapshot.revision)throw new Error('连接配置在登录预检期间已变化，请刷新后重新核对');
      this.assertIdentityAvailable(id);
      if(result.alreadyAuthenticated){
        if(result.authenticationStatus)this.authenticationStatus(id,result.authenticationStatus,snapshot.revision);
        const timestamp=now(),attempt:LoginAttempt={id:randomUUID(),connectionId:id,runtime:snapshot.runtime,state:'completed',startedAt:timestamp,updatedAt:timestamp,method:'browser',detail:result.detail??'已观察到当前 CLI 原生凭据，未发起新登录；实际调用仍需单独验证。'};
        this.saveLoginHistory(attempt,this.nativeScope(snapshot));return attempt;
      }
    }
    const {profile,operation}=this.beginIdentity(id,'login',preparation,method);this.runtimeLoginIds.set(this.nativeScope(profile),id);
    operation.startup=(async()=>{try{
      await preparation.prepare?.();
      if(operation.cancelRequested){operation.attempt={...operation.attempt,state:'cancelled',updatedAt:now(),detail:'登录尚未启动，已取消；请重新检测并验证原生认证。'};this.finishIdentity(profile.runtime,operation,operation.attempt.detail);return operation.attempt;}
      const config=await this.runtimeOverrides(id,{cwd});return await this.login.start(this.get(id),cwd,config,method);
    }catch(error){if(error instanceof NativeIdentityError&&!error.stopConfirmed)this.holdUnknown(operation,'登录准备失败，原生进程停止未确认；共享原生连接继续暂停，请重试停止。',error.retryStop);else this.finishIdentity(profile.runtime,operation,'原生登录启动失败，旧验证已失效；请重新检测并验证。');throw error;}})();
    return await operation.startup as LoginAttempt;
  }
  async logout(id:string,cwd:string,preparation:IdentityPreparation={}):Promise<ConnectionProfile>{
    const {profile,operation}=this.beginIdentity(id,'logout',preparation);
    operation.startup=(async()=>{let status:ConnectionStatus;
      try{await preparation.prepare?.();status=await (this.options.nativeLogout??logoutNative)(this.get(id),cwd,await this.runtimeOverrides(id,{cwd}));}
      catch(error){if(error instanceof NativeIdentityError&&error.stopConfirmed)this.finishIdentity(profile.runtime,operation,'原生退出失败，但已确认进程停止；旧验证已失效，请重新检测认证。');else this.holdUnknown(operation,'原生退出流程未确认停止；共享原生连接继续暂停，请重试停止或在服务重启后人工核对。',error instanceof NativeIdentityError?error.retryStop:undefined);throw error;}
      this.finishIdentity(profile.runtime,operation,'原生退出流程已结束，旧验证已失效；请重新检测认证。');
      for(const row of this.list().filter(row=>this.affectedNative(row,profile.runtime,operation.identityScope)))this.status(row.id,status);return this.get(id);
    })();return await operation.startup as ConnectionProfile;
  }
  async cancelLogin(id:string):Promise<LoginAttempt|undefined>{
    const profile=this.get(id),operation=profile.mode==='native'?this.identityOperations.get(profile.runtime):undefined;
    if(profile.mode!=='native')return;
    if(operation&&operation.connectionId!==profile.id&&!this.visibleNativeAttempt(profile,operation.attempt,operation.identityScope))throw new Error('原生账号操作属于另一个 WorkBuddy 版本，请在对应连接中停止或核对；不会中断其他版本的登录');
    if(operation?.recovered)return {...operation.attempt};
    if(operation?.retryStop){
      if(operation.stopWait)return operation.stopWait;
      const stop=operation.retryStop;operation.attempt={...operation.attempt,state:'stopping',updatedAt:now(),detail:'正在重试停止原生流程；确认退出前共享连接继续暂停。'};this.persistIdentity(operation);
      operation.stopWait=(async()=>{
        try{await stop();operation.attempt={...operation.attempt,state:'cancelled',updatedAt:now(),detail:'已确认原生流程停止；这不代表登录、退出或模型验证成功，请重新检测并验证。'};this.saveLoginHistory(operation.attempt,operation.identityScope);this.finishIdentity(profile.runtime,operation,operation.attempt.detail);}
        catch{this.holdUnknown(operation,'原生流程停止仍未确认；共享连接继续暂停，请检查进程后重试。',stop);}
        return {...operation.attempt};
      })();try{return await operation.stopWait;}finally{operation.stopWait=undefined;}
    }
    if(operation?.kind==='logout')throw new Error(operation.attempt.state==='unknown'?'原生退出停止仍未确认；请核对进程，服务重启后可登记人工核对。':'原生退出正在执行，请等待停止回执');
    if(operation){operation.cancelRequested=true;operation.attempt={...operation.attempt,state:'stopping',updatedAt:now(),detail:'正在停止原生登录；确认退出前共享连接继续暂停。'};this.persistIdentity(operation);await operation.startup;if(operation.attempt.state==='cancelled')return {...operation.attempt};}
    return this.login.cancel(operation?.connectionId??this.runtimeLoginIds.get(this.nativeScope(profile))??id);
  }
  async reconcileLogin(id:string,input:{confirmedStopped?:unknown;reason?:unknown},preparation:IdentityPreparation={}):Promise<LoginAttempt>{
    if(this.closing)throw new Error('服务正在关闭');const profile=this.get(id),operation=profile.mode==='native'?this.identityOperations.get(profile.runtime):undefined;
    if(operation&&operation.connectionId!==profile.id&&!this.visibleNativeAttempt(profile,operation.attempt,operation.identityScope))throw new Error('原生账号操作属于另一个 WorkBuddy 版本，请在对应连接中登记人工核对');
    if(!operation?.recovered||!operation.attempt.recoveryRequired)throw new Error('只有服务重启后待人工核对的原生账号操作可以人工解除；当前登录请先取消并确认停止');
    if(operation.reconciling)throw new Error('人工核对正在处理，请等待回执');
    if(input.confirmedStopped!==true||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw new Error('请明确确认已在原生终端核对登录进程退出，并填写核对依据（最多 2000 字）');
    preparation.assertIdle?.();operation.reconciling=true;
    const previous={...operation.attempt};operation.attempt={...previous,state:'stopping',updatedAt:now(),detail:'正在登记人工停止核对，相关原生连接继续暂停。'};this.persistIdentity(operation);
    try{
      this.invalidateNative(profile.runtime,'人工核对原生账号操作；旧调用验证失效，需要重新检测并验证当前模型。',operation.identityScope);
      await preparation.prepare?.();
      const resolved:LoginAttempt={...previous,state:'resolved',updatedAt:now(),recoveryRequired:false,recoveryAction:undefined,detail:'已按人工核对解除登录暂停；这不是原生登录成功回执，请重新检测认证并验证当前模型。'};
      this.store.put('native_identity_audits',randomUUID(),{connectionId:id,runtime:profile.runtime,attemptId:previous.id,source:'human-stop-reconciliation',previousAttempt:previous,reason:this.scrub(input.reason.trim()),confirmedStopped:true,recordedAt:resolved.updatedAt});
      this.saveLoginHistory(resolved,operation.identityScope);operation.attempt=resolved;this.finishIdentity(profile.runtime,operation,resolved.detail);return {...resolved};
    }catch(error){operation.attempt={...previous,updatedAt:now(),detail:'人工核对未完成，相关原生连接继续暂停；请检查成员会话后重试。'};this.persistIdentity(operation);throw error;}
    finally{operation.reconciling=false;}
  }
  async loginStatus(id:string):Promise<LoginAttempt|undefined>{
    const profile=this.get(id);if(profile.mode!=='native')return;
    const active=this.identityOperations.get(profile.runtime),operation=active&&(active.connectionId===profile.id||this.visibleNativeAttempt(profile,active.attempt,active.identityScope))?active:undefined;
    const target=operation?.connectionId??this.runtimeLoginIds.get(this.nativeScope(profile))??id;
    const attempt=await this.login.status(target);
    if(operation&&this.identityOperations.get(profile.runtime)===operation)return {...operation.attempt};
    const stored=attempt?this.store.get<StoredLoginHistory>('native_login_history',attempt.id):undefined;
    if(attempt&&this.visibleNativeAttempt(profile,attempt,stored?.identityScope??operation?.identityScope))return attempt;
    const history=this.store.all<StoredLoginHistory>('native_login_history').filter(row=>this.visibleNativeAttempt(profile,row,row.identityScope)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if(history){const {identityScope:_,...safe}=history;return safe;}
  }
  async close():Promise<void>{this.closing=true;for(const operation of this.identityOperations.values())if(operation.kind==='login')operation.cancelRequested=true;for(const abort of this.verificationAborts.values())abort();await Promise.all([...this.verificationWaits.values()]);await Promise.allSettled([...this.authenticationReads.values(),...this.loginPreflights.values()]);await Promise.allSettled([...this.identityOperations.values()].map(operation=>operation.startup));for(const operation of this.identityOperations.values())if(operation.retryStop)await this.cancelLogin(operation.connectionId);await this.login.close();}
}
