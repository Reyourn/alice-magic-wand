import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PreviewServer } from '../src/server/previews.js';
import { assertUniqueRelativePaths, copyVerifiedFiles, fileHash, OfficeWorkspaceManager, safeRelativePath, snapshotFiles } from '../src/server/workflows/files.js';
import { Store } from '../src/server/store.js';
import type { BundleFile, InputSnapshot } from '../src/shared/workflows.js';
import type { TaskRepository } from '../src/server/repositories.js';

const roots:string[]=[],servers:PreviewServer[]=[],stores:Store[]=[];
afterEach(async()=>{
  for(const server of servers.splice(0))await server.close();
  for(const store of stores.splice(0))store.close();
  for(const root of roots.splice(0)){
    if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe test cleanup');
    rmSync(root,{recursive:true,force:true,maxRetries:3});
  }
});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'awb-prototype-'));roots.push(root);
  const outputs=join(root,'outputs');mkdirSync(outputs);
  const sources:Record<string,string>={
    'pages/原型.html':'<!doctype html><link rel="stylesheet" href="../assets/style.css"><img src="../assets/red/icon.svg"><img src="../assets/blue/icon.svg"><button>Run</button><script type="module" src="../assets/app.js"></script>',
    'assets/style.css':'button { color: rgb(123, 45, 67); }',
    'assets/app.js':'import { value } from "./value.js"; document.querySelector("button").textContent = value;',
    'assets/value.js':'export const value = "模块已加载";',
    'assets/red/icon.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    'assets/blue/icon.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>',
  };
  for(const [path,text] of Object.entries(sources)){mkdirSync(dirname(join(outputs,path)),{recursive:true});writeFileSync(join(outputs,path),text);}
  const files=snapshotFiles(outputs,Object.keys(sources).map(path=>join(outputs,path)),join(root,'bundle'));
  return {root,outputs,sources,files};
}

describe('portable multi-file prototype bundles',()=>{
  it('preserves nested paths and same-named assets in fixed snapshots and downstream input groups',()=>{
    const {root,sources,files}=fixture();
    expect(files.map(file=>file.relativePath)).toEqual(Object.keys(sources));
    expect(files.filter(file=>file.name==='icon.svg')).toHaveLength(2);
    const store=new Store(':memory:');stores.push(store);
    const office=new OfficeWorkspaceManager(join(root,'data'),store,{} as TaskRepository);
    const task=office.createTaskDirectory('office','round',undefined,[{id:'bundle-a',files},{id:'bundle-b',files}]);
    for(const [path,text] of Object.entries(sources)){
      expect(readFileSync(join(task,'inputs','bundles','bundle-a',path),'utf8')).toBe(text);
      expect(readFileSync(join(task,'inputs','bundles','bundle-b',path),'utf8')).toBe(text);
    }
    expect(office.createTaskDirectory('office','round',undefined,[{id:'bundle-a',files},{id:'bundle-b',files}])).toBe(task);
    writeFileSync(join(task,'inputs','bundles','bundle-a','assets/style.css'),'unreviewed edit');
    expect(()=>office.createTaskDirectory('office','round',undefined,[{id:'bundle-a',files}])).toThrow('拒绝覆盖');
  });
  it('serves the real HTML, CSS, ES modules and distinct same-named images over isolated HTTP',async()=>{
    const {sources,files}=fixture(),preview=new PreviewServer();servers.push(preview);
    const html=files.find(file=>file.relativePath==='pages/原型.html')!;
    const url=await preview.html(html.path,files);
    expect(decodeURIComponent(new URL(url).pathname)).toMatch(/\/p\/[a-f0-9]+\/pages\/原型\.html$/);
    const page=await fetch(url);expect(page.status).toBe(200);expect(await page.text()).toBe(sources['pages/原型.html']);
    expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(page.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    for(const [path,text] of Object.entries(sources)){
      const response=await fetch(new URL(`../${path}`,url),{headers:{Origin:'null'}});
      expect(response.status,path).toBe(200);expect(await response.text(),path).toBe(text);
      expect(response.headers.get('access-control-allow-origin')).toBe('null');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
      if(path.endsWith('.js'))expect(response.headers.get('content-type')).toContain('text/javascript');
    }
    expect((await fetch(new URL('../unlisted.txt',url))).status).toBe(404);
    expect((await fetch(new URL('/api/snapshot',url))).status).toBe(404);
    writeFileSync(files.find(file=>file.relativePath==='assets/style.css')!.path,'changed');
    expect((await fetch(new URL('../assets/style.css',url))).status).toBe(409);
  });
  it('retains legacy file metadata and reads old flattened snapshots without rewriting them',async()=>{
    const {root}=fixture(),path=join(root,'0-old.html');writeFileSync(path,'<h1>Legacy</h1>');
    const legacy:BundleFile={name:'old.html',path,sha256:fileHash(path),size:readFileSync(path).length};
    const before=JSON.stringify(legacy),preview=new PreviewServer();servers.push(preview);
    const url=await preview.html(path,[legacy]);expect(await (await fetch(url)).text()).toBe('<h1>Legacy</h1>');
    const store=new Store(':memory:');stores.push(store);
    const snapshot:InputSnapshot={id:'legacy-input',projectId:'office',createdAt:'2026-01-01',directory:root,files:[{...legacy,sourcePath:path,sourceHash:legacy.sha256}]};
    store.put('input_snapshots',snapshot.id,snapshot);
    const office=new OfficeWorkspaceManager(join(root,'data'),store,{} as TaskRepository);
    const task=office.createTaskDirectory('office','old-round',snapshot.id,[{id:'old-bundle',files:[legacy]}]);
    expect(readFileSync(join(task,'inputs','0-old.html'),'utf8')).toBe('<h1>Legacy</h1>');
    expect(readFileSync(join(task,'inputs','1-old.html'),'utf8')).toBe('<h1>Legacy</h1>');
    expect(JSON.stringify(legacy)).toBe(before);expect(store.get('input_snapshots',snapshot.id)).toEqual(snapshot);
  });
  it('opens a legacy HTML entry with duplicate image basenames without guessing an ambiguous alias',async()=>{
    const {root}=fixture(),preview=new PreviewServer();servers.push(preview);
    const definitions=[
      {name:'old.html',physical:'0-old.html',text:'<h1>Old page</h1><img src="1-logo.svg"><img src="2-logo.svg">'},
      {name:'logo.svg',physical:'1-logo.svg',text:'<svg xmlns="http://www.w3.org/2000/svg"><text>red</text></svg>'},
      {name:'logo.svg',physical:'2-logo.svg',text:'<svg xmlns="http://www.w3.org/2000/svg"><text>blue</text></svg>'},
      {name:'style.css',physical:'3-style.css',text:'h1 { color: red; }'},
    ];
    const files:BundleFile[]=definitions.map(({name,physical,text})=>{const path=join(root,physical);writeFileSync(path,text);return {name,path,sha256:fileHash(path),size:Buffer.byteLength(text)};});
    const before=JSON.stringify(files),url=await preview.html(files[0]!.path,files);
    expect(new URL(url).pathname).toMatch(/\/0-old\.html$/);
    expect(await (await fetch(url)).text()).toBe(definitions[0]!.text);
    for(const item of definitions)expect(await (await fetch(new URL(item.physical,url))).text()).toBe(item.text);
    expect(await (await fetch(new URL('style.css',url))).text()).toBe(definitions[3]!.text);
    expect((await fetch(new URL('logo.svg',url))).status).toBe(404);
    expect(JSON.stringify(files)).toBe(before);
    for(const file of files)expect(fileHash(file.path)).toBe(file.sha256);
  });
  it('rejects Windows aliases, traversal and duplicate paths before creating a snapshot or copy',()=>{
    const {root,outputs,files}=fixture();
    for(const path of ['../escape','a/../escape','/absolute','C:\\temp\\file','a//b','a/./b','assets/con.txt','a.txt:secret','name.','name ','COM1.txt'])expect(()=>safeRelativePath(path),path).toThrow();
    expect(()=>assertUniqueRelativePaths(['assets/icon.svg','ASSETS\\ICON.svg'])).toThrow('重复');
    expect(()=>assertUniqueRelativePaths(['a','a/b'])).toThrow('冲突');
    const target=join(root,'duplicate');
    expect(()=>snapshotFiles(outputs,[join(outputs,'assets/style.css'),join(outputs,'assets/style.css')],target)).toThrow('重复');
    expect(existsSync(target)).toBe(false);
    expect(()=>snapshotFiles(outputs,[join(outputs,'assets/style.css')],join(root,'bundle'))).toThrow('拒绝覆盖');
    const outside=join(root,'outside.txt');writeFileSync(outside,'untouched');
    expect(()=>snapshotFiles(outputs,[outside],join(root,'escape'))).toThrow('工作区');
    expect(()=>copyVerifiedFiles([{file:files[0]!,relativePath:'../outside.txt'}],join(root,'copy'))).toThrow();
    expect(readFileSync(outside,'utf8')).toBe('untouched');
    expect(existsSync(join(root,'copy'))).toBe(false);
  });
  it('rejects conflicting preview names instead of silently selecting the final asset',async()=>{
    const {files}=fixture(),preview=new PreviewServer();servers.push(preview);
    const html=files[0]!;
    await expect(preview.html(html.path,[html,{...files[1]!,relativePath:'ASSETS/STYLE.CSS'},{...files[1]!,relativePath:'assets/style.css'}])).rejects.toThrow('重复');
  });
});
