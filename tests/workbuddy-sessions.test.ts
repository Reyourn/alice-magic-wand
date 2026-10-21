import {EventEmitter} from 'node:events';
import {describe,expect,it,vi} from 'vitest';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {RuntimeEvent,RuntimeOptions} from '../src/shared/types.js';
import {createWorkbuddyAdapter,workbuddyLaunch} from '../src/server/runtime/workbuddy.js';
import {createAdapters} from '../src/server/runtime/index.js';
import {WorkbuddySessionRegistry} from '../src/server/runtime/workbuddy-sessions.js';
import type {JsonProcess,Json} from '../src/server/runtime/process.js';

function gate<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class NativePeer extends EventEmitter {
  pid=55001;exited=false;methods=['workbuddy-desktop'];methodsAfterAuth?:string[];methodsField:'authMethods'|'methods'='authMethods';auth=gate<Json>();closeFailure=false;authenticated=false;credentialAfterAuth=true;
  constructor(){super();void this.auth.promise.catch(()=>{});}
  request=vi.fn(async(_id:string,frame:Json,_timeoutMs?:number)=>{
    switch(frame.request.subtype){
      case 'initialize':return {currentModelId:'controlled-model',account:{...(this.authenticated&&this.credentialAfterAuth?{token:'PRIVATE-NATIVE-TOKEN'}:{}),uid:'PRIVATE-UID'}};
      case 'get_auth_methods':return {[this.methodsField]:(this.authenticated?this.methodsAfterAuth??this.methods:this.methods).map(id=>({id}))};
      case 'authenticate':{const result=await this.auth.promise;this.authenticated=result.success===true;return result;}
      case 'get_available_models':return {rawModels:[]};
      case 'interrupt':this.result();return {};
      default:throw new Error('Unexpected control request');
    }
  });
  write=vi.fn(async(_frame:Json)=>{});
  close=vi.fn(async()=>{this.auth.reject(new Error('Owned process closing'));if(this.closeFailure)throw new Error('No process tree receipt');this.exited=true;this.emit('exit',{code:0,expected:true});});
  child(){return this as unknown as JsonProcess;}
  callback(subtype:string,values:Json={}){this.emit('frame',{type:'control_request',request_id:`callback-${subtype}`,request:{subtype,...values}});}
  result(text='controlled reply'){this.emit('frame',{type:'result',session_id:'native-session',result:text});}
}
function options(values:Partial<RuntimeOptions>={}):RuntimeOptions{return {agentId:'member-a',cwd:join(tmpdir(),'awb-memory-member-a'),model:'controlled-model',permissionMode:'workspace-write',instructions:'Only this task workspace',connection:{connectionId:'native-china',revision:7,env:{ACC_PRODUCT_CONFIG_V3:'public-vendor-product'},workbuddyEdition:'china',nativeMemoryAuthentication:true},...values};}
function setup(peers=[new NativePeer()],cooldown=0){const process=vi.fn((_command:string,_args:string[],_cwd:string,_env:NodeJS.ProcessEnv)=>{const peer=peers.shift();if(!peer)throw new Error('Unexpected native process');return peer.child();});const adapter=createWorkbuddyAdapter({executable:async()=>'controlled-codebuddy-script',process,interruptCooldownMs:cooldown});return {adapter,process};}
const requests=(peer:NativePeer)=>peer.request.mock.calls.map(([,frame])=>frame.request);

describe('owned WorkBuddy native memory authorization sessions',()=>{
  it('authorizes and executes in the same PID with safe public metadata and a scoped startup context',async()=>{
    const peer=new NativePeer(),f=setup([peer]),events:RuntimeEvent[]=[],o=options({mcpServers:{member:{command:'controlled-mcp',args:['--readonly'],env:{MCP_PRIVATE_KEY:'MCP-PRIVATE'}}}});
    const pending=f.adapter.connect(o,event=>events.push(event));await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));
    const session=f.adapter.authentication!.list()[0]!;expect(session).toMatchObject({pid:peer.pid,agentId:o.agentId,connectionRevision:7,state:'waiting'});
    peer.callback('auth_url_callback',{authState:{authUrl:'https://www.workbuddy.cn/native?state=PRIVATE-STATE'}});
    peer.callback('auth_result_callback',{success:true,userinfo:{token:'PRIVATE-RESULT'}});
    expect(f.adapter.authentication!.list()[0]).toMatchObject({state:'waiting',detail:expect.stringContaining('60 秒窗口')});expect(f.adapter.authentication!.list()[0]?.detail).toContain('不延长原生时限');expect(f.adapter.authentication!.url(session.id)).toContain('PRIVATE-STATE');
    expect(JSON.stringify([f.adapter.authentication!.list(),events])).not.toMatch(/PRIVATE-STATE|PRIVATE-NATIVE|PRIVATE-RESULT|PRIVATE-UID|MCP-PRIVATE/);
    peer.auth.resolve({success:true,userinfo:{token:'PRIVATE-FINAL'}});const connection=await pending;
    expect(connection.pid).toBe(peer.pid);expect(f.process).toHaveBeenCalledOnce();expect(peer.close).not.toHaveBeenCalled();expect(f.adapter.authentication!.url(session.id)).toBeUndefined();
    const launch=f.process.mock.calls[0]!;expect(launch[2]).toBe(o.cwd);expect(launch[1]).toContain(o.instructions);expect(launch[3]).toMatchObject({CODEBUDDY_CREDENTIALS_IN_MEMORY:'1',CODEBUDDY_INTERNET_ENVIRONMENT:'internal',ACC_PRODUCT_CONFIG_V3:'public-vendor-product'});
    expect(launch[1].join(' ')).not.toContain('MCP-PRIVATE');
    expect(peer.listenerCount('frame')).toBe(1);
    await connection.send('perform the controlled task','message-a');expect(peer.write.mock.calls.some(([frame])=>frame.type==='user'&&frame.uuid==='message-a')).toBe(true);
    peer.emit('frame',{type:'system',subtype:'init',session_id:'native-session',model:'controlled-model'});peer.result();await vi.waitFor(()=>expect(events.some(event=>event.type==='result')).toBe(true));
    await connection.close();expect(peer.close).toHaveBeenCalledOnce();expect(f.adapter.authentication!.list()[0]?.state).toBe('stopped');await f.adapter.authentication!.close();
  });
  it('uses only the selected international method and child environment',async()=>{
    const peer=new NativePeer();peer.methods=['workbuddy-desktop-ai'];peer.methodsField='methods';const f=setup([peer]),o=options({connection:{connectionId:'native-international',revision:2,env:{},workbuddyEdition:'international',nativeMemoryAuthentication:true}});
    const pending=f.adapter.connect(o,()=>{});await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));
    expect(requests(peer).find(row=>row.subtype==='authenticate')).toEqual({subtype:'authenticate'});expect(f.process.mock.calls[0]?.[3].CODEBUDDY_INTERNET_ENVIRONMENT).toBe('external');
    peer.auth.resolve({success:true});const connection=await pending;expect(requests(peer).filter(row=>row.subtype==='get_auth_methods')).toHaveLength(2);await connection.close();
  });
  it('still rejects an international provider change after implicit native selection without sending a task',async()=>{
    const peer=new NativePeer();peer.methods=['workbuddy-desktop-ai'];peer.methodsAfterAuth=['workbuddy-desktop'];const f=setup([peer]);
    const pending=f.adapter.connect(options({connection:{...options().connection!,workbuddyEdition:'international'}}),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',message:expect.stringContaining('核对授权后版本')});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.auth.resolve({success:true});await failed;
    expect(requests(peer).filter(row=>row.subtype==='authenticate')).toEqual([{subtype:'authenticate'}]);expect(requests(peer).filter(row=>row.subtype==='get_auth_methods')).toHaveLength(2);expect(peer.write.mock.calls.some(([frame])=>frame.type==='user')).toBe(false);expect(peer.close).toHaveBeenCalledOnce();expect(f.process).toHaveBeenCalledOnce();
  });
  it('rejects a native method mismatch without authenticating or sending a user prompt',async()=>{
    const peer=new NativePeer();peer.methods=['workbuddy-desktop-ai'];const f=setup([peer]);
    await expect(f.adapter.connect(options(),()=>{})).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',stopConfirmed:true});
    expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(false);expect(peer.write).not.toHaveBeenCalled();expect(peer.close).toHaveBeenCalledOnce();
    expect(f.adapter.authentication!.list()[0]).toMatchObject({state:'failed',detail:expect.stringContaining('核对所选版本')});
  });
  it('requires a same-process credential receipt after the final authentication response',async()=>{
    const peer=new NativePeer(),f=setup([peer]);peer.credentialAfterAuth=false;
    const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',stopConfirmed:true});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.auth.resolve({success:true,userinfo:{token:'PRIVATE-CALLBACK-ONLY'}});await failed;
    expect(peer.close).toHaveBeenCalledOnce();expect(peer.write.mock.calls.some(([frame])=>frame.type==='user')).toBe(false);expect(JSON.stringify(f.adapter.authentication!.list())).not.toContain('PRIVATE');
  });
  it('rejects an unexpected inherited credential before sending authenticate',async()=>{
    const peer=new NativePeer(),f=setup([peer]);peer.authenticated=true;
    await expect(f.adapter.connect(options(),()=>{})).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',stopConfirmed:true});
    expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(false);expect(peer.close).toHaveBeenCalledOnce();
  });
  it('cancels a pending authorization by stopping exactly its owned process and never sends the task',async()=>{
    const peer=new NativePeer(),f=setup([peer]);const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_CANCELLED',stopConfirmed:true});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));const id=f.adapter.authentication!.list()[0]!.id;
    await f.adapter.authentication!.cancel(id);await failed;expect(peer.close).toHaveBeenCalledOnce();expect(peer.write.mock.calls.some(([frame])=>frame.type==='user')).toBe(false);expect(f.adapter.authentication!.url(id)).toBeUndefined();
  });
  it('keeps an unconfirmed stop locked and retries the same owned process without another authorization',async()=>{
    const peer=new NativePeer(),f=setup([peer]);peer.closeFailure=true;
    const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_STOP_UNCONFIRMED',stopConfirmed:false});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));const id=f.adapter.authentication!.list()[0]!.id;
    await expect(f.adapter.authentication!.cancel(id)).rejects.toMatchObject({stopConfirmed:false});await failed;
    expect(f.adapter.authentication!.list()[0]?.state).toBe('unknown');await expect(f.adapter.connect(options({agentId:'second',cwd:join(tmpdir(),'different')}),()=>{})).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_BUSY'});expect(f.process).toHaveBeenCalledOnce();
    peer.closeFailure=false;await f.adapter.authentication!.cancel(id);expect(peer.close).toHaveBeenCalledTimes(2);expect(f.adapter.authentication!.list()[0]?.state).toBe('stopped');
  });
  it('does not treat a vanished root after failed stop as proof that its tools stopped',async()=>{
    const peer=new NativePeer(),f=setup([peer]);peer.closeFailure=true;const pending=f.adapter.connect(options(),()=>{});void pending.catch(()=>{});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));const id=f.adapter.authentication!.list()[0]!.id;
    await expect(f.adapter.authentication!.cancel(id)).rejects.toMatchObject({stopConfirmed:false});await expect(pending).rejects.toMatchObject({stopConfirmed:false});peer.exited=true;
    await expect(f.adapter.authentication!.cancel(id)).rejects.toMatchObject({stopConfirmed:false});expect(peer.close).toHaveBeenCalledOnce();expect(f.adapter.authentication!.list()[0]?.state).toBe('unknown');
  });
  it('closes a connect-pending process on adapter shutdown and refuses later work',async()=>{
    const peer=new NativePeer(),f=setup([peer]);const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_CANCELLED'});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));await f.adapter.authentication!.close();await failed;expect(peer.close).toHaveBeenCalledOnce();
    await expect(f.adapter.connect(options({agentId:'later'}),()=>{})).rejects.toThrow('正在关闭');expect(f.process).toHaveBeenCalledOnce();
  });
  it('never reuses an old authorized agent/cwd/config for a new context',async()=>{
    const first=new NativePeer(),second=new NativePeer();second.pid=55002;const f=setup([first,second]);
    const one=f.adapter.connect(options(),()=>{});await vi.waitFor(()=>expect(requests(first).some(row=>row.subtype==='authenticate')).toBe(true));first.auth.resolve({success:true});const connection=await one;
    await expect(f.adapter.connect(options({cwd:join(tmpdir(),'another-worktree')}),()=>{})).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_BUSY'});expect(f.process).toHaveBeenCalledOnce();
    await connection.close();const two=f.adapter.connect(options({cwd:join(tmpdir(),'another-worktree'),connection:{...options().connection!,revision:8}}),()=>{});
    await vi.waitFor(()=>expect(requests(second).some(row=>row.subtype==='authenticate')).toBe(true));expect(f.adapter.authentication!.list().at(-1)).toMatchObject({pid:55002,connectionRevision:8,state:'waiting'});second.auth.resolve({success:true});await (await two).close();
  });
  it('does not retransmit a timed-out authentication request or leak its native diagnostic',async()=>{
    const peer=new NativePeer(),f=setup([peer]);const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED'});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));expect(peer.request.mock.calls.find(([,frame])=>frame.request.subtype==='authenticate')?.[2]).toBe(300_000);peer.auth.reject(new Error('Timeout token=PRIVATE-TIMEOUT'));await failed;
    expect(requests(peer).filter(row=>row.subtype==='authenticate')).toHaveLength(1);expect(JSON.stringify(f.adapter.authentication!.list())).not.toContain('PRIVATE');expect(peer.close).toHaveBeenCalledOnce();expect(f.adapter.authentication!.list()[0]?.detail).toContain('等待原生授权');
  });
  it('reports only a fixed Chinese initialization stage and keeps vendor errors out of public failures',async()=>{
    const peer=new NativePeer(),f=setup([peer]);peer.request.mockRejectedValue(new Error('PRIVATE-RAW-RESPONSE account=PRIVATE-ACCOUNT https://private.example/auth'));
    const failure=await f.adapter.connect(options(),()=>{}).catch(error=>error);
    expect(failure).toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',stopConfirmed:true,message:expect.stringContaining('初始化原生协议')});
    expect(JSON.stringify([failure,f.adapter.authentication!.list()])).not.toMatch(/PRIVATE|private\.example/);expect(peer.close).toHaveBeenCalledOnce();
  });
  it.each([['invalid_method','原生登录方式不可用'],['timeout','原生授权等待超时'],['cancelled','原生授权被取消'],['auth_failed','原生授权未成功'],['PRIVATE-UNKNOWN',undefined]])('maps only the native callback error type %s to a fixed safe label',async(type,label)=>{
    const peer=new NativePeer(),f=setup([peer]);const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',stopConfirmed:true});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.callback('auth_result_callback',{success:false,error:{type,message:'PRIVATE-ERROR account=PRIVATE https://private.example/auth'},userinfo:{token:'PRIVATE'}});peer.auth.reject(new Error('PRIVATE-RAW'));await failed;
    const detail=f.adapter.authentication!.list()[0]?.detail;expect(detail).not.toMatch(/PRIVATE|private\.example/);if(label)expect(detail).toContain(label);expect(peer.close).toHaveBeenCalledOnce();
  });
  it('identifies the native hard control timeout without exposing its diagnostic or resending',async()=>{
    const peer=new NativePeer(),f=setup([peer]);const pending=f.adapter.connect(options(),()=>{}),failed=expect(pending).rejects.toMatchObject({code:'WORKBUDDY_AUTHENTICATION_FAILED',message:expect.stringContaining('原生授权等待超时')});
    await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.auth.reject(new Error('Request timeout'));await failed;expect(requests(peer).filter(row=>row.subtype==='authenticate')).toHaveLength(1);expect(peer.close).toHaveBeenCalledOnce();
  });
  it('keeps registries separate per factory and bounds terminal public history',async()=>{
    const left=createAdapters(),right=createAdapters();expect(left.workbuddy.authentication).not.toBe(right.workbuddy.authentication);
    const registry=new WorkbuddySessionRegistry({maxRetained:2});
    for(let i=0;i<4;i++){const peer=new NativePeer();peer.methods=[];await expect(registry.authorize(options({agentId:`member-${i}`}),()=>peer.child())).rejects.toMatchObject({stopConfirmed:true});}
    expect(registry.list()).toHaveLength(2);await registry.close();
  });
  it('keeps non-memory launch environments unchanged and rejects ambiguous memory authentication',()=>{
    const plain=options({connection:{connectionId:'native',revision:1,env:{}}});expect(workbuddyLaunch('controlled',plain).env.CODEBUDDY_CREDENTIALS_IN_MEMORY).toBeUndefined();
    const conflict=options({connection:{...options().connection!,env:{CODEBUDDY_AUTH_TOKEN:'PRIVATE'}}});expect(()=>workbuddyLaunch('controlled',conflict)).toThrow('其他原生认证');
  });
  it('limits verification to its declared MCP tool while retaining native plan permissions',async()=>{
    const peer=new NativePeer(),f=setup([peer]),o=options({permissionMode:'read-only',verificationTools:['mcp__workbench_probe__connection_probe']});
    const pending=f.adapter.connect(o,()=>{});await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.auth.resolve({success:true});const connection=await pending;
    const args=f.process.mock.calls[0]![1];expect(args[args.indexOf('--permission-mode')+1]).toBe('plan');expect(args).toContain('--strict-mcp-config');expect(args[args.indexOf('--tools')+1]).toBe('');
    peer.callback('can_use_tool',{tool_name:'Bash',input:{command:'must not run'}});await vi.waitFor(()=>expect(peer.write.mock.calls.some(([frame])=>frame.response?.request_id==='callback-can_use_tool'&&frame.response.response?.allowed===false)).toBe(true));
    await connection.close();
  });
  it('keeps sends blocked during post-interrupt cleanup and waits for real terminal/ack first',async()=>{
    const peer=new NativePeer(),f=setup([peer],40);const pending=f.adapter.connect(options(),()=>{});await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.auth.resolve({success:true});const connection=await pending;
    await connection.send('first','first');peer.emit('frame',{type:'system',subtype:'init',session_id:'native-session',model:'controlled-model'});
    const interrupted=connection.interrupt();await expect(connection.send('too early','early')).rejects.toThrow('当前轮次未结束');await interrupted;
    await connection.send('after cleanup','after');peer.result();await connection.close();
  });
  it('does not treat a terminal result as an interrupt acknowledgement when the control fails',async()=>{
    const peer=new NativePeer(),f=setup([peer],1);const original=peer.request.getMockImplementation()!;
    peer.request.mockImplementation(async(id,frame)=>{if(frame.request.subtype==='interrupt'){peer.result();throw new Error('No control receipt');}return original(id,frame);});
    const pending=f.adapter.connect(options(),()=>{});await vi.waitFor(()=>expect(requests(peer).some(row=>row.subtype==='authenticate')).toBe(true));peer.auth.resolve({success:true});const connection=await pending;
    await connection.send('first','first');peer.emit('frame',{type:'system',subtype:'init',session_id:'native-session',model:'controlled-model'});
    await expect(connection.interrupt()).rejects.toThrow('No control receipt');await expect(connection.send('unsafe retry','next')).rejects.toThrow('会话不可用');await connection.close();
  });
});
