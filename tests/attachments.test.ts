import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/index.js';
import { MAX_IMAGE_BYTES, type ImageAttachment, type RuntimeAdapter, type RuntimeConnection, type RuntimeEvent, type RuntimeImageAttachment, type RuntimeOptions } from '../src/shared/types.js';
import type { GitRepository, TaskRepository } from '../src/server/repositories.js';
import type { QueuedMessage } from '../src/server/store.js';
import { RuntimeInputError } from '../src/server/runtime/base.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGMAAAAASUVORK5CYII=';
const token='isolated-attachment-test';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const tick=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
class ImagesAdapter implements RuntimeAdapter {
  kind='codex' as const;
  sent:{text:string;messageId:string;images:RuntimeImageAttachment[]}[]=[];
  interruptions=0;
  nextSendError?:Error;
  emit?: (event:RuntimeEvent)=>void;
  async discover(){return {kind:this.kind,available:true,detail:'simulated image runtime',capabilities:{steer:false,interrupt:true,resume:true,approvals:true}};}
  async connect(_options:RuntimeOptions,emit:(event:RuntimeEvent)=>void):Promise<RuntimeConnection> {
    this.emit=emit;
    return {nativeSessionId:'image-test-session',pid:undefined,send:async(text,messageId,images=[])=>{const error=this.nextSendError;this.nextSendError=undefined;if(error)throw error;this.sent.push({text,messageId,images});},interrupt:async()=>{this.interruptions++;emit({type:'result',data:{interrupted:true}});},respondApproval:async()=>{},close:async()=>{}};
  }
}
const tasks:TaskRepository={validate:async()=>{},list:async()=>[],get:async()=>{throw new Error('No test task');},create:async()=>{throw new Error('No test task');},update:async()=>{throw new Error('No test task');}};
const git:GitRepository={validate:async(path)=>path,createWorktree:async()=>{throw new Error('No test worktree');},inspect:async()=>({commit:'a'.repeat(40),dirty:false,diff:''}),resolveCommit:async(_project,ref)=>ref};
async function setup() {
  const dir=mkdtempSync(join(tmpdir(),'awb-images-test-')),adapter=new ImagesAdapter();
  let app=await buildApp({dataDir:dir,adapters:[adapter],tasks,git,token,staticRoot:false});
  const project=await app.workbench.createProject({name:'Images test',path:'C:/synthetic-images'});
  const agent=await app.workbench.createAgent({projectId:project.id,name:'图片主控',role:'controller',memberKind:'controller',runtime:'codex',permissionMode:'read-only'});
  cleanups.push(async()=>{await app.close();const target=resolve(dir);if(!target.startsWith(`${resolve(tmpdir())}\\awb-images-test-`)&&!target.startsWith(`${resolve(tmpdir())}/awb-images-test-`))throw new Error('Unexpected test cleanup path');rmSync(target,{recursive:true,force:true});});
  const post=(url:string,payload:unknown,key:string=randomUUID())=>app.inject({method:'POST',url,headers:{host:'127.0.0.1','x-workbench-token':token,'idempotency-key':key},payload:payload as object});
  const upload=(target=agent.id,payload:unknown={name:'截图.png',mimeType:'image/png',data:png},key?:string)=>post(`/api/agents/${target}/attachments`,payload,key);
  const restart=async()=>{await app.close();app=await buildApp({dataDir:dir,adapters:[adapter],tasks,git,token,staticRoot:false});return app;};
  return {get app(){return app;},dir,adapter,project,agent,post,upload,restart};
}

describe('durable image attachments through HTTP and the service',()=>{
  it('keeps confirmed input rejection recoverable without falsely requiring process recovery',async()=>{
    const test=await setup(),image=(await test.upload()).json<ImageAttachment>();
    test.adapter.nextSendError=new RuntimeInputError('当前模型不支持图片');
    const response=await test.post(`/api/agents/${test.agent.id}/messages`,{text:'识图',attachmentIds:[image.id]});
    expect(response.statusCode).toBe(202);await tick();
    expect(test.adapter.sent).toHaveLength(0);
    expect(test.app.workbench.getAgent(test.agent.id).state).toBe('error');
    expect(test.app.workbench.store.get<QueuedMessage>('messages',response.json().messageId)?.state).toBe('failed');
    expect(test.app.workbench.store.get<{state:string}>('runs',test.agent.id)?.state).toBe('terminal');
    expect((await test.app.workbench.updateAgent(test.agent.id,{model:'vision-model'})).model).toBe('vision-model');
    expect((await test.post(`/api/agents/${test.agent.id}/messages`,{text:'改用图片模型重试',attachmentIds:[image.id]})).statusCode).toBe(202);
    await tick();expect(test.adapter.sent).toHaveLength(1);expect(test.app.workbench.getAgent(test.agent.id).state).toBe('running');
  });
  it('preserves unknown delivery protection for a transport error after send begins',async()=>{
    const test=await setup(),image=(await test.upload()).json<ImageAttachment>();
    test.adapter.nextSendError=new Error('连接断开，无法确认投递');
    const response=await test.post(`/api/agents/${test.agent.id}/messages`,{text:'识图',attachmentIds:[image.id]});await tick();
    expect(test.app.workbench.getAgent(test.agent.id).state).toBe('unknown');
    expect(test.app.workbench.store.get<QueuedMessage>('messages',response.json().messageId)?.state).toBe('uncertain');
    await expect(test.app.workbench.updateAgent(test.agent.id,{model:'vision-model'})).rejects.toThrow('核实会话');
    expect((await test.post(`/api/agents/${test.agent.id}/messages`,{text:'禁止盲目重试'})).statusCode).toBe(409);
  });
  it('persists the bytes outside projects, returns safe metadata and serves them after restart',async()=>{
    const test=await setup();
    const response=await test.upload(test.agent.id,{name:'../../屏幕截图.png',mimeType:'image/png',data:png});
    expect(response.statusCode).toBe(201);
    const image=response.json<ImageAttachment>();
    expect(Object.keys(image).sort()).toEqual(['id','mimeType','name','size','url']);
    expect(image).toMatchObject({name:'../../屏幕截图.png',mimeType:'image/png',size:Buffer.from(png,'base64').length,url:`/api/attachments/${image.id}`});
    expect(readdirSync(join(test.dir,'attachments'))).toEqual([`${image.id}.png`]);
    const app=await test.restart();
    await app.listen({port:0,host:'127.0.0.1'});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing test address');
    const result=await fetch(`http://127.0.0.1:${address.port}${image.url}`);
    expect(result.status).toBe(200);expect(result.headers.get('content-type')).toContain('image/png');expect(result.headers.get('x-content-type-options')).toBe('nosniff');expect(result.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(Buffer.from(await result.arrayBuffer())).toEqual(Buffer.from(png,'base64'));
    const retry=await test.upload(test.agent.id,{name:'../../屏幕截图.png',mimeType:'image/png',data:png},'different-upload');expect(retry.statusCode).toBe(201);
  });
  it('requires the existing mutation token and an idempotency key for uploads',async()=>{
    const test=await setup(),url=`/api/agents/${test.agent.id}/attachments`,payload={name:'x.png',mimeType:'image/png',data:png};
    const denied=await test.app.inject({method:'POST',url,headers:{host:'127.0.0.1'},payload});expect(denied.statusCode).toBe(401);
    const noKey=await test.app.inject({method:'POST',url,headers:{host:'127.0.0.1','x-workbench-token':token},payload});expect(noKey.statusCode).toBe(400);
    expect(test.app.workbench.store.all('attachments')).toEqual([]);
  });
  it.each([
    ['SVG',{name:'x.svg',mimeType:'image/svg+xml',data:Buffer.from('<svg/>').toString('base64')}],
    ['MIME mismatch',{name:'x.jpg',mimeType:'image/jpeg',data:png}],
    ['invalid signature',{name:'x.png',mimeType:'image/png',data:Buffer.from('not a picture').toString('base64')}],
    ['invalid base64',{name:'x.png',mimeType:'image/png',data:png+'!'}],
    ['base64 URI',{name:'x.png',mimeType:'image/png',data:`data:image/png;base64,${png}`}],
    ['empty name',{name:' ',mimeType:'image/png',data:png}],
    ['long name',{name:'x'.repeat(201),mimeType:'image/png',data:png}],
    ['control in name',{name:'a\u0000.png',mimeType:'image/png',data:png}],
  ])('rejects %s without saving bytes or recording the raw request',async(_name,payload)=>{
    const test=await setup(),result=await test.upload(test.agent.id,payload);expect(result.statusCode).toBe(400);
    expect(test.app.workbench.store.all('attachments')).toEqual([]);expect(JSON.stringify(test.app.workbench.store.events())).not.toContain(png);
  });
  it('accepts an upload above the ordinary body limit, rejects above 5 MiB and keeps other routes limited',async()=>{
    const test=await setup(),bytes=Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(1024*1024)]);
    expect((await test.upload(test.agent.id,{name:'large.png',mimeType:'image/png',data:bytes.toString('base64')})).statusCode).toBe(201);
    expect((await test.upload(test.agent.id,{name:'too-large.png',mimeType:'image/png',data:Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')})).statusCode).toBe(413);
    expect((await test.post(`/api/agents/${test.agent.id}/messages`,{text:'x'.repeat(1024*1024+1)})).statusCode).toBe(413);
    expect(test.app.workbench.store.all('attachments')).toHaveLength(1);
  });
  it('deduplicates concurrent upload retries and preserves their result after restart',async()=>{
    const test=await setup(),payload={name:'x.png',mimeType:'image/png',data:png};
    const [a,b]=await Promise.all([test.upload(test.agent.id,payload,'same-upload'),test.upload(test.agent.id,payload,'same-upload')]);
    expect(a.statusCode).toBe(201);expect(a.json()).toEqual(b.json());expect(readdirSync(join(test.dir,'attachments'))).toHaveLength(1);
    expect((await test.upload(test.agent.id,{...payload,name:'other.png'},'same-upload')).statusCode).toBe(409);
    await test.restart();expect((await test.upload(test.agent.id,payload,'same-upload')).json()).toEqual(a.json());expect(readdirSync(join(test.dir,'attachments'))).toHaveLength(1);
  });
  it('delivers image-only messages once to the runtime and stores only IDs and public history metadata',async()=>{
    const test=await setup(),image=(await test.upload()).json<ImageAttachment>(),payload={text:'',attachmentIds:[image.id,image.id]};
    const [a,b]=await Promise.all([test.post(`/api/agents/${test.agent.id}/messages`,payload,'same-message'),test.post(`/api/agents/${test.agent.id}/messages`,payload,'same-message')]);
    expect(a.statusCode).toBe(202);expect(a.json()).toEqual(b.json());await tick();
    expect(test.adapter.sent).toHaveLength(1);expect(test.adapter.sent[0].text).toBe('');expect(test.adapter.sent[0].images).toHaveLength(1);
    expect(readFileSync(test.adapter.sent[0].images[0].path)).toEqual(Buffer.from(png,'base64'));
    const message=test.app.workbench.store.all<QueuedMessage>('messages')[0];expect(message.attachmentIds).toEqual([image.id]);expect(JSON.stringify(message)).not.toContain(test.dir);
    const queued=test.app.workbench.store.events().find(event=>event.type==='message.queued');expect(queued?.data?.attachments).toEqual([image]);
    const publicState=JSON.stringify(await test.app.workbench.snapshot());expect(publicState).not.toContain(png);expect(publicState).not.toContain(test.adapter.sent[0].images[0].path);
    const image2=(await test.upload()).json<ImageAttachment>();expect((await test.post(`/api/agents/${test.agent.id}/messages`,{...payload,attachmentIds:[image2.id]},'same-message')).statusCode).toBe(409);expect(test.adapter.interruptions).toBe(0);
  });
  it('validates foreign images and missing files before human takeover or interruption',async()=>{
    const test=await setup(),image=(await test.upload()).json<ImageAttachment>();
    const member=await test.app.workbench.createAgent({projectId:test.project.id,name:'Worker',role:'developer',runtime:'codex'});
    test.app.workbench.store.put('agents',member.id,{...member,worktree:'C:/synthetic-images/worktree'});
    vi.spyOn(test.app.workbench.connectionManager,'assertReady').mockResolvedValue({} as never);
    await test.app.workbench.message(member.id,{text:'keep running'},'first','controller');await tick();
    const response=await test.post(`/api/agents/${member.id}/messages`,{text:'replace',attachmentIds:[image.id]});expect(response.statusCode).toBe(403);
    expect(test.adapter.interruptions).toBe(0);expect(test.app.workbench.getAgent(member.id)).toMatchObject({controlMode:'auto',state:'running'});
    const own=(await test.upload(member.id)).json<ImageAttachment>();unlinkSync(join(test.dir,'attachments',`${own.id}.png`));
    expect((await test.post(`/api/agents/${member.id}/messages`,{text:'replace',attachmentIds:[own.id]})).statusCode).toBe(404);
    expect(test.adapter.interruptions).toBe(0);expect(test.app.workbench.getAgent(member.id).controlMode).toBe('auto');expect(test.adapter.sent).toHaveLength(1);
  });
  it('enforces the per-message cap, rejects invalid IDs and accepts four distinct images',async()=>{
    const test=await setup(),ids:string[]=[];for(let i=0;i<5;i++)ids.push((await test.upload()).json<ImageAttachment>().id);
    const url=`/api/agents/${test.agent.id}/messages`;
    expect((await test.post(url,{text:'',attachmentIds:ids})).statusCode).toBe(400);
    expect((await test.post(url,{text:'',attachmentIds:['../../anything']})).statusCode).toBe(400);
    expect((await test.post(url,{text:'',attachmentIds:[]})).statusCode).toBe(400);
    expect((await test.post(url,{text:'',attachmentIds:[randomUUID()]})).statusCode).toBe(404);
    expect((await test.post(url,{text:'',attachmentIds:ids.slice(0,4)})).statusCode).toBe(202);await tick();expect(test.adapter.sent[0].images).toHaveLength(4);
  });
});
