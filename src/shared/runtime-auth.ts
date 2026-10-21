import type { WorkbuddyEdition } from './connections.js';

/** Safe snapshot only. Native authorization URLs and credentials remain in the owning process controller. */
export interface RuntimeAuthenticationSession {
  id:string; agentId:string; connectionId:string; connectionRevision:number;
  /** Owned native process identity, including while connect() is awaiting authorization. */
  pid?:number;
  edition:WorkbuddyEdition; cwd:string;
  state:'starting'|'waiting'|'authenticated'|'failed'|'stopping'|'stopped'|'unknown';
  createdAt:string; updatedAt:string; detail:string; canAuthorize:boolean;
}

/** Backend-only adapter lifecycle; url() is never serialized or persisted. */
export interface RuntimeAuthenticationControl {
  list():RuntimeAuthenticationSession[];
  url(id:string):string|undefined;
  cancel(id:string):Promise<void>;
  close():Promise<void>;
}
