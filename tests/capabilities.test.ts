import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Agent, Capability, RuntimeAdapter, RuntimeEvent, RuntimeOptions } from '../src/shared/types.js';
import { CapabilityManager } from '../src/server/capabilities.js';
import { verifyCapability, type CapabilityVerificationInput } from '../src/server/capability-probe.js';
import { Store } from '../src/server/store.js';

// Native transport is simulated; the narrow stdio verifier and fixture script execute for real.
class ProbeAdapter implements RuntimeAdapter {
  kind='codex' as const;prompts:string[]=[];launches:RuntimeOptions[]=[];approvals:boolean[]=[];
  constructor(private readonly run:(client:Client,call:(name:string,args?:Record<string,unknown>)=>Promise<unknown>,emit:(e:RuntimeEvent)=>void,server:string)=>Promise<void>){}
  async discover(){return {kind:this.kind,available:true,detail:'simulated',capabilities:{interrupt:true,approvals:true,resume:true,steer:false}};}
  async connect(options:RuntimeOptions,emit:(e:RuntimeEvent)=>void){
    this.launches.push(options);const [server,config]=Object.entries(options.mcpServers!)[0]!;
    const client=new Client({name:'controlled-capability-test',version:'1.0.0'},{capabilities:{}});
    const transport=new StdioClientTransport({...config,env:{...getDefaultEnvironment(),...config.env},stderr:'ignore'});
    const local=config.args.some(arg=>arg.includes('capability-local-probe.'));
    if(local)await client.connect(transport);
    let count=0;
    const call=async(name:string,args:Record<string,unknown>={})=>{const id=`call-${++count}`;emit({type:'tool',data:{name:`mcp__${server}__${name}`,id,phase:'started',input:args}});const result=await client.callTool({name,arguments:args});emit({type:'tool',data:{id,phase:'completed',isError:result.isError===true}});return result;};
    return {nativeSessionId:undefined,pid:undefined,send:async(prompt:string)=>{this.prompts.push(prompt);await this.run(client,call,emit,server);emit({type:'result',text:'Model claims success'});},interrupt:async()=>{},respondApproval:async(_id:string,allow:boolean)=>{this.approvals.push(allow);},close:async()=>{await client.close();await transport.close();}};
  }
}
const cleanup:(()=>void)[]=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'awb-capability-test-')),store=new Store(':memory:');
  cleanup.push(()=>{store.close();if(!resolve(dir).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe fixture cleanup');rmSync(dir,{recursive:true,force:true,maxRetries:3});});
  const agent:Agent={id:'probe-member',name:'Fixture',projectId:'fixture',role:'analyst',runtime:'codex',model:'test',permissionMode:'read-only',instructions:'',controlMode:'human',state:'idle',createdAt:new Date().toISOString(),connectionId:'native-codex',connectionRevision:1};
  const manager=new CapabilityManager(store,()=>[agent]);
  const run=(capability:Capability,adapter:ProbeAdapter,input:CapabilityVerificationInput)=>verifyCapability(manager,capability,agent,adapter,{agentId:agent.id,cwd:dir,model:'test',permissionMode:'read-only',instructions:''},input,()=>{});
  return {dir,store,agent,manager,run};
}
function contents(value:unknown){return JSON.parse((value as {content:{text:string}[]}).content[0]!.text) as {instructions:string;readToken:string};}

describe('native capability verification evidence',()=>{
  it('refuses separate credential flags rather than persisting their following argument',()=>{
    const f=fixture();expect(()=>f.manager.save({name:'Unsafe MCP args',kind:'mcp',command:process.execPath,args:['--token','fixture-private-value']})).toThrow('凭据');expect(f.manager.list()).toHaveLength(0);
  });
  it('requires an actual skill read and independently checked case, without sending the expected answer to the model',async()=>{
    const f=fixture(),path=join(f.dir,'SKILL.md');writeFileSync(path,'For input red, output ROUGE.');const capability=f.manager.save({kind:'skill',name:'Translate case',path});
    const adapter=new ProbeAdapter(async(_client,call)=>{const read=contents(await call('read_bound_skill'));expect(read.instructions).toContain('ROUGE');await call('complete_skill_case',{readToken:read.readToken,answer:'ROUGE'});});
    const result=await f.run(capability,adapter,{scenario:'Translate red using the bound skill.',expectedOutput:'ROUGE'});
    expect(result.validations[0]).toMatchObject({state:'verified',stale:false});expect(result.validations[0]!.detail).toContain('已验证该小用例');expect(adapter.prompts.join()).not.toContain('ROUGE');
    expect(adapter.launches[0]!.cwd).toBe(f.dir);expect(adapter.launches[0]!.resumeSessionId).toBeUndefined();
    expect(adapter.launches[0]!.verificationTools).toEqual([`mcp__cap_${capability.id.replace(/-/g,'')}__complete_skill_case`,`mcp__cap_${capability.id.replace(/-/g,'')}__read_bound_skill`]);
    f.agent.capabilityIds=[capability.id];expect(()=>f.manager.assertBound(f.agent,[capability.id])).not.toThrow();
    writeFileSync(path,'For input red, output RED.');expect(f.manager.get(capability.id).validations[0]!.stale).toBe(true);expect(()=>f.manager.assertBound(f.agent,[capability.id])).toThrow('已改变');
  });
  it('rejects model claims, fabricated tool events, and incorrect expected-answer cases',async()=>{
    const f=fixture(),path=join(f.dir,'SKILL.md');writeFileSync(path,'Convert lowercase to uppercase.');const capability=f.manager.save({kind:'skill',name:'Case',path});
    const claim=new ProbeAdapter(async(_client,_call,emit,server)=>{emit({type:'tool',data:{name:`mcp__${server}__read_bound_skill`,phase:'completed'}});emit({type:'tool',data:{name:`mcp__${server}__complete_skill_case`,phase:'completed'}});});
    expect((await f.run(capability,claim,{scenario:'Uppercase abc',expectedOutput:'ABC'})).validations[0]!.state).toBe('failed');
    const wrong=new ProbeAdapter(async(_client,call)=>{const read=contents(await call('read_bound_skill'));await call('complete_skill_case',{readToken:read.readToken,answer:'wrong'});});
    expect((await f.run(capability,wrong,{scenario:'Uppercase abc',expectedOutput:'ABC'})).validations[0]!.state).toBe('failed');
  });
  it('runs only the saved script path and args in an isolated directory and checks the real exit code',async()=>{
    const f=fixture(),path=join(f.dir,'fixture.cjs'),marker=join(f.dir,'executed.json');
    writeFileSync(path,`require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));`);
    const capability=f.manager.save({kind:'script',name:'Fixture script',path,command:process.execPath,args:['fixed']});
    const adapter=new ProbeAdapter(async(_client,call)=>{await call('run_bound_script');});
    expect((await f.run(capability,adapter,{})).validations[0]!.state).toBe('verified');
    const actual=JSON.parse(readFileSync(marker,'utf8')) as {cwd:string;args:string[]};expect(actual.cwd).not.toBe(f.dir);expect(actual.args).toEqual(['fixed']);expect(existsSync(actual.cwd)).toBe(false);
    writeFileSync(path,'process.exit(7)');expect((await f.run(f.manager.get(capability.id),adapter,{})).validations[0]!.state).toBe('failed');
  });
  it('does not let the model override the saved script arguments',async()=>{
    const f=fixture(),path=join(f.dir,'fixture.cjs'),marker=join(f.dir,'must-not-run');writeFileSync(path,`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
    const capability=f.manager.save({kind:'script',name:'Fixed script',path,command:process.execPath,args:[]});
    const adapter=new ProbeAdapter(async(_client,call)=>{await call('run_bound_script',{args:['override']});});
    expect((await f.run(capability,adapter,{})).validations[0]!.state).toBe('failed');expect(existsSync(marker)).toBe(false);
  });
  it('binds proof to environment values and rejects config changes during the probe',async()=>{
    const f=fixture(),path=join(f.dir,'fixture.cjs');writeFileSync(path,'process.exit(0)');const previous=process.env.AWB_CAPABILITY_TEST_SECRET;process.env.AWB_CAPABILITY_TEST_SECRET='first-private-value';cleanup.push(()=>{if(previous===undefined)delete process.env.AWB_CAPABILITY_TEST_SECRET;else process.env.AWB_CAPABILITY_TEST_SECRET=previous;});
    const capability=f.manager.save({kind:'script',name:'Env-bound',path,command:process.execPath,envRefs:{EXAMPLE:'AWB_CAPABILITY_TEST_SECRET'}});
    const adapter=new ProbeAdapter(async(_client,call)=>{await call('run_bound_script');});const result=await f.run(capability,adapter,{});expect(result.validations[0]!.state).toBe('verified');expect(JSON.stringify(result)).not.toContain('first-private-value');
    process.env.AWB_CAPABILITY_TEST_SECRET='second-private-value';expect(f.manager.get(capability.id).validations[0]!.stale).toBe(true);
    const changed=new ProbeAdapter(async(_client,call)=>{await call('run_bound_script');writeFileSync(path,'process.exit(2)');});await expect(f.run(f.manager.get(capability.id),changed,{})).rejects.toThrow('已改变');
  });
  it('checks native Codex serverName approval metadata and rejects mismatched parameter approvals',async()=>{
    const f=fixture();let capability=f.manager.save({kind:'mcp',name:'Explicit MCP',command:process.execPath,args:[]});capability={...capability,status:'connected',tools:[{name:'echo',description:'Echo exactly the supplied text'}]};f.store.put('capabilities',capability.id,capability);
    const adapter=new ProbeAdapter(async(_client,_call,emit,server)=>{
      emit({type:'approval',approvalId:'good',data:{tool:'MCP 工具调用',input:{serverName:server,toolDescription:'Echo exactly the supplied text',toolParameters:{text:'selected'}}}});
      emit({type:'approval',approvalId:'wrong-server',data:{tool:'MCP 工具调用',input:{serverName:'other',toolDescription:'Echo exactly the supplied text',toolParameters:{text:'selected'}}}});
      emit({type:'approval',approvalId:'wrong-args',data:{tool:'MCP 工具调用',input:{serverName:server,toolDescription:'Echo exactly the supplied text',toolParameters:{text:'different'}}}});
      emit({type:'tool',data:{serverName:server,name:'echo',arguments:{text:'selected'},phase:'completed',isError:false}});
    });
    expect((await f.run(capability,adapter,{tool:'echo',arguments:{text:'selected'}})).validations[0]!.state).toBe('verified');expect(adapter.approvals).toEqual([true,false,false]);
  });
  it('unwraps WorkBuddy deferred calls but approves only the selected tool and exact arguments',async()=>{
    const f=fixture();let capability=f.manager.save({kind:'mcp',name:'Deferred fixture',command:process.execPath});capability={...capability,status:'connected',tools:[{name:'echo'}]};f.store.put('capabilities',capability.id,capability);
    const adapter=new ProbeAdapter(async(_client,_call,emit,server)=>{
      emit({type:'approval',approvalId:'selected',data:{tool:'DeferExecuteTool',input:{toolName:`mcp__${server}__echo`,params:{text:'selected'}}}});
      emit({type:'approval',approvalId:'other',data:{tool:'DeferExecuteTool',input:{toolName:'mcp__other__echo',params:{text:'selected'}}}});
      emit({type:'approval',approvalId:'changed',data:{tool:'DeferExecuteTool',input:{toolName:`mcp__${server}__echo`,params:{text:'changed'}}}});
      emit({type:'tool',data:{name:'DeferExecuteTool',id:'deferred',phase:'started',input:{toolName:`mcp__${server}__echo`,params:{text:'selected'}}}});emit({type:'tool',data:{id:'deferred',phase:'completed',isError:false}});
    });
    expect((await f.run(capability,adapter,{tool:'echo',arguments:{text:'selected'}})).validations[0]!.state).toBe('verified');expect(adapter.approvals).toEqual([true,false,false]);
  });
  it('uses the completed Claude tool arguments after its streamed empty input frame',async()=>{
    const f=fixture();let capability=f.manager.save({kind:'mcp',name:'Streaming fixture',command:process.execPath});capability={...capability,status:'connected',tools:[{name:'echo'}]};f.store.put('capabilities',capability.id,capability);
    const adapter=new ProbeAdapter(async(_client,_call,emit,server)=>{
      emit({type:'tool',data:{name:`mcp__${server}__echo`,id:'streamed',phase:'started',input:{}}});
      emit({type:'tool',data:{name:`mcp__${server}__echo`,id:'streamed',phase:'started',input:{text:'selected'}}});
      emit({type:'tool',data:{id:'streamed',phase:'completed',isError:false}});
    });expect((await f.run(capability,adapter,{tool:'echo',arguments:{text:'selected'}})).validations[0]!.state).toBe('verified');
    const wrong=new ProbeAdapter(async(_client,_call,emit,server)=>{emit({type:'tool',data:{name:`mcp__${server}__echo`,id:'wrong',phase:'started',input:{text:'other'}}});emit({type:'tool',data:{id:'wrong',phase:'completed',isError:false}});});
    expect((await f.run(capability,wrong,{tool:'echo',arguments:{text:'selected'}})).validations[0]!.state).toBe('failed');
  });
});
