import test from 'node:test';
import assert from 'node:assert/strict';
import {HostedController} from '../src/cloudflare/controller.ts';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {projectMutationResult} from '../public/workspace-page.js';
import {scaleSnapshot} from './helpers/workspace-scale.mjs';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority,AGENT_CLIENT} from './helpers/hosted-authority.mjs';

function fixture(t,projects=2,runtime){
  const {db,storage,queries}=sqliteStorage();t.after(()=>db.close());
  const store=new WorkspaceStore(storage,'workspace-scale');store.write(scaleSnapshot(projects),0);
  const authority=testAuthority('workspace-scale');
  const artifacts={get(){throw Error('Replay must not read Git or issue credentials');}};
  const controller=new HostedController(store,artifacts,authority,runtime);
  const input={source:'project',projectId:Object.keys(store.read().workspace.projects).at(-1),tasks:[{title:'Replay safely',purpose:'Keep every operation and current project state.',criteria:['Return the same task.'],owner:'Scripted owner'}]};
  return {store,storage,queries,authority,artifacts,controller,input};
}

test('eight restarted task replays read no full snapshot and keep current project and global page counts',async t=>{
  const c=fixture(t,100),key='retained-task-at-scale',first=await c.controller.createTasks(c.input,key);
  const changed=c.store.read();changed.workspace.projects[c.input.projectId].name='Renamed after the first response';changed.workspace.version++;changed.revision++;c.store.write(changed,changed.revision-1);
  const store=new WorkspaceStore(c.storage,'workspace-scale'),controller=new HostedController(store,c.artifacts,c.authority);
  store.read=()=>{throw Error('Full snapshot read during retained task replay');};c.queries.length=0;
  const results=await Promise.all(Array.from({length:8},()=>controller.createTasks(c.input,key)));
  for(const result of results){
    assert.equal(result.replayed,true);assert.equal(result.taskId,first.taskId);assert.deepEqual(result.taskIds,first.taskIds);
    const wire=projectMutationResult(result,'/api/tasks');assert.equal(wire.workspace.projects[c.input.projectId].name,'Renamed after the first response');
    assert.equal(wire.workspace.tasks.length,9);assert.equal(wire.workspace.runs.length,8);assert.equal(wire.workspace.page.offset,99);
    assert.equal(wire.workspace.page.totalProjects,100);assert.equal(wire.workspace.page.workspaceTotals.tasks,801);assert.equal(wire.workspace.page.taskNumbers[first.taskId],801);
    assert.equal(wire.workspace.page.revision,null);assert.equal(wire.workspace.capacity.occupied,4);assert.equal(wire.workspace.capacity.verification.occupied,2);
    assert.ok(Buffer.byteLength(JSON.stringify(wire))<200000);
  }
  assert.ok(c.queries.filter(q=>q.sql.includes("kind = 'operations' AND id = ?")).every(q=>q.rows<=1));
  assert.ok(!c.queries.some(q=>/^SELECT kind, id, position, data FROM workspace_records ORDER BY/.test(q.sql)));
  assert.deepEqual(c.store.read(),changed,'Replay must not write state or forget receipts');
});

test('bounded replay refuses changed bodies, cancelled keys and unauthorized sessions without full reads or mutation',async t=>{
  const c=fixture(t),key='principal-bound-replay';await c.controller.createTasks(c.input,key);
  await c.controller.releaseTaskRequest('cancelled-before-submission');
  const before=c.store.read(),read=c.store.read.bind(c.store);
  c.store.read=()=>{throw Error('A refused replay must not load the full snapshot');};
  await assert.rejects(c.controller.createTasks({...c.input,tasks:[{...c.input.tasks[0],title:'Changed'}]},key),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(c.controller.createTasks(c.input,'cancelled-before-submission'),{code:'REQUEST_CANCELLED'});
  const agent=new HostedController(c.store,c.artifacts,testAuthority('workspace-scale',AGENT_CLIENT));
  await assert.rejects(agent.createTasks(c.input,key),{code:'OWNER_REQUIRED'});
  const expired=structuredClone(c.authority);expired.principal.expiresAt=0;
  assert.throws(()=>new HostedController(c.store,c.artifacts,expired),{code:'SESSION_EXPIRED'});
  const foreign=testAuthority('another-workspace');assert.throws(()=>new HostedController(c.store,c.artifacts,foreign),{code:'WORKSPACE_FORBIDDEN'});
  assert.deepEqual(read(),before);
});

test('revocation during delayed subscription reconciliation rejects the replay response',async t=>{
  let hold=false,entered,release;const enteredPromise=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  const c=fixture(t,2,{ensureSubscription:async(_name,validate)=>{validate();if(hold){entered();await barrier;}}});
  await c.controller.createTasks(c.input,'delayed-replay');hold=true;
  const request=c.controller.createTasks(c.input,'delayed-replay');const refused=assert.rejects(request,{code:'SESSION_REVOKED'});
  await enteredPromise;
  const revoked=c.store.read();revoked.workspace.sessionsValidAfter=c.authority.principal.issuedAt;revoked.revision++;c.store.write(revoked,revoked.revision-1);
  c.store.read=()=>{throw Error('Revoked replay must not load the full snapshot');};release();await refused;
  assert.deepEqual(new WorkspaceStore(c.storage,'workspace-scale').read(),revoked);
});

test('subscription registration still reconciles a committed task receipt after its first failure',async t=>{
  let unavailable=true,calls=0;
  const c=fixture(t,2,{ensureSubscription:async(_name,validate)=>{calls++;validate();if(unavailable)throw Error('Registration unavailable');}});
  await assert.rejects(c.controller.createTasks(c.input,'registration-replay'),/Registration unavailable/);
  const saved=c.store.read();assert.equal(saved.workspace.tasks.length,17);unavailable=false;
  c.store.read=()=>{throw Error('Subscription replay must use retained rows');};
  const result=await c.controller.createTasks(c.input,'registration-replay');assert.equal(result.replayed,true);assert.equal(calls,2);
  assert.deepEqual(new WorkspaceStore(c.storage,'workspace-scale').read(),saved);
});

test('mutation projection refuses mismatched pre-scoped data instead of hiding its counts',()=>{
  const workspace={tasks:[],runs:[],projects:{owned:{id:'owned'}},page:{scope:'loaded-projects',totalProjects:100}};
  assert.throws(()=>projectMutationResult({workspace,projectId:'foreign'},'/api/tasks'),/does not match/);
  assert.throws(()=>projectMutationResult({workspace:{...workspace,page:{...workspace.page,scope:'other'}},projectId:'owned'},'/api/tasks'),/does not match/);
});
