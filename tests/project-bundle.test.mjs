import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, access, cp, rename, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {RepositoryRunner} from '../src/local/repository-runner.mjs';
import {writeProjectBundle, restoreProjectBundle} from '../src/local/project-bundle.mjs';
import {createWorkspace, createTask, assignRun, startRun, completeRun} from '../src/core/workflow.mjs';
import {buildProjectArchive} from '../src/core/project-archive.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'projects-artifacts-bundle-')),runner=new RepositoryRunner(root);await runner.initialize();
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});});
 const source=path.join(root,'source');await mkdir(source);const git=args=>runner.git(source,args);
 await git(['init','-b','main']);await writeFile(path.join(source,'report.py'),'value = 0\n');await git(['add','report.py']);
 const commit=async message=>{await git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am',message]);return git(['rev-parse','HEAD']);};
 const base=await commit('Start');await writeFile(path.join(source,'report.py'),'value = 1\n');const main=await commit('Accepted change');
 await git(['switch','-c','agent/alternative']);await writeFile(path.join(source,'report.py'),'value = 2\n');const alternative=await commit('Retained alternative');
 const state=createWorkspace({provider:'cloudflare-artifacts'}),projectId=crypto.randomUUID();
 state.projects={[projectId]:{id:projectId,name:'Bundle fixture',repositoryName:'source',defaultBranch:'main',mainCommit:main,kind:'artifacts',acceptingWork:false,policyVersion:1}};
 const task=createTask(state,{title:'Alternative',purpose:'Retain every candidate',criteria:['Keep history'],baseCommit:base,owner:'Fixture owner'});task.projectId=projectId;
 const run=assignRun(state,task.id,{agent:'fixture',label:'Scripted fixture',branch:'agent/alternative'});startRun(state,run.id);
 completeRun(state,run.id,{headCommit:alternative,changedFiles:['report.py'],diff:'fixture',summary:'Keep this alternative'});
 return {root,runner,source,base,main,alternative,state,projectId};
}

test('offline bundle preserves full Git ancestry, alternative candidate and evidence without the original repository',async t=>{
 const {root,runner,source,main,alternative,state,projectId}=await fixture(t);
 const archive=await buildProjectArchive(state,projectId),directory=path.join(root,'export');
 const exported=await writeProjectBundle({archive,expectedArchiveSha256:archive.sha256,sources:Object.fromEntries(archive.payload.commits.map(hash=>[hash,source])),directory});
 const retired=path.join(root,'source-unavailable');assert.equal(path.dirname(retired),root);await rename(source,retired);
 const destination=path.join(root,'restored.git'),restored=await restoreProjectBundle({directory,destination,expectedManifestSha256:exported.manifestSha256});
 assert.equal(restored.mainCommit,main);assert.equal(restored.commits,3);
 assert.equal(await runner.git(destination,['show','HEAD:report.py']),'value = 1');
 assert.equal(await runner.git(destination,['show',alternative+':report.py']),'value = 2');
 assert.equal(await runner.git(destination,['rev-list','--all','--count']),'3');
 assert.equal(await runner.git(destination,['remote']), '');
 assert.deepEqual(JSON.parse(await readFile(path.join(destination,'project-history.json'),'utf8')),archive);
 await assert.rejects(restoreProjectBundle({directory,destination,expectedManifestSha256:exported.manifestSha256}),{code:'EEXIST'});
 const tampered=path.join(root,'tampered');await cp(directory,tampered,{recursive:true});
 const bytes=await readFile(path.join(tampered,'project.bundle'));bytes[bytes.length-1]^=1;await writeFile(path.join(tampered,'project.bundle'),bytes);
 const refused=path.join(root,'refused.git');await assert.rejects(restoreProjectBundle({directory:tampered,destination:refused,expectedManifestSha256:exported.manifestSha256}),/digest mismatch/);
 await assert.rejects(access(refused),{code:'ENOENT'});
 await assert.rejects(restoreProjectBundle({directory,destination:refused,expectedManifestSha256:'0'.repeat(64)}),/Manifest digest mismatch/);
 await assert.rejects(access(refused),{code:'ENOENT'});
});

test('default branches cannot collide with retained refs and existing valid v1 layouts stay readable',async t=>{
 const {root,runner,source,main,alternative,state,projectId}=await fixture(t);
 const branches=['projects-archive/'+alternative,'projects-archive','projects-archive/'+main];
 for(const [index,branch] of branches.entries()) {
  state.projects[projectId].defaultBranch=branch;
  const archive=await buildProjectArchive(state,projectId),directory=path.join(root,'collision-'+index);
  const exported=await writeProjectBundle({archive,expectedArchiveSha256:archive.sha256,sources:Object.fromEntries(archive.payload.commits.map(hash=>[hash,source])),directory});
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.refs['refs/heads/'+branch],main);
  for(const hash of archive.payload.commits)assert.ok(Object.values(manifest.refs).includes(hash));
  if(index===2)assert.ok(Object.keys(manifest.refs).every(ref=>ref.startsWith('refs/heads/projects-archive/')),'Previously valid v1 mapping remains identical');
  const destination=path.join(root,'collision-restored-'+index+'.git');
  assert.equal((await restoreProjectBundle({directory,destination,expectedManifestSha256:exported.manifestSha256})).mainCommit,main);
  assert.equal(await runner.git(destination,['symbolic-ref','HEAD']),'refs/heads/'+branch);
  assert.equal(await runner.git(destination,['show',alternative+':report.py']),'value = 2');
 }
});

test('Git bundle output is bounded while produced and aggregate object charges deduplicate shared ancestry',async t=>{
 const {root,runner,source,main,alternative}=await fixture(t);
 await assert.rejects(runner.git(source,['bundle','create','-','--all'],undefined,[],{binary:true,maxBuffer:32}),/output byte allowance/);
 const destination=path.join(root,'budget.git');await mkdir(destination);await runner.git(destination,['init','--bare']);
 const budget={remainingBytes:1024*1024,remainingObjects:4096,seen:new Set()};
 await runner.copyCommit(source,destination,main,{boundary:'0'.repeat(40),objectBudget:budget});
 const before={bytes:budget.remainingBytes,objects:budget.remainingObjects};
 await runner.copyCommit(source,destination,main,{boundary:'0'.repeat(40),objectBudget:budget});
 assert.equal(budget.remainingBytes,before.bytes);assert.equal(budget.remainingObjects,before.objects);
 const stopped={remainingBytes:1024*1024,remainingObjects:0,seen:new Set()};
 await assert.rejects(runner.copyCommit(source,destination,alternative,{boundary:'0'.repeat(40),objectBudget:stopped}),/aggregate/);
});

test('disjoint retained commits stop at the aggregate staging budget before creating a bundle',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'projects-artifacts-budget-')),runner=new RepositoryRunner(root);await runner.initialize();
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});});
 const source=path.join(root,'source');await mkdir(source);const git=args=>runner.git(source,args);await git(['init','-b','main']);
 const commits=[];
 for(let index=0;index<9;index++) {
  for(let file=0;file<8;file++) {
   const bytes=Buffer.alloc(1024*1024,120);bytes.write('disjoint-'+index+'-'+file);
   await writeFile(path.join(source,'file-'+file+'.txt'),bytes);
  }
  await git(['add','.']);const tree=await git(['write-tree']);
  const hash=await runner.git(source,['-c','user.name=Budget fixture','-c','user.email=fixture@example.invalid','commit-tree',tree], 'Disjoint '+index+'\n');
  await git(['update-ref','refs/heads/fixture-'+index,hash]);commits.push(hash);
 }
 const state=createWorkspace({provider:'cloudflare-artifacts'}),id=crypto.randomUUID();
 state.projects={[id]:{id,name:'Budget fixture',repositoryName:'source',defaultBranch:'main',mainCommit:commits[0],acceptingWork:false,kind:'artifacts'}};
 const task=createTask(state,{title:'Keep disjoint candidates',purpose:'Stop before unbounded staging',criteria:['Bound all candidates together'],baseCommit:commits[0],owner:'Fixture'});task.projectId=id;
 for(const [index,headCommit] of commits.entries()) {
  if(index===0)continue; // The first commit is the project baseline, not a candidate change.
  const run=assignRun(state,task.id,{agent:'fixture',label:'Disjoint '+index,branch:'fixture-'+index});startRun(state,run.id);
  completeRun(state,run.id,{headCommit,changedFiles:['file-0.txt'],diff:'fixture',summary:'Retained disjoint candidate'});
 }
 const archive=await buildProjectArchive(state,id),directory=path.join(root,'refused-export');
 await assert.rejects(writeProjectBundle({archive,expectedArchiveSha256:archive.sha256,sources:Object.fromEntries(commits.map(hash=>[hash,source])),directory}),/aggregate/);
 await assert.rejects(access(path.join(directory,'project.bundle')),{code:'ENOENT'});
 await assert.rejects(access(path.join(directory,'manifest.json')),{code:'ENOENT'});
 let charge=0,objects=0;
 const objectsDirectory=path.join(directory,'objects.git','objects');
 for(const prefix of await readdir(objectsDirectory))if(/^[a-f0-9]{2}$/.test(prefix))for(const name of await readdir(path.join(objectsDirectory,prefix))) {
  const bytes=await readFile(path.join(objectsDirectory,prefix,name));charge+=Math.max(bytes.length,inflateSync(bytes).length);objects++;
 }
 assert.ok(charge<=64*1024*1024);assert.ok(objects<=16384);assert.ok(charge>=56*1024*1024,'The test reached the shared budget across many disjoint commits');
});
