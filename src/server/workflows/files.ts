import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ArtifactBundle, BundleFile, InputSnapshot } from '../../shared/workflows.js';
import type { Project } from '../../shared/types.js';
import { runCommand, WorkbenchError, type TaskRepository } from '../repositories.js';
import type { Store } from '../store.js';

export function fileHash(path:string):string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function inside(root:string,path:string):boolean { const value=relative(resolve(root),resolve(path));return value===''||(!value.startsWith(`..${sep}`)&&value!=='..'&&!isAbsolute(value)); }
export function safeExistingFile(root:string,path:string):string {
  const actual=realpathSync(resolve(path)), actualRoot=realpathSync(root);
  if(!inside(actualRoot,actual)||!statSync(actual).isFile())throw new WorkbenchError('文件必须位于本次工作区内，且不能通过符号链接越界。');
  if(statSync(actual).size>100*1024*1024)throw new WorkbenchError('单个成果文件不能超过 100 MiB。');
  return actual;
}
/** A bundle is portable to Windows and must never alias another output or escape its directory. */
export function safeRelativePath(value:string):string {
  if(typeof value!=='string'||!value)throw new WorkbenchError('成果相对路径不能为空。');
  const path=value.replaceAll('\\','/'),parts=path.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f\x7f]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))throw new WorkbenchError(`成果相对路径不安全：${value}`);
  return path;
}
export function assertUniqueRelativePaths(paths:string[]):string[] {
  const normalized=paths.map(safeRelativePath),seen=new Set<string>();
  for(const path of normalized){
    const key=path.normalize('NFC').toLowerCase();
    if(seen.has(key)||[...seen].some(prior=>prior.startsWith(`${key}/`)||key.startsWith(`${prior}/`)))throw new WorkbenchError(`成果相对路径重复或冲突：${path}`);
    seen.add(key);
  }
  return normalized;
}
function assertPlainDestination(root:string,path:string):void {
  if(!inside(root,path))throw new WorkbenchError('成果目标路径越界。');
  // Existing links must not redirect an otherwise safe relative path.
  let current=resolve(path);
  for(;;){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new WorkbenchError('成果目标不能包含符号链接或目录联接。');const parent=dirname(current);if(parent===current)break;current=parent;}
}
export function copyVerifiedFiles(entries:{file:BundleFile;relativePath:string}[],target:string,reuseIdentical=false):BundleFile[] {
  const paths=assertUniqueRelativePaths(entries.map(entry=>entry.relativePath));
  const prepared=entries.map(({file},index)=>{
    const relativePath=paths[index]!,destination=resolve(target,...relativePath.split('/'));
    assertPlainDestination(target,destination);
    if(fileHash(file.path)!==file.sha256)throw new WorkbenchError('输入或前置成果已被修改，必须重新核对。',409);
    if(existsSync(destination)&&(!reuseIdentical||!statSync(destination).isFile()||fileHash(destination)!==file.sha256))throw new WorkbenchError('任务输入或交付目标已存在，拒绝覆盖。',409);
    return {file,relativePath,destination};
  });
  return prepared.map(({file,relativePath,destination})=>{
    mkdirSync(dirname(destination),{recursive:true});assertPlainDestination(target,destination);
    if(!existsSync(destination))copyFileSync(file.path,destination,constants.COPYFILE_EXCL);
    if(fileHash(destination)!==file.sha256||fileHash(file.path)!==file.sha256)throw new WorkbenchError('文件在复制期间发生变化，未完成快照或交付。',409);
    return {...file,path:destination,relativePath};
  });
}
export function snapshotFiles(sourceRoot:string,paths:string[],target:string):BundleFile[] {
  if(!paths.length||paths.length>200)throw new WorkbenchError('请选择 1 至 200 个文件。');
  if(existsSync(target))throw new WorkbenchError('快照目标已存在，拒绝覆盖。',409);
  const entries=paths.map(path=>{
    const requested=resolve(path);
    if(!inside(sourceRoot,requested))throw new WorkbenchError('文件必须位于本次工作区内。');
    const source=safeExistingFile(sourceRoot,requested),relativePath=safeRelativePath(relative(resolve(sourceRoot),requested));
    return {relativePath,file:{name:basename(requested),path:source,sha256:fileHash(source),size:statSync(source).size}};
  });
  return copyVerifiedFiles(entries,target);
}
export class OfficeWorkspaceManager {
  constructor(private readonly dataDir:string,private readonly store:Store,private readonly tasks:TaskRepository){}
  async registerFolder(projectId:string,path:string):Promise<{path:string;controlPath:string}> {
    const original=realpathSync(resolve(path)); if(!statSync(original).isDirectory())throw new WorkbenchError('办公项目必须是文件夹。');
    const controlPath=resolve(this.dataDir,'office',projectId,'control'); mkdirSync(controlPath,{recursive:true});
    if(!existsSync(join(controlPath,'.git'))){
      await runCommand('git',['init','-b','main'],controlPath);
      writeFileSync(join(controlPath,'.gitignore'),'.beads/\n');
      await runCommand('git',['add','.gitignore'],controlPath);
      await runCommand('git',['-c','user.name=Agent Workbench','-c','user.email=workbench@localhost','commit','-m','Office task control repository'],controlPath);
    }
    await this.tasks.validate(controlPath,true);return {path:original,controlPath};
  }
  snapshotInputs(project:Project,paths:string[]):InputSnapshot {
    if(project.kind!=='office')throw new WorkbenchError('仅办公项目使用文件输入快照。');
    const id=randomUUID(), directory=resolve(this.dataDir,'office',project.id,'inputs',id);
    const files=snapshotFiles(project.path,paths,directory).map((file,index)=>({...file,sourcePath:realpathSync(paths[index]!),sourceHash:file.sha256}));
    const snapshot:InputSnapshot={id,projectId:project.id,createdAt:new Date().toISOString(),directory,files};
    this.store.put('input_snapshots',id,snapshot);return snapshot;
  }
  list(projectId:string):InputSnapshot[]{return this.store.all<InputSnapshot>('input_snapshots').filter(item=>item.projectId===projectId);}
  checkInputs(snapshotId:string):{unchanged:boolean;changed:string[]} {
    const snapshot=this.store.get<InputSnapshot>('input_snapshots',snapshotId);if(!snapshot)throw new WorkbenchError('输入快照不存在',404);
    const changed=snapshot.files.filter(file=>!existsSync(file.sourcePath)||fileHash(file.sourcePath)!==file.sourceHash).map(file=>file.name);
    return {unchanged:changed.length===0,changed};
  }
  createTaskDirectory(projectId:string,roundId:string,snapshotId?:string|string[],priorBundles:Pick<ArtifactBundle,'id'|'files'>[]=[]):string {
    const target=resolve(this.dataDir,'office',projectId,'rounds',roundId);
    const ids=typeof snapshotId==='string'?[snapshotId]:snapshotId??[];
    const snapshots=ids.map(id=>{const snapshot=this.store.get<InputSnapshot>('input_snapshots',id);if(!snapshot||snapshot.projectId!==projectId)throw new WorkbenchError('输入快照与项目不匹配。');return snapshot;});
    let index=0;
    const groups=[...snapshots.map(snapshot=>({prefix:`snapshots/${safeRelativePath(snapshot.id)}`,files:snapshot.files})),...priorBundles.map(bundle=>({prefix:`bundles/${safeRelativePath(bundle.id)}`,files:bundle.files}))];
    const entries=groups.flatMap(group=>group.files.map(file=>({file,relativePath:file.relativePath?`${group.prefix}/${safeRelativePath(file.relativePath)}`:`${index++}-${safeRelativePath(file.name)}`})));
    copyVerifiedFiles(entries,join(target,'inputs'),true);
    mkdirSync(join(target,'inputs'),{recursive:true});mkdirSync(join(target,'outputs'),{recursive:true});
    return target;
  }
}
