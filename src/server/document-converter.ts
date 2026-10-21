import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fileHash } from './workflows/files.js';
import { executeCheck } from './workflows/integration.js';

export interface ConverterStatus {available:boolean; name:string; executable?:string; detail:string;}
/** A private LibreOffice profile avoids changing a user's open Office session. */
export class DocumentConverter {
  private pending=new Map<string,Promise<string>>();
  constructor(private readonly directory:string){}
  status():ConverterStatus {
    const candidates=[process.env.WORKBENCH_OFFICE_CONVERTER,
      process.env.ProgramFiles&&join(process.env.ProgramFiles,'LibreOffice','program','soffice.exe'),
      process.env['ProgramFiles(x86)']&&join(process.env['ProgramFiles(x86)']!,'LibreOffice','program','soffice.exe'),
      ...(process.env.PATH??'').split(process.platform==='win32'?';':':').filter(Boolean).map(part=>join(part,process.platform==='win32'?'soffice.exe':'soffice'))];
    const executable=candidates.find((path):path is string=>!!path&&existsSync(path)&&statSync(path).isFile());
    return executable?{available:true,name:'LibreOffice',executable:resolve(executable),detail:'使用独立配置目录将输入副本转换为 PDF；原件保持不变。'}:{available:false,name:'LibreOffice',detail:'未检测到 LibreOffice。DOCX/PPTX 提供内容提取及原件下载；安装后自动检测，或用 WORKBENCH_OFFICE_CONVERTER 指定本机 soffice 程序。'};
  }
  async pdf(source:string):Promise<string> {
    const converter=this.status();if(!converter.available)throw new Error(converter.detail);
    const hash=fileHash(source),key=hash+extname(source).toLowerCase(),existing=this.pending.get(key);if(existing)return existing;
    const work=(async()=>{
      const root=resolve(this.directory,key),output=join(root,'output'),pdf=join(output,'source.pdf'),manifest=join(root,'converted.json');
      if(existsSync(pdf)&&existsSync(manifest)){const saved=JSON.parse(readFileSync(manifest,'utf8')) as {sourceHash:string;pdfHash:string};if(saved.sourceHash===hash&&saved.pdfHash===fileHash(pdf))return pdf;}
      mkdirSync(output,{recursive:true});const input=join(root,`source${extname(source).toLowerCase()}`);copyFileSync(source,input);
      if(fileHash(input)!==hash||fileHash(source)!==hash)throw new Error('输入在复制过程中发生变化，请重新打开预览');
      const profile=pathToFileURL(join(root,`profile-${randomUUID()}`)).href;
      const result=await executeCheck(root,converter.executable!,[`-env:UserInstallation=${profile}`,'--headless','--nologo','--nodefault','--nofirststartwizard','--convert-to','pdf','--outdir',output,input],60000);
      if(result.exitCode!==0||!existsSync(pdf)||readFileSync(pdf).subarray(0,5).toString()!=='%PDF-')throw new Error(`逐页转换未成功（退出码 ${result.exitCode}），仍可查看内容提取并下载原件。`);
      if(fileHash(source)!==hash)throw new Error('原文件在转换期间已变化，请重新核对版本');
      writeFileSync(manifest,JSON.stringify({sourceHash:hash,pdfHash:fileHash(pdf),converter:'LibreOffice',createdAt:new Date().toISOString()}));return pdf;
    })();this.pending.set(key,work);try{return await work;}finally{this.pending.delete(key);}
  }
  async close(){await Promise.allSettled(this.pending.values());}
}
