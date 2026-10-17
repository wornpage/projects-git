import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {HostedController} from '../src/cloudflare/controller.ts';
import {parseWorkspacePage,projectWorkspace,projectMutationResult} from '../public/workspace-page.js';
import {HostedAgentClient} from '../src/local/hosted-agent-client.mjs';
import {projectBrief,mergeIntentSummary} from '../public/workbench-state.js';
import {projectStatus} from '../src/local/repository-cli-view.mjs';
import {scaleSnapshot} from './helpers/workspace-scale.mjs';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority} from './helpers/hosted-authority.mjs';
import {setRepositoryAccess} from '../src/core/repository-access.mjs';

test('100 projects retain mixed histories while pages bound SQL reads and keep global capacity',t=>{
  const {db,storage,queries}=sqliteStorage();t.after(()=>db.close());
  const store=new WorkspaceStore(storage,'workspace-scale'),source=scaleSnapshot();store.write(source,0);
  assert.equal(source.workspace.tasks.length,800);assert.equal(source.workspace.runs.length,800);assert.equal(Object.keys(source.operations).length,3203);
  const original=JSON.stringify(store.read());assert.ok(Buffer.byteLength(original)>3_000_000);
  const seen=new Set(),times=[],sizes=[];
  const controller=new HostedController(store,{},testAuthority('workspace-scale'));
  for(let offset=0;offset<100;offset+=10){
    queries.length=0;const start=performance.now();
    const page=store.readPage(parseWorkspacePage(`limit=10&offset=${offset}&at=1`));
    const result={...controller.workspace(page.snapshot,page.capacity),page:page.page};
    times.push(performance.now()-start);sizes.push(Buffer.byteLength(JSON.stringify(result)));
    assert.equal(Object.keys(result.projects).length,10);assert.equal(result.tasks.length,80);assert.equal(result.runs.length,80);
    assert.deepEqual(result.capacity,{limit:4,running:2,reserved:2,occupied:4,queued:0,verification:{limit:2,occupied:2,waiting:0}});
    assert.deepEqual(result.page.workspaceTotals,{projects:100,tasks:800,runs:800});
    assert.equal(page.operationReceipts,3203);assert.equal(Object.keys(page.snapshot.operations).length,3);
    assert.ok(queries.every(query=>!/^SELECT kind, id, position, data FROM workspace_records ORDER/.test(query.sql)),'Routine page reads must not materialize every durable record');
    assert.ok(queries.filter(query=>query.sql.includes("kind = 'projects'")&&query.sql.includes('SELECT kind')).every(query=>query.rows<=10));
    for(const id of Object.keys(result.projects)){assert.ok(!seen.has(id));seen.add(id);assert.deepEqual(projectBrief(result,id),projectBrief(source.workspace,id));}
    assert.throws(()=>store.write(page.snapshot,1),{code:'PARTIAL_WORKSPACE_WRITE'});
  }
  assert.equal(seen.size,100);assert.equal(JSON.stringify(store.read()),original);
  const target=source.workspace.tasks.at(-1),page=store.readPage(parseWorkspacePage('limit=1&task='+target.id));
  assert.equal(Object.keys(page.snapshot.workspace.projects).length,1);assert.equal(page.page.taskNumbers[target.id],800);
  assert.deepEqual(page.snapshot.workspace.runs,source.workspace.runs.slice(-8));
  const restarted=new WorkspaceStore(storage,'workspace-scale');assert.equal(JSON.stringify(restarted.read()),original);
  t.diagnostic(JSON.stringify({fixture:'synthetic histories; zero provider calls',projects:100,tasks:800,candidates:800,operationReceipts:3203,totalBytes:Buffer.byteLength(original),maxPageBytes:Math.max(...sizes),maxPageMs:Math.max(...times)}));
});

test('receipts beyond 500 survive restart, replay, conflicting bodies and a lost response',async t=>{
  const {db,storage}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'workspace-scale');store.write(scaleSnapshot(),0);
  let providerCalls=0;const artifacts={get(){providerCalls++;throw Error('Unexpected provider I/O');}};
  let controller=new HostedController(store,artifacts,testAuthority('workspace-scale'));
  const input={source:'project',projectId:Object.keys(store.read().workspace.projects)[0],tasks:[{title:'One more task',purpose:'Prove retained operation growth.',criteria:['Keep earlier request identities.'],owner:'Scripted scale owner'}]};
  const first=await controller.createTasks(input,'lost-response-after-3203');
  controller=new HostedController(new WorkspaceStore(storage,'workspace-scale'),artifacts,testAuthority('workspace-scale'));
  const again=await controller.createTasks(input,'lost-response-after-3203');assert.equal(again.replayed,true);assert.equal(again.taskId,first.taskId);
  await assert.rejects(controller.createTasks({...input,tasks:[{...input.tasks[0],title:'Changed payload'}]},'lost-response-after-3203'),{code:'IDEMPOTENCY_CONFLICT'});
  const saved=store.read();assert.equal(Object.keys(saved.operations).length,3204);assert.equal(saved.workspace.tasks.length,801);assert.equal(providerCalls,0);
  delete saved.operations['fixture-0-0-0'];saved.revision++;
  assert.throws(()=>store.write(saved,saved.revision-1),{code:'OPERATION_RECEIPT_REMOVAL'});assert.equal(Object.keys(store.read().operations).length,3204);
});

test('page revisions, foreign IDs and invalid cursors refuse without changing durable state',t=>{
  const {db,storage}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'workspace-scale');store.write(scaleSnapshot(2),0);
  const request=parseWorkspacePage('limit=1&offset=1&at=1'),changed=store.read();changed.revision++;changed.workspace.projects[Object.keys(changed.workspace.projects)[0]].name='Changed';store.write(changed,1);
  assert.throws(()=>store.readPage(request),{code:'WORKSPACE_PAGE_CHANGED'});
  for(const query of ['limit=21','limit=0','offset=-1','at=bad','limit=1&task=foreign','limit=1&project=foreign','limit=1&offset=2']){
    assert.throws(()=>store.readPage(parseWorkspacePage(query)));
  }
  assert.equal(store.identity().revision,2);
  assert.throws(()=>new HostedController(store,{},testAuthority('foreign-workspace')),{code:'WORKSPACE_FORBIDDEN'});
  const first=projectWorkspace(changed.workspace,parseWorkspacePage('limit=1'));assert.equal(first.page.totalProjects,2);assert.equal(first.tasks.length,8);assert.equal(first.metrics.tasks.total,8);
});

test('mutation responses and hosted client navigation remain bounded at 100 projects',async t=>{
  const {db,storage}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'workspace-scale'),source=scaleSnapshot(),owner=testAuthority('workspace-scale');
  for(const project of Object.values(source.workspace.projects))setRepositoryAccess(project,{expectedVersion:0,grants:[{kind:'agent',id:owner.policy.agentClientIds[0],role:'read'}]},owner.principal,owner.policy);
  store.write(source,0);
  const authority=testAuthority('workspace-scale','11111111111111111111111111111111.access'),controller=new HostedController(store,{},authority),requests=[];
  const client=new HostedAgentClient({origin:'https://fixture.example',workspaceId:'workspace-scale',clientId:authority.principal.id,clientSecret:'synthetic-test-only'}, {fetchImpl:async(url,options)=>{
    requests.push(url.search);assert.equal(options.method,'GET');const page=store.readPage(parseWorkspacePage(url.search));
    return Response.json({...controller.workspace(page.snapshot,page.capacity),page:page.page});
  }});
  const first=await client.execute('projects');assert.equal(first.projects.length,10);assert.equal(first.page.totalProjects,100);
  assert.throws(()=>client.locks,/absolute private connection state directory/,'Read-only projections do not guess a private ledger path.');
  const next=await client.execute('projects',{offset:first.page.nextOffset,revision:first.page.revision});assert.equal(next.projects.length,10);assert.equal(next.page.offset,10);
  await assert.rejects(client.execute('projects',{offset:20}),/revision/);
  const state=store.read().workspace,task=state.tasks.at(-1),run=state.runs.at(-1);
  await client.execute('status',{project:task.projectId});assert.match(requests.at(-1),/limit=1&project=/);
  await client.execute('show',{task:task.id});assert.match(requests.at(-1),/limit=1&task=/);
  await client.workspace({run:run.id});assert.match(requests.at(-1),/limit=1&run=/);
  const projected=projectMutationResult({taskId:task.id,runId:run.id,workspace:state},'/api/projects/'+task.projectId+'/claim');
  assert.equal(projected.workspace.tasks.length,8);assert.equal(projected.workspace.runs.length,8);assert.equal(projected.workspace.page.totalProjects,100);assert.ok(Buffer.byteLength(JSON.stringify(projected))<200000);
  const original=JSON.stringify(state);const response=projectMutationResult(state,'/api/runs/'+run.id+'/submit');assert.equal(response.tasks.length,8);assert.equal(JSON.stringify(state),original);
});

test('a merge on project 100 stays visible in workspace recovery on project 1',t=>{
  const {db,storage}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'workspace-scale'),source=scaleSnapshot();
  source.operations['pending-check-1'].kind='merge';store.write(source,0);
  const controller=new HostedController(store,{},testAuthority('workspace-scale'));
  for(const running of [false,true]){
    if(running){const next=store.read();next.operations['pending-check-1'].leaseUntil=Date.now()+120000;next.revision++;store.write(next,next.revision-1);}
    const page=store.readPage(parseWorkspacePage('limit=1')),workspace=controller.workspace(page.snapshot,page.capacity),projectId=Object.keys(workspace.projects)[0];
    assert.ok(!workspace.runs.some(run=>run.id===source.operations['pending-check-1'].itemId));
    assert.equal(workspace.recovery.pendingMergeIntents,1);assert.equal(workspace.capacity.verification.occupied,2);
    const summary=mergeIntentSummary(workspace);assert.equal(summary.total,1);assert.equal(summary.unclassified,0);assert.equal(running?summary.running:summary.recoveryRequired,1);
    assert.deepEqual(projectStatus(workspace,projectId,new URL('https://fixture.example')).mergeIntents,{scope:'workspace',...summary});
  }
});
