import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, type ConnectionStore } from '../src/server/connections/manager.js';
import type { NativeLoginHandle } from '../src/server/connections/native.js';
import type { ConnectionProfile, ConnectionStatus, LoginAttempt, RuntimeAdapter, RuntimeKind } from '../src/shared/types.js';

vi.mock('../src/server/runtime/process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/runtime/process.js')>(),
  resolveWorkbuddyExecutable: vi.fn(async (_executable?: string, edition?: string) => `controlled-${edition ?? 'legacy'}-cli`),
}));
class MemoryStore implements ConnectionStore {
  rows=new Map<string,unknown>();
  get<T>(c:string,id:string){return structuredClone(this.rows.get(`${c}:${id}`)) as T|undefined;}
  all<T>(c:string){return [...this.rows].filter(([key])=>key.startsWith(`${c}:`)).map(([,value])=>structuredClone(value)) as T[];}
  put(c:string,id:string,value:unknown){this.rows.set(`${c}:${id}`,structuredClone(value));}
  remove(c:string,id:string){this.rows.delete(`${c}:${id}`);}
}
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const work of cleanup.splice(0).reverse())await work();});
async function setup(){
  const store=new MemoryStore(),handles=new Map<string,{handle:NativeLoginHandle;complete:()=>void;close:ReturnType<typeof vi.fn>}>();
  const connect=vi.fn(async()=>{throw new Error('Login isolation must never start inference');});
  const adapter=(kind:RuntimeKind):RuntimeAdapter=>({kind,discover:async()=>({kind,available:true,detail:'controlled',capabilities:{steer:false,interrupt:true,resume:true,approvals:true}}),connect});
  const options={dataDir:'.controlled-native-isolation',store,adapters:{codex:adapter('codex'),claude:adapter('claude'),workbuddy:adapter('workbuddy')},nativeLogin:{launch:async(profile:ConnectionProfile)=>{
    let done=false;const close=vi.fn(async()=>{}),handle:NativeLoginHandle={authUrl:`https://native.example.test/${profile.workbuddyEdition??'legacy'}`,poll:async()=>done?{state:'completed',detail:'Controlled native receipt'}:undefined,close};
    handles.set(profile.id,{handle,complete:()=>{done=true;},close});return handle;
  }},nativeLogout:async():Promise<ConnectionStatus>=>({state:'unconfigured',checkedAt:'current',detail:'Controlled logout receipt'})};
  const manager=new ConnectionManager(options);cleanup.push(()=>manager.close());
  const create=(name:string,workbuddyEdition?:'china'|'international')=>manager.create({name,runtime:'workbuddy',mode:'native',workbuddyEdition});
  const china=await create('China','china'),chinaSibling=await create('China sibling','china'),international=await create('International','international'),legacy=await create('Legacy'),legacySibling=await create('Other legacy');
  const complete=async(p:ConnectionProfile)=>{handles.get(p.id)!.complete();return manager.loginStatus(p.id);};
  return {manager,store,options,handles,connect,china,chinaSibling,international,legacy,legacySibling,complete};
}
function verified(store:MemoryStore,p:ConnectionProfile){
  const status:ConnectionStatus={state:'verified',checkedAt:'old',detail:'Earlier real call proof'};
  store.put('connections',p.id,{...p,status,authenticationStatus:{...status,state:'authentication-observed'},catalog:{runtime:'workbuddy',models:[{id:'fixed'}],source:'controlled',status:'ready',checkedAt:'old',detail:'Controlled catalog'},verifications:[{id:`proof-${p.id}`,connectionId:p.id,revision:p.revision,requestedModel:'',checkedAt:'old',success:true,status,capabilities:['inference'],usage:[],detail:'Earlier real call proof'}]});
}

describe('WorkBuddy editions keep independent native authorization and proof scope',()=>{
  it('lists only the selected desktop authentication scope and legacy ambiguity as affected members',async()=>{
    const f=await setup();
    const affected=f.manager.affectedNativeConnections(f.china.id).map(p=>p.id);
    expect(affected).toContain(f.china.id);expect(affected).toContain(f.chinaSibling.id);
    expect(affected).toContain(f.legacy.id);expect(affected).not.toContain(f.international.id);
    const all=f.manager.affectedNativeConnections(f.legacy.id).map(p=>p.id);
    expect(all).toContain(f.china.id);expect(all).toContain(f.international.id);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('shares a live link only with the same edition and keeps the conservative runtime lock',async()=>{
    const f=await setup();await f.manager.startLogin(f.china.id,{cwd:'.'});
    expect((await f.manager.loginStatus(f.china.id))?.authUrl).toContain('/china');
    expect((await f.manager.loginStatus(f.chinaSibling.id))?.authUrl).toContain('/china');
    expect(await f.manager.loginStatus(f.international.id)).toBeUndefined();
    expect(await f.manager.loginStatus(f.legacy.id)).toBeUndefined();
    await expect(f.manager.startLogin(f.international.id,{cwd:'.'})).rejects.toThrow('共享原生账号');
    await expect(f.manager.cancelLogin(f.international.id)).rejects.toThrow('另一个 WorkBuddy 版本');
    expect(f.handles.get(f.china.id)!.close).not.toHaveBeenCalled();
    await f.manager.cancelLogin(f.chinaSibling.id);expect(f.handles.get(f.china.id)!.close).toHaveBeenCalledOnce();
  });
  it('retains each edition history while another edition is active and after a manager restart',async()=>{
    const f=await setup();await f.manager.startLogin(f.china.id,{cwd:'.'});const china=await f.complete(f.china);
    await f.manager.startLogin(f.international.id,{cwd:'.'});
    expect((await f.manager.loginStatus(f.china.id))?.id).toBe(china?.id);
    expect((await f.manager.loginStatus(f.chinaSibling.id))?.state).toBe('completed');
    expect((await f.manager.loginStatus(f.international.id))?.authUrl).toContain('/international');
    expect(await f.manager.loginStatus(f.legacy.id)).toBeUndefined();
    const international=await f.complete(f.international),restarted=new ConnectionManager(f.options);cleanup.push(()=>restarted.close());
    expect((await restarted.loginStatus(f.china.id))?.id).toBe(china?.id);
    expect((await restarted.loginStatus(f.international.id))?.id).toBe(international?.id);
    expect(JSON.stringify(f.store.all('native_login_history'))).not.toContain('https://native.example.test');
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('invalidates the selected edition and legacy ambiguity while preserving the other edition proofs',async()=>{
    const f=await setup();for(const p of [f.china,f.chinaSibling,f.international,f.legacy])verified(f.store,p);
    const before=f.manager.get(f.international.id);await f.manager.startLogin(f.china.id,{cwd:'.'});
    for(const p of [f.china,f.chinaSibling,f.legacy])expect(f.manager.get(p.id)).toMatchObject({revision:2,status:{state:'unknown'}});
    expect(f.manager.get(f.china.id).catalog).toBeUndefined();expect(f.manager.get(f.international.id)).toEqual(before);
    await f.complete(f.china);expect(f.manager.get(f.international.id)).toEqual(before);
    expect(()=>f.manager.assertVerified(f.international.id,'')).not.toThrow();expect(()=>f.manager.assertVerified(f.chinaSibling.id,'')).toThrow('尚未通过');
  });
  it('treats a legacy login conservatively without lending its URL to other connections',async()=>{
    const f=await setup();for(const p of [f.china,f.international,f.legacy,f.legacySibling])verified(f.store,p);
    await f.manager.startLogin(f.legacy.id,{cwd:'.'});
    for(const p of [f.china,f.international,f.legacy,f.legacySibling])expect(f.manager.get(p.id).revision).toBe(2);
    expect((await f.manager.loginStatus(f.legacy.id))?.authUrl).toContain('/legacy');
    for(const p of [f.china,f.international,f.legacySibling])expect(await f.manager.loginStatus(p.id)).toBeUndefined();
    await expect(f.manager.cancelLogin(f.legacySibling.id)).rejects.toThrow('另一个 WorkBuddy 版本');
    await f.manager.cancelLogin(f.legacy.id);
  });
  it('uses the saved historical edition rather than relabeling history after a connection is reconfigured',async()=>{
    const f=await setup();await f.manager.startLogin(f.china.id,{cwd:'.'});const old=await f.complete(f.china);
    await f.manager.update(f.china.id,{name:'Changed to international',runtime:'workbuddy',mode:'native',workbuddyEdition:'international'});
    expect(await f.manager.loginStatus(f.china.id)).toBeUndefined();
    expect((await f.manager.loginStatus(f.chinaSibling.id))?.id).toBe(old?.id);
    expect(await f.manager.loginStatus(f.international.id)).toBeUndefined();
  });
  it('does not overwrite the other edition status or proof on native logout',async()=>{
    const f=await setup();for(const p of [f.china,f.chinaSibling,f.international,f.legacy])verified(f.store,p);
    const before=f.manager.get(f.international.id);await f.manager.logout(f.china.id,'.');
    for(const p of [f.china,f.chinaSibling,f.legacy])expect(f.manager.get(p.id).status?.state).toBe('unconfigured');
    expect(f.manager.get(f.international.id)).toEqual(before);
  });
  it('preserves a recovered operation scope and prevents reconciliation through the other edition',async()=>{
    const f=await setup();await f.manager.startLogin(f.china.id,{cwd:'.'});
    const restarted=new ConnectionManager(f.options);cleanup.push(()=>restarted.close());
    expect((await restarted.loginStatus(f.chinaSibling.id))?.state).toBe('unknown');expect(await restarted.loginStatus(f.international.id)).toBeUndefined();
    await expect(restarted.reconcileLogin(f.international.id,{confirmedStopped:true,reason:'wrong edition'})).rejects.toThrow('另一个 WorkBuddy 版本');
    await restarted.reconcileLogin(f.china.id,{confirmedStopped:true,reason:'Controlled test confirms former process stopped'});
    expect((await restarted.loginStatus(f.chinaSibling.id))?.state).toBe('resolved');expect(await restarted.loginStatus(f.international.id)).toBeUndefined();
    await f.manager.cancelLogin(f.china.id);
  });
  it('never infers an old unscoped history edition from a current connection setting',async()=>{
    const f=await setup();const old:LoginAttempt={id:'legacy-history',connectionId:f.china.id,runtime:'workbuddy',state:'completed',startedAt:'old',updatedAt:'old',method:'browser',detail:'Historical operation without edition evidence'};
    f.store.put('native_login_history',old.id,old);
    expect(await f.manager.loginStatus(f.china.id)).toBeUndefined();expect(await f.manager.loginStatus(f.international.id)).toBeUndefined();
    f.store.put('native_login_history','legacy-own',{...old,id:'legacy-own',connectionId:f.legacy.id});
    expect((await f.manager.loginStatus(f.legacy.id))?.id).toBe('legacy-own');expect(await f.manager.loginStatus(f.legacySibling.id)).toBeUndefined();
  });
});
