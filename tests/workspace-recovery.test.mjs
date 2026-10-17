import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedController,initialSnapshot} from '../src/cloudflare/controller.ts';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority,testReviewerAuthority,AGENT_CLIENT} from './helpers/hosted-authority.mjs';
import {buildWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {createTask} from '../src/core/workflow.mjs';
import {quarantinedRecoveryNames,requireFreshRecoveryResource} from '../src/core/workspace-recovery.mjs';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import {systemAuthority} from '../src/cloudflare/access.ts';
import {setRepositoryAccess} from '../src/core/repository-access.mjs';

const emptyLedgers=()=>({artifactSubscriptions:[],artifactSubscriptionAttempts:[],artifactEvents:[],artifactEventAttempts:[],artifactDeliveries:[]});
async function archive(){
  const source=initialSnapshot('source-workspace'),projectId=crypto.randomUUID();
  source.workspace.projects[projectId]={id:projectId,name:'Historical project',repositoryName:'original-project',mainCommit:'a'.repeat(40),defaultBranch:'main',restoredHistory:[],restoredCheckPolicies:[]};
  const task=createTask(source.workspace,{title:'Historical task',purpose:'Preserve prior work',criteria:['Readable after cold restart'],owner:'Earlier owner',baseCommit:'a'.repeat(40)});
  task.projectId=projectId;task.repositoryName='original-project';source.repositories[task.id]='original-project';
  source.operations['1'.repeat(64)]={kind:'repository-create',state:'pending',fingerprint:'2'.repeat(64),projectId:crypto.randomUUID(),resourceName:'uncertain-original',pendingCommit:'b'.repeat(40),leaseUntil:0};
  return buildWorkspaceBackup(source,new Date().toISOString(),emptyLedgers());
}
function destination(t){
  const {storage,db}=sqliteStorage();t.after(()=>db.close());let store=new WorkspaceStore(storage,'destination-workspace');
  const artifacts=new Proxy({},{get(){throw Error('Restore must not contact a provider');}}),authority=testAuthority('destination-workspace');
  const owner=()=>new HostedController(store,artifacts,authority);owner().adoptOwner();
  return {storage,db,authority,artifacts,store:()=>store,owner,restart:()=>{store=new WorkspaceStore(storage,'destination-workspace');return owner();}};
}
const input=(value,revision)=>({archive:value,expectedSha256:value.sha256,expectedSourceWorkspaceId:value.payload.workspace.id,expectedWorkspaceId:'destination-workspace',expectedRevision:revision,confirmation:'RESTORE HISTORY ONLY'});

test('whole history restore is atomic, immutable, owner-bound and readable after a cold SQLite restart',async t=>{
  const f=destination(t),value=await archive(),before=f.store().read(),request=input(value,before.revision);
  const result=await f.owner().restoreWorkspaceHistory(request,'restore-request-001');assert.equal(result.historical,true);assert.equal(result.codeAvailable,false);
  let after=f.store().read();assert.deepEqual(after.workspace.authentication,before.workspace.authentication);assert.deepEqual(after.workspace.tasks,[]);assert.deepEqual(after.workspace.runs,[]);assert.deepEqual(after.workspace.projects,{});
  assert.deepEqual(after.jobs,{});assert.deepEqual(after.repositories,{});assert.deepEqual(after.forks,{});assert.equal(Object.values(after.operations).length,1);
  assert.equal(Object.values(after.operations)[0].kind,'workspace-restore');assert.equal(after.recoveryImports[value.sha256].importedBy,f.authority.principal.id);
  const restarted=f.restart();assert.deepEqual(restarted.recoveryHistory(value.sha256,true),value);
  const list=restarted.recoveryHistory();assert.equal(list.imports.length,1);assert.equal(list.current.tasks,0);assert.ok(list.quarantinedNames.includes('original-project'));assert.ok(list.quarantinedNames.includes('uncertain-original'));
  assert.equal(restarted.recoveryHistory(value.sha256).counts.tasks,1);
  const replay=await restarted.restoreWorkspaceHistory(request,'restore-request-001');assert.equal(replay.replayed,true);assert.deepEqual(f.store().read(),after);
  const reexport=await restarted.workspaceBackup();assert.deepEqual(reexport.payload.priorImports[0].archive,value);
  const counts=workspaceBackupPreview(reexport).counts;assert.equal(counts.currentProjects,0);assert.equal(counts.historicalProjects,1);assert.equal(counts.currentTasks,0);assert.equal(counts.historicalTasks,1);
  assert.equal(counts.currentOperations,1);assert.equal(counts.historicalOperations,1);assert.equal(counts.priorImports,1);
  assert.ok(reexport.payload.resources.some(resource=>resource.id.startsWith('import:'+value.sha256+':')));
  await assert.rejects(restarted.restoreWorkspaceHistory({...request,expectedRevision:after.revision},'restore-request-001'),{code:'IDEMPOTENCY_CONFLICT'});
  const changed=f.store().read();changed.recoveryImports[value.sha256].importedBy='forged';changed.revision++;
  assert.throws(()=>f.store().write(changed,after.revision),{code:'RECOVERY_IMPORT_IMMUTABLE'});assert.deepEqual(f.store().read(),after);
  const removed=f.store().read();delete removed.recoveryImports[value.sha256];removed.revision++;
  assert.throws(()=>f.store().write(removed,after.revision),{code:'RECOVERY_IMPORT_IMMUTABLE'});assert.deepEqual(f.store().read(),after);
});

test('source/destination/revision/confirmation, schema and existing workflow refuse without saving',async t=>{
  const f=destination(t),value=await archive(),before=f.store().read(),request=input(value,before.revision);
  for(const changed of [{expectedSourceWorkspaceId:'wrong'},{expectedWorkspaceId:'wrong'},{expectedRevision:before.revision+1},{confirmation:'yes'},{expectedSha256:'0'.repeat(64)},{extra:'forged'}]){
    await assert.rejects(f.owner().restoreWorkspaceHistory({...request,...changed},crypto.randomUUID()));assert.deepEqual(f.store().read(),before);
  }
  const malformed=structuredClone(value);malformed.payload.credentials='forbidden';await assert.rejects(f.owner().restoreWorkspaceHistory({...request,archive:malformed},crypto.randomUUID()));
  const occupied=f.store().read();occupied.workspace.projects.live={id:'live',name:'Preserve',mainCommit:'c'.repeat(40),repositoryName:'fresh-name'};occupied.revision++;
  f.store().write(occupied,before.revision);
  await assert.rejects(f.owner().restoreWorkspaceHistory({...request,expectedRevision:occupied.revision},crypto.randomUUID()),{code:'WORKSPACE_RESTORE_NOT_EMPTY'});
  assert.deepEqual(f.store().read(),occupied);
});

test('non-owner and internal system actors cannot restore or read historical archives',async t=>{
  const f=destination(t),value=await archive(),request=input(value,f.store().read().revision);
  for(const authority of [testAuthority('destination-workspace',AGENT_CLIENT),testReviewerAuthority('destination-workspace'),systemAuthority(f.authority.policy)]){
    const actor=new HostedController(f.store(),f.artifacts,authority);
    await assert.rejects(actor.restoreWorkspaceHistory(request,crypto.randomUUID()),{code:'OWNER_REQUIRED'});assert.throws(()=>actor.recoveryHistory(),{code:'OWNER_REQUIRED'});
  }
});

test('all original repository and uncertain resource names are quarantined before provider I/O; fresh names reach ordinary validation',async t=>{
  const f=destination(t),value=await archive();await f.owner().restoreWorkspaceHistory(input(value,f.store().read().revision),crypto.randomUUID());
  const controller=new HostedController(f.store(),f.artifacts,f.authority,{git:{}});
  for(const name of quarantinedRecoveryNames(f.store().read())){
    await assert.rejects(controller.createRepository({name},crypto.randomUUID()),{code:'RECOVERY_RESOURCE_QUARANTINED'});
    await assert.rejects(controller.createTasks({source:'repository',repo:name,baseCommit:'a'.repeat(40),projectName:'New',tasks:[{title:'Task',purpose:'Purpose',criteria:['Criterion'],owner:'Owner'}]},crypto.randomUUID()),{code:'RECOVERY_RESOURCE_QUARANTINED'});
  }
  await assert.rejects(controller.createTasks({source:'repository',repo:'explicitly-fresh',baseCommit:'a'.repeat(40),projectName:'New',tasks:[{title:'Task',purpose:'Purpose',criteria:['Criterion'],owner:'Owner'}]},crypto.randomUUID()),/Restore must not contact a provider/);
});

test('authenticated HTTP boundary preserves exact restore DTO, requires key and denies cross-origin/foreign destinations',async t=>{
  const f=destination(t),value=await archive(),request=input(value,f.store().read().revision);
  const file=new URL('../src/cloudflare/index.ts',import.meta.url),require=createRequire(file),module={exports:{}};
  new Function('require','module','exports',transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code)(name=>name==='cloudflare:workers'?{DurableObject:class{},WorkerEntrypoint:class{}}:name==='./check-container.ts'?{RepositoryCheckContainer:class{}}:require(name),module,module.exports);
  const coordinator=Object.create(module.exports.WorkspaceCoordinator.prototype);coordinator.env={WORKSPACE_ID:'destination-workspace'};coordinator.controller=()=>f.owner();coordinator.schedule=async()=>{};
  const calls=[],env={WORKSPACE_ID:'destination-workspace',ACCESS_TEAM_DOMAIN:f.authority.policy.issuer,ACCESS_AUD:f.authority.policy.audience,ACCESS_OWNER_SUB:f.authority.policy.ownerSubject,
    ACCESS_AGENT_CLIENT_IDS:JSON.stringify(f.authority.policy.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(f.authority.policy.reviewerClientIds),ACCESS_REVIEWER_SUBJECTS:'[]',
    WORKSPACES:{getByName(){return {api:async call=>{calls.push(call);return coordinator.api(call);}}}}};
  const handler=module.exports.createAuthenticatedFetch({authenticate:async()=>f.authority.principal}),origin='https://fixture.test';
  const send=(body,headers={})=>handler(new Request(origin+'/api/workspace/restore',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'Idempotency-Key':'restore-http-001',...headers},body:JSON.stringify(body)}),env,{});
  assert.equal((await send(request,{'Idempotency-Key':''})).status,400);assert.equal((await send(request,{Origin:'https://foreign.test'})).status,403);
  assert.equal((await send({...request,expectedWorkspaceId:'wrong'})).status,403);assert.equal(calls.length,0);
  const response=await send(request);assert.equal(response.status,201);assert.equal((await response.json()).recoveryImportId,value.sha256);assert.deepEqual(calls[0].body,request);assert.equal(calls[0].key,'restore-http-001');
  const replay=await send(request);assert.equal((await replay.json()).replayed,true);
  const download=await handler(new Request(origin+'/api/workspace/recovery-imports/'+value.sha256+'/archive'),env,{});assert.equal(download.status,200);assert.deepEqual(await download.json(),value);
});

test('quarantine includes nested imports, original forks and event/subscription ledger repositories',async()=>{
  const value=await archive(),inner=structuredClone(value);inner.sha256='3'.repeat(64);inner.payload.projects[0].repositoryName='nested-project';
  inner.payload.forks=[{runId:'historical',name:'nested-fork'}];inner.payload.ledgers={artifactSubscriptions:[{repositoryName:'subscription-repo'}],artifactSubscriptionAttempts:[{repositoryName:'subscription-attempt-repo'}],artifactEvents:[{event:{repositoryName:'event-repo'}}]};
  const outer=structuredClone(value);outer.payload.priorImports=[{id:inner.sha256,archive:inner,importedAt:new Date().toISOString(),importedBy:'prior-owner'}];
  const snapshot={recoveryImports:{[outer.sha256]:{archive:outer}}},names=quarantinedRecoveryNames(snapshot);
  for(const name of ['nested-project','nested-fork','subscription-repo','subscription-attempt-repo','event-repo']){
    assert.ok(names.includes(name));assert.throws(()=>requireFreshRecoveryResource(snapshot,name.toUpperCase()),{code:'RECOVERY_RESOURCE_QUARANTINED'});
  }
  assert.doesNotThrow(()=>requireFreshRecoveryResource(snapshot,'fresh-explicit-name'));
});

test('assignment cannot reuse a quarantined original repository even if old metadata is injected into live state',async t=>{
  const f=destination(t),value=await archive();await f.owner().restoreWorkspaceHistory(input(value,f.store().read().revision),crypto.randomUUID());
  const snapshot=f.store().read(),project=structuredClone(value.payload.projects[0]);project.acceptingWork=true;
  setRepositoryAccess(project,{expectedVersion:0,grants:[{kind:'agent',id:AGENT_CLIENT,role:'build'}]},f.authority.principal,f.authority.policy);
  snapshot.workspace.projects[project.id]=project;const task=createTask(snapshot.workspace,{title:'Fresh task',purpose:'Attempt an old source',criteria:['Refuse old source'],owner:'Current owner',baseCommit:project.mainCommit});
  task.projectId=project.id;task.origin='artifacts';snapshot.repositories[task.id]=project.repositoryName;snapshot.revision++;f.store().write(snapshot,snapshot.revision-1);
  await assert.rejects(f.owner().assign(task.id,{agentClientId:AGENT_CLIENT,label:'Must refuse'},crypto.randomUUID()),{code:'RECOVERY_RESOURCE_QUARANTINED'});
  assert.equal(f.store().read().workspace.runs.length,0);
});
