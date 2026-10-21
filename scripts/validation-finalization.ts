import type { Store, QueuedMessage, RunRecord } from '../src/server/store.js';
import type { WorkbenchEvent } from '../src/shared/types.js';

/** A native result can precede async artifact indexing and completion notices.
 * Acceptance must drain those handlers too, rather than observing idle between
 * two queued controller turns. This reads evidence only and never sends work. */
export function nativeFinalizationPending(store:Store,agentIds:string[]):boolean {
  const scope=new Set(agentIds);
  const messages=store.all<QueuedMessage>('messages').filter(row=>scope.has(row.agentId));
  // Historical uncertain messages remain truthful after explicit recovery.
  // The latest run below, not old missing receipts, determines current liveness.
  if(messages.some(row=>['queued','sending','delivered'].includes(row.state)))return true;
  const runs=store.all<RunRecord>('runs').filter(row=>scope.has(row.agentId));
  if(runs.some(row=>row.state!=='terminal'))return true;
  const completed=new Set<string>();
  // Read the full durable event table: fixtures can exceed Store.events' page
  // cap, and a missing final event must never be inferred from an idle badge.
  for(const row of store.db.prepare('SELECT json FROM events ORDER BY id').all() as {json:string}[]) {
    const event=JSON.parse(row.json) as WorkbenchEvent;
    if(event.agentId&&scope.has(event.agentId)&&['agent.turn_completed','agent.turn_failed'].includes(event.type)&&typeof event.data?.messageId==='string')
      completed.add(event.data.messageId);
  }
  return runs.some(run=>messages.some(message=>message.id===run.messageId&&message.state==='completed')&&!completed.has(run.messageId));
}
