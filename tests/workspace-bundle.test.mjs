import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,cp,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RepositoryRunner} from '../src/local/repository-runner.mjs';
import {createWorkspace,createTask,assignRun,startRun} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup} from '../src/core/workspace-backup.mjs';
import {writeWorkspaceBundle,restoreWorkspaceBundle} from '../src/local/workspace-bundle.mjs';
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'projects-workspace-backup-')),runner=new RepositoryRunner(root);await runner.initialize();
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});});
  const source=path.join(root,'source');await mkdir(source);const git=args=>runner.git(source,args);
  await git(['init','-b','main']);await writeFile(path.join(source,'value.txt'),'original\n');await git(['add','value.txt']);
  const commit=async message=>{await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am',message]);return git(['rev-parse','HEAD']);};
  const base=await commit('Base');await writeFile(path.join(source,'value.txt'),'uncertain\n');const pending=await commit('Uncertain');
  const workspace=createWorkspace({provider:'cloudflare-artifacts'}),first=crypto.randomUUID(),second=crypto.randomUUID();
  workspace.projects={};for(const id of [first,second])workspace.projects[id]={id,name:id===first?'First':'Second',repositoryName:'fixture-'+id,mainCommit:base,defaultBranch:'main',kind:'artifacts',acceptingWork:true,policyVersion:1};
  const task=createTask(workspace,{title:'Retain uncertainty',purpose:'Recover without retrying',criteria:['Keep every referenced object'],baseCommit:base,owner:'Fixture'});task.projectId=first;
  const run=assignRun(workspace,task.id,{agent:'external',label:'Fixture',branch:'agents/fixture'});startRun(workspace,run.id);
  const snapshot={revision:3,workspace,operations:{['f'.repeat(64)]:{kind:'merge',fingerprint:'e'.repeat(64),state:'pending',projectId:first,itemId:run.id,pendingCommit:pending}},
    repositories:{[task.id]:workspace.projects[first].repositoryName},forks:{},jobs:{},checkPolicies:{}};
  const archive=await buildWorkspaceBackup(snapshot),sources=Object.fromEntries(archive.payload.projects.map(project=>[project.id,Object.fromEntries(project.commits.map(hash=>[hash,source]))]));
  return {root,runner,source,base,pending,archive,sources};
}
test('cold offline recovery retains two projects and uncertain commits without the original source or live authority',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'package'),destination=path.join(f.root,'recovery');
  const packaged=await writeWorkspaceBundle({...f,expectedArchiveSha256:f.archive.sha256,directory});
  const retired=path.join(f.root,'retired-source');assert.equal(path.dirname(f.source),f.root);assert.equal(path.dirname(retired),f.root);await rename(f.source,retired);
  const restored=await restoreWorkspaceBundle({directory,destination,expectedManifestSha256:packaged.manifestSha256,expectedSourceWorkspaceId:f.archive.payload.workspace.id});
  assert.equal(restored.repositories.length,2);assert.equal(restored.counts.pendingOperations,1);assert.equal(restored.installableSnapshot,false);
  assert.equal(restored.format,'projects-git-offline-recovery/v1');
  assert.equal(restored.resumesWork,false);assert.equal(restored.restoresAuthority,false);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination,'workspace.json'),'utf8')),f.archive);
  for(const repository of restored.repositories){
    assert.equal(await f.runner.git(repository.directory,['show','HEAD:value.txt']),'original');assert.equal(await f.runner.git(repository.directory,['remote']),'');
  }
  assert.equal(await f.runner.git(restored.repositories[0].directory,['show',f.pending+':value.txt']),'uncertain');
  await assert.rejects(restoreWorkspaceBundle({directory,destination,expectedManifestSha256:packaged.manifestSha256,expectedSourceWorkspaceId:f.archive.payload.workspace.id}),{code:'EEXIST'});
});
test('wrong workspace, corrupt or missing Git data and manifest substitution fail before a recovery directory exists',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'package'),destination=path.join(f.root,'refused');
  const packaged=await writeWorkspaceBundle({...f,expectedArchiveSha256:f.archive.sha256,directory});
  const args={directory,destination,expectedManifestSha256:packaged.manifestSha256,expectedSourceWorkspaceId:f.archive.payload.workspace.id};
  await assert.rejects(restoreWorkspaceBundle({...args,expectedSourceWorkspaceId:'another-workspace'}),/source workspace/);
  await assert.rejects(access(destination),{code:'ENOENT'});
  await assert.rejects(restoreWorkspaceBundle({...args,expectedManifestSha256:'0'.repeat(64)}),/Manifest digest mismatch/);
  const tampered=path.join(f.root,'tampered');await cp(directory,tampered,{recursive:true});
  const file=path.join(tampered,'project-000','history.bundle'),bytes=await readFile(file);bytes[bytes.length-1]^=1;await writeFile(file,bytes);
  await assert.rejects(restoreWorkspaceBundle({...args,directory:tampered}),/Git bundle digest mismatch/);await assert.rejects(access(destination),{code:'ENOENT'});
  const missing=path.join(f.root,'missing');await cp(directory,missing,{recursive:true});
  const missingFile=path.join(missing,'project-001','history.bundle');assert.ok(missingFile.startsWith(f.root+path.sep));await rm(missingFile);
  await assert.rejects(restoreWorkspaceBundle({...args,directory:missing}),{code:'ENOENT'});await assert.rejects(access(destination),{code:'ENOENT'});
});
test('missing local source mappings and URLs cannot begin a package',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'refused');
  await assert.rejects(writeWorkspaceBundle({...f,expectedArchiveSha256:f.archive.sha256,sources:{},directory}),/every project/);
  const sources=structuredClone(f.sources),first=Object.keys(sources)[0];sources[first][Object.keys(sources[first])[0]]='https://example.invalid/repo.git';
  await assert.rejects(writeWorkspaceBundle({...f,expectedArchiveSha256:f.archive.sha256,sources,directory}),/absolute local source/);
  await assert.rejects(access(directory),{code:'ENOENT'});
});
