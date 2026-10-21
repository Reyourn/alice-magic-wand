import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimeKind, WorkbenchEvent } from '../shared/types.js';

export interface CommandRecord { key: string; fingerprint: string; state: 'pending'|'done'|'failed'; result?: unknown; error?: string; retrySafe?:boolean; }
export interface QueuedMessage { id: string; agentId: string; text: string; attachmentIds?:string[]; source: 'human'|'controller'|'system'; state: 'queued'|'sending'|'delivered'|'completed'|'failed'|'uncertain'|'cancelled'; createdAt: string; taskId?: string; workflowId?:string; roundId?:string; }
export interface RunRecord { agentId: string; messageId: string; nativeSessionId?: string; runtime?:RuntimeKind; model?:string; provider?:string; configuredModel?:string; connectionId?:string; connectionRevision?:number; workflowId?:string; roundId?:string; pid?: number; state: 'active'|'terminal'|'unknown'; startedAt: string; }

/** Runtime mappings only. Task lifecycle deliberately remains in Beads. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, beforeWrite?: (db:DatabaseSync)=>void) {
    const existing=path!==':memory:'&&existsSync(path);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try { beforeWrite?.(this.db); } catch (error) { this.db.close(); throw error; }
    const version=Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(existing&&version<1)this.db.prepare('VACUUM INTO ?').run(`${path}.pre-upgrade-${Date.now()}.backup`);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_agent ON events(json_extract(json,'$.agentId'),id);
      CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,json TEXT NOT NULL);`);
    if(version<1)this.db.exec('PRAGMA user_version=1');
  }
  put<T extends { id?: string }>(collection: string, id: string, value: T | unknown): void {
    this.db.prepare('INSERT INTO entities(collection,id,json) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET json=excluded.json').run(collection,id,JSON.stringify(value));
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM entities WHERE collection=? AND id=?').get(collection,id) as {json:string}|undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  all<T>(collection: string): T[] {
    return (this.db.prepare('SELECT json FROM entities WHERE collection=? ORDER BY rowid').all(collection) as {json:string}[]).map(row=>JSON.parse(row.json) as T);
  }
  remove(collection: string, id: string): void { this.db.prepare('DELETE FROM entities WHERE collection=? AND id=?').run(collection,id); }
  event(value: Omit<WorkbenchEvent,'id'>): WorkbenchEvent {
    const result = this.db.prepare('INSERT INTO events(json) VALUES(?)').run(JSON.stringify(value));
    return { ...value, id: Number(result.lastInsertRowid) };
  }
  events(after=0, limit=500): WorkbenchEvent[] {
    const rows = this.db.prepare('SELECT id,json FROM events WHERE id>? ORDER BY id DESC LIMIT ?').all(after,limit) as {id:number;json:string}[];
    return rows.reverse().map(row=>({ ...JSON.parse(row.json), id: row.id }));
  }
  /** Controller context uses complete messages and tool results, not duplicated stream fragments. */
  agentEvents(agentId:string,after=0,limit=100):WorkbenchEvent[] {
    const rows=this.db.prepare(`SELECT id,json FROM events
      WHERE json_extract(json,'$.agentId')=? AND id>?
        AND json_extract(json,'$.type')!='runtime.delta'
        AND NOT (json_extract(json,'$.type')='runtime.tool' AND COALESCE(json_extract(json,'$.data.phase'),'') IN ('output','progress'))
      ORDER BY id DESC LIMIT ?`).all(agentId,after,limit) as {id:number;json:string}[];
    return rows.reverse().map(row=>({...JSON.parse(row.json),id:row.id}));
  }
  history(input:{projectId?:string;agentId?:string;taskId?:string;before?:number;query?:string;limit?:number}):import('../shared/types.js').HistoryPage {
    const conditions=["json_extract(json,'$.type')!='runtime.delta'"];const values:(string|number)[]=[];
    for(const field of ['projectId','agentId'] as const)if(input[field]){conditions.push(`json_extract(json,'$.${field}')=?`);values.push(input[field]!);}
    if(input.taskId){conditions.push("(json_extract(json,'$.data.taskId')=? OR json_extract(json,'$.data.messageId') IN (SELECT json_extract(json,'$.id') FROM entities WHERE collection='messages' AND json_extract(json,'$.taskId')=?))");values.push(input.taskId,input.taskId);}
    if(input.before){conditions.push('id<?');values.push(input.before);}
    if(input.query){conditions.push("instr(lower(COALESCE(json_extract(json,'$.text'),'')),lower(?))>0");values.push(input.query.slice(0,500));}
    const limit=Number.isFinite(input.limit)?Math.min(200,Math.max(1,Math.trunc(input.limit!))):50;values.push(limit+1);
    const rows=this.db.prepare(`SELECT id,json FROM events WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values) as {id:number;json:string}[];
    const more=rows.length>limit;const page=rows.slice(0,limit);
    return {events:page.reverse().map(row=>({...JSON.parse(row.json),id:row.id})),...(more?{nextBefore:page[0]?.id}:{})};
  }
  command(key: string): CommandRecord | undefined {
    const row = this.db.prepare('SELECT json FROM commands WHERE key=?').get(key) as {json:string}|undefined;
    return row ? JSON.parse(row.json) as CommandRecord : undefined;
  }
  saveCommand(record: CommandRecord): void {
    this.db.prepare('INSERT INTO commands(key,fingerprint,state,json) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,json=excluded.json').run(record.key,record.fingerprint,record.state,JSON.stringify(record));
  }
  close(): void { this.db.close(); }
}
