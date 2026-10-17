import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RepositoryRunner} from './repository-runner.mjs';
import {captureGitObjects,readGitObjects,installGitObjects} from './git-object-capsule.mjs';
import {readWorkspaceBackup,workspaceBackupPreview,MAX_WORKSPACE_BACKUP_BYTES} from '../core/workspace-backup.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const MAX_RECOVERY_GIT_BYTES=64*1024*1024,MAX_RECOVERY_OBJECTS=16384;
const budget=()=>({remainingBytes:MAX_RECOVERY_GIT_BYTES,remainingObjects:MAX_RECOVERY_OBJECTS,remainingArchiveBytes:MAX_RECOVERY_GIT_BYTES});
const refuse=message=>{throw Error('Workspace bundle: '+message);};
const anchorRef=resource=>resource.kind==='project'?'refs/heads/recovered-main':'refs/heads/recovered-anchor';
const refs=resource=>Object.fromEntries([[anchorRef(resource),resource.anchorCommit],...resource.commits.map(hash=>['refs/projects-backup/'+hash,hash])]);
const dirname=index=>'resource-'+String(index).padStart(3,'0');
async function freshDirectory(directory){
  const root=path.resolve(directory);await mkdir(root,{mode:0o700});
  if(await realpath(root)!==root)refuse('Destination must not be redirected.');return root;
}
async function boundedFile(root,name,limit){
  const file=path.join(root,name),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit||await realpath(file)!==file)refuse('Invalid or oversized '+name+'.');
  const bytes=await readFile(file);if(bytes.length>limit)refuse('A package file grew beyond its limit.');return bytes;
}

/** Local object-only sources; no submission walker, fetch, checkout, credentials or imported checks. */
export async function writeWorkspaceBundle({archive,expectedArchiveSha256,sources,directory}){
  archive=await readWorkspaceBackup(JSON.stringify(archive),expectedArchiveSha256);
  const resources=archive.payload.resources;
  if(!sources||typeof sources!=='object'||Array.isArray(sources)||Object.keys(sources).length!==resources.length
    ||resources.some(resource=>!Object.hasOwn(sources,resource.id)))refuse('Supply exact local source mappings for every recovery resource.');
  for(const resource of resources){
    const rows=sources[resource.id];
    if(!rows||typeof rows!=='object'||Array.isArray(rows)||Object.keys(rows).length!==resource.commits.length
      ||resource.commits.some(hash=>!Object.hasOwn(rows,hash)||typeof rows[hash]!=='string'||!path.isAbsolute(rows[hash])))refuse('Every referenced commit needs an explicit absolute local source.');
  }
  const root=await freshDirectory(directory),allowance=budget(),entries=[];
  for(const [index,resource] of resources.entries()){
    const name=dirname(index),folder=path.join(root,name);await mkdir(folder,{mode:0o700});
    const bytes=await captureGitObjects(resource.commits,sources[resource.id],allowance);
    await writeFile(path.join(folder,'objects.dat'),bytes,{flag:'wx',mode:0o600});
    entries.push({resourceId:resource.id,directory:name,objectsSha256:digest(bytes),objectsBytes:bytes.length,refs:refs(resource)});
  }
  await writeFile(path.join(root,'workspace.json'),JSON.stringify(archive),{flag:'wx',mode:0o600});
  const manifest={format:'projects-git-workspace-bundle/v1',archiveSha256:archive.sha256,sourceWorkspaceId:archive.payload.workspace.id,resources:entries},bytes=JSON.stringify(manifest);
  if(Buffer.byteLength(bytes)>MAX_WORKSPACE_BACKUP_BYTES)refuse('Manifest exceeds 1 MiB.');
  await writeFile(path.join(root,'manifest.json'),bytes,{flag:'wx',mode:0o600});
  return {directory:root,manifestSha256:digest(bytes),archiveSha256:archive.sha256,projects:archive.payload.projects.length,resources:resources.length,
    encodedBytes:MAX_RECOVERY_GIT_BYTES-allowance.remainingArchiveBytes,expandedBytes:MAX_RECOVERY_GIT_BYTES-allowance.remainingBytes,
    objects:MAX_RECOVERY_OBJECTS-allowance.remainingObjects,historical:true};
}

/** Recover to a fresh offline directory after independently validating every expanded object and root. */
export async function restoreWorkspaceBundle({directory,destination,expectedManifestSha256,expectedSourceWorkspaceId}){
  const root=path.resolve(directory);if(await realpath(root)!==root)refuse('Package directory must not be redirected.');
  const manifestBytes=await boundedFile(root,'manifest.json',MAX_WORKSPACE_BACKUP_BYTES);
  if(typeof expectedManifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedManifestSha256)||digest(manifestBytes)!==expectedManifestSha256)refuse('Manifest digest mismatch.');
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{refuse('Invalid manifest JSON.');}
  if(!manifest||Object.keys(manifest).sort().join(',')!=='archiveSha256,format,resources,sourceWorkspaceId'||manifest.format!=='projects-git-workspace-bundle/v1'
    ||typeof expectedSourceWorkspaceId!=='string'||manifest.sourceWorkspaceId!==expectedSourceWorkspaceId||!Array.isArray(manifest.resources))refuse('Unexpected manifest or source workspace.');
  const archive=await readWorkspaceBackup(new TextDecoder('utf-8',{fatal:true}).decode(await boundedFile(root,'workspace.json',MAX_WORKSPACE_BACKUP_BYTES)),manifest.archiveSha256);
  if(archive.payload.workspace.id!==expectedSourceWorkspaceId||manifest.resources.length!==archive.payload.resources.length)refuse('Backup identity or resource denominator differs.');
  const captured=[],allowance=budget();
  for(const [index,resource] of archive.payload.resources.entries()){
    const entry=manifest.resources[index],name=dirname(index),folder=path.join(root,name);
    if(!entry||Object.keys(entry).sort().join(',')!=='directory,objectsBytes,objectsSha256,refs,resourceId'||entry.resourceId!==resource.id||entry.directory!==name
      ||JSON.stringify(entry.refs)!==JSON.stringify(refs(resource))||!Number.isSafeInteger(entry.objectsBytes)||entry.objectsBytes<1||entry.objectsBytes>allowance.remainingArchiveBytes
      ||typeof entry.objectsSha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.objectsSha256))refuse('Recovery resource inventory differs from the backup.');
    const stat=await lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(folder)!==folder)refuse('Resource package directory was redirected.');
    const bytes=await boundedFile(folder,'objects.dat',entry.objectsBytes);
    if(bytes.length!==entry.objectsBytes||digest(bytes)!==entry.objectsSha256)refuse('Git object capsule digest mismatch.');
    captured.push(readGitObjects(bytes,resource.commits,allowance));
  }
  // Both compressed/encoded and expanded budgets, all object identities and
  // complete graph closure are checked before a destination can be created.
  const restored=await freshDirectory(destination),runner=new RepositoryRunner(restored);await runner.initialize();
  const repositories=[];
  for(const [index,resource] of archive.payload.resources.entries()){
    const repository=path.join(restored,dirname(index)+'.git');await mkdir(repository,{mode:0o700});await runner.git(repository,['init','--bare']);
    await installGitObjects(captured[index],repository);
    for(const [ref,hash] of Object.entries(refs(resource)))await runner.git(repository,['update-ref',ref,hash,'0'.repeat(40)]);
    await runner.git(repository,['symbolic-ref','HEAD',anchorRef(resource)]);await runner.git(repository,['fsck','--strict','--full']);
    repositories.push({resourceId:resource.id,resourceKind:resource.kind,projectId:resource.projectId,directory:repository,
      recordedDefaultBranch:resource.defaultBranch,anchorCommit:resource.anchorCommit,commits:resource.commits.length});
  }
  await writeFile(path.join(restored,'workspace.json'),JSON.stringify(archive),{flag:'wx',mode:0o600});
  const recovery={...workspaceBackupPreview(archive),format:'projects-git-offline-recovery/v1',manifestSha256:expectedManifestSha256,repositories,
    encodedBytes:MAX_RECOVERY_GIT_BYTES-allowance.remainingArchiveBytes,expandedBytes:MAX_RECOVERY_GIT_BYTES-allowance.remainingBytes,objects:MAX_RECOVERY_OBJECTS-allowance.remainingObjects,
    installableSnapshot:false,pendingEffectPolicy:'Retain and reconcile separately. An expired lease is not evidence that work stopped.'};
  await writeFile(path.join(restored,'recovery.json'),JSON.stringify(recovery),{flag:'wx',mode:0o600});return recovery;
}
