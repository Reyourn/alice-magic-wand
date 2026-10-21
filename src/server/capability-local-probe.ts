import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// This process receives a fixed saved capability, never a model-selected command/path.
interface Config {kind:'skill'|'script';path:string;command?:string;args:string[];cwd:string;receipt:string;nonce:string;expectedHash?:string;environmentNames:string[];}
const config=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as Config;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
let readNonce:string|undefined,used=false;
const clean=(value:string)=>config.environmentNames.reduce((text,name)=>{const secret=process.env[name];return secret?text.split(secret).join('[redacted]'):text;},value).slice(0,12000);
const server=new Server({name:'workbench-local-capability-case',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:config.kind==='skill'?[
  {name:'read_bound_skill',description:'Read the exact bound skill. Returns its instructions and a read receipt token.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'complete_skill_case',description:'Submit the answer for this user-selected case after reading the skill. Only an independently checked exact answer passes.',inputSchema:{type:'object',properties:{readToken:{type:'string'},answer:{type:'string'}},required:['readToken','answer'],additionalProperties:false}},
]:[{name:'run_bound_script',description:'Execute the one saved script with its fixed interpreter and arguments, once. No command/path/argument overrides accepted.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const args=request.params.arguments??{},text=(value:string,isError=false)=>({content:[{type:'text' as const,text:clean(value)}],isError});
  if(config.kind==='skill'&&request.params.name==='read_bound_skill'&&Object.keys(args).length===0){const content=readFileSync(config.path,'utf8');readNonce=randomUUID();writeFileSync(config.receipt,JSON.stringify({nonce:config.nonce,readHash:hash(content),read:true}));return text(JSON.stringify({instructions:content,readToken:readNonce}));}
  if(config.kind==='skill'&&request.params.name==='complete_skill_case') {
    if(used||!readNonce||args.readToken!==readNonce||typeof args.answer!=='string'||Object.keys(args).some(key=>!['readToken','answer'].includes(key)))return text('The bound skill must be read first; one exact case submission is allowed.',true);
    used=true;const passed=hash(args.answer)===config.expectedHash;
    writeFileSync(config.receipt,JSON.stringify({nonce:config.nonce,read:true,readHash:hash(readFileSync(config.path)),passed,answerHash:hash(args.answer)}));
    return text(passed?'Selected case passed.':'Selected case did not match the independent expected answer.',!passed);
  }
  if(config.kind==='script'&&request.params.name==='run_bound_script'&&Object.keys(args).length===0&&!used){
    used=true;let output='',errors='';const command=config.command??config.path,argv=config.command?[config.path,...config.args]:config.args;
    const exitCode=await new Promise<number|null>(resolve=>{
      const child=spawn(command,argv,{cwd:config.cwd,env:process.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-20000);});child.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-20000);});
      const timer=setTimeout(()=>child.kill(),30000);child.once('error',error=>{errors=error.message;clearTimeout(timer);resolve(null);});child.once('close',code=>{clearTimeout(timer);resolve(code);});
    });
    writeFileSync(config.receipt,JSON.stringify({nonce:config.nonce,passed:exitCode===0,exitCode,scriptHash:hash(readFileSync(config.path)),outputHash:hash(output)}));
    return text(JSON.stringify({exitCode,stdout:output,stderr:errors}),exitCode!==0);
  }
  return text('This tool or override is outside the selected verification case.',true);
});
await server.connect(new StdioServerTransport());
