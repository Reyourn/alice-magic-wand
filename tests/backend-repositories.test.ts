import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BeadsRepository, LocalGitRepository, runCommand } from '../src/server/repositories.js';
import type { Project } from '../src/shared/types.js';

const beads=new BeadsRepository();
const available=existsSync(beads.executable)||!!process.env.WORKBENCH_BD_PATH;
describe.skipIf(!available)('real Git and Beads repository adapters',()=>{
  const root=mkdtempSync(join(tmpdir(),'workbench-repository-'));
  const git=new LocalGitRepository(join(root,'worktrees'));
  const project:Project={id:'integration',name:'Synthetic integration',path:join(root,'repo'),createdAt:new Date().toISOString()};
  beforeAll(async()=>{
    await runCommand('git',['init','-b','main',project.path],root);
    await runCommand('git',['config','user.name','Workbench Integration'],project.path);
    await runCommand('git',['config','user.email','workbench@example.invalid'],project.path);
    await runCommand('git',['config','core.autocrlf','false'],project.path);
    writeFileSync(join(project.path,'example.txt'),'initial\n');
    await runCommand('git',['add','example.txt'],project.path);
    await runCommand('git',['commit','-m','Synthetic fixture'],project.path);
  },30000);
  afterAll(()=>{
    // Only the directory freshly allocated by this suite can be recursively removed.
    if(!resolve(root).startsWith(resolve(tmpdir())+requireSeparator()))throw new Error('Unexpected cleanup path');
    rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  it('initializes Beads explicitly, reads real dependency edges and updates status',async()=>{
    await beads.validate(project.path,true);
    const first=await beads.create(project,{title:'实现中文测试任务',description:'临时示例',acceptance:'真实命令通过'});
    const second=await beads.create(project,{title:'审查测试任务',dependencies:[first.id]});
    expect((await beads.get(project,first.id)).acceptance).toBe('真实命令通过');
    expect((await beads.get(project,second.id)).dependencies).toContain(first.id);
    expect((await beads.list(project)).find(task=>task.id===second.id)!.dependencies).toContain(first.id);
    await beads.update(project,first.id,{status:'in_progress',owner:'integration-agent'});
    expect((await beads.get(project,first.id)).status).toBe('in_progress');
    await beads.update(project,first.id,{status:'closed',reason:'临时集成适配器测试已验证'});
    expect((await beads.get(project,first.id)).status).toBe('closed');
  },45000);
  it('creates independent worktrees from fixed commits and preserves source changes',async()=>{
    expect(await git.validate(project.path)).toBe(project.path);
    const head=await runCommand('git',['rev-parse','HEAD'],project.path);
    writeFileSync(join(project.path,'example.txt'),'user dirty change\n');
    const binding=await git.createWorktree(project,'synthetic-task','agent-example',head);
    expect(readFileSync(join(binding.worktree,'example.txt'),'utf8')).toBe('initial\n');
    expect(readFileSync(join(project.path,'example.txt'),'utf8')).toBe('user dirty change\n');
    expect((await git.inspect(binding.worktree)).commit).toBe(head);
    expect((await git.inspect(binding.worktree)).dirty).toBe(false);
  },20000);
});
function requireSeparator():string {return process.platform==='win32'?'\\':'/';}
