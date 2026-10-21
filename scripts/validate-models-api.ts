import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeModelCatalog, Snapshot } from '../src/shared/types.js';

// Metadata-only check against the user's running localhost service; no execution requests.
const base='http://127.0.0.1:4310';
async function get<T>(path:string):Promise<T>{
  const response=await fetch(`${base}${path}`,{signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const before=await get<Snapshot>('/api/state');
const results=[];
for(const runtime of ['codex','claude','workbuddy'] as const){
  const agent=before.agents.find(item=>item.runtime===runtime);
  if(!agent){results.push({runtime,status:'missing-agent'});continue;}
  const catalog=await get<RuntimeModelCatalog>(`/api/agents/${agent.id}/models?refresh=1`);
  results.push({runtime,status:catalog.status,source:catalog.source,checkedAt:catalog.checkedAt,stale:catalog.stale??false,models:catalog.models});
}
const after=await get<Snapshot>('/api/state');
const unchanged={
  members:JSON.stringify(before.agents)===JSON.stringify(after.agents),
  usage:JSON.stringify(before.usage)===JSON.stringify(after.usage),
  events:JSON.stringify(before.events)===JSON.stringify(after.events),
  artifacts:JSON.stringify(before.artifacts)===JSON.stringify(after.artifacts),
};
const report={checkedAt:new Date().toISOString(),metadataOnly:true,results,unchanged,passed:results.every(item=>item.status==='ready'&&'models' in item&&item.models.length>0)&&Object.values(unchanged).every(Boolean)};
const directory=join(process.cwd(),'.workbench','validation');await mkdir(directory,{recursive:true});
await writeFile(join(directory,'models-api.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({passed:report.passed,results:results.map(item=>({runtime:item.runtime,status:item.status,count:'models' in item?item.models.length:0})),unchanged},null,2)+'\n');
if(!report.passed)process.exitCode=1;
