import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/index.js';
import { MAX_FILE_BYTES, type FileAttachment, type ImageAttachment, type RuntimeAdapter, type RuntimeConnection, type RuntimeEvent, type RuntimeImageAttachment, type RuntimeOptions } from '../src/shared/types.js';
import type { GitRepository, TaskRepository } from '../src/server/repositories.js';
import type { QueuedMessage } from '../src/server/store.js';
import { createPptxFixture } from '../scripts/fixtures/pptx.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGMAAAAASUVORK5CYII=';
const token='isolated-file-acceptance';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const tick=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
class FilesAdapter implements RuntimeAdapter {
  kind='codex' as const;
  sent:{text:string;messageId:string;images:RuntimeImageAttachment[]}[]=[];
  interruptions=0;
  async discover(){return {kind:this.kind,available:true,detail:'simulated file runtime',capabilities:{steer:false,interrupt:true,resume:true,approvals:true}};}
  async connect(_options:RuntimeOptions,emit:(event:RuntimeEvent)=>void):Promise<RuntimeConnection>{
    return {nativeSessionId:'files-test-session',pid:undefined,send:async(text,messageId,images=[])=>{this.sent.push({text,messageId,images});},interrupt:async()=>{this.interruptions++;emit({type:'result',data:{interrupted:true}});},respondApproval:async()=>{},close:async()=>{}};
  }
}
const tasks:TaskRepository={validate:async()=>{},list:async()=>[],get:async()=>{throw new Error('No test task');},create:async()=>{throw new Error('No test task');},update:async()=>{throw new Error('No test task');}};
const git:GitRepository={validate:async(path)=>path,createWorktree:async()=>{throw new Error('No test worktree');},inspect:async()=>({commit:'a'.repeat(40),dirty:false,diff:''}),resolveCommit:async(_project,ref)=>ref};
function payload(name='requirements.md',content='附件哨兵 FILE-CONTENT-5831',mimeType=''){return {name,mimeType,data:Buffer.from(content).toString('base64')};}
function documentFixtures(){
  const xml:Record<string,string>={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX-SENTINEL-4268</w:t></w:r></w:p></w:body></w:document>',
  };
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,content] of Object.entries(xml)){
    const filename=Buffer.from(name),bytes=Buffer.from(content);let crc=0xffffffff;
    for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);local.push(header,filename,bytes);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(bytes.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);central.push(entry,filename);offset+=header.length+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const stream='BT /F1 16 Tf 20 100 Td (PDF-SENTINEL-4268) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text='%PDF-1.4\n';const positions:number[]=[];
  for(const [index,object] of objects.entries()){positions.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n${positions.map(position=>`${String(position).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return {docx:Buffer.concat([...local,directory,end]),pdf:Buffer.from(text)};
}
async function setup(){
  const dir=mkdtempSync(join(tmpdir(),'awb-files-test-')),adapter=new FilesAdapter();
  let app=await buildApp({dataDir:dir,adapters:[adapter],tasks,git,token,staticRoot:false});
  const project=await app.workbench.createProject({name:'Files test',path:'C:/synthetic-files'});
  const agent=await app.workbench.createAgent({projectId:project.id,name:'文件主控',role:'controller',memberKind:'controller',runtime:'codex',permissionMode:'read-only'});
  cleanups.push(async()=>{await app.close();const target=resolve(dir),prefix=resolve(tmpdir());if(!target.startsWith(`${prefix}\\awb-files-test-`)&&!target.startsWith(`${prefix}/awb-files-test-`))throw new Error('Unexpected cleanup path');rmSync(target,{recursive:true,force:true});});
  const post=(url:string,input:unknown,key:string=randomUUID())=>app.inject({method:'POST',url,headers:{host:'127.0.0.1','x-workbench-token':token,'idempotency-key':key},payload:input as object});
  const upload=(input:unknown=payload(),target=agent.id,key?:string)=>post(`/api/agents/${target}/attachments`,input,key);
  const restart=async()=>{await app.close();app=await buildApp({dataDir:dir,adapters:[adapter],tasks,git,token,staticRoot:false});};
  return {get app(){return app;},dir,adapter,project,agent,post,upload,restart};
}

describe('ordinary files over HTTP with an isolated simulated runtime',()=>{
  it('extracts real PDF, DOCX, XLSX and Chinese PPTX uploads before dispatching four documents together',async()=>{
    const test=await setup(),fixtures=documentFixtures(),ExcelJS=(await import('exceljs')).default,book=new ExcelJS.Workbook();
    book.addWorksheet('证据').getCell('A1').value='XLSX-SENTINEL-4268';
    const files:FileAttachment[]=[];
    for(const [name,bytes] of [['sample.pdf',fixtures.pdf],['sample.docx',fixtures.docx],['sample.xlsx',Buffer.from(await book.xlsx.writeBuffer())],['2022年12月客户运营报告.pptx',await createPptxFixture()]] as const){
      const response=await test.upload({name,mimeType:'application/octet-stream',data:bytes.toString('base64')});expect(response.statusCode,response.body).toBe(201);files.push(response.json<FileAttachment>());
    }
    expect((await test.post(`/api/agents/${test.agent.id}/messages`,{text:'',attachmentIds:files.map(file=>file.id)})).statusCode).toBe(202);await tick();
    expect(test.adapter.sent).toHaveLength(1);expect(test.adapter.sent[0].images).toEqual([]);for(const format of ['PDF','DOCX','XLSX','PPTX'])expect(test.adapter.sent[0].text).toContain(`${format}-SENTINEL-4268`);
    const text=test.adapter.sent[0].text;expect(text).toContain('客户总数');expect(text).toContain('2689');expect(text).toContain('NOTE-4716');expect(text.indexOf('PPTX-SENTINEL-4268')).toBeLessThan(text.indexOf('SLIDE2-9057'));
    expect(files[3]).toMatchObject({kind:'file',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',extraction:{status:'ready'}});
  },20000);
  it('accepts code with empty browser MIME, exposes metadata only and downloads the original bytes after restart',async()=>{
    const test=await setup(),content='export const marker = "FILE-CONTENT-5831";\n// 中文注释\n',name='需求"说明.ts';
    const response=await test.upload(payload(name,content));expect(response.statusCode).toBe(201);
    const file=response.json<FileAttachment>();expect(file).toMatchObject({kind:'file',name,mimeType:'text/plain',size:Buffer.byteLength(content),extraction:{status:'ready'}});
    expect(Object.keys(file).sort()).toEqual(['extraction','id','kind','mimeType','name','size','url']);expect(JSON.stringify(file)).not.toContain('FILE-CONTENT-5831');
    await test.restart();
    await test.app.listen({host:'127.0.0.1',port:0});const address=test.app.server.address();if(!address||typeof address==='string')throw new Error('Missing address');
    const result=await fetch(`http://127.0.0.1:${address.port}${file.url}`);
    expect(result.status).toBe(200);expect(result.headers.get('content-disposition')).toBe(`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');expect(result.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await result.arrayBuffer())).toEqual(Buffer.from(content));expect(readdirSync(join(test.dir,'attachments'))).toEqual([`${file.id}.file`]);
  });
  it('delivers mixed attachment-only input with extracted text and image bytes, without exposing file text in history',async()=>{
    const test=await setup(),file=(await test.upload()).json<FileAttachment>(),image=(await test.upload({name:'sample.png',mimeType:'image/png',data:png})).json<ImageAttachment>();
    const input={text:'',attachmentIds:[file.id,image.id,file.id]},url=`/api/agents/${test.agent.id}/messages`;
    const [first,retry]=await Promise.all([test.post(url,input,'mixed-message'),test.post(url,input,'mixed-message')]);
    expect(first.statusCode).toBe(202);expect(first.json()).toEqual(retry.json());await tick();
    expect(test.adapter.sent).toHaveLength(1);expect(test.adapter.sent[0].text).toContain('FILE-CONTENT-5831');expect(test.adapter.sent[0].text).toContain(file.name);
    expect(test.adapter.sent[0].images).toHaveLength(1);expect(test.adapter.sent[0].images[0].id).toBe(image.id);
    const queued=test.app.workbench.store.events().find(event=>event.type==='message.queued');expect(queued?.data?.attachments).toEqual([file,image]);
    expect(test.app.workbench.store.all<QueuedMessage>('messages')[0]).toMatchObject({text:'',attachmentIds:[file.id,image.id]});
    const publicState=JSON.stringify(await test.app.workbench.snapshot());expect(publicState).not.toContain('FILE-CONTENT-5831');expect(publicState).not.toContain(png);expect(publicState).not.toContain(test.dir);
  });
  it('deduplicates concurrent file uploads, persists receipts and rejects a changed retry',async()=>{
    const test=await setup(),input=payload();
    const [a,b]=await Promise.all([test.upload(input,test.agent.id,'file-upload'),test.upload(input,test.agent.id,'file-upload')]);
    expect(a.statusCode).toBe(201);expect(a.json()).toEqual(b.json());expect(readdirSync(join(test.dir,'attachments'))).toHaveLength(1);
    expect((await test.upload(payload('changed.txt'),test.agent.id,'file-upload')).statusCode).toBe(409);
    await test.restart();expect((await test.upload(input,test.agent.id,'file-upload')).json()).toEqual(a.json());expect(readdirSync(join(test.dir,'attachments'))).toHaveLength(1);
  });
  it('rejects another member or a missing source file before interrupting the active writer',async()=>{
    const test=await setup(),foreign=(await test.upload()).json<FileAttachment>();
    const member=await test.app.workbench.createAgent({projectId:test.project.id,name:'Worker',role:'developer',runtime:'codex'});
    test.app.workbench.store.put('agents',member.id,{...member,worktree:'C:/synthetic-files/worktree'});
    vi.spyOn(test.app.workbench.connectionManager,'assertReady').mockResolvedValue({} as never);
    await test.app.workbench.message(member.id,{text:'keep running'},'first','controller');await tick();
    const url=`/api/agents/${member.id}/messages`;
    expect((await test.post(url,{text:'correct',attachmentIds:[foreign.id]})).statusCode).toBe(403);
    const own=(await test.upload(payload(),member.id)).json<FileAttachment>();unlinkSync(join(test.dir,'attachments',`${own.id}.file`));
    expect((await test.post(url,{text:'correct',attachmentIds:[own.id]})).statusCode).toBe(404);
    expect(test.adapter.interruptions).toBe(0);expect(test.adapter.sent).toHaveLength(1);expect(test.app.workbench.getAgent(member.id)).toMatchObject({controlMode:'auto',state:'running'});
  });
  it('counts files and images together and permits four file-only attachments',async()=>{
    const test=await setup(),files:FileAttachment[]=[];for(let i=0;i<4;i++)files.push((await test.upload(payload(`${i}.txt`,`SENTINEL-${i}`))).json<FileAttachment>());
    const image=(await test.upload({name:'sample.png',mimeType:'image/png',data:png})).json<ImageAttachment>(),url=`/api/agents/${test.agent.id}/messages`;
    expect((await test.post(url,{text:'',attachmentIds:[...files.map(file=>file.id),image.id]})).statusCode).toBe(400);
    expect((await test.post(url,{text:'',attachmentIds:files.map(file=>file.id)})).statusCode).toBe(202);await tick();
    expect(test.adapter.sent).toHaveLength(1);expect(test.adapter.sent[0].images).toEqual([]);for(let i=0;i<4;i++)expect(test.adapter.sent[0].text).toContain(`SENTINEL-${i}`);
  });
  it('accepts the ordinary file limit, reports text truncation and rejects over 20 MiB before saving',async()=>{
    const test=await setup(),text='z'.repeat(MAX_FILE_BYTES),response=await test.upload(payload('large.txt',text));
    expect(response.statusCode).toBe(201);expect(response.json<FileAttachment>()).toMatchObject({size:MAX_FILE_BYTES,extraction:{status:'truncated'}});expect(response.json<FileAttachment>().extraction.characters).toBeLessThanOrEqual(40000);
    const invalid=await test.upload(payload('too-large.txt',text+'z'));expect(invalid.statusCode).toBe(413);expect(test.app.workbench.store.all('attachments')).toHaveLength(1);
  },20000);
  it.each([
    ['unsupported executable',payload('program.exe','MZ-file')],
    ['invalid document',payload('broken.pdf','this is not a PDF','application/pdf')],
    ['invalid office archive',payload('broken.docx','not an archive')],
    ['binary content in text',payload('binary.txt','\u0000\u0001\u0002')],
    ['empty document',payload('empty.txt','')],
    ['control in filename',payload('bad\r\n.txt')],
  ])('rejects %s with a readable error and no saved attachment',async(_label,input)=>{
    const test=await setup(),response=await test.upload(input);expect(response.statusCode).toBe(400);expect(response.json().error).toMatch(/[\u4e00-\u9fff]/);expect(test.app.workbench.store.all('attachments')).toEqual([]);
  });
});
