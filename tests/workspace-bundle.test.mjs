import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,cp,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {RepositoryRunner} from '../src/local/repository-runner.mjs';
import {createWorkspace,createTask,assignRun,startRun} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup} from '../src/core/workspace-backup.mjs';
import {writeWorkspaceBundle,restoreWorkspaceBundle} from '../src/local/workspace-bundle.mjs';
const testLedgers=()=>({capture:'coherent-sqlite-transaction',artifactSubscriptions:[],artifactSubscriptionAttempts:[],artifactEvents:[],artifactEventAttempts:[],artifactDeliveries:[]});
const buildBackup=(snapshot,exportedAt)=>buildWorkspaceBackup(snapshot,exportedAt,testLedgers());
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
  const archive=await buildBackup(snapshot),sources=Object.fromEntries(archive.payload.resources.map(resource=>[resource.id,Object.fromEntries(resource.commits.map(hash=>[hash,source]))]));
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
  const file=path.join(tampered,'resource-000','objects.dat'),bytes=await readFile(file);bytes[bytes.length-1]^=1;await writeFile(file,bytes);
  await assert.rejects(restoreWorkspaceBundle({...args,directory:tampered}),/Git object capsule digest mismatch/);await assert.rejects(access(destination),{code:'ENOENT'});
  const missing=path.join(f.root,'missing');await cp(directory,missing,{recursive:true});
  const missingFile=path.join(missing,'resource-001','objects.dat');assert.ok(missingFile.startsWith(f.root+path.sep));await rm(missingFile);
  await assert.rejects(restoreWorkspaceBundle({...args,directory:missing}),{code:'ENOENT'});await assert.rejects(access(destination),{code:'ENOENT'});
});
test('missing local source mappings and URLs cannot begin a package',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'refused');
  await assert.rejects(writeWorkspaceBundle({...f,expectedArchiveSha256:f.archive.sha256,sources:{},directory}),/every recovery resource/);
  const sources=structuredClone(f.sources),first=Object.keys(sources)[0];sources[first][Object.keys(sources[first])[0]]='https://example.invalid/repo.git';
  await assert.rejects(writeWorkspaceBundle({...f,expectedArchiveSha256:f.archive.sha256,sources,directory}),/absolute local source/);
  await assert.rejects(access(directory),{code:'ENOENT'});
});

async function singleResource(head,source){
  const workspace=createWorkspace({provider:'cloudflare-artifacts'}),id=crypto.randomUUID();workspace.projects={[id]:{id,name:'Full history',repositoryName:'full-history',mainCommit:head,defaultBranch:'main',kind:'artifacts',acceptingWork:true,policyVersion:1}};
  const archive=await buildBackup({revision:1,workspace,operations:{},repositories:{},forks:{},jobs:{},checkPolicies:{}});
  return {archive,expectedArchiveSha256:archive.sha256,sources:{[id]:{[head]:source}}};
}
test('backup captures more than 32 ancestors under aggregate budgets',async t=>{
  const f=await fixture(t),git=args=>f.runner.git(f.source,args);
  for(let i=0;i<33;i++)await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','History '+i]);
  const head=await git(['rev-parse','HEAD']),input=await singleResource(head,f.source),directory=path.join(f.root,'long-history');
  const packaged=await writeWorkspaceBundle({...input,directory});
  const restored=await restoreWorkspaceBundle({directory,destination:path.join(f.root,'recovered-long-history'),expectedManifestSha256:packaged.manifestSha256,expectedSourceWorkspaceId:input.archive.payload.workspace.id});
  assert.equal(await f.runner.git(restored.repositories[0].directory,['rev-list','--count','HEAD']),'35');
  assert.ok(packaged.expandedBytes<64*1024*1024);assert.ok(packaged.objects<16384);
});
test('wide, binary and symlink trees recover without submission-only snapshot limits or checkout',async t=>{
  const f=await fixture(t),git=args=>f.runner.git(f.source,args);await mkdir(path.join(f.source,'wide'));
  for(let i=0;i<257;i++)await writeFile(path.join(f.source,'wide','file-'+i+'.txt'),'file '+i+'\n');
  await writeFile(path.join(f.source,'large.bin'),Buffer.alloc(9*1024*1024));await git(['add','wide','large.bin']);
  const link=await f.runner.git(f.source,['hash-object','-w','--stdin'],'outside-target');
  await git(['update-index','--add','--cacheinfo','120000,'+link+',retained-link']);
  await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Wide binary and link']);
  const head=await git(['rev-parse','HEAD']),input=await singleResource(head,f.source),directory=path.join(f.root,'wide-package');
  const packaged=await writeWorkspaceBundle({...input,directory}),restored=await restoreWorkspaceBundle({directory,destination:path.join(f.root,'recovered-wide'),
    expectedManifestSha256:packaged.manifestSha256,expectedSourceWorkspaceId:input.archive.payload.workspace.id}),repository=restored.repositories[0].directory;
  assert.equal(await f.runner.git(repository,['cat-file','-s','HEAD:large.bin']),String(9*1024*1024));
  assert.match(await f.runner.git(repository,['ls-tree','HEAD','retained-link']),/^120000 blob/);
  assert.equal((await f.runner.git(repository,['ls-tree','-r','--name-only','HEAD'])).split('\n').length,260);
  assert.ok(restored.expandedBytes>9*1024*1024);assert.equal(restored.objects,packaged.objects);
  await assert.rejects(access(path.join(repository,'large.bin')),{code:'ENOENT'});
});
test('a pending resource with no project record packages and restores its uncertain commit',async t=>{
  const f=await fixture(t),workspace=createWorkspace({provider:'cloudflare-artifacts'});workspace.projects={};const projectId=crypto.randomUUID(),key='d'.repeat(64);
  const archive=await buildBackup({revision:1,workspace,repositories:{},forks:{},jobs:{},checkPolicies:{},operations:{[key]:{kind:'repository-create',
    fingerprint:'c'.repeat(64),state:'pending',projectId,resourceName:'pending-source',pendingCommit:f.pending}}});
  const resource=archive.payload.resources[0],directory=path.join(f.root,'pending-package');
  const packaged=await writeWorkspaceBundle({archive,expectedArchiveSha256:archive.sha256,sources:{[resource.id]:{[f.pending]:f.source}},directory});
  const restored=await restoreWorkspaceBundle({directory,destination:path.join(f.root,'recovered-pending'),expectedManifestSha256:packaged.manifestSha256,expectedSourceWorkspaceId:workspace.id});
  assert.equal(restored.counts.projects,0);assert.equal(restored.counts.resources,1);assert.equal(restored.repositories[0].resourceKind,'unattached-operation');
  assert.equal(await f.runner.git(restored.repositories[0].directory,['show','HEAD:value.txt']),'uncertain');
  assert.equal(restored.pendingReceipts[0].key,key);assert.equal(restored.resumesWork,false);
});

function hostileCapsule(blobs){
  const object=(type,bytes)=>{const loose=Buffer.concat([Buffer.from(type+' '+bytes.length+'\0'),bytes]);return {type,bytes,hash:createHash('sha1').update(loose).digest('hex'),compressed:deflateSync(loose)};};
  const data=blobs.map(bytes=>object('blob',bytes)),tree=object('tree',Buffer.concat(data.map((entry,i)=>Buffer.concat([Buffer.from('100644 file-'+String(i).padStart(5,'0')+'\0'),Buffer.from(entry.hash,'hex')]))));
  const commit=object('commit',Buffer.from('tree '+tree.hash+'\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nUntrusted package\n'));
  const objects=[commit,tree,...data],count=Buffer.alloc(4);count.writeUInt32BE(objects.length);
  const segments=[Buffer.from('ProjectsGitObjects\0v1\n'),count];
  for(const entry of objects){const frame=Buffer.alloc(29);frame[0]=['','commit','tree','blob'].indexOf(entry.type);Buffer.from(entry.hash,'hex').copy(frame,1);
    frame.writeUInt32BE(entry.bytes.length,21);frame.writeUInt32BE(entry.compressed.length,25);segments.push(frame,entry.compressed);}
  return {head:commit.hash,bytes:Buffer.concat(segments)};
}
test('self-consistent untrusted capsules cannot exceed expanded bytes or object counts before destination creation',async t=>{
  const f=await fixture(t);
  for(const [name,blobs,pattern] of [['objects',Array.from({length:16383},(_,i)=>Buffer.from('value '+i)),/object-count allowance/],
    ['expanded',[Buffer.alloc(64*1024*1024+1)],/expanded-byte allowance/]]){
    const capsule=hostileCapsule(blobs),input=await singleResource(capsule.head,f.source),resource=input.archive.payload.resources[0],directory=path.join(f.root,'hostile-'+name),folder=path.join(directory,'resource-000');
    await mkdir(directory);await mkdir(folder);await writeFile(path.join(folder,'objects.dat'),capsule.bytes);await writeFile(path.join(directory,'workspace.json'),JSON.stringify(input.archive));
    const manifest={format:'projects-git-workspace-bundle/v1',archiveSha256:input.archive.sha256,sourceWorkspaceId:input.archive.payload.workspace.id,resources:[{
      resourceId:resource.id,directory:'resource-000',objectsSha256:createHash('sha256').update(capsule.bytes).digest('hex'),objectsBytes:capsule.bytes.length,
      refs:{'refs/heads/recovered-main':capsule.head,['refs/projects-backup/'+capsule.head]:capsule.head}}]},encoded=JSON.stringify(manifest);
    await writeFile(path.join(directory,'manifest.json'),encoded);const destination=path.join(f.root,'refused-'+name);
    await assert.rejects(restoreWorkspaceBundle({directory,destination,expectedManifestSha256:createHash('sha256').update(encoded).digest('hex'),expectedSourceWorkspaceId:input.archive.payload.workspace.id}),pattern);
    await assert.rejects(access(destination),{code:'ENOENT'});
  }
});
