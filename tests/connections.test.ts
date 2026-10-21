import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { inflateSync } from 'node:zlib';
import { ConnectionManager, classifyConnectionError } from '../src/server/connections/manager.js';
import { profileOverrides, routingConflicts } from '../src/server/connections/configuration.js';
import { WindowsDpapiProtector } from '../src/server/connections/secrets.js';
import { WorkbuddyConnection, workbuddyLaunch } from '../src/server/runtime/workbuddy.js';
import { CodexConnection } from '../src/server/runtime/codex.js';
import { ClaudeConnection } from '../src/server/runtime/claude.js';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import type { JsonProcess } from '../src/server/runtime/process.js';
import type { ConnectionProfile } from '../src/shared/connections.js';
import type { RuntimeAdapter, RuntimeEvent, RuntimeOptions } from '../src/shared/types.js';

const directories:string[]=[];afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();});
class MemoryStore { rows=new Map<string,unknown>();get<T>(c:string,id:string):T|undefined{return structuredClone(this.rows.get(`${c}:${id}`)) as T|undefined;}all<T>(c:string):T[]{return [...this.rows].filter(([k])=>k.startsWith(`${c}:`)).map(([,v])=>structuredClone(v)) as T[];}put(c:string,id:string,v:unknown){this.rows.set(`${c}:${id}`,structuredClone(v));}remove(c:string,id:string){this.rows.delete(`${c}:${id}`);}}
async function setup(){const directory=await mkdtemp(join(tmpdir(),'awb-connections-'));directories.push(directory);const store=new MemoryStore();const keys=new Map<string,string>();let keyId=0;const launches:RuntimeOptions[]=[];
  const adapter:RuntimeAdapter={kind:'codex',discover:async()=>({kind:'codex',available:true,detail:'test',capabilities:{approvals:true,interrupt:true,resume:true,steer:false}}),listModels:async()=>({runtime:'codex',models:[{id:'model-a',name:'A'}],source:'test',status:'ready',checkedAt:new Date().toISOString(),detail:'metadata'}),connect:async(options,emit)=>{launches.push(options);return {nativeSessionId:'session',pid:undefined,send:async()=>{emit({type:'ready',data:{model:options.model,provider:'test-provider'}});emit({type:'delta',text:'连接'});const probe=options.mcpServers?.workbench_probe;if(probe)await writeFile(probe.args[1],JSON.stringify({nonce:probe.args[2]}));emit({type:'usage',data:{scope:'turn',source:'test.usage',inputTokens:10,outputTokens:2}});emit({type:'result',text:'成功'});},interrupt:async()=>{},respondApproval:async()=>{},close:async()=>{}};}};
  const manager=new ConnectionManager({dataDir:directory,store,adapters:{codex:adapter,claude:{...adapter,kind:'claude'},workbuddy:{...adapter,kind:'workbuddy'}},secrets:{protect:async(value)=>{const id=`encrypted-${++keyId}`;keys.set(id,value);return id;},unprotect:async(value)=>keys.get(value)!}});return {directory,store,manager,adapter,launches};}

describe('connection configuration and provenance',()=>{
  it('migrates native bindings without inventing authentication or verification',async()=>{const {manager}=await setup();const a=manager.ensureNative('codex');expect(manager.ensureNative('codex').id).toBe(a.id);expect(a.hasCredential).toBe(false);expect(a.status).toBeUndefined();expect(a.verifications).toEqual([]);expect(()=>manager.assertVerified(a.id,'')).toThrow('尚未通过');});
  it('never returns or persists a plaintext key and keeps revisions with historical evidence',async()=>{const {manager,store,directory}=await setup();const p=await manager.create({name:'API',runtime:'codex',mode:'official-api',defaultModel:'model-a',apiKey:'private-value-123'});expect(JSON.stringify(manager.list())).not.toContain('private-value');expect(JSON.stringify([...store.rows.values()])).not.toContain('private-value');expect(manager.scrub('echo private-value-123')).toBe('echo [REDACTED]');const v=await manager.verify(p.id,{cwd:directory});expect(v.success).toBe(true);expect(v.capabilities).toEqual(expect.arrayContaining(['inference','streaming','tools','usage']));expect(manager.assertVerified(p.id,'model-a').id).toBe(v.id);const edited=await manager.update(p.id,{name:'API changed',runtime:'codex',mode:'official-api',defaultModel:'model-a'});expect(edited.revision).toBe(2);expect(edited.verifications).toHaveLength(1);expect(()=>manager.assertVerified(p.id,'model-a')).toThrow('尚未通过');});
  it('keeps concurrent API profiles separate without altering global environment',async()=>{const {manager,directory}=await setup();vi.stubEnv('ANTHROPIC_AUTH_TOKEN','competing-token');vi.stubEnv('OPENAI_API_KEY','inherited-key');vi.stubEnv('CODEBUDDY_BASE_URL','https://wrong.test');const one=await manager.create({name:'A',runtime:'codex',mode:'gateway',baseUrl:'https://one.test/v1',apiKey:'key-a'});const two=await manager.create({name:'B',runtime:'codex',mode:'gateway',baseUrl:'https://two.test/v1',apiKey:'key-b'});const [a,b]=await Promise.all([manager.resolveRuntime(one.id,{cwd:directory}),manager.resolveRuntime(two.id,{cwd:directory})]);expect(a.env.AWB_CONNECTION_KEY).toBe('key-a');expect(b.env.AWB_CONNECTION_KEY).toBe('key-b');expect(a.env.CODEX_HOME).not.toBe(b.env.CODEX_HOME);expect(a.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();expect(a.env.OPENAI_API_KEY).toBeUndefined();expect(a.env.CODEBUDDY_BASE_URL).toBeUndefined();expect(process.env.OPENAI_API_KEY).toBe('inherited-key');expect(await readFile(join(a.env.CODEX_HOME!,'config.toml'),'utf8')).toContain('https://one.test/v1');expect(await readFile(join(a.env.CODEX_HOME!,'config.toml'),'utf8')).not.toContain('key-a');});
  it('keeps Claude OS environment while dropping competing auth and project settings',async()=>{const {manager,directory}=await setup();vi.stubEnv('CLAUDE_CODE_USE_BEDROCK','1');vi.stubEnv('ANTHROPIC_AUTH_TOKEN','wrong');const p=await manager.create({name:'C',runtime:'claude',mode:'gateway',baseUrl:'https://claude.test',apiKey:'correct'});const config=await manager.resolveRuntime(p.id,{cwd:directory});expect(config.env.ANTHROPIC_API_KEY).toBe('correct');expect(config.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();expect(config.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();expect(config.env.PATH).toBe(process.env.PATH);expect(config.settingSources).toEqual([]);});
  it('blocks project and ancestor routing overrides rather than silently using a different credential',async()=>{const {manager,directory}=await setup();const workspace=join(directory,'project');await mkdir(join(directory,'.codebuddy'),{recursive:true});await mkdir(workspace);await writeFile(join(directory,'.codebuddy','models.json'),' {"models":[{"id":"other","apiKey":"secret"}]}');const p=await manager.create({name:'W',runtime:'workbuddy',mode:'gateway',protocol:'openai-chat',baseUrl:'https://models.test/v1/chat/completions',defaultModel:'x',apiKey:'key'});await expect(manager.resolveRuntime(p.id,{cwd:workspace})).rejects.toThrow('覆盖所选连接');expect(await routingConflicts(p,workspace)).toHaveLength(1);});
  it('does not infer tools or image support from a model catalog or successful text response',async()=>{const {manager,directory,adapter}=await setup();const p=manager.ensureNative('codex');await manager.models(p.id,directory);expect(manager.get(p.id).verifications).toHaveLength(0);adapter.connect=async()=>({nativeSessionId:'s',pid:undefined,send:async()=>{},interrupt:async()=>{},respondApproval:async()=>{},close:async()=>{}});const profile=await manager.create({name:'test',runtime:'codex',mode:'official-api',apiKey:'key'});expect(profile.status).toBeUndefined();expect(()=>manager.assertVerified(profile.id,'')).toThrow();});
  it('validates protocol, endpoint and runtime before saving configuration',async()=>{const {manager}=await setup();await expect(manager.create({name:'bad',runtime:'codex',mode:'gateway',protocol:'openai-chat',baseUrl:'https://a.test'})).rejects.toThrow('协议');await expect(manager.create({name:'bad',runtime:'claude',mode:'gateway',baseUrl:'https://user:pass@a.test'})).rejects.toThrow('服务地址');await expect(manager.create({name:'bad',runtime:'claude',mode:'official-api',baseUrl:'https://a.test'})).rejects.toThrow('兼容网关');});
  it('records failed requests without falling back to another profile',async()=>{const {manager,directory,adapter,launches}=await setup();const p=await manager.create({name:'bad key',runtime:'codex',mode:'official-api',defaultModel:'model-a',apiKey:'secret-no-pattern'});adapter.connect=async()=>{throw new Error('401 Unauthorized secret-no-pattern');};const result=await manager.verify(p.id,{cwd:directory});expect(result.success).toBe(false);expect(result.status.state).toBe('authentication-failed');expect(JSON.stringify(result)).not.toContain('secret-no-pattern');expect(manager.list()).toHaveLength(1);expect(launches).toHaveLength(0);});
  it('marks tool protocol configuration as unverified until the bound model passes',async()=>{const {manager,directory}=await setup();const p=await manager.create({name:'W',runtime:'workbuddy',mode:'gateway',protocol:'openai-chat',defaultModel:'alpha',baseUrl:'https://api.example.test/v1/chat/completions',apiKey:'wb-secret'});const config=await manager.resolveRuntime(p.id,{cwd:directory,model:'alpha'});expect(config.env.CODEBUDDY_CONFIG_DIR).toBe(config.env.WORKBUDDY_CONFIG_DIR);const file=await readFile(join(config.env.CODEBUDDY_CONFIG_DIR!,'models.json'),'utf8');expect(file).toContain('${AWB_CONNECTION_KEY}');expect(file).not.toContain('wb-secret');await expect(manager.resolveRuntime(p.id,{cwd:directory,model:'beta'})).rejects.toThrow('仅绑定');});
  it('uses the native custom-model registry identity instead of a possibly matching built-in ID',async()=>{const {manager,directory}=await setup();const profile=await manager.create({name:'W',runtime:'workbuddy',mode:'gateway',protocol:'openai-chat',defaultModel:'alpha',baseUrl:'https://api.example.test/v1/chat/completions',apiKey:'synthetic'});const connection=await manager.resolveRuntime(profile.id,{cwd:directory,model:'alpha'});const launch=workbuddyLaunch('codebuddy',{agentId:'a',cwd:directory,model:'alpha',permissionMode:'read-only',instructions:'',connection});expect(launch.args[launch.args.indexOf('--model')+1]).toBe('custom-local:alpha');expect(launch.args.join(' ')).not.toContain('synthetic');});
  it('blocks native fallback before a paid turn when WorkBuddy ignores the selected custom model',async()=>{const {manager,directory}=await setup();const profile=await manager.create({name:'W',runtime:'workbuddy',mode:'gateway',protocol:'openai-chat',defaultModel:'alpha',baseUrl:'https://api.example.test/v1/chat/completions',apiKey:'synthetic'});const config=await manager.resolveRuntime(profile.id,{cwd:directory});const process=Object.assign(new EventEmitter(),{request:vi.fn(async()=>({currentModelId:'auto'})),write:vi.fn()});const connection=new WorkbuddyConnection({agentId:'a',cwd:directory,model:'alpha',permissionMode:'read-only',instructions:'',connection:config},()=>{},process as unknown as JsonProcess);await expect(connection.initialize()).rejects.toThrow('不能回退');expect(process.write).not.toHaveBeenCalled();});
  it('binds proof to routing contents, while allowing an identical isolated worktree',async()=>{const {manager,directory,launches}=await setup();const first=join(directory,'project'),second=join(directory,'worktree');await mkdir(join(first,'.codex'),{recursive:true});await mkdir(join(second,'.codex'),{recursive:true});const content='model_provider = "native-provider"';await writeFile(join(first,'.codex','config.toml'),content);await writeFile(join(second,'.codex','config.toml'),content);const profile=manager.ensureNative('codex');const verified=await manager.verify(profile.id,{cwd:first});expect(launches[0].cwd).toBe(first);expect(verified.contextFingerprint).toMatch(/^[a-f0-9]{64}$/);expect((await manager.assertReady(profile.id,'',second)).id).toBe(verified.id);await writeFile(join(second,'.codex','config.toml'),'model_provider = "other-provider"');await expect(manager.assertReady(profile.id,'',second)).rejects.toThrow('路由配置已变化');});
  it('invalidates native proof when an inherited auth routing variable changes',async()=>{const {manager,directory}=await setup();const profile=manager.ensureNative('claude');vi.stubEnv('ANTHROPIC_BASE_URL','https://one.example.test');await manager.verify(profile.id,{cwd:directory});await manager.assertReady(profile.id,'',directory);vi.stubEnv('ANTHROPIC_BASE_URL','https://two.example.test');await expect(manager.assertReady(profile.id,'',directory)).rejects.toThrow('路由配置已变化');});
  it('keeps only safe model metadata in the connection store',async()=>{const {manager,directory,adapter,store}=await setup();const profile=await manager.create({name:'private',runtime:'codex',mode:'official-api',apiKey:'catalog-secret'});adapter.listModels=async()=>({runtime:'codex',models:[{id:'a',name:'catalog-secret',apiKey:'extra-secret'}],source:'test',status:'ready',checkedAt:new Date().toISOString(),detail:'catalog-secret',account:{token:'extra-secret'}});const result=await manager.models(profile.id,directory);expect(result.models).toEqual([{id:'a',name:'[REDACTED]'}]);expect(JSON.stringify([...store.rows.values()])).not.toContain('catalog-secret');expect(JSON.stringify([...store.rows.values()])).not.toContain('extra-secret');expect(result.detail).toBe('[REDACTED]');});
  it.each([true,false])('records image capability only when a random attached PNG is actually identified (correct=%s)',async(correct)=>{
    const {manager,directory,adapter}=await setup();const profile=manager.ensureNative('codex');let observedPrompt='';
    adapter.connect=async(_options,emit)=>({nativeSessionId:'vision',pid:undefined,send:async(text,_id,images)=>{
      observedPrompt=text;expect(images).toHaveLength(1);const png=await readFile(images![0]!.path),offset=png.indexOf(Buffer.from('IDAT')),length=png.readUInt32BE(offset-4),pixels=inflateSync(png.subarray(offset+4,offset+4+length));
      const color=pixels[1]===230?'red':pixels[2]===200?'green':'blue';emit({type:'delta',text:'连接验证成功'});emit({type:'result',text:`WORKBENCH_IMAGE_COLOR: ${correct?color:color==='red'?'green':'red'}`});
    },interrupt:async()=>{},respondApproval:async()=>{},close:async()=>{}});
    const result=await manager.verify(profile.id,{cwd:directory,capabilities:['inference','streaming','images']});expect(result.success).toBe(correct);expect(result.capabilities.includes('images')).toBe(correct);expect(observedPrompt).toContain('red 或 green 或 blue');expect(result.detail).not.toContain('期望颜色');
  });
  it('cancels an active verification before shutdown completes and does not leave a billable turn running',async()=>{const {manager,directory,adapter}=await setup();const profile=manager.ensureNative('codex');const close=vi.fn(async()=>{}),interrupt=vi.fn(async()=>{}),send=vi.fn(async()=>{});adapter.connect=async()=>({nativeSessionId:'s',pid:undefined,send,interrupt,respondApproval:async()=>{},close});const pending=manager.verify(profile.id,{cwd:directory});await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce());await manager.close();const result=await pending;expect(result.success).toBe(false);expect(result.detail).toContain('取消');expect(interrupt).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();await expect(manager.verify(profile.id,{cwd:directory})).rejects.toThrow('服务正在关闭');});
});
describe('native CLI failure wording', () => {
  it('recognises a model the account cannot use', () => {
    expect(classifyConnectionError(new Error("There's an issue with the selected model (mock-model). It may not exist or you may not have access to it.")).state).toBe('model-unavailable');
    expect(classifyConnectionError(new Error('issue with the selected model: gpt-x')).state).toBe('model-unavailable');
  });
});

describe('Windows credential storage',()=>{it.skipIf(process.platform!=='win32')('round trips through DPAPI without plaintext ciphertext',async()=>{const protector=new WindowsDpapiProtector();const secret=`synthetic-dpapi-${Date.now()}`;const encrypted=await protector.protect(secret);expect(encrypted).not.toContain(secret);expect(await protector.unprotect(encrypted)).toBe(secret);});});
describe('connection error categories',()=>{
  it.each([['401 unauthorized','authentication-failed'],['usage limit exceeded','quota-exceeded'],['model not found','model-unavailable'],['ECONNRESET','network-failed']])('%s → %s',(message,state)=>expect(classifyConnectionError(new Error(message)).state).toBe(state));
  it('classifies provider failures through the real verification path and never switches profile',async()=>{
    const {manager,directory,adapter}=await setup();
    const cases:[string,string][]=[['401 Unauthorized invalid api key','authentication-failed'],['429 usage limit exceeded','quota-exceeded'],['model not found: model-z','model-unavailable'],['fetch failed ECONNREFUSED','network-failed']];
    const ids:string[]=[];
    for(const [index,[message,expected]] of cases.entries()){
      const secret=`provider-secret-${index}`,profile=await manager.create({name:`case ${index}`,runtime:'codex',mode:'official-api',defaultModel:'model-a',apiKey:secret});ids.push(profile.id);
      adapter.connect=async()=>{throw new Error(`${message} ${secret}`);};
      const result=await manager.verify(profile.id,{cwd:directory});
      expect(result.success).toBe(false);expect(result.status.state).toBe(expected);expect(result.connectionId).toBe(profile.id);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(manager.list())).not.toContain(secret);
      expect(manager.get(profile.id).verifications[0]?.status.state).toBe(expected);
      expect(()=>manager.assertVerified(profile.id,'model-a')).toThrow('尚未通过');
    }
    expect(manager.list().filter(item=>item.verifications.some(row=>row.success))).toEqual([]);
    expect(new Set(ids).size).toBe(cases.length);
  });
  it('verifies two API profiles concurrently without sharing endpoint, model or credential',async()=>{
    const {manager,directory,adapter}=await setup();
    const one=await manager.create({name:'one',runtime:'codex',mode:'gateway',baseUrl:'https://one.test/v1',apiKey:'key-one',defaultModel:'model-one'});
    const two=await manager.create({name:'two',runtime:'codex',mode:'gateway',baseUrl:'https://two.test/v1',apiKey:'key-two',defaultModel:'model-two'});
    const seen:RuntimeOptions[]=[];let arrivals=0;let release!:()=>void;const overlap=new Promise<void>(resolve=>{release=resolve;});
    adapter.connect=async(options,emit)=>{seen.push(options);if(++arrivals===2)release();await overlap;return {nativeSessionId:`session-${options.model}`,pid:undefined,send:async()=>{emit({type:'ready',data:{model:options.model,provider:'gateway-test'}});emit({type:'delta',text:'连接验证成功'});const probe=options.mcpServers?.workbench_probe;if(probe)await writeFile(probe.args[1],JSON.stringify({nonce:probe.args[2]}));emit({type:'result',text:'连接验证成功'});},interrupt:async()=>{},respondApproval:async()=>{},close:async()=>{}};};
    const [first,second]=await Promise.all([manager.verify(one.id,{cwd:directory}),manager.verify(two.id,{cwd:directory})]);
    expect(first.success&&second.success).toBe(true);expect(arrivals).toBe(2);
    const launches=new Map(seen.map(options=>[options.connection!.connectionId,options]));
    expect(launches.size).toBe(2);
    expect(launches.get(one.id)!.connection!.env.AWB_CONNECTION_KEY).toBe('key-one');
    expect(launches.get(two.id)!.connection!.env.AWB_CONNECTION_KEY).toBe('key-two');
    expect(launches.get(one.id)!.model).toBe('model-one');expect(launches.get(two.id)!.model).toBe('model-two');
    expect(launches.get(one.id)!.connection!.env.CODEX_HOME).not.toBe(launches.get(two.id)!.connection!.env.CODEX_HOME);
    const oneConfig=await readFile(join(launches.get(one.id)!.connection!.env.CODEX_HOME!,'config.toml'),'utf8');
    const twoConfig=await readFile(join(launches.get(two.id)!.connection!.env.CODEX_HOME!,'config.toml'),'utf8');
    expect(oneConfig).toContain('https://one.test/v1');expect(oneConfig).not.toContain('key-one');
    expect(twoConfig).toContain('https://two.test/v1');expect(twoConfig).not.toContain('key-two');
    expect(JSON.stringify(launches.get(one.id)!.connection!.config)).not.toContain('key-one');
    expect(JSON.stringify(launches.get(two.id)!.connection!.config)).not.toContain('key-two');
    // The key reaches the native process only through its isolated environment.
    expect(JSON.stringify([...manager.list()])).not.toContain('key-one');
    expect(JSON.stringify([...manager.list()])).not.toContain('key-two');
    expect(JSON.stringify([first,second])).not.toContain('key-one');
    expect(JSON.stringify([first,second])).not.toContain('key-two');
    expect(first.connectionId).toBe(one.id);expect(second.connectionId).toBe(two.id);
    expect(first.observedModel).toBe('model-one');expect(second.observedModel).toBe('model-two');
    expect(manager.assertVerified(one.id,'model-one').id).toBe(first.id);
    expect(manager.assertVerified(two.id,'model-two').id).toBe(second.id);
    expect(()=>manager.assertVerified(one.id,'model-two')).toThrow('尚未通过');
  });
});
describe('native startup interruption',()=>{
  it('limits Claude verification to named MCP approval without weakening ordinary readonly sessions',async()=>{
    for(const verificationTools of [undefined,['mcp__probe__echo']]){
      let sdkOptions!:Options,close!:()=>void;const done=new Promise<void>(resolve=>{close=resolve;});const events:RuntimeEvent[]=[];
      const fakeQuery={async *[Symbol.asyncIterator](){await done;},initializationResult:async()=>({}),close:()=>close()};
      const connection=new ClaudeConnection({agentId:'a',cwd:tmpdir(),permissionMode:'read-only',instructions:'',verificationTools},event=>events.push(event),'claude.exe',((args:{options:Options})=>{sdkOptions=args.options;return fakeQuery as unknown as Query;}) as any);
      await connection.initialize();expect(sdkOptions.permissionMode).toBe(verificationTools?'default':'plan');expect(sdkOptions.tools).toEqual(verificationTools?[]:undefined);expect(sdkOptions.allowedTools).toBeUndefined();
      if(verificationTools){
        const context={signal:new AbortController().signal,toolUseID:'tool',requestId:'request'};
        expect(await sdkOptions.canUseTool!('Write',{file_path:'plan.md'},context)).toMatchObject({behavior:'deny'});
        expect(await sdkOptions.canUseTool!('mcp__other__echo',{},context)).toMatchObject({behavior:'deny'});expect(events.some(event=>event.type==='approval')).toBe(false);
        const permission=sdkOptions.canUseTool!('mcp__probe__echo',{nonce:'actual'},context);const approval=events.find(event=>event.type==='approval')!;expect(approval.data?.input).toEqual({nonce:'actual'});
        await connection.respondApproval(approval.approvalId!,true);expect(await permission).toMatchObject({behavior:'allow',updatedInput:{nonce:'actual'}});
      }
      await connection.close();
    }
  });
  it('accepts the native WorkBuddy startup AbortError only during an explicit stop',async()=>{
    const emitter=new EventEmitter(),events:RuntimeEvent[]=[];const transport=Object.assign(emitter,{write:async()=>{},request:async(_id:string,frame:Record<string,any>)=>{
      if(frame.request.subtype==='interrupt')emitter.emit('frame',{type:'error',error:'Agent run startup was cancelled'});return {currentModelId:'auto'};
    }});
    const connection=new WorkbuddyConnection({agentId:'a',cwd:tmpdir(),resumeSessionId:'real',permissionMode:'read-only',instructions:''},event=>events.push(event),transport as unknown as JsonProcess);
    await connection.initialize();await connection.send('待中断','first');await connection.interrupt();
    expect(events.some(event=>event.type==='result'&&event.data?.subtype==='startup_cancelled'&&event.data?.interrupted===true)).toBe(true);
    await connection.send('真正下一轮','second');emitter.emit('frame',{type:'error',error:'Agent run startup was cancelled'});
    expect(events.some(event=>event.type==='error'&&event.messageId==='second')).toBe(true);
  });
  it('waits for the first WorkBuddy native session before cancellation without replaying user input',async()=>{
    const emitter=new EventEmitter(),events:RuntimeEvent[]=[];let writes=0,cancellations=0;
    const transport=Object.assign(emitter,{write:async()=>{writes++;},request:async(_id:string,frame:Record<string,any>)=>{
      if(frame.request.subtype==='initialize')return {currentModelId:'auto'};
      if(frame.request.subtype==='get_available_models')return {rawModels:[]};
      if(frame.request.subtype==='interrupt'){cancellations++;expect(frame.request.session_id).toBe('real-session');emitter.emit('frame',{type:'result',session_id:'real-session',subtype:'success'});}
      return {};
    }});
    const connection=new WorkbuddyConnection({agentId:'a',cwd:tmpdir(),permissionMode:'read-only',instructions:''},event=>events.push(event),transport as unknown as JsonProcess);
    await connection.initialize();await connection.send('中文中断验证','message');const stopped=connection.interrupt();
    expect(cancellations).toBe(0);emitter.emit('frame',{type:'system',subtype:'init',session_id:'real-session',model:'auto'});await stopped;
    expect(writes).toBe(1);expect(cancellations).toBe(1);expect(events.some(event=>event.type==='result'&&event.data?.interrupted===true)).toBe(true);
  });
  it('retries only the same Codex cancellation when start acknowledgement precedes the active turn',async()=>{
    const emitter=new EventEmitter();let cancellations=0,starts=0;const events:RuntimeEvent[]=[];
    const transport=Object.assign(emitter,{write:async()=>{},request:async(_id:string,frame:Record<string,any>)=>{
      if(frame.method==='thread/start')return {thread:{id:'thread'}};
      if(frame.method==='turn/start'){starts++;return {turn:{id:'turn'}};}
      if(frame.method==='turn/interrupt'){expect(frame.params.turnId).toBe('turn');if(++cancellations===1)throw new Error('no active turn to interrupt');emitter.emit('frame',{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted'}}});}
      return {};
    }});
    const connection=new CodexConnection({agentId:'a',cwd:tmpdir(),permissionMode:'read-only',instructions:''},event=>events.push(event),transport as unknown as JsonProcess);
    await connection.initialize();await connection.send('中文中断验证','message');await connection.interrupt();
    expect(starts).toBe(1);expect(cancellations).toBe(2);expect(events.some(event=>event.type==='result'&&event.data?.interrupted===true)).toBe(true);
  });
});

describe('per-process WorkBuddy authorization retains verification gates',()=>{
  it('loads explicitly bound verification MCP without enabling built-in tool search',()=>{
    const launch=workbuddyLaunch('codebuddy',{agentId:'probe',cwd:tmpdir(),permissionMode:'read-only',instructions:'',verificationTools:['mcp__workbench_probe__connection_probe'],mcpServers:{workbench_probe:{command:'node',args:['probe.mjs'],env:{SCOPED_TOKEN:'synthetic-only'}}}});
    expect(launch.args[launch.args.indexOf('--tools')+1]).toBe('');
    expect(launch.args).toContain('--strict-mcp-config');
    const config=JSON.parse(launch.args[launch.args.indexOf('--mcp-config')+1]);
    expect(config.mcpServers.workbench_probe.alwaysLoad).toBe(true);
    expect(launch.args.join(' ')).not.toContain('synthetic-only');
    const ordinary=workbuddyLaunch('codebuddy',{agentId:'member',cwd:tmpdir(),permissionMode:'read-only',instructions:'',mcpServers:{workbench:{command:'node',args:['mcp.mjs']}}});
    expect(JSON.parse(ordinary.args[ordinary.args.indexOf('--mcp-config')+1]).mcpServers.workbench.alwaysLoad).toBeUndefined();
  });
  it('allows fresh-process authorization only with current real-call proof and unchanged routing',async()=>{
    const f=await setup(),profile=f.manager.ensureNative('workbuddy');
    vi.spyOn(f.manager,'resolveRuntime').mockResolvedValue({connectionId:profile.id,revision:profile.revision,workbuddyEdition:'china',nativeMemoryAuthentication:true,env:{}});
    await expect(f.manager.assertReady(profile.id,'',f.directory,['inference','streaming','tools'])).rejects.toThrow('尚未通过');
    expect((await f.manager.verify(profile.id,{cwd:f.directory})).success).toBe(true);
    f.store.put('connections',profile.id,{...f.manager.get(profile.id),authenticationStatus:{state:'unconfigured',checkedAt:new Date().toISOString(),detail:'New native process has no inherited credential'}});
    await expect(f.manager.assertReady(profile.id,'',f.directory,['inference','streaming','tools'])).resolves.toHaveProperty('success',true);
    await expect(f.manager.assertReady(profile.id,'another-model',f.directory)).rejects.toThrow('尚未通过');
    await mkdir(join(f.directory,'.codebuddy'),{recursive:true});await writeFile(join(f.directory,'.codebuddy','settings.json'),'{"model":"changed"}');
    await expect(f.manager.assertReady(profile.id,'',f.directory)).rejects.toThrow('路由配置已变化');
    await f.manager.close();
  });
  it('reads authenticated live session evidence without spawning an unauthenticated metadata process',async()=>{
    const f=await setup(),nativeAuthentication=vi.fn(async()=>({state:'unconfigured' as const,checkedAt:'',detail:'Should not run'}));
    const managed={...f.adapter,kind:'workbuddy' as const,authentication:{list:()=>[{id:'owned',agentId:'member',connectionId:'native-workbuddy',connectionRevision:1,edition:'international' as const,cwd:f.directory,state:'authenticated' as const,createdAt:'',updatedAt:'',detail:'Native receipt',canAuthorize:false}],url:()=>undefined,cancel:async()=>{},close:async()=>{}}};
    const manager=new ConnectionManager({dataDir:f.directory,store:f.store,adapters:{codex:f.adapter,claude:{...f.adapter,kind:'claude'},workbuddy:managed},nativeAuthentication});
    const profile=manager.ensureNative('workbuddy'),updated=await manager.refreshAuthentication(profile.id,f.directory);
    expect(updated.authenticationStatus).toMatchObject({state:'authentication-observed',credentialSource:'native-memory-session',provider:'WorkBuddy 国际站'});
    expect(nativeAuthentication).not.toHaveBeenCalled();expect(updated.verifications).toEqual([]);await manager.close();await f.manager.close();
  });
});
