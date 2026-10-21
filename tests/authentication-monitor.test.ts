import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionManager,type ConnectionStore} from '../src/server/connections/manager.js';
import {NativeIdentityError} from '../src/server/connections/native.js';
import type {ConnectionProfile,ConnectionStatus,RuntimeAdapter,RuntimeKind} from '../src/shared/types.js';

class MemoryStore implements ConnectionStore {
  rows=new Map<string,unknown>();
  get<T>(c:string,id:string){return structuredClone(this.rows.get(`${c}:${id}`)) as T|undefined;}
  all<T>(c:string){return [...this.rows].filter(([key])=>key.startsWith(`${c}:`)).map(([,value])=>structuredClone(value)) as T[];}
  put(c:string,id:string,value:unknown){this.rows.set(`${c}:${id}`,structuredClone(value));}
  remove(c:string,id:string){this.rows.delete(`${c}:${id}`);}
}
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const work of cleanup.splice(0).reverse())await work();});
async function setup(read:()=>Promise<ConnectionStatus>){
  const directory=await mkdtemp(join(tmpdir(),'awb-auth-monitor-')),store=new MemoryStore();
  const connect=vi.fn(async()=>{throw new Error('Authentication polling must never start inference');});
  const adapter=(kind:RuntimeKind):RuntimeAdapter=>({kind,discover:async()=>({kind,available:true,detail:'controlled',capabilities:{steer:false,interrupt:true,resume:true,approvals:true}}),connect});
  const manager=new ConnectionManager({dataDir:directory,store,adapters:{codex:adapter('codex'),claude:adapter('claude'),workbuddy:adapter('workbuddy')},nativeAuthentication:read});
  cleanup.push(async()=>{await manager.close();await rm(directory,{recursive:true,force:true});});
  const profile=manager.ensureNative('codex');return {manager,profile,store,directory,connect};
}
const observed=():ConnectionStatus=>({state:'authentication-observed',checkedAt:new Date().toISOString(),detail:'Native account exists; inference not attempted'});

describe('read-only automatic authentication evidence',()=>{
  it('preserves call verification and records independent login evidence without inference',async()=>{
    const f=await setup(async()=>observed());
    const old={...f.profile,status:{state:'quota-exceeded',checkedAt:'old',detail:'Prior real quota response'},verifications:[{id:'historical-proof',success:true}]};
    f.store.put('connections',f.profile.id,old);
    const refreshed=await f.manager.refreshAuthentication(f.profile.id,f.directory);
    expect(refreshed.authenticationStatus?.state).toBe('authentication-observed');
    expect(refreshed.status).toEqual(old.status);expect(refreshed.verifications).toEqual(old.verifications);expect(f.connect).not.toHaveBeenCalled();
  });
  it('coalesces overlapping refreshes and leaves missing information unknown',async()=>{
    let release!:(value:ConnectionStatus)=>void;const read=vi.fn(()=>new Promise<ConnectionStatus>(resolve=>{release=resolve;}));
    const f=await setup(read);const first=f.manager.refreshAuthentication(f.profile.id,f.directory),second=f.manager.refreshAuthentication(f.profile.id,f.directory);
    await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());release({state:'unknown',checkedAt:'current',detail:'Native status not available'});
    expect((await first).authenticationStatus?.state).toBe('unknown');expect(await second).toEqual(await first);expect(f.connect).not.toHaveBeenCalled();
  });
  it('ignores an old read when the connection changes during the await',async()=>{
    let release!:(value:ConnectionStatus)=>void;const read=vi.fn(()=>new Promise<ConnectionStatus>(resolve=>{release=resolve;}));const f=await setup(read);
    const pending=f.manager.refreshAuthentication(f.profile.id,f.directory);await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    await f.manager.update(f.profile.id,{name:'new revision',runtime:'codex',mode:'native'});release(observed());
    const result=await pending;expect(result.revision).toBe(2);expect(result.authenticationStatus).toBeUndefined();
  });
  it('does not send API credentials or requests while monitoring an API connection',async()=>{
    const read=vi.fn(async()=>observed()),f=await setup(read);const api:ConnectionProfile={...f.profile,id:'api-profile',mode:'official-api',protocol:'responses',hasCredential:true};
    f.store.put('connections',api.id,api);expect(await f.manager.refreshAuthentication(api.id,f.directory)).toEqual(api);expect(read).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();
  });
  it('keeps the native identity gate when a status probe has an unconfirmed stop',async()=>{
    const stop=vi.fn(async()=>{}),f=await setup(async()=>{throw new NativeIdentityError('Stop receipt absent',false,stop);});
    await f.manager.refreshAuthentication(f.profile.id,f.directory);
    expect(()=>f.manager.assertIdentityAvailable(f.profile.id)).toThrow('暂停调用');
    expect(f.manager.list()[0]?.status?.state).toBe('unknown');expect(stop).not.toHaveBeenCalled();
    await f.manager.cancelLogin(f.profile.id);expect(stop).toHaveBeenCalledOnce();expect(()=>f.manager.assertIdentityAvailable(f.profile.id)).not.toThrow();
  });
  it('waits for an active read before closing and refuses new reads after close',async()=>{
    let release!:(value:ConnectionStatus)=>void;const read=vi.fn(()=>new Promise<ConnectionStatus>(resolve=>{release=resolve;})),f=await setup(read);
    const pending=f.manager.refreshAuthentication(f.profile.id,f.directory);await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());
    let closed=false;const closing=f.manager.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
    release(observed());await pending;await closing;expect(closed).toBe(true);await expect(f.manager.refreshAuthentication(f.profile.id,f.directory)).rejects.toThrow('关闭');
  });
});
