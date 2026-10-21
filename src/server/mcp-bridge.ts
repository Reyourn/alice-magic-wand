import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { controllerTools, memberTools } from './mcp-definitions.js';

const isController = process.env.WORKBENCH_MEMBER_KIND !== 'worker';
const definitions = isController ? controllerTools : memberTools;

const base = process.env.WORKBENCH_URL;
const controllerId = process.env.WORKBENCH_CONTROLLER_ID;
const token = process.env.WORKBENCH_CONTROLLER_TOKEN;
if (!base || !controllerId || !token) throw new Error('Workbench bridge requires its scoped runtime environment.');
const url = new URL(base);
if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Workbench bridge only connects to loopback HTTP.');
const server = new Server({name:'agent-workbench', version:'0.1.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async()=>({tools: definitions.map(t=>({name:t.name,description:t.description,inputSchema:{type:'object' as const,properties:t.properties,required:t.required,additionalProperties:false}}))}));
server.setRequestHandler(CallToolRequestSchema, async(request)=>{
  if(!definitions.some(t=>t.name===request.params.name)) throw new Error('Unknown workbench tool');
  const response = await fetch(new URL(`/api/${isController ? 'controller' : 'member'}/${encodeURIComponent(controllerId!)}/tools`,url), {
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'Idempotency-Key':`mcp-${crypto.randomUUID()}`},
    body:JSON.stringify({name:request.params.name,arguments:request.params.arguments??{}}), signal:AbortSignal.timeout(120_000)
  });
  const text=await response.text();
  return {content:[{type:'text' as const,text}],isError:!response.ok};
});
await server.connect(new StdioServerTransport());
