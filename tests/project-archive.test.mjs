import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProjectArchive, readProjectArchive, MAX_PROJECT_ARCHIVE_BYTES} from '../src/core/project-archive.mjs';
import {createTask, assignRun, startRun, completeRun, failRun} from '../src/core/workflow.mjs';
import {HostedController, initialSnapshot} from '../src/cloudflare/controller.ts';
import {testAuthority, testReviewerAuthority, AGENT_CLIENT} from './helpers/hosted-authority.mjs';
import {digest} from '../src/core/check-definition.mjs';
import {errorResponse} from '../src/cloudflare/security.ts';
import {createHash} from 'node:crypto';
import {snapshotPage} from './helpers/snapshot-page.mjs';

const BASE='a'.repeat(40), HEAD='b'.repeat(40), OLD='c'.repeat(40);
function fixture(id='archive-source') {
  let snapshot=initialSnapshot(id); let reads=0;
  const store={identity:()=>({...snapshot.workspace,revision:snapshot.revision,empty:!snapshot.workspace.tasks.length&&!snapshot.workspace.runs.length&&!Object.keys(snapshot.operations).length}),read:()=>structuredClone(snapshot),write:(value,expected)=>{assert.equal(snapshot.revision,expected);snapshot=structuredClone(value);}};
  store.operation=key=>structuredClone(snapshot.operations[key]);
  store.project=id=>structuredClone(snapshot.workspace.projects?.[id]);
  store.readPage=request=>snapshotPage(snapshot,request);
  const hashes=new Set([BASE,HEAD,OLD]);
  const repo={info:async()=>({defaultBranch:'main'}),log:async()=>[{hash:HEAD}],readCommit:async hash=>{reads++;return hashes.has(hash)?{hash,treeHash:'d'.repeat(40),parents:[]}:null;},[Symbol.dispose]() {}};
  const artifacts={get:async()=>{reads++;return repo;}};
  const controller=new HostedController(store,artifacts,testAuthority(id));
  return {store,controller,repo,hashes,artifacts,reads:()=>reads};
}
function populate(c) {
  const s=c.store.read(),w=s.workspace,p={id:crypto.randomUUID(),name:'Lifecycle',repositoryName:'source',defaultBranch:'main',mainCommit:HEAD,kind:'artifacts',acceptingWork:false,policyVersion:2};
  w.projects[p.id]=p;
  const task=createTask(w,{title:'Retain reports',purpose:'Keep all outcomes',criteria:['Keep failures'],baseCommit:BASE,owner:'Original owner'});
  task.projectId=p.id;
  const run=assignRun(w,task.id,{agent:'fixture',label:'Scripted builder',branch:'agent/one'});
  startRun(w,run.id);completeRun(w,run.id,{headCommit:HEAD,changedFiles:['reports.py'],diff:'retained diff',summary:'Scripted qualification'});
  run.reviewHistory=[{decision:'reject',headCommit:OLD,taskRevision:1,ownerVersion:1,reviewer:'Original historical attribution',note:'Earlier failure',at:'2026-10-06T00:00:00.000Z'}];
  run.evidenceHistory=[{commit:OLD,taskRevision:1,verified:false,passed:0,total:1,exitCode:1,command:'fixture',source:'hosted-harness-report',checks:[{name:'failed attempt',passed:false,detail:'retained'}],output:'failure',verifiedAt:'2026-10-06T00:00:00.000Z'}];
  const failed=assignRun(w,task.id,{agent:'fixture',label:'Interrupted builder',branch:'agent/failed'});startRun(w,failed.id);failRun(w,failed.id,'Retained failure');
  s.repositories[task.id]='source';s.forks[run.id]={name:'fork-one',remote:'https://example.invalid/one.git'};
  s.checkPolicies[run.id]={definition:'Retained fixture definition; never execute on import',definitionSha256:digest('Retained fixture definition; never execute on import'),image:'sha256:'+'e'.repeat(64)};
  s.revision++;c.store.write(s,s.revision-1);
  return {projectId:p.id,taskId:task.id,runId:run.id};
}
const restoreInput=archive=>({archive,expectedSha256:archive.sha256,projectName:'Restored lifecycle',repo:'restore-target'});
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const checksum=value=>createHash('sha256').update(canonical(value)).digest('hex');

test('project export retains failures, old attribution and every referenced commit without credentials',async()=>{
 const c=fixture(),ids=populate(c),before=c.store.read();
 const archive=await c.controller.exportProject(ids.projectId);
 assert.deepEqual(archive.payload.commits,[BASE,HEAD,OLD].sort());assert.equal(archive.payload.current.length,1);
 assert.equal(archive.payload.current[0].payload.runs.length,2);
 assert.equal(archive.payload.current[0].payload.runs[0].reviewHistory[0].reviewer,'Original historical attribution');
 assert.equal(archive.payload.current[0].payload.runs[0].evidenceHistory[0].passed,0);
 assert.equal(JSON.stringify(archive).includes('example.invalid'),false);
 assert.equal(archive.payload.checkPolicies[0].definition,'Retained fixture definition; never execute on import');
 assert.deepEqual(c.store.read(),before);assert.deepEqual(await readProjectArchive(JSON.stringify(archive),archive.sha256),archive);
});
test('archive refuses tampering, wrong expected digest and oversized records',async()=>{
 const c=fixture(),ids=populate(c),archive=await c.controller.exportProject(ids.projectId);
 const changed=structuredClone(archive);changed.payload.current[0].payload.runs[0].summary='altered';
 await assert.rejects(readProjectArchive(JSON.stringify(changed),archive.sha256),/checksum/);
 await assert.rejects(readProjectArchive(JSON.stringify(archive),'0'.repeat(64)),/checksum/);
 await assert.rejects(readProjectArchive(' '.repeat(MAX_PROJECT_ARCHIVE_BYTES+1),archive.sha256),/1 MiB/);
});
test('paused, quiescent export is required and delayed exports cannot mix revisions',async()=>{
 const c=fixture(),ids=populate(c);let s=c.store.read();s.workspace.projects[ids.projectId].acceptingWork=true;c.store.write(s,s.revision);
 await assert.rejects(c.controller.exportProject(ids.projectId),{code:'project_not_paused'});
 s=c.store.read();s.workspace.projects[ids.projectId].acceptingWork=false;s.operations.pending={kind:'merge',state:'pending',fingerprint:'test',itemId:ids.runId};c.store.write(s,s.revision);
 await assert.rejects(c.controller.exportProject(ids.projectId),{code:'PROJECT_OPERATION_PENDING'});
 s=c.store.read();delete s.operations.pending;c.store.write(s,s.revision);
 s=c.store.read();s.workspace.runs[0].execution={pendingCommit:'d'.repeat(40)};c.store.write(s,s.revision);
 await assert.rejects(c.controller.exportProject(ids.projectId),{code:'project_busy'});
 s=c.store.read();delete s.workspace.runs[0].execution;c.store.write(s,s.revision);
 const log=c.repo.log;c.repo.log=async()=>{const newer=c.store.read();newer.revision++;c.store.write(newer,newer.revision-1);return log();};
 await assert.rejects(c.controller.exportProject(ids.projectId),{code:'STALE_EXPORT'});
});
test('restore verifies Git objects then retains history without reviving jobs, identity or approval',async()=>{
 const source=fixture(),ids=populate(source),archive=await source.controller.exportProject(ids.projectId),target=fixture('archive-destination');
 const before=target.store.read(),result=await target.controller.restoreProject(restoreInput(archive),'restore-one');
 const after=target.store.read(),project=after.workspace.projects[result.projectId];
 assert.equal(target.reads(),4);assert.equal(project.acceptingWork,false);assert.equal(project.owner,'owner@example.test');
 assert.deepEqual(after.workspace.tasks,[]);assert.deepEqual(after.workspace.runs,[]);assert.deepEqual(after.jobs,{});
 assert.deepEqual(after.workspace.authentication,before.workspace.authentication);
 assert.deepEqual(after.checkPolicies,{});assert.deepEqual(project.restoredCheckPolicies,archive.payload.checkPolicies);
 assert.deepEqual(project.restoredHistory,archive.payload.current);
 assert.equal(target.controller.projectHistory(project.id).historical,true);
 assert.equal((await target.controller.restoreProject(restoreInput(archive),'restore-one')).replayed,true);
 assert.deepEqual(target.store.read(),after);assert.equal(target.reads(),4);
 await assert.rejects(target.controller.restoreProject({...restoreInput(archive),repo:'different'},'restore-one'),{code:'IDEMPOTENCY_CONFLICT'});
 const second=await target.controller.exportProject(project.id);assert.deepEqual(second.payload.history,archive.payload.current);assert.deepEqual(second.payload.commits,archive.payload.commits);
});
test('wrong Git head, absent historical object and existing destination refuse before durable restore',async()=>{
 const source=fixture(),ids=populate(source),archive=await source.controller.exportProject(ids.projectId);
 for(const mode of ['head','object','existing']) {
  const c=fixture('destination-'+mode);
  if(mode==='head')c.repo.log=async()=>[{hash:BASE}];
  if(mode==='object')c.hashes.delete(OLD);
  if(mode==='existing'){const s=c.store.read();s.workspace.projects.keep={id:'keep',repositoryName:'restore-target'};c.store.write(s,s.revision);}
  const before=c.store.read();await assert.rejects(c.controller.restoreProject(restoreInput(archive),'invalid-'+mode));assert.deepEqual(c.store.read(),before);
 }
});
test('agent and reviewer cannot export or restore through direct controller calls',async()=>{
 const c=fixture(),ids=populate(c),archive=await c.controller.exportProject(ids.projectId),before=c.store.read(),reads=c.reads();
 for(const authority of [testAuthority('archive-source',AGENT_CLIENT),testReviewerAuthority('archive-source')]) {
  const controller=new HostedController(c.store,c.artifacts,authority);
  await assert.rejects(controller.exportProject(ids.projectId),{code:'OWNER_REQUIRED'});
  await assert.rejects(controller.restoreProject(restoreInput(archive),'foreign-replay'),{code:'OWNER_REQUIRED'});
  assert.throws(()=>controller.projectHistory(ids.projectId),{code:'OWNER_REQUIRED'});
 }
 assert.deepEqual(c.store.read(),before);assert.equal(c.reads(),reads);
});

test('archive validation failures retain actionable HTTP errors and never mutate state',async()=>{
 const source=fixture(),ids=populate(source),archive=await source.controller.exportProject(ids.projectId),target=fixture('invalid-archive-destination');
 const before=target.store.read(),tampered=structuredClone(archive);tampered.payload.project.name='Changed without its saved digest';
 for(const input of [restoreInput(tampered),{...restoreInput(archive),expectedSha256:'0'.repeat(64)}]) {
  await assert.rejects(target.controller.restoreProject(input,'invalid-archive'),error=>{
   assert.equal(errorResponse(error).status,422);assert.equal(error.code,'invalid_project_archive');return true;
  });
  assert.deepEqual(target.store.read(),before);assert.equal(target.reads(),0);
 }
 const s=source.store.read();s.workspace.projects[ids.projectId].acceptingWork=true;source.store.write(s,s.revision);
 const active=source.store.read(),reads=source.reads();
 await assert.rejects(source.controller.exportProject(ids.projectId),error=>{
  assert.equal(errorResponse(error).status,409);assert.equal(error.code,'project_not_paused');return true;
 });
 assert.deepEqual(source.store.read(),active);assert.equal(source.reads(),reads);
});

test('self-consistent malformed histories are rejected before provider reads or durable state changes',async()=>{
 const source=fixture(),ids=populate(source),archive=await source.controller.exportProject(ids.projectId),target=fixture('malformed-history-destination');
 const before=target.store.read();
 const cases=[
  p=>p.task.baseHistory={},p=>p.task.baseHistory=[null],p=>p.task.baseHistory=[{}],
  p=>p.runs[0].reviewHistory={},p=>p.runs[0].reviewHistory=[[]],p=>p.runs[0].reviewHistory=[{headCommit:42}],
  p=>p.runs[0].evidenceHistory={},p=>p.runs[0].evidenceHistory=[null],p=>p.runs[0].evidenceHistory=[{commit:[]}],
  p=>p.runs[0].review=[],p=>p.runs[0].evidence='invalid',p=>p.runs[0].baseCommit=null
 ];
 for(const mutate of cases) {
  const input=structuredClone(archive),handoff=input.payload.current[0];mutate(handoff.payload);
  handoff.sha256=checksum(handoff.payload);input.sha256=checksum(input.payload);
  await assert.rejects(target.controller.restoreProject(restoreInput(input),'malformed-history'),error=>{
   assert.equal(error.code,'invalid_project_archive');assert.equal(errorResponse(error).status,422);return true;
  });
  assert.deepEqual(target.store.read(),before);assert.equal(target.reads(),0);
 }
});

test('self-consistent malformed check policies are rejected without property access or coercion failures',async()=>{
 const source=fixture(),ids=populate(source),archive=await source.controller.exportProject(ids.projectId),target=fixture('malformed-policy-destination');
 const before=target.store.read(),policy=archive.payload.checkPolicies[0];
 for(const invalid of [null,[],false,0,'invalid',{}, {...policy,image:{toString:null}}, {...policy,image:[]}, {...policy,definition:[]}, {...policy,definitionSha256:{}}]) {
  const changed=structuredClone(archive);changed.payload.checkPolicies=[invalid];changed.sha256=checksum(changed.payload);
  await assert.rejects(target.controller.restoreProject(restoreInput(changed),'malformed-policy'),error=>{
   assert.equal(error.code,'invalid_project_archive');assert.equal(errorResponse(error).status,422);return true;
  });
  assert.deepEqual(target.store.read(),before);assert.equal(target.reads(),0);
 }
 await assert.rejects(readProjectArchive(JSON.stringify(archive),{toString:null}),{code:'invalid_project_archive'});
});
