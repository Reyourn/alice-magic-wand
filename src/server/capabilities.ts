import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Agent, Capability, CapabilityCandidate, CapabilityInput, CapabilityValidation, McpServerConfig } from '../shared/types.js';
import { Store } from './store.js';
import { WorkbenchError } from './repositories.js';
import { safeText } from './runtime/process.js';

const stamp=()=>new Date().toISOString();
const busy=['starting','running','waiting_approval','interrupting','unknown'];
export class CapabilityManager {
  constructor(private readonly store:Store,private readonly agents:()=>Agent[]) {}
  list():Capability[]{return this.store.all<Capability>('capabilities').map(value=>this.current(value));}
  get(id:string):Capability {const value=this.store.get<Capability>('capabilities',id);if(!value)throw new WorkbenchError('能力不存在',404);return this.current(value);}
  private current(value:Capability):Capability {
    let fingerprint:string|undefined;try{fingerprint=this.fingerprint(value);}catch{/* Missing files/env invalidate prior proof. */}
    return {...value,validations:value.validations.map(v=>({...v,stale:!fingerprint||!v.fingerprint||v.fingerprint!==fingerprint}))};
  }
  fingerprint(capability:Capability):string {
    const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
    const env=Object.entries(capability.envRefs??{}).sort(([a],[b])=>a.localeCompare(b)).map(([target,source])=>{const value=process.env[source];if(value===undefined)throw new WorkbenchError(`后端缺少环境变量 ${source}`);return [target,source,hash(value)];});
    const files=(capability.path?[capability.path]:[]).map(path=>[realpathSync(path),hash(readFileSync(path))]);
    return hash(JSON.stringify({kind:capability.kind,command:capability.command??'',args:capability.args??[],env,files}));
  }
  save(input:CapabilityInput,id?:string):Capability {
    const old=id?this.get(id):undefined;
    if(old&&this.agents().some(a=>a.capabilityIds?.includes(old.id)&&busy.includes(a.state)))throw new WorkbenchError('绑定成员仍在执行或状态未知，先停止后修改能力',409);
    if(!input||!['mcp','skill','script'].includes(input.kind)||typeof input.name!=='string'||!input.name.trim()||input.name.length>120)throw new WorkbenchError('请填写有效能力名称与类型');
    if(!Array.isArray(input.args??[])||(input.args??[]).some(a=>typeof a!=='string'))throw new WorkbenchError('能力参数必须为字符串数组');
    if(input.kind==='mcp'&&!input.command?.trim())throw new WorkbenchError('本机 MCP 需要命令与参数数组');
    if(input.command&&/[\r\n]/.test(input.command))throw new WorkbenchError('命令不能包含换行');
    if((input.args??[]).some(a=>/(?:bearer\s|sk-[a-z0-9]{10,}|api[_-]?key=|token=|password=|^--?(?:api[-_]?key|access[-_]?token|token|password|secret|authorization)$)/i.test(a)))throw new WorkbenchError('凭据不能写入命令参数，请使用后端环境变量引用');
    for(const [key,value] of Object.entries(input.envRefs??{}))if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))throw new WorkbenchError('环境配置只接受变量名引用，不接受密钥值');
    let path:string|undefined;
    if(input.kind!=='mcp') {if(!input.path||!existsSync(input.path)||!statSync(input.path).isFile())throw new WorkbenchError('请选择已存在的本地技能或脚本文件');path=realpathSync(resolve(input.path));}
    const value:Capability={id:old?.id??randomUUID(),name:input.name.trim(),kind:input.kind,source:input.kind==='mcp'?'managed':'local',revision:(old?.revision??0)+1,description:input.description??'',command:input.command,args:input.args??[],envRefs:input.envRefs??{},path,status:'discovered',tools:[],validations:[]};
    this.store.put('capabilities',value.id,value);return value;
  }
  remove(id:string):void {if(this.agents().some(a=>a.capabilityIds?.includes(id)))throw new WorkbenchError('请先解除成员绑定；原生继承能力需在原生工具中处理',409);this.get(id);this.store.remove('capabilities',id);}
  discover():CapabilityCandidate[] {
    const candidates:CapabilityCandidate[]=[];
    for(const root of [join(homedir(),'.codex','skills'),join(homedir(),'.agents','skills'),join(homedir(),'.claude','skills')]) {
      if(!existsSync(root))continue;
      for(const entry of readdirSync(root,{withFileTypes:true}).slice(0,200)) {const path=join(root,entry.name,'SKILL.md');if(entry.isDirectory()&&existsSync(path))candidates.push({id:path,name:entry.name,kind:'skill',sourcePath:path,detail:'本地文件已发现；显式导入后才可绑定。'});}
    }
    for(const path of [join(homedir(),'.claude.json'),join(homedir(),'.codebuddy','mcp.json'),join(homedir(),'.codebuddy','settings.json')]) {
      try {const data=JSON.parse(readFileSync(path,'utf8')) as {mcpServers?:Record<string,unknown>};for(const name of Object.keys(data.mcpServers??{}))candidates.push({id:`${path}:${name}`,name,kind:'mcp',sourcePath:path,detail:'原生继承配置已发现；不会复制凭据，导入时请重新配置命令及环境变量引用。'});}catch{/* absent/non-JSON config is not imported */}
    }
    return candidates;
  }
  config(capability:Capability):McpServerConfig {
    if(capability.kind!=='mcp'||!capability.command)throw new WorkbenchError('该能力不是本机 stdio MCP');
    const env:Record<string,string>={};
    for(const [target,source] of Object.entries(capability.envRefs??{})){const value=process.env[source];if(!value)throw new WorkbenchError(`后端缺少环境变量 ${source}`);env[target]=value;}
    return {command:capability.command,args:capability.args??[],env};
  }
  configs(agent:Agent):Record<string,McpServerConfig> {return Object.fromEntries((agent.capabilityIds??[]).map(id=>this.get(id)).filter(c=>c.kind==='mcp').map(c=>[`cap_${c.id.replace(/-/g,'')}`,this.config(c)]));}
  instructions(agent:Agent):string {
    return (agent.capabilityIds??[]).map(id=>this.get(id)).filter(c=>c.kind==='skill'||c.kind==='script').map(c=>`已绑定${c.kind==='skill'?'技能':'脚本'} ${c.name}：${c.path}。${c.kind==='skill'?'使用前读取该文件的适用指令。':'仅按任务需求执行，保存实际命令与退出码。'}`).join('\n');
  }
  assertBound(agent:Agent,requirements:string[]):void {
    for(const id of requirements) {
      if(!agent.capabilityIds?.includes(id))throw new WorkbenchError(`成员 ${agent.name} 未绑定必需能力 ${id}`,409);
      const capability=this.get(id);
      if(!capability.validations.some(v=>!v.stale&&v.runtime===agent.runtime&&v.revision===capability.revision&&v.connectionId===agent.connectionId&&v.connectionRevision===agent.connectionRevision&&v.state==='verified'))throw new WorkbenchError(`能力 ${capability.name} 尚未在当前工具及连接版本完成真实用例验证，或文件／环境配置已改变`,409);
    }
  }
  async check(id:string):Promise<Capability> {
    const capability=this.get(id);
    if(capability.kind!=='mcp') {const valid=!!capability.path&&existsSync(capability.path);const next={...capability,status:valid?'connected' as const:'failed' as const,checkedAt:stamp(),detail:valid?'文件可读取；尚未证明原生工具已使用。':'本地文件不存在'};this.store.put('capabilities',id,next);return next;}
    const config=this.config(capability);
    const client=new Client({name:'workbench-capability-check',version:'1.0.0'},{capabilities:{}});
    // Only explicitly referenced secrets enter this process. Never persist transport output.
    const env:Record<string,string>={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOME','COMSPEC'])if(process.env[key])env[key]=process.env[key]!;
    const transport=new StdioClientTransport({...config,env:{...env,...config.env},stderr:'ignore'});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([(async()=>{await client.connect(transport);return client.listTools();})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('MCP 连接检测超时')),15000);})]);
      const next:Capability={...capability,status:'connected',tools:result.tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})),checkedAt:stamp(),detail:'stdio 连接与工具目录正常；需通过成员真实调用后才能标为已验证。'};
      this.store.put('capabilities',id,next);return next;
    }catch(error){const next:Capability={...capability,status:'failed',checkedAt:stamp(),detail:safeText(error instanceof Error?error.message:String(error))};this.store.put('capabilities',id,next);return next;}
    finally {clearTimeout(timer);await client.close().catch(()=>{});await transport.close().catch(()=>{});}
  }
  recordValidation(id:string,validation:CapabilityValidation):Capability {const capability=this.get(id);if(validation.revision!==capability.revision||validation.fingerprint!==this.fingerprint(capability))throw new WorkbenchError('能力文件或配置已改变，请重新验证',409);const next={...capability,validations:[...capability.validations.filter(v=>!(v.runtime===validation.runtime&&v.connectionId===validation.connectionId&&v.connectionRevision===validation.connectionRevision)),{...validation,stale:false}]};this.store.put('capabilities',id,next);return next;}
}
