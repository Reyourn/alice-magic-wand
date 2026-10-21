import { expect, it } from 'vitest';
import { Store } from '../src/server/store.js';

it('keeps member evidence despite thousands of other-member events and stream fragments',()=>{
  const store=new Store(':memory:');
  try {
    const first=store.event({agentId:'reviewer',type:'runtime.tool',data:{phase:'completed',content:'5 tests passed'},createdAt:'2026-10-09T00:00:00Z'});
    for(let i=0;i<1100;i++) {
      store.event({agentId:'other',type:'runtime.message',text:'other output',createdAt:'2026-10-09T00:00:01Z'});
      store.event({agentId:'reviewer',type:'runtime.delta',text:'fragment',createdAt:'2026-10-09T00:00:01Z'});
      store.event({agentId:'reviewer',type:'runtime.tool',data:{phase:'output',text:'partial tool output'},createdAt:'2026-10-09T00:00:01Z'});
    }
    const last=store.event({agentId:'reviewer',type:'runtime.result',text:'Review passed',createdAt:'2026-10-09T00:00:02Z'});
    expect(store.agentEvents('reviewer').map(e=>e.id)).toEqual([first.id,last.id]);
    expect(store.agentEvents('reviewer',first.id)).toEqual([last]);
    expect(store.agentEvents('reviewer',0,1)).toEqual([last]);
    // Browser/SSE storage still retains the original stream.
    expect(store.events(0,10000)).toHaveLength(3302);
  }finally{store.close();}
});
