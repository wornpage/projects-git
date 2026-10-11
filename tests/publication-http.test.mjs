import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createApplication} from '../src/local/server.mjs';
import {RepositoryRunner} from '../src/local/repository-runner.mjs';
import {readOnlyGit,committedChange} from '../src/local/git-reader.mjs';
import {createWorkspace,createTask,assignRun,startRun,completeRun,verifyRun,reviewRun,mergeRun} from '../src/core/workflow.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'projects-publication-http-')),data=join(root,'data'),seed=join(root,'seed');
  mkdirSync(data);mkdirSync(seed);
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath='+join(root,'no-hooks'),'-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{cwd:seed,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');writeFileSync(join(seed,'app.py'),'print(1)\n');git('add','app.py');git('commit','-m','Base');const base=git('rev-parse','HEAD');
  writeFileSync(join(seed,'app.py'),'print(2)\n');git('add','app.py');git('commit','-m','Candidate');const head=git('rev-parse','HEAD');
  const state=createWorkspace(),task=createTask(state,{title:'Python fixture',purpose:'Retain the intended result',criteria:['Print the intended number'],owner:'Fixture owner',baseCommit:base});
  const run=assignRun(state,task.id,{agent:'external',label:'Fixture agent',branch:'newwork/fixture'});startRun(state,run.id);
  completeRun(state,run.id,{headCommit:head,...await committedChange(readOnlyGit(seed),base,head),summary:'HTTP boundary fixture'});
  verifyRun(state,run.id,{commit:head,taskRevision:1,source:'independent-local-checks',verified:true,passed:1,total:1,checks:[{name:'Declared fixture',passed:true,detail:'Test-only evidence'}],command:'fixture',exitCode:0,output:'2',verifiedAt:new Date().toISOString()});
  reviewRun(state,run.id,{decision:'accept',reviewer:'Fixture owner',note:'Test-only decision',headCommit:head,taskRevision:1,ownerVersion:1,comparisons:[]});
  mergeRun(state,run.id,{headCommit:head,baseCommit:base,mergedCommit:head});
  Object.assign(task,{origin:'connected-git',projectId:task.id,repositoryKey:task.id});
  state.projects={[task.id]:{id:task.id,kind:'connected',name:'Fixture',owner:task.owner,mainCommit:head,codeConnected:true,acceptingWork:true,policyVersion:1}};
  const runner=new RepositoryRunner(join(data,'connected'));await runner.initialize();const connected=await runner.connect(task,seed);
  await runner.copyCommit(seed,connected.repository,head,{boundary:base});
  await runner.git(connected.repository,['update-ref','refs/candidates/'+run.id,head]);
  await runner.git(connected.repository,['update-ref','refs/heads/main',head,base]);
  writeFileSync(join(data,'workspace.json'),JSON.stringify(state));writeFileSync(join(data,'repositories.json'),JSON.stringify({[task.id]:connected.repository}));
  const remote={branch:null,pr:null,losePR:false,pause:null},calls=[];
  const provider={repository:'fixture/private-repo',secret:'provider-secret-must-stay-private',
    async repositoryInfo(){calls.push('read');return {id:321,full_name:this.repository,private:true,default_branch:'main',permissions:{push:true}};},
    async ref(branch){return branch==='main'?base:remote.branch;},
    async findPullRequest(){return remote.pr;},async pullRequest(){return remote.pr;},
    async pushBranch(repository,binding){calls.push('push');assert.equal(repository,connected.repository);assert.equal(binding.local.headCommit,head);if(remote.pause){remote.pause.entered.resolve();await remote.pause.release.promise;}remote.branch=head;},
    async createPullRequest(record){calls.push('create');remote.pr={number:1,html_url:'https://github.com/fixture/private-repo/pull/1',state:'open',merged:false,
      head:{sha:head,ref:record.binding.headBranch,repo:{id:321}},base:{ref:'main',repo:{id:321}}};if(remote.losePR)throw Error('Lost response');return remote.pr;}};
  let app,url;
  async function start(){app=createApplication({dataDir:data,githubProvider:provider});await app.ready;app.server.listen(0,'127.0.0.1');await once(app.server,'listening');url='http://127.0.0.1:'+app.server.address().port;}
  await start();
  t.after(async()=>{await app.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  const post=(suffix,body={},headers={})=>fetch(url+`/api/runs/${run.id}/publication/`+suffix,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,...headers},body:JSON.stringify(body)});
  return {post,remote,calls,data,head,runId:run.id,app:()=>app,url:()=>url,restart:async()=>{await app.close();await start();}};
}

test('local HTTP refuses forged destinations and cross-origin requests before provider I/O',async t=>{
  const f=await fixture(t),version=f.app().snapshot().version;
  assert.equal((await f.post('preview',{repository:'other/repo'})).status,422);
  assert.equal((await f.post('preview',{}, {Origin:'https://other.example'})).status,403);
  const foreign=await fetch(f.url()+`/api/runs/${crypto.randomUUID()}/publication/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(foreign.status,404);assert.deepEqual(f.calls,[]);assert.equal(f.app().snapshot().version,version);
  assert.equal(JSON.stringify(f.app().snapshot()).includes('provider-secret'),false);
});

test('competing publication requests are bounded by the existing repository lock',async t=>{
  const f=await fixture(t),preview=await (await f.post('preview')).json();
  const request={previewId:preview.id,requestId:crypto.randomUUID()};
  f.remote.pause={entered:deferred(),release:deferred()};const first=f.post('publish',request);await f.remote.pause.entered.promise;
  assert.equal((await f.post('publish',request)).status,409);
  const durable=JSON.parse(readFileSync(join(f.data,'workspace.json'))).runs[0].publication;
  assert.equal(durable.id,request.requestId);assert.ok(durable.pushStartedAt);assert.equal(f.calls.filter(c=>c==='push').length,1);
  f.remote.pause.release.resolve();const result=await first;assert.equal(result.status,200);assert.equal((await result.json()).status,'open');
  assert.equal((await (await f.post('publish',request)).json()).status,'open');assert.equal(f.calls.filter(c=>c==='create').length,1);
});

test('real durable restart retains an uncertain PR and refresh resolves it without replay',async t=>{
  const f=await fixture(t),preview=await (await f.post('preview')).json();f.remote.losePR=true;
  const record=await (await f.post('publish',{previewId:preview.id,requestId:crypto.randomUUID()})).json();
  assert.equal(record.status,'needs_attention');assert.equal(f.calls.filter(c=>c==='create').length,1);
  await f.restart();f.remote.losePR=false;
  const observed=await (await f.post(record.id+'/refresh')).json();assert.equal(observed.status,'open');
  assert.equal(f.calls.filter(c=>c==='push').length,1);assert.equal(f.calls.filter(c=>c==='create').length,1);
  assert.ok(observed.observations.some(item=>item.status==='needs_attention'));
});

test('invalid publication configuration refuses before acquiring a server lock',()=>{
  const data=join(tmpdir(),'must-not-be-created-'+crypto.randomUUID());
  assert.throws(()=>createApplication({dataDir:data,githubProvider:{repository:'https://invalid'}}),{code:'github_configuration'});
});
