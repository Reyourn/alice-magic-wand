import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import { DeliveryActions } from '../src/server/delivery-actions.js';
import { LocalGitRepository, runCommand } from '../src/server/repositories.js';
import type { WorkflowManager } from '../src/server/workflows/index.js';
import type { WorkflowDetail } from '../src/shared/workflows.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const work of cleanup.splice(0).reverse())work();});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'awb-delivery-actions-')),repo=join(root,'repo'),remote=join(root,'remote.git');mkdirSync(repo);
  cleanup.push(()=>rmSync(root,{recursive:true,force:true,maxRetries:3}));
  await runCommand('git',['init','-b','main'],repo);await runCommand('git',['init','--bare',remote],repo);
  await runCommand('git',['remote','add','fixture',remote],repo);writeFileSync(join(repo,'answer.txt'),'reviewed candidate');
  await runCommand('git',['add','.'],repo);await runCommand('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','candidate'],repo);
  const commit=await runCommand('git',['rev-parse','HEAD'],repo),store=new Store(join(root,'state.sqlite'));cleanup.push(()=>store.close());
  const detail={workflow:{id:'flow',projectId:'project',status:'completed'},nodes:[{accepted:true,bundle:{id:'bundle',kind:'code'}}],integration:{headCommit:commit,worktree:repo,state:'verified',targetBranch:'main',integratedBundleIds:['bundle'],checks:[{commit,exitCode:0}]}} as WorkflowDetail;
  const manager={get:()=>detail.workflow,detail:async()=>detail} as unknown as WorkflowManager;
  const actions=new DeliveryActions(store,manager,new LocalGitRepository(join(root,'worktrees')));
  return {root,repo,remote,commit,store,detail,manager,actions};
}

describe('explicit outbound delivery actions',()=>{
  it('previews without pushing, confirms the fixed commit once, and keeps publication separate from task delivery',async()=>{
    const f=await fixture(),input={kind:'push' as const,remote:'fixture',branch:'release'};
    const action=await f.actions.prepare('flow',input);expect(action.state).toBe('prepared');
    expect((await f.actions.prepare('flow',input)).id).toBe(action.id);
    await expect(runCommand('git',['--git-dir',f.remote,'rev-parse','--verify','refs/heads/release'],f.repo)).rejects.toThrow();
    await expect(f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:'stale'})).rejects.toThrow('准确版本');
    const [first,second]=await Promise.all([f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:action.fingerprint}),f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:action.fingerprint})]);
    expect(first.state).toBe('succeeded');expect(second.receipts).toHaveLength(1);
    expect(await runCommand('git',['--git-dir',f.remote,'rev-parse','refs/heads/release'],f.repo)).toBe(f.commit);
    expect(f.detail.workflow.status).toBe('completed');
  });
  it('invalidates a preview after remote routing or candidate bytes change',async()=>{
    const f=await fixture(),action=await f.actions.prepare('flow',{kind:'push',remote:'fixture',branch:'release'});
    await runCommand('git',['remote','set-url','fixture',join(f.root,'another.git')],f.repo);
    await expect(f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:action.fingerprint})).rejects.toThrow('远端地址');
    writeFileSync(join(f.repo,'answer.txt'),'unreviewed');
    await expect(f.actions.prepare('flow',{kind:'push',remote:'fixture',branch:'other'})).rejects.toThrow('已变化');
    expect(f.actions.get(action.id).state).toBe('prepared');
  });
  it('does not replay a deployment with a partial side effect or fabricate an automatic success from manual reconciliation',async()=>{
    const f=await fixture(),marker=join(f.root,'executions.txt');
    const action=await f.actions.prepare('flow',{kind:'deploy',command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},'run\\n'); process.exit(7);`]});
    expect(action.receipts).toEqual([]);
    const result=await f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:action.fingerprint});
    expect(result.state).toBe('unknown');expect(result.receipts[0]?.exitCode).toBe(7);
    await expect(f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:action.fingerprint})).rejects.toThrow('不能重复执行');
    expect(readFileSync(marker,'utf8')).toBe('run\n');
    const reconciled=f.actions.reconcile(action.id,{result:'failed',reason:'Confirmed one local marker; no deployment endpoint was used.'});
    expect(reconciled.reconciliation?.result).toBe('failed');expect(reconciled.receipts[0]?.exitCode).toBe(7);
  });
  it('marks interrupted service records unknown and blocks a second action until reconciliation',async()=>{
    const f=await fixture(),action=await f.actions.prepare('flow',{kind:'deploy',command:process.execPath,args:['-e','process.exit(0)']});
    f.store.put('delivery_actions',action.id,{...action,state:'running'});
    const restarted=new DeliveryActions(f.store,f.manager,new LocalGitRepository(join(f.root,'worktrees')));
    expect(restarted.get(action.id).state).toBe('unknown');
    const other=await restarted.prepare('flow',{kind:'push',remote:'fixture',branch:'release'});
    await expect(restarted.execute(other.id,{confirmedCommit:f.commit,fingerprint:other.fingerprint})).rejects.toThrow('未核对');
  });
  it('rejects extra push destinations, stale accepted evidence, and split credential arguments',async()=>{
    const f=await fixture();
    await expect(f.actions.prepare('flow',{kind:'deploy',command:process.execPath,args:['--token','private-fixture-value']})).rejects.toThrow('凭据');
    f.detail.nodes[0]!.accepted=false;
    await expect(f.actions.prepare('flow',{kind:'push',remote:'fixture',branch:'release'})).rejects.toThrow('重新验收');
    f.detail.nodes[0]!.accepted=true;
    const action=await f.actions.prepare('flow',{kind:'push',remote:'fixture',branch:'release'});
    await runCommand('git',['config','--add','remote.fixture.pushurl',f.remote],f.repo);
    await runCommand('git',['config','--add','remote.fixture.pushurl',join(f.root,'unreviewed.git')],f.repo);
    await expect(f.actions.execute(action.id,{confirmedCommit:f.commit,fingerprint:action.fingerprint})).rejects.toThrow('一个明确');
    expect(f.actions.get(action.id).receipts).toEqual([]);
  });
});
