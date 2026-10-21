import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RuntimeAdapter, RuntimeKind, WorkbenchEvent } from '../shared/types.js';
import { isImageAttachment } from '../shared/types.js';
import { createAdapters } from './runtime/index.js';
import { WorkbenchService, type ServiceOptions } from './service.js';
import { WorkbenchError } from './repositories.js';
import { registerUpgradeRoutes } from './upgrade-routes.js';

export interface AppOptions extends Partial<Omit<ServiceOptions,'dataDir'|'adapters'>> {
  dataDir?:string;
  adapters?:RuntimeAdapter[]|Record<RuntimeKind,RuntimeAdapter>;
  token?:string;
  staticRoot?:string|false;
  logger?:boolean;
}
function loopback(host:string):boolean {return ['localhost','127.0.0.1','[::1]','::1'].includes(host.toLowerCase());}
function safeEqual(a:unknown,b:string):boolean {return typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function body(value:unknown):Record<string,unknown> {return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
export async function buildApp(options:AppOptions={}):Promise<FastifyInstance & {workbench:WorkbenchService}> {
  const app=Fastify({logger:options.logger??false,bodyLimit:1024*1024});
  const token=options.token??randomBytes(32).toString('hex');
  const service=new WorkbenchService({...options,dataDir:options.dataDir??process.env.WORKBENCH_DATA_DIR??join(homedir(),'.agent-workbench'),adapters:options.adapters??createAdapters()});
  const streams=new Set<import('node:http').ServerResponse>();
  app.decorate('workbench',service);
  app.addHook('onRequest',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','no-referrer');
    const host=request.headers.host??'';
    let hostUrl:URL;try{hostUrl=new URL(`http://${host}`);}catch{throw new WorkbenchError('无效 Host',403);}
    if(!loopback(hostUrl.hostname))throw new WorkbenchError('服务只接受本机 Host',403);
    if(request.headers.origin) {
      let origin:URL;try{origin=new URL(request.headers.origin);}catch{throw new WorkbenchError('无效 Origin',403);}
      if(!loopback(origin.hostname)||!['http:','https:'].includes(origin.protocol))throw new WorkbenchError('拒绝非本机来源',403);
      // Only the same origin or the local Vite development port may access the API.
      if(origin.host!==host&&!(process.env.NODE_ENV!=='production'&&origin.port==='4311'))throw new WorkbenchError('来源端口与工作台不匹配',403);
    }
    if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
      if(request.url.startsWith('/api/controller/')||request.url.startsWith('/api/member/')) {
        const id=request.url.split('/')[3];const authorization=request.headers.authorization;
        const valid=id&&authorization?.startsWith('Bearer ')&&(request.url.startsWith('/api/controller/')?service.authenticateController(id,authorization.slice(7)):service.authenticateMember(id,authorization.slice(7)));
        if(!valid)throw new WorkbenchError('成员能力凭据无效',401);
      }else if(!safeEqual(request.headers['x-workbench-token'],token))throw new WorkbenchError('工作台令牌无效，请刷新页面',401);
    }
  });
  app.setErrorHandler((error,_request,reply)=>{
    const status=error instanceof WorkbenchError?error.statusCode:((error as {statusCode?:number}).statusCode??500);
    reply.code(status).send({error:service.publicError(error),statusCode:status,...(error instanceof WorkbenchError&&error.retrySafe?{retrySafe:true}:{})});
  });
  app.get('/api/health',async()=>({app:'agent-workbench',pid:process.pid}));
  app.get('/api/bootstrap',async()=>({token}));
  app.post('/api/shutdown',async(_request,reply)=>{
    process.stderr.write(`[workbench] 收到关闭请求，正在关闭（pid ${process.pid}）\n`);
    reply.send({ok:true});
    setImmediate(()=>{void app.close().then(()=>process.stderr.write(`[workbench] 已关闭（pid ${process.pid}）\n`)).catch(error=>process.stderr.write(`Shutdown failed: ${service.publicError(error)}\n`));});
  });
  app.get('/api/state',async()=>service.snapshot());
  app.get('/api/projects/discovery',async()=>service.discoverProjects());
  app.get('/api/events',async(request,reply)=>{
    const query=request.query as {after?:string};const after=Number(request.headers['last-event-id']??query.after??0);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
    let closed=false;
    const send=(event:WorkbenchEvent)=>{if(!closed)reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);};
    // Attach before replay. JS synchronous SQLite replay prevents an event gap.
    service.on('event',send);
    for(const event of service.store.events(Number.isFinite(after)?after:0,1000))send(event);
    reply.raw.write(': connected\n\n');
    const heartbeat=setInterval(()=>{if(!closed)reply.raw.write(': heartbeat\n\n');},15000);
    const close=()=>{if(closed)return;closed=true;streams.delete(reply.raw);clearInterval(heartbeat);service.off('event',send);};
    request.raw.once('close',close);reply.raw.once('close',close);
  });
  app.post('/api/projects',async(request,reply)=>{const project=await service.createProject(request.body);return reply.code(201).send(project);});
  app.post('/api/agents',async(request,reply)=>reply.code(201).send(await service.createAgent(request.body)));
  app.get<{Params:{id:string};Querystring:{refresh?:string}}>('/api/agents/:id/models',async request=>service.modelsForAgent(request.params.id,request.query.refresh==='1'));
  app.patch<{Params:{id:string}}>('/api/agents/:id',async request=>service.updateAgent(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/agents/:id/control',async request=>service.control(request.params.id,body(request.body).mode));
  app.post<{Params:{id:string}}>('/api/agents/:id/attachments',{bodyLimit:28*1024*1024},async(request,reply)=>reply.code(201).send(await service.uploadAttachment(request.params.id,request.body,request.headers['idempotency-key'])));
  app.get<{Params:{id:string}}>('/api/attachments/:id',async(request,reply)=>{
    const {image,bytes}=service.readAttachment(request.params.id);
    if(!isImageAttachment(image))reply.header('Content-Disposition',`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(image.name).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    return reply.type(image.mimeType).header('Content-Security-Policy',"default-src 'none'; sandbox").send(bytes);
  });
  app.post<{Params:{id:string}}>('/api/agents/:id/messages',async(request,reply)=>reply.code(202).send(await service.message(request.params.id,request.body,request.headers['idempotency-key'],'human')));
  app.post<{Params:{id:string}}>('/api/agents/:id/interrupt',async request=>service.interrupt(request.params.id));
  app.post<{Params:{id:string}}>('/api/agents/:id/recover',async request=>service.recover(request.params.id));
  app.post<{Params:{id:string;approvalId:string}}>('/api/agents/:id/approvals/:approvalId',async request=>service.respondApproval(request.params.id,request.params.approvalId,body(request.body).allow));
  app.post('/api/tasks',async(request,reply)=>reply.code(201).send(await service.createTask(request.body)));
  app.post<{Params:{id:string}}>('/api/tasks/:id/dispatch',async(request,reply)=>reply.code(202).send(await service.dispatch(request.params.id,request.body,request.headers['idempotency-key'])));
  app.post<{Params:{id:string}}>('/api/tasks/:id/status',async request=>service.setTaskStatus(request.params.id,request.body));
  app.post('/api/artifacts',async(request,reply)=>reply.code(201).send(await service.recordArtifact(request.body)));
  app.post<{Params:{id:string}}>('/api/controller/:id/tools',async request=>{const input=body(request.body);return service.controllerTool(request.params.id,input.name,input.arguments);});
  app.post<{Params:{id:string}}>('/api/member/:id/tools',async request=>{const input=body(request.body);return service.memberTool(request.params.id,input.name,input.arguments);});
  registerUpgradeRoutes(app,service);
  app.addHook('onListen',async()=>{const address=app.server.address();if(address&&typeof address==='object')service.setBaseUrl(`http://127.0.0.1:${address.port}`);if(!options.adapters||typeof options.authenticationMonitorIntervalMs==='number')service.startAuthenticationMonitoring();});
  app.addHook('preClose',async()=>{for(const stream of streams)stream.end();streams.clear();});
  app.addHook('onClose',async()=>service.close());
  const staticRoot=options.staticRoot===false?undefined:options.staticRoot??resolve(dirname(fileURLToPath(import.meta.url)),'../public');
  if(staticRoot&&existsSync(staticRoot)) {
    await app.register(fastifyStatic,{root:staticRoot});
    app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
  }
  return app as unknown as FastifyInstance & {workbench:WorkbenchService};
}

async function main():Promise<void> {
  const app=await buildApp({logger:false});
  const port=Number(process.env.WORKBENCH_PORT??4310);
  const address=await app.listen({host:'127.0.0.1',port});
  process.stdout.write(`Agent Workbench: ${address} (pid ${process.pid})\n`);
  // A process killed from outside leaves no line at all, so a graceful stop must
  // always be distinguishable from an unexplained exit. No secrets are logged.
  let closing=false;
  const close=(signal:string)=>{if(closing)return;closing=true;process.stderr.write(`[workbench] 收到 ${signal}，正在关闭（pid ${process.pid}）\n`);void app.close().then(()=>{process.stderr.write(`[workbench] 已关闭（pid ${process.pid}）\n`);process.exit(0);}).catch(error=>{process.stderr.write(`[workbench] 关闭失败：${error instanceof Error?error.message:String(error)}\n`);process.exit(1);});};
  process.once('SIGINT',()=>close('SIGINT'));process.once('SIGTERM',()=>close('SIGTERM'));
  process.on('uncaughtException',error=>{process.stderr.write(`[workbench] 未捕获异常：${error instanceof Error?error.message:String(error)}\n`);process.exit(1);});
  process.on('unhandledRejection',reason=>{process.stderr.write(`[workbench] 未处理的拒绝：${reason instanceof Error?reason.message:String(reason)}\n`);process.exit(1);});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
