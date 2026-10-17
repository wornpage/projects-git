import {mkdir,readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RepositoryRunner} from './repository-runner.mjs';
import {readWorkspaceBackup,workspaceBackupPreview,MAX_WORKSPACE_BACKUP_BYTES} from '../core/workspace-backup.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_GIT_BYTES=64*1024*1024,MAX_OBJECTS=16384;
const refuse=message=>{throw Error('Workspace bundle: '+message);};
const refs=project=>Object.fromEntries([['refs/heads/recovered-main',project.mainCommit],...project.commits.map(hash=>['refs/projects-backup/'+hash,hash])]);
const dirname=index=>'project-'+String(index).padStart(3,'0');
async function freshDirectory(directory){
  const root=path.resolve(directory);await mkdir(root,{mode:0o700});
  if(await realpath(root)!==root)refuse('Destination must not be redirected.');return root;
}
async function boundedFile(root,name,limit){
  const file=path.join(root,name),stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit||await realpath(file)!==file)refuse('Invalid or oversized '+name+'.');
  const bytes=await readFile(file);if(bytes.length>limit)refuse('A package file grew beyond its limit.');return bytes;
}

/** Local sources only. Never clones, fetches a URL, reads credentials or runs imported checks. */
export async function writeWorkspaceBundle({archive,expectedArchiveSha256,sources,directory}){
  archive=await readWorkspaceBackup(JSON.stringify(archive),expectedArchiveSha256);
  const projects=archive.payload.projects;
  if(!sources||typeof sources!=='object'||Array.isArray(sources)||Object.keys(sources).length!==projects.length
    ||projects.some(project=>!Object.hasOwn(sources,project.id)))refuse('Supply exact local source mappings for every project.');
  for(const project of projects){
    const rows=sources[project.id];
    if(!rows||typeof rows!=='object'||Array.isArray(rows)||Object.keys(rows).length!==project.commits.length
      ||project.commits.some(hash=>!Object.hasOwn(rows,hash)||typeof rows[hash]!=='string'||!path.isAbsolute(rows[hash])))refuse('Every referenced commit needs an explicit absolute local source.');
  }
  const root=await freshDirectory(directory),runner=new RepositoryRunner(root);await runner.initialize();
  const budget={remainingBytes:MAX_GIT_BYTES,remainingObjects:MAX_OBJECTS,seen:new Set()},entries=[];
  let totalBundleBytes=0;
  for(const [index,project] of projects.entries()){
    const name=dirname(index),directory=path.join(root,name),repository=path.join(directory,'objects.git');
    await mkdir(directory,{mode:0o700});await mkdir(repository,{mode:0o700});await runner.git(repository,['init','--bare']);budget.seen=new Set();
    for(const hash of project.commits)await runner.copyCommit(sources[project.id][hash],repository,hash,{boundary:'0'.repeat(40),objectBudget:budget});
    const references=refs(project);for(const [ref,hash] of Object.entries(references))await runner.git(repository,['update-ref',ref,hash,'0'.repeat(40)]);
    await runner.git(repository,['symbolic-ref','HEAD','refs/heads/recovered-main']);await runner.git(repository,['fsck','--strict','--full']);
    const bytes=await runner.git(repository,['bundle','create','-','--all'],undefined,[],{binary:true,maxBuffer:MAX_GIT_BYTES-totalBundleBytes});
    totalBundleBytes+=bytes.length;if(totalBundleBytes>MAX_GIT_BYTES)refuse('Git bundles exceed their aggregate 64 MiB limit.');
    await writeFile(path.join(directory,'history.bundle'),bytes,{flag:'wx',mode:0o600});
    entries.push({projectId:project.id,directory:name,bundleSha256:digest(bytes),bundleBytes:bytes.length,refs:references});
  }
  await writeFile(path.join(root,'workspace.json'),JSON.stringify(archive),{flag:'wx',mode:0o600});
  const manifest={format:'projects-git-workspace-bundle/v1',archiveSha256:archive.sha256,sourceWorkspaceId:archive.payload.workspace.id,projects:entries},bytes=JSON.stringify(manifest);
  await writeFile(path.join(root,'manifest.json'),bytes,{flag:'wx',mode:0o600});
  return {directory:root,manifestSha256:digest(bytes),archiveSha256:archive.sha256,projects:projects.length,totalBundleBytes,historical:true};
}

/** Recover into a new offline directory, never into an app's active database or source checkout. */
export async function restoreWorkspaceBundle({directory,destination,expectedManifestSha256,expectedSourceWorkspaceId}){
  const root=path.resolve(directory);if(await realpath(root)!==root)refuse('Package directory must not be redirected.');
  const manifestBytes=await boundedFile(root,'manifest.json',128*1024);
  if(typeof expectedManifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedManifestSha256)||digest(manifestBytes)!==expectedManifestSha256)refuse('Manifest digest mismatch.');
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));}catch{refuse('Invalid manifest JSON.');}
  if(!manifest||Object.keys(manifest).sort().join(',')!=='archiveSha256,format,projects,sourceWorkspaceId'||manifest.format!=='projects-git-workspace-bundle/v1'
    ||typeof expectedSourceWorkspaceId!=='string'||manifest.sourceWorkspaceId!==expectedSourceWorkspaceId||!Array.isArray(manifest.projects))refuse('Unexpected manifest or source workspace.');
  const archive=await readWorkspaceBackup(new TextDecoder('utf-8',{fatal:true}).decode(await boundedFile(root,'workspace.json',MAX_WORKSPACE_BACKUP_BYTES)),manifest.archiveSha256);
  if(archive.payload.workspace.id!==expectedSourceWorkspaceId||manifest.projects.length!==archive.payload.projects.length)refuse('Backup identity or project denominator differs.');
  const bundles=[];let total=0;
  for(const [index,project] of archive.payload.projects.entries()){
    const entry=manifest.projects[index],name=dirname(index),folder=path.join(root,name);
    if(!entry||Object.keys(entry).sort().join(',')!=='bundleBytes,bundleSha256,directory,projectId,refs'||entry.projectId!==project.id||entry.directory!==name
      ||JSON.stringify(entry.refs)!==JSON.stringify(refs(project))||!Number.isSafeInteger(entry.bundleBytes)||entry.bundleBytes<1||entry.bundleBytes>MAX_GIT_BYTES-total
      ||typeof entry.bundleSha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.bundleSha256))refuse('Project bundle inventory differs from the backup.');
    const stat=await lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(folder)!==folder)refuse('Project package directory was redirected.');
    const bytes=await boundedFile(folder,'history.bundle',entry.bundleBytes);
    if(bytes.length!==entry.bundleBytes||digest(bytes)!==entry.bundleSha256)refuse('Git bundle digest mismatch.');
    total+=bytes.length;bundles.push(bytes);
  }
  // Validate identities and every file digest before creating the destination.
  const restored=await freshDirectory(destination),runner=new RepositoryRunner(restored);await runner.initialize();
  const repositories=[];
  for(const [index,project] of archive.payload.projects.entries()){
    const repository=path.join(restored,dirname(index)+'.git');await mkdir(repository,{mode:0o700});await runner.git(repository,['init','--bare']);
    const file=path.join(repository,'history.bundle');await writeFile(file,bundles[index],{flag:'wx',mode:0o600});
    await runner.git(repository,['bundle','verify',file]);
    const references=refs(project),actual=(await runner.git(repository,['bundle','list-heads',file])).split('\n').map(line=>line.split(' ')).filter(([,ref])=>ref!=='HEAD');
    if(actual.length!==Object.keys(references).length||actual.some(([hash,ref])=>!Object.hasOwn(references,ref)||references[ref]!==hash))refuse('Git bundle references differ from retained roots.');
    await runner.git(repository,['bundle','unbundle',file]);
    for(const [ref,hash] of Object.entries(references)){await runner.git(repository,['cat-file','-e',hash+'^{commit}']);await runner.git(repository,['update-ref',ref,hash,'0'.repeat(40)]);}
    await runner.git(repository,['symbolic-ref','HEAD','refs/heads/recovered-main']);await runner.git(repository,['fsck','--strict','--full']);
    repositories.push({projectId:project.id,directory:repository,recordedDefaultBranch:project.defaultBranch,mainCommit:project.mainCommit,commits:project.commits.length});
  }
  await writeFile(path.join(restored,'workspace.json'),JSON.stringify(archive),{flag:'wx',mode:0o600});
  const recovery={...workspaceBackupPreview(archive),format:'projects-git-offline-recovery/v1',manifestSha256:expectedManifestSha256,repositories,
    installableSnapshot:false,pendingEffectPolicy:'Retain and reconcile separately. An expired lease is not evidence that work stopped.'};
  await writeFile(path.join(restored,'recovery.json'),JSON.stringify(recovery),{flag:'wx',mode:0o600});
  return recovery;
}
