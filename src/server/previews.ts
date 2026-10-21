import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { extractDocument } from './documents.js';
import { assertUniqueRelativePaths, fileHash, safeExistingFile, safeRelativePath } from './workflows/files.js';
import { WorkbenchError } from './repositories.js';
import { DocumentConverter } from './document-converter.js';

export interface Preview {kind:'text'|'image'|'pdf'|'html'|'table'|'document';title:string;text?:string;url?:string;downloadUrl:string;detail?:string;}
type PreviewFile={name:string;path:string;sha256:string;relativePath?:string};
const mimeByExt:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.pdf':'application/pdf','.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2'};
/** Untrusted HTML never shares the workbench origin or receives its control credential. */
export class PreviewServer {
  readonly converter?:DocumentConverter;
  constructor(directory?:string){if(directory)this.converter=new DocumentConverter(directory);}
  private app?:FastifyInstance;private starting?:Promise<void>;private origin='';
  private grants=new Map<string,{files:Map<string,{path:string;hash:string}>;created:number}>();
  private async start():Promise<void> {
    if(this.app)return;if(this.starting)return this.starting;
    this.starting=(async()=>{
      const app=Fastify({logger:false});
      app.get<{Params:{grant:string;'*':string}}>('/p/:grant/*',async(request,reply)=>{
        const host=request.headers.host??'';if(host!==new URL(this.origin).host)return reply.code(403).send();
        const grant=this.grants.get(request.params.grant),entry=grant?.files.get(request.params['*']);
        if(!grant||!entry||Date.now()-grant.created>3600000)return reply.code(404).send('预览已过期，请重新打开');
        if(fileHash(entry.path)!==entry.hash)return reply.code(409).send('成果内容已改变，请重新核对版本');
        reply.header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:* http://localhost:*");
        reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
        // Sandboxed HTML has an opaque origin. ES modules and fonts need CORS;
        // this grant serves only fixed public preview bytes, never credentials.
        reply.header('Access-Control-Allow-Origin','null');
        return reply.type(mimeByExt[extname(entry.path).toLowerCase()]??'application/octet-stream').send(readFileSync(entry.path));
      });
      this.origin=await app.listen({host:'127.0.0.1',port:0});this.app=app;
    })();try{await this.starting;}finally{this.starting=undefined;}
  }
  async html(path:string,files:PreviewFile[]=[]):Promise<string> {
    const selected=files.find(file=>resolve(file.path)===resolve(path));
    const entries=[...files,...(selected?[]:[{name:basename(path),path,sha256:fileHash(path)}])];
    const current=entries.filter(file=>file.relativePath!==undefined),legacy=entries.filter(file=>file.relativePath===undefined);
    const paths=assertUniqueRelativePaths(current.map(file=>file.relativePath!));
    const map=new Map(current.map((file,index)=>[paths[index]!,{path:file.path,hash:file.sha256}]));
    const key=(value:string)=>value.normalize('NFC').toLowerCase();
    const occupied=(name:string)=>[...map.keys()].some(existing=>key(existing)===key(name));
    const addLegacyAliases=(nameOf:(file:PreviewFile)=>string)=>{
      const groups=new Map<string,{name:string;files:PreviewFile[]}>();
      for(const file of legacy){const name=safeRelativePath(nameOf(file)),group=groups.get(key(name))??{name,files:[]};group.files.push(file);groups.set(key(name),group);}
      for(const {name,files:matching} of groups.values()){
        if(new Set(matching.map(file=>resolve(file.path))).size!==1||occupied(name))continue;
        const file=matching[0]!;map.set(name,{path:file.path,hash:file.sha256});
      }
    };
    // Old bundles were flattened to 0-name / 1-name. Keep those exact entries
    // and unique original-name aliases, but never guess which duplicate name
    // an old relative reference meant. Ambiguous aliases simply remain absent.
    addLegacyAliases(file=>basename(file.path));
    addLegacyAliases(file=>file.name);
    let entryPath=safeRelativePath(selected?.relativePath??basename(path));
    if(!map.has(entryPath)||resolve(map.get(entryPath)!.path)!==resolve(path)){
      if(occupied(entryPath)){let index=0;do{entryPath=`__entry_${index++}/${safeRelativePath(basename(path))}`;}while(occupied(entryPath));}
      map.set(entryPath,{path,hash:selected?.sha256??fileHash(path)});
    }
    await this.start();const grant=randomBytes(24).toString('hex');
    this.grants.set(grant,{files:map,created:Date.now()});for(const [id,value] of this.grants)if(Date.now()-value.created>3600000)this.grants.delete(id);
    return `${this.origin}/p/${grant}/${entryPath.split('/').map(encodeURIComponent).join('/')}`;
  }
  async file(root:string,path:string,downloadUrl:string,expectedHash?:string,siblings:PreviewFile[]=[]):Promise<Preview> {
    const actual=safeExistingFile(root,path);if(expectedHash&&fileHash(actual)!==expectedHash)throw new WorkbenchError('成果哈希已变化，不能用旧版本预览或验收',409);
    const extension=extname(actual).toLowerCase(),title=basename(actual);
    if(['.png','.jpg','.jpeg','.webp','.gif','.svg'].includes(extension))return {kind:'image',title,url:downloadUrl,downloadUrl};
    if(extension==='.pdf')return {kind:'pdf',title,url:downloadUrl,downloadUrl};
    if(['.html','.htm'].includes(extension))return {kind:'html',title,url:await this.html(actual,siblings),downloadUrl,detail:'在独立本机来源中运行，无法获得工作台控制凭据。'};
    if(['.docx','.pptx','.xlsx'].includes(extension)) {
      let detail='内容提取预览；原件保留。未检测到本机 LibreOffice，尚无逐页视觉预览。';
      if(extension!=='.xlsx'&&this.converter?.status().available)try {const pdf=await this.converter.pdf(actual);return {kind:'pdf',title,url:await this.html(pdf),downloadUrl,detail:'LibreOffice 转换的逐页 PDF 视觉预览；下载保留原始可编辑文件。'};}catch(error){detail=error instanceof Error?error.message:'逐页转换失败，改用内容提取预览。';}
      const result=await extractDocument({name:title,bytes:readFileSync(actual)});return {kind:extension==='.xlsx'?'table':'document',title,text:result.text,downloadUrl,detail:extension==='.xlsx'?'工作表内容提取预览；公式和编辑请下载原件。':detail};
    }
    if(statSync(actual).size>2*1024*1024)return {kind:'text',title,text:'文件超过文本预览大小，请下载原件。',downloadUrl};
    return {kind:extension==='.csv'?'table':'text',title,text:readFileSync(actual,'utf8'),downloadUrl};
  }
  bytes(root:string,path:string,expectedHash?:string):{bytes:Buffer;name:string;mime:string} {const actual=safeExistingFile(root,path);if(expectedHash&&fileHash(actual)!==expectedHash)throw new WorkbenchError('成果文件已改变',409);return {bytes:readFileSync(actual),name:basename(actual),mime:mimeByExt[extname(actual).toLowerCase()]??'application/octet-stream'};}
  async close():Promise<void>{await this.converter?.close();await this.starting;await this.app?.close();this.grants.clear();}
}
