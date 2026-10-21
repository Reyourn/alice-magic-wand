import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchService } from '../src/server/service.js';

describe('legacy startup ownership',()=>{
  it('refuses a live legacy owner before changing its database or creating a migration backup',()=>{
    const directory=mkdtempSync(join(tmpdir(),'awb-live-legacy-')),path=join(directory,'workbench.sqlite');
    try {
      const db=new DatabaseSync(path);
      db.exec('CREATE TABLE entities(collection TEXT,id TEXT,json TEXT,PRIMARY KEY(collection,id));');
      db.prepare('INSERT INTO entities VALUES(?,?,?)').run('service','owner',JSON.stringify({pid:process.pid,instanceId:'original-instance'}));
      db.prepare('INSERT INTO entities VALUES(?,?,?)').run('messages','existing',JSON.stringify({id:'existing',text:'原始指令'}));
      db.close();
      const original=readFileSync(path);
      expect(()=>new WorkbenchService({dataDir:directory,adapters:[]})).toThrow(/正在由工作台进程/);
      expect(readFileSync(path)).toEqual(original);
      expect(readdirSync(directory).filter(name=>name.includes('pre-upgrade'))).toEqual([]);
      const check=new DatabaseSync(path,{readOnly:true});
      try {
        expect(check.prepare('PRAGMA user_version').get()).toEqual({user_version:0});
        expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{name:'entities'}]);
        expect(JSON.parse((check.prepare("SELECT json FROM entities WHERE id='owner'").get() as {json:string}).json).instanceId).toBe('original-instance');
      } finally {check.close();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  });
});
