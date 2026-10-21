import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentConverter } from '../src/server/document-converter.js';
import { executeCheck } from '../src/server/workflows/integration.js';
import { Store } from '../src/server/store.js';
import { WorkbenchService } from '../src/server/service.js';
import { WorkbenchError } from '../src/server/repositories.js';

vi.mock('../src/server/workflows/integration.js',async original=>({...await original<object>(),executeCheck:vi.fn()}));
const directories:string[]=[];
function directory(){const value=mkdtempSync(join(tmpdir(),'awb-upgrade-edge-'));directories.push(value);return value;}
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});

describe('isolated document conversion and durable retry boundaries',()=>{
  it('reports an unavailable converter without starting a process',()=>{
    vi.stubEnv('WORKBENCH_OFFICE_CONVERTER','');vi.stubEnv('ProgramFiles','');vi.stubEnv('ProgramFiles(x86)','');vi.stubEnv('PATH','');
    expect(new DocumentConverter(directory()).status().available).toBe(false);expect(executeCheck).not.toHaveBeenCalled();
  });
  it('converts a copy with a private profile and retains the original editable bytes',async()=>{
    vi.stubEnv('WORKBENCH_OFFICE_CONVERTER',process.execPath);
    const root=directory(),source=join(root,'原件.pptx');writeFileSync(source,'fixture-original');
    vi.mocked(executeCheck).mockImplementation(async(_cwd,_command,args)=>{const out=args[args.indexOf('--outdir')+1]!;expect(readFileSync(args.at(-1)!,'utf8')).toBe('fixture-original');expect(args.some(arg=>arg.startsWith('-env:UserInstallation=file:'))).toBe(true);writeFileSync(join(out,'source.pdf'),'%PDF-1.7\nfixture');return {exitCode:0,log:''};});
    const converter=new DocumentConverter(join(root,'cache')),first=await converter.pdf(source);
    expect(first.endsWith('source.pdf')).toBe(true);expect(readFileSync(source,'utf8')).toBe('fixture-original');
    expect(await converter.pdf(source)).toBe(first);expect(executeCheck).toHaveBeenCalledTimes(1);
    writeFileSync(first,'corrupted');await converter.pdf(source);expect(executeCheck).toHaveBeenCalledTimes(2);
  });
  it('refuses to show conversion against an input that changed during the run',async()=>{
    vi.stubEnv('WORKBENCH_OFFICE_CONVERTER',process.execPath);
    const root=directory(),source=join(root,'source.docx');writeFileSync(source,'old');
    vi.mocked(executeCheck).mockImplementation(async(_cwd,_command,args)=>{writeFileSync(join(args[args.indexOf('--outdir')+1]!,'source.pdf'),'%PDF-1.7\nfixture');writeFileSync(source,'changed');return {exitCode:0,log:''};});
    await expect(new DocumentConverter(join(root,'cache')).pdf(source)).rejects.toThrow('原文件在转换期间已变化');
  });
  it('preserves retry-safe preflight classification while unknown writes cannot be replayed',async()=>{
    const service=new WorkbenchService({dataDir:directory(),adapters:[]});
    try{
      const preflight=vi.fn(async()=>{throw new WorkbenchError('配置尚未验证',409,true);});
      await expect(service.idempotent('confirm','preflight',{},preflight)).rejects.toMatchObject({retrySafe:true});
      await expect(service.idempotent('confirm','preflight',{},preflight)).rejects.toMatchObject({retrySafe:true});expect(preflight).toHaveBeenCalledTimes(1);
      const ambiguous=vi.fn(async()=>{throw new Error('acknowledgement lost');});
      await expect(service.idempotent('confirm','unknown',{},ambiguous)).rejects.toThrow();
      await expect(service.idempotent('confirm','unknown',{},ambiguous)).rejects.toMatchObject({retrySafe:false});expect(ambiguous).toHaveBeenCalledTimes(1);
    }finally{await service.close();}
  });
  it('bounds invalid history limits instead of sending NaN to SQLite',()=>{
    const store=new Store(':memory:');try{expect(store.history({limit:Number.NaN})).toEqual({events:[]});}finally{store.close();}
  });
});
