/** One fresh native session through real upload/message HTTP routes; never resumes user work. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/server/index.js';
import { createAdapters } from '../src/server/runtime/index.js';
import { safeData, safeText } from '../src/server/runtime/process.js';
import type { GitRepository, TaskRepository } from '../src/server/repositories.js';
import type { Approval, FileAttachment, RuntimeAdapter, RuntimeConnection, RuntimeKind } from '../src/shared/types.js';
import { createPptxFixture } from './fixtures/pptx.mjs';

const args=process.argv.slice(2),arg=(name:string)=>{const index=args.indexOf(`--${name}`);return index<0?undefined:args[index+1];};
if(args.includes('--help')){console.log('npx tsx scripts/validate-file-runtime.ts --runtime codex|claude|workbuddy [--format pptx] --out REPORT.json');process.exit(0);}
const kind=arg('runtime') as RuntimeKind,out=arg('out'),format=arg('format');
if(!['codex','claude','workbuddy'].includes(kind)||!out)throw new Error('请传入 --runtime codex|claude|workbuddy --out REPORT.json');
if(format!==undefined&&format!=='pptx')throw new Error('--format 目前仅支持 pptx；省略时验证 PDF、DOCX、XLSX 和 Markdown。');
const root=fileURLToPath(new URL('../',import.meta.url)),directory=join(root,'.workbench','file-runtime-validation');
await mkdir(directory,{recursive:true});await mkdir(dirname(resolve(out)),{recursive:true});
const evidence=await mkdtemp(join(directory,`${kind}-`)),cwd=join(evidence,'workspace');await mkdir(cwd);
const fixtures=join(evidence,'fixtures');await mkdir(fixtures);
const presentationName='2022年12月客户运营报告.pptx';
const ordinaryExpected={'sample.pdf':'PDF-2078','sample.docx':'DOCX-6519','sample.xlsx':'XLSX-9247','sample.md':'MD-3186'};
const expected:Record<string,string>=format==='pptx'?{[presentationName]:'PPTX-6832'}:ordinaryExpected;
function pdf(text:string):Buffer {
  const stream=`BT /F1 16 Tf 20 100 Td (Verification code: ${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result='%PDF-1.4\n';const offsets:number[]=[];for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(result));result+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(result);return Buffer.from(result+`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const zip=new JSZip();
zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文件验证码：${ordinaryExpected['sample.docx']}</w:t></w:r></w:p></w:body></w:document>`);
const book=new ExcelJS.Workbook();book.addWorksheet('验收').addRows([['项目','验证码'],['合成文件',ordinaryExpected['sample.xlsx']]]);
const files:Record<string,Buffer>=format==='pptx'?{[presentationName]:await createPptxFixture(expected[presentationName])}:{'sample.pdf':pdf(ordinaryExpected['sample.pdf']),'sample.docx':await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'sample.xlsx':Buffer.from(await book.xlsx.writeBuffer()),'sample.md':Buffer.from(`# 合成文件\n\n文件验证码：${ordinaryExpected['sample.md']}\n`)};
for(const [name,bytes] of Object.entries(files))await writeFile(join(fixtures,name),bytes);
const tasks:TaskRepository={validate:async()=>{},list:async()=>[],get:async()=>{throw new Error('Synthetic probe has no tasks');},create:async()=>{throw new Error('Synthetic probe has no tasks');},update:async()=>{throw new Error('Synthetic probe has no tasks');}};
const git:GitRepository={validate:async path=>path,createWorktree:async()=>{throw new Error('Synthetic probe uses its own empty workspace');},inspect:async()=>({commit:'a'.repeat(40),dirty:false,diff:''}),resolveCommit:async(_project,ref)=>ref};
let native:RuntimeConnection|undefined,toolEvents=0,approvalsDenied=0,terminal=false,failure:string|undefined,agentId='',messageId='';
const answers:string[]=[],deltas:string[]=[],errors:string[]=[],observed:{model:unknown;provider:unknown}[]=[],usage:unknown[]=[],results:{text:string;isError:unknown;interrupted:unknown}[]=[];
const original=createAdapters()[kind],adapter:RuntimeAdapter={...original,async connect(options,emit){
  native=await original.connect(options,event=>{
    if(event.type==='message'&&event.text)answers.push(safeText(event.text));
    if(event.type==='delta'&&event.text)deltas.push(safeText(event.text));
    if(event.type==='tool')toolEvents++;
    if(event.type==='ready')observed.push({model:safeData(event.data?.model),provider:safeData(event.data?.provider)});
    if(event.type==='usage')usage.push(safeData(event.data));
    if(event.type==='error')errors.push(safeText(event.text));
    if(event.type==='result')results.push({text:safeText(event.text),isError:event.data?.isError,interrupted:event.data?.interrupted});
    emit(event);
  });return native;
}};
const token=randomUUID();let app:Awaited<ReturnType<typeof buildApp>>|undefined;const uploaded:FileAttachment[]=[];
try {
  app=await buildApp({dataDir:join(evidence,'data'),adapters:[adapter],tasks,git,token,staticRoot:false});
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing loopback address');const base=`http://127.0.0.1:${address.port}`;
  const post=async(path:string,input:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':token,'Idempotency-Key':randomUUID()},body:JSON.stringify(input)});const value=await response.json();if(!response.ok)throw new Error(safeText(value.error??`HTTP ${response.status}`));return value;};
  const project=await app.workbench.createProject({name:'隔离文件原生验收',path:cwd});
  const agent=await app.workbench.createAgent({projectId:project.id,name:'文件读取验证',role:'developer',runtime:kind,permissionMode:'read-only',instructions:'本次仅核对用户上传的合成文件，直接使用消息内提取内容回答。禁止调用工具、读取本机文件、搜索网络或更改代码。没有任何实际开发任务。'});
  agentId=agent.id;app.workbench.store.put('agents',agent.id,{...agent,worktree:cwd});
  app.workbench.on('event',event=>{if(event.agentId===agentId&&['agent.turn_completed','agent.turn_failed','runtime.failure'].includes(event.type))terminal=true;});
  for(const [name,bytes] of Object.entries(files))uploaded.push(await post(`/api/agents/${agentId}/attachments`,{name,mimeType:'application/octet-stream',data:bytes.toString('base64')}));
  const deadline=Date.now()+90000;
  const prompt=format==='pptx'?'请列出所附演示文稿的文件名，按幻灯片展示顺序逐页列出标题和该页验证码，再列出表格中的客户总数以及演讲者备注中的验证码。只根据附带文件内容回答，不调用工具，不猜测；未读到则明确说明。':'请逐个列出所附四个文件的文件名和其中的验证码。只根据附带文件内容回答，不调用工具，不猜测；未读到则明确说明。';
  const queued=await post(`/api/agents/${agentId}/messages`,{text:prompt,attachmentIds:uploaded.map(file=>file.id)});messageId=queued.messageId;
  while(!terminal&&Date.now()<deadline){
    for(const approval of app.workbench.store.all<Approval>('approvals'))if(approval.agentId===agentId){await app.workbench.respondApproval(agentId,approval.id,false);approvalsDenied++;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!terminal)failure='文件读取探针超过 90 秒，已结束自有会话，没有重试。';
  const finalAgent=app.workbench.getAgent(agentId);if(finalAgent.lastError)failure??=safeText(finalAgent.lastError);
} catch(error){failure=safeText(error instanceof Error?error.message:String(error));}
finally {await app?.close().catch(error=>{failure??=safeText(error instanceof Error?error.message:String(error));});}
const answer=answers.length?answers.join('\n'):deltas.join(''),pid=native?.pid;
let processStillAlive:boolean|undefined;if(pid){try{process.kill(pid,0);processStillAlive=true;}catch{processStillAlive=false;}}
const codes=Object.fromEntries(Object.entries(expected).map(([file,code])=>[file,answer.includes(code)]));
const presentationChecks=format==='pptx'?{filename:answer.includes(presentationName),table:answer.includes('2689'),slideTitle:answer.includes('行动计划'),slideOrder:answer.includes('SLIDE2-9057')&&answer.indexOf(expected[presentationName])<answer.indexOf('SLIDE2-9057'),notes:answer.includes('NOTE-4716')}:undefined;
const passed=!failure&&!errors.length&&terminal&&Object.values(codes).every(Boolean)&&(!presentationChecks||Object.values(presentationChecks).every(Boolean))&&!toolEvents&&!results.some(result=>result.isError===true||result.interrupted===true)&&processStillAlive!==true;
const report={passed,runtime:kind,format:format??'documents',nativeRuntime:true,configuredModel:'native-default',check:`Fresh isolated developer session; ${Object.keys(files).length} real HTTP uploads and one message; no resumed work; synthetic task/Git repositories; tool approvals denied.`,evidence,cwd,messageId,nativeSessionId:native?.nativeSessionId,observed,answer,codes,presentationChecks,attachments:uploaded.map(file=>({name:file.name,size:file.size,mimeType:file.mimeType,extraction:file.extraction})),toolEvents,approvalsDenied,processStillAlive,failure,errors,results,usage};
await writeFile(resolve(out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!passed)process.exitCode=1;
