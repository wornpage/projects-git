import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryAccess,hasRepositoryPermission,setRepositoryAccess,repositoryWorkspace} from '../src/core/repository-access.mjs';
import {HostedController,initialSnapshot} from '../src/cloudflare/controller.ts';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {ownerBinding,authorizeRoute,assertAuthority} from '../src/cloudflare/access.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority,AGENT_CLIENT,REVIEWER_CLIENT} from './helpers/hosted-authority.mjs';
import {parseWorkspacePage} from '../public/workspace-page.js';
import {parseProjectCatalog} from '../public/project-catalog.js';
import {createTask,assignRun} from '../src/core/workflow.mjs';

const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
const owner=testAuthority(),policy={...owner.policy,memberSubjects:['member-one','member-two']};
const actor=(kind,id)=>({...owner.principal,kind,id});
const builder=actor('agent',AGENT_CLIENT),member=actor('member','member-one'),reviewer=actor('reviewer',REVIEWER_CLIENT);
const grant=(kind,id,role)=>({kind,id,role});
const project=id=>({id,name:id===a?'Visible repository':'Secret repository',repositoryName:id,mainCommit:'a'.repeat(40),kind:'artifacts',acceptingWork:true,policyVersion:1});
function fixture(t){
  const {db,storage}=sqliteStorage();t.after(()=>db.close());
  const store=new WorkspaceStore(storage,policy.workspaceId),snapshot=store.read();
  snapshot.workspace.authentication=ownerBinding(policy);snapshot.workspace.projects={[a]:project(a),[b]:project(b)};
  for(const id of [a,b]){
    const task=createTask(snapshot.workspace,{title:id===a?'Visible task':'Secret task',purpose:'Repository access fixture',criteria:['Preserve isolation'],owner:'Owner',baseCommit:'a'.repeat(40)});
    task.projectId=id;task.origin='artifacts';
    const run=assignRun(snapshot.workspace,task.id,{agent:'external',label:'Builder',branch:'agents/'+id.replaceAll('-','')});
    run.origin='external-agent';run.agentIdentity=builder;run.checkoutState='ready';
  }
  snapshot.revision++;store.write(snapshot,0);
  let calls=0;
  const artifacts={get:async()=>{calls++;throw Error('Unexpected provider work');}};
  const controller=principal=>new HostedController(store,artifacts,{policy,principal});
  return {store,controller,calls:()=>calls};
}
async function allow(f,id,grants){
  return f.controller(owner.principal).changeProjectAccess(id,{expectedVersion:repositoryAccess(f.store.project(id)).version,grants},crypto.randomUUID());
}

test('missing repository grants mean owner-only access; no implicit grants are migrated',()=>{
  const p=project(a);assert.deepEqual(repositoryAccess(p),{version:0,grants:[],configured:false});
  for(const person of [builder,member,reviewer])for(const permission of ['read','build','review'])assert.equal(hasRepositoryPermission(p,person,policy,permission),false);
  assert.equal(hasRepositoryPermission(p,owner.principal,policy,'build'),true);assert.equal(p.access,undefined);
});
test('repository roles derive from configured stable identities and remain disjoint',()=>{
  const p=project(a);
  setRepositoryAccess(p,{expectedVersion:0,grants:[grant('member',member.id,'read'),grant('agent',builder.id,'build'),grant('reviewer',reviewer.id,'review')]},owner.principal,policy);
  assert.equal(hasRepositoryPermission(p,builder,policy,'read'),true);assert.equal(hasRepositoryPermission(p,builder,policy,'build'),true);
  assert.equal(hasRepositoryPermission(p,member,policy,'read'),true);assert.equal(hasRepositoryPermission(p,member,policy,'build'),false);
  assert.equal(hasRepositoryPermission(p,reviewer,policy,'review'),true);assert.equal(hasRepositoryPermission(p,reviewer,policy,'read'),false);
  assert.equal(hasRepositoryPermission(p,{...builder,issuer:'https://foreign.cloudflareaccess.com'},policy,'build'),false);
  assert.equal(hasRepositoryPermission(p,builder,{...policy,agentClientIds:[]},'build'),false);
});
test('forged, duplicate, invalid-role, stale and non-owner grant changes preserve the prior policy',()=>{
  for(const entry of [grant('member','unknown','read'),grant('member',member.id,'build'),grant('reviewer',reviewer.id,'build'),
    grant('agent',builder.id,'review'),{...grant('agent',builder.id,'build'),issuer:policy.issuer},grant('constructor',member.id,'read')]){
    const p=project(a);assert.throws(()=>setRepositoryAccess(p,{expectedVersion:0,grants:[entry]},owner.principal,policy),{code:'INVALID_PROJECT_GRANT'});assert.equal(p.access,undefined);
  }
  const p=project(a),input={expectedVersion:0,grants:[grant('agent',builder.id,'build')]};
  assert.throws(()=>setRepositoryAccess(p,input,builder,policy),{code:'OWNER_REQUIRED'});
  assert.throws(()=>setRepositoryAccess(p,{...input,grants:[...input.grants,...input.grants]},owner.principal,policy),{code:'INVALID_PROJECT_GRANT'});
  setRepositoryAccess(p,input,owner.principal,policy);const original=structuredClone(p);
  assert.throws(()=>setRepositoryAccess(p,input,owner.principal,policy),{code:'PROJECT_ACCESS_CHANGED'});assert.deepEqual(p,original);
});
test('corrupt persisted grants never become a successful empty policy',()=>{
  for(const value of [null,[],{version:1,grants:[]},{version:NaN,grants:[]}]){
    const p={...project(a),access:value};assert.throws(()=>repositoryAccess(p),{code:'PROJECT_ACCESS_INVALID'});
    assert.throws(()=>hasRepositoryPermission(p,builder,policy,'read'),{code:'PROJECT_ACCESS_INVALID'});
  }
});
test('non-owner reads filter repositories, event references and grants before numbering and denominators',async t=>{
  const f=fixture(t);await allow(f,a,[grant('member',member.id,'read'),grant('agent',builder.id,'build')]);
  const snapshot=f.store.read();snapshot.workspace.events.push({id:crypto.randomUUID(),type:'operator',at:new Date().toISOString(),taskId:null,runId:null,message:'Private workspace operator metadata'});
  snapshot.revision++;f.store.write(snapshot,snapshot.revision-1);
  const c=f.controller(member),state=c.workspacePage(parseWorkspacePage('?limit=1'));
  assert.deepEqual(Object.keys(state.projects),[a]);assert.equal(state.tasks.length,1);assert.equal(state.runs.length,1);
  assert.equal(state.page.totalProjects,1);assert.equal(state.page.nextOffset,null);assert.equal(state.page.workspaceTotals.tasks,1);
  assert.ok(!JSON.stringify(state).includes('Secret task'));assert.ok(!JSON.stringify(state).includes('Private workspace operator metadata'));
  assert.equal(state.projects[a].access,undefined);assert.equal(state.authentication.permissions.manage,false);
  assert.equal(c.projectCatalog(parseProjectCatalog('')).total,1);
  assert.throws(()=>c.workspacePage(parseWorkspacePage('?limit=1&project='+b)),/unavailable/);
  assert.equal(f.calls(),0);
});
test('ungranted claims, direct assignment reads and handoffs are refused before provider I/O',async t=>{
  const f=fixture(t),c=f.controller(builder),snapshot=f.store.read(),run=snapshot.workspace.runs[0],task=snapshot.workspace.tasks[0];
  assert.deepEqual(Object.keys(c.workspace().projects),[]);
  await assert.rejects(c.claim(a,{label:'Builder'},crypto.randomUUID()),{code:'PROJECT_FORBIDDEN'});
  assert.throws(()=>c.start(run.id),{code:'PROJECT_FORBIDDEN'});
  await assert.rejects(c.handoff(task.id),{code:'PROJECT_FORBIDDEN'});assert.equal(f.calls(),0);
});
test('members cannot mutate or become reviewers even with a valid session and read grant',async t=>{
  const f=fixture(t);await allow(f,a,[grant('member',member.id,'read')]);const c=f.controller(member);
  assertAuthority({policy,principal:member},policy.workspaceId);
  assert.throws(()=>authorizeRoute(member,'POST','/api/projects/'+a+'/claim'),{code:'MEMBER_READ_ONLY'});
  await assert.rejects(c.claim(a,{label:'forged'},crypto.randomUUID()),{code:'OWNER_REQUIRED'});
  await assert.rejects(c.changeProjectAccess(a,{expectedVersion:1,grants:[]},crypto.randomUUID()),{code:'OWNER_REQUIRED'});
  assert.throws(()=>c.reviewInbox(),{code:'REVIEWER_REQUIRED'});assert.equal(f.calls(),0);
});
test('repository access changes have immutable principal-bound receipts and CAS across restarts',async t=>{
  const f=fixture(t),input={expectedVersion:0,grants:[grant('member',member.id,'read')]},id=crypto.randomUUID();
  const first=await f.controller(owner.principal).changeProjectAccess(a,input,id);
  const replay=await f.controller(owner.principal).changeProjectAccess(a,input,id);
  assert.equal(first.accessVersion,1);assert.equal(replay.replayed,true);assert.equal(f.store.project(a).access.version,1);
  await assert.rejects(f.controller(owner.principal).changeProjectAccess(a,{...input,grants:[]},id),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.controller(owner.principal).changeProjectAccess(a,{expectedVersion:0,grants:[]},crypto.randomUUID()),{code:'PROJECT_ACCESS_CHANGED'});
  assert.equal(f.controller(owner.principal).projectAccess(a).recovery,null);assert.equal(f.calls(),0);
});
test('revocation and regrant fence an already-admitted request by access version',async t=>{
  const f=fixture(t);await allow(f,a,[grant('agent',builder.id,'read')]);const c=f.controller(builder);c.requireProjectAccess(a,'read');
  await allow(f,a,[]);await allow(f,a,[grant('agent',builder.id,'read')]);
  assert.throws(()=>c.requireProjectAccess(a,'read'),{code:'PROJECT_ACCESS_CHANGED'});
  const fresh=f.controller(builder);fresh.requireProjectAccess(a,'read');assert.equal(f.calls(),0);
});
test('pending provider assignments retain explicit credential-cleanup uncertainty after access is revoked',async t=>{
  const f=fixture(t);await allow(f,a,[grant('agent',builder.id,'build')]);
  const snapshot=f.store.read(),run=snapshot.workspace.runs[0];
  snapshot.operations['pending-assignment']={kind:'claim',fingerprint:'fixture',state:'pending',itemId:run.id,projectId:a};
  snapshot.revision++;f.store.write(snapshot,snapshot.revision-1);
  const id=crypto.randomUUID(),input={expectedVersion:1,grants:[]};
  const result=await f.controller(owner.principal).changeProjectAccess(a,input,id);
  assert.equal(result.credentialCleanup,'pending');assert.deepEqual(result.pendingRunIds,[run.id]);
  const recovery=f.controller(owner.principal).projectAccess(a).recovery;
  assert.equal(recovery.requestId,id);assert.deepEqual(recovery.input,input);
  await assert.rejects(f.controller(owner.principal).changeProjectAccess(a,{expectedVersion:2,grants:[]},crypto.randomUUID()),{code:'PROJECT_ACCESS_RECOVERY_REQUIRED'});
  assert.throws(()=>f.controller(builder).start(run.id),{code:'PROJECT_FORBIDDEN'});assert.equal(f.calls(),0);
});
