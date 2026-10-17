import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TRIAL_SAMPLE,trialSampleName} from '../src/core/trial-sample.mjs';
import {trialSampleFixture} from './helpers/trial-sample.mjs';
import {handler,token,req,admit,fixture,identityKey} from './helpers/trial-http.mjs';

const endpoint='/api/trial/sample';
const setup=(f,jwt,key='sample-test-request')=>handler(req(endpoint,jwt,{}, {'Idempotency-Key':key}),f.env);
const json=async response=>{assert.ok(response.ok,await response.clone().text());return response.json();};

test('the versioned supplied code matches the checkout starter and has no fabricated evidence',()=>{
  assert.equal(TRIAL_SAMPLE.files.find(file=>file.path==='checkout.mjs').content,readFileSync(new URL('../fixtures/checkout.mjs',import.meta.url),'utf8').replaceAll('\r\n','\n'));
  assert.equal(TRIAL_SAMPLE.files.length,4);assert.ok(JSON.stringify(TRIAL_SAMPLE).length<65536);
  assert.throws(()=>trialSampleName('real-private-workspace'));
  assert.ok(TRIAL_SAMPLE.files.every(file=>!file.path.startsWith('.projects')));
});

test('sample setup makes one real Git root commit, connects one read-only project and revokes all tokens',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
  const before=await json(await handler(req(endpoint,jwt),f.env));assert.equal(before.phase,'not-started');assert.equal(f.count('create'),0);
  const response=await setup(f,jwt);assert.equal(response.status,201,await response.clone().text());const result=await response.json();
  assert.equal(result.phase,'ready');assert.equal(result.workflowReady,false);assert.equal(result.replayed,false);assert.equal(f.count('create'),1);assert.equal(f.count('seed'),1);
  const name=trialSampleName(grant.workspaceId),repo=f.repositories.get(name),snapshot=f.store(grant.workspaceId).read();
  assert.equal(result.repository.name,name);assert.equal(f.operation(grant.workspaceId).repositoryId,repo.data.id);
  assert.equal(await f.git.git(repo.directory,'rev-list','--count','main'),'1');
  for(const file of TRIAL_SAMPLE.files)assert.equal(await f.git.git(repo.directory,'show','main:'+file.path),file.content.trimEnd());
  assert.equal(snapshot.workspace.projects[result.repository.projectId].name,TRIAL_SAMPLE.projectName);
  assert.equal(snapshot.workspace.projects[result.repository.projectId].acceptingWork,false);assert.equal(snapshot.workspace.tasks.length,0);assert.equal(snapshot.workspace.runs.length,0);
  assert.ok([...repo.tokens.values()].every(token=>token.state==='revoked'));
  assert.ok(!JSON.stringify({result,snapshot}).includes('local-sample-write-token'));assert.ok(!JSON.stringify({result,snapshot}).includes('local-sample-initial-token'));
  assert.ok(f.git.received.filter(call=>call.path.startsWith('/'+name+'.git/')).every(call=>call.token==='Bearer local-sample-write-token'));
  const count=f.calls.length;f.restart(grant.workspaceId);const repeat=await setup(f,jwt,'new-client-key');assert.equal(repeat.status,200);
  assert.deepEqual((await repeat.json()).repository,result.repository);assert.equal(f.calls.length,count);
  const read=await json(await handler(req('/api/workspace',jwt),f.env));assert.equal(Object.keys(read.projects).length,1);assert.ok(Object.values(read.capabilities).every(value=>value===false));
});

for(const failure of ['create','push','issue','cleanup'])test(`lost ${failure} result resumes the same owned repository after restart`,async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
  const hook={create:'create',push:'afterSeed',issue:'issue',cleanup:'revoke'}[failure];
  f.hooks[hook]=async()=>{delete f.hooks[hook];throw Error('local-sample-write-token');};
  const first=await setup(f,jwt);assert.equal(first.status,502,await first.clone().text());assert.ok(!(await first.text()).includes('local-sample-write-token'));
  assert.equal(Object.keys(f.store(grant.workspaceId).read().workspace.projects).length,0);
  const status=await json(await handler(req(endpoint,jwt),f.env));assert.equal(status.phase,'failed');assert.equal(status.retryable,true);
  f.restart(grant.workspaceId);const result=await json(await setup(f,jwt,'different-retry-key'));assert.equal(result.phase,'ready');
  assert.equal(f.count('create'),1);assert.equal(f.count('seed'),1);assert.equal(f.repositories.size,1);
  assert.ok([...f.repositories.values()].every(repo=>[...repo.tokens.values()].every(token=>token.state==='revoked')));
});

test('concurrent client keys share one durable sample setup intent',async t=>{
  const f=await trialSampleFixture(t),jwt=await token();await admit(f,jwt);let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.hooks.create=async()=>{entered();await gate;};const first=setup(f,jwt,'first-client-key');await started;
  const other=await setup(f,jwt,'second-client-key');assert.equal(other.status,409);assert.equal((await other.json()).code,'OPERATION_IN_PROGRESS');
  assert.equal((await json(await handler(req(endpoint,jwt),f.env))).phase,'preparing');
  release();assert.equal((await first).status,201);assert.equal((await setup(f,jwt,'third-client-key')).status,200);assert.equal(f.count('create'),1);assert.equal(f.count('seed'),1);
});

test('two trial identities receive different repositories and cannot select each other or general provider APIs',async t=>{
  const f=await trialSampleFixture(t),a=await token(),b=await token('person-b'),ga=await admit(f,a),gb=await admit(f,b);
  const [ra,rb]=await Promise.all([setup(f,a),setup(f,b)]);assert.equal(ra.status,201);assert.equal(rb.status,201);
  const va=await ra.json(),vb=await rb.json();assert.notEqual(va.repository.name,vb.repository.name);assert.notEqual(va.repository.projectId,vb.repository.projectId);
  assert.equal(va.workspaceId,ga.workspaceId);assert.equal(vb.workspaceId,gb.workspaceId);
  const before=f.calls.length;
  for(const request of [req(endpoint+'?workspaceId='+gb.workspaceId,a),req(endpoint,a,{}, {'X-Workspace-Id':gb.workspaceId}),
    req(endpoint,a,{name:vb.repository.name}),req(endpoint,a,{workspaceId:gb.workspaceId}),req(endpoint,a,{files:TRIAL_SAMPLE.files}),
    req('/api/repositories',a),req('/api/repositories',a,{name:'free-choice'}),req('/api/tasks',a,{})])assert.ok([400,409].includes((await handler(request,f.env)).status));
  assert.equal(f.calls.length,before);
  const own=await json(await handler(req('/api/workspace',a),f.env));assert.equal(Object.keys(own.projects).length,1);assert.ok(!JSON.stringify(own).includes(vb.repository.name));
});

test('identity, origin and idempotency preconditions refuse setup before any provider effect',async t=>{
  const f=await trialSampleFixture(t),a=await token(),b=await token('person-b');await admit(f,a);await admit(f,b);
  const missingKey=req(endpoint,a,{});missingKey.headers.delete('Idempotency-Key');
  for(const request of [missingKey,req(endpoint,a,{}, {'Origin':'https://other.test'}),req(endpoint,b,{}, {'X-Trial-Identity':identityKey(a)})])
    assert.ok([400,403,409].includes((await handler(request,f.env)).status));
  assert.equal(f.calls.length,0);assert.equal(f.repositories.size,0);
});

for(const timing of ['create','beforePush','afterPush'])test(`closure during ${timing} prevents project attachment and any later setup`,async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
  const close=async()=>{assert.equal((await handler(req('/api/trial/close',jwt,{}),f.env)).status,200);};
  if(timing==='create')f.hooks.create=close;
  if(timing==='beforePush')f.hooks.beforeSeed=close;
  if(timing==='afterPush')f.hooks.afterSeed=close;
  const response=await setup(f,jwt);assert.equal(response.status,403,await response.clone().text());assert.equal((await response.json()).code,'TRIAL_CLOSED');
  assert.equal(Object.keys(f.store(grant.workspaceId).read().workspace.projects).length,0);assert.equal(f.operation(grant.workspaceId).state,'pending');
  const repo=[...f.repositories.values()][0];assert.ok([...repo.tokens.values()].every(token=>token.state==='revoked'));
  if(timing!=='afterPush')assert.equal(f.git.received.filter(call=>call.path.endsWith('/git-receive-pack')&&call.path.includes(trialSampleName(grant.workspaceId))).length,0);
  const before=f.calls.length;assert.equal((await setup(f,jwt)).status,403);assert.equal(f.calls.length,before);
});

test('expired admission and missing dedicated binding fail without falling back to the owner application',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
  const clock=Date.now;t.mock.method(Date,'now',()=>Date.parse(grant.expiresAt));assert.equal((await setup(f,jwt)).status,403);t.mock.method(Date,'now',clock);
  assert.equal(f.calls.length,0);
  const bare=fixture(),other=await token('without-binding');t.after(()=>{bare.sql.db.close();for(const ctx of bare.contexts.values())ctx.db.close();});await admit(bare,other);
  const missing=await setup(bare,other);assert.equal(missing.status,503);assert.equal((await missing.json()).code,'TRIAL_SAMPLE_UNAVAILABLE');
  assert.equal((await handler(req(endpoint,other),bare.env)).status,503);
});

test('a same-name repository with another ownership marker is never adopted or stripped of credentials',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt),name=trialSampleName(grant.workspaceId);
  await f.artifacts.create(name,{description:'Unrelated private code',setDefaultBranch:'main',readOnly:false});const before=f.count('revoke');
  const response=await setup(f,jwt);assert.equal(response.status,409);assert.equal((await response.json()).code,'REPOSITORY_NAME_TAKEN');
  assert.equal(f.count('seed'),0);assert.equal(f.count('revoke'),before);assert.equal(f.repositories.get(name).tokens.get('initial').state,'active');
  const status=await json(await handler(req(endpoint,jwt),f.env));assert.equal(status.phase,'failed');assert.equal(status.retryable,false);
});

test('fresh registry responses cannot replace the owner or extend the retained trial during setup',async t=>{
  for(const change of [{ownerSubject:'other-owner'},{workspaceId:'trial-'+'f'.repeat(64)},{expiresAt:Date.now()+120000}]){
    const f=await trialSampleFixture(t),jwt=await token();await admit(f,jwt);
    const authorize=f.registry.authorize.bind(f.registry);let calls=0;
    f.registry.authorize=async(...args)=>{const reply=await authorize(...args);return ++calls>1&&reply.ok?{ok:true,grant:{...reply.grant,...change}}:reply;};
    const response=await setup(f,jwt);assert.equal(response.status,403,await response.clone().text());assert.equal((await response.json()).code,'TRIAL_SAMPLE_FORBIDDEN');assert.equal(f.count('create'),0);
  }
});

test('a replacement repository ID and a changed seed head are quarantined on retry',async t=>{
  for(const change of ['id','head']){
    const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
    f.hooks.afterSeed=async()=>{delete f.hooks.afterSeed;throw Error('Lost response');};assert.equal((await setup(f,jwt)).status,502);
    const repo=[...f.repositories.values()][0];
    if(change==='id')repo.data.id=crypto.randomUUID();
    else {await f.git.git(repo.directory,'fetch',f.git.root+'/source.git','main');await f.git.git(repo.directory,'update-ref','refs/heads/main',f.git.baseCommit);}
    const response=await setup(f,jwt,'retry-owned-sample');assert.equal(response.status,409,await response.clone().text());
    assert.equal((await response.json()).code,change==='id'?'REPOSITORY_ID_CHANGED':'REPOSITORY_SEED_CHANGED');assert.equal(f.count('seed'),1);
    assert.equal(Object.keys(f.store(grant.workspaceId).read().workspace.projects).length,0);
  }
});

test('a displaced setup attempt cannot push after a newer retry has completed',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.hooks.beforeSeed=async()=>{delete f.hooks.beforeSeed;entered();await gate;};
  const old=setup(f,jwt,'old-client-key');await started;
  const snapshot=f.store(grant.workspaceId).read();Object.values(snapshot.operations).find(operation=>operation.kind==='repository-create').leaseUntil=0;
  const revision=snapshot.revision;snapshot.revision++;f.store(grant.workspaceId).write(snapshot,revision);
  const resumed=await json(await setup(f,jwt,'new-client-key'));assert.equal(resumed.phase,'ready');release();
  assert.ok([409,502].includes((await old).status));
  assert.equal(f.git.received.filter(call=>call.path.includes(trialSampleName(grant.workspaceId))&&call.path.endsWith('/git-receive-pack')).length,1);
  assert.equal(Object.keys(f.store(grant.workspaceId).read().workspace.projects).length,1);
  assert.deepEqual((await json(await handler(req(endpoint,jwt),f.env))).repository,resumed.repository);
});

test('a completed receipt with a corrupted project cannot be reported ready',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt),result=await json(await setup(f,jwt));
  const snapshot=f.store(grant.workspaceId).read();snapshot.workspace.projects[result.repository.projectId].codeConnected=false;
  const revision=snapshot.revision;snapshot.revision++;f.store(grant.workspaceId).write(snapshot,revision);
  const calls=f.calls.length,response=await handler(req(endpoint,jwt),f.env);assert.equal(response.status,409);assert.equal((await response.json()).code,'TRIAL_SAMPLE_STATE_CHANGED');assert.equal(f.calls.length,calls);
});
