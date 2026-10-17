import test from 'node:test';
import assert from 'node:assert/strict';
import {trialWorkflowFixture,correctCheckout} from './helpers/trial-workflow.mjs';
import {handler,token,req,admit} from './helpers/trial-http.mjs';
const json=async response=>{const body=await response.json();assert.ok(response.ok,JSON.stringify(body));return body;};

test('a workflow loader without dedicated trial storage fails closed',async t=>{
  const f=await trialWorkflowFixture(t),jwt=await token();delete f.env.TRIAL_ARTIFACTS;
  const response=await handler(req('/api/trial',jwt),f.env);
  assert.equal(response.status,503);assert.equal((await response.json()).code,'TRIAL_DEPLOYMENT_FORBIDDEN');
  assert.equal(f.calls.length,0);
});

test('a self-service trial completes real Git publication, workerd checks, review, merge, export and cleanup',async t=>{
  const f=await trialWorkflowFixture(t),jwt=await token(),grant=await admit(f,jwt);
  const sample=await json(await handler(req('/api/trial/sample',jwt,{}),f.env));assert.equal(sample.workflowReady,true);
  const workspace=await json(await handler(req('/api/workspace',jwt),f.env));assert.equal(workspace.tasks.length,1);assert.equal(workspace.trial.workflowReady,true);assert.equal(workspace.capacity.limit,1);
  const issue=role=>handler(req('/api/trial/credentials',jwt,{role},{'X-Workspace-Id':grant.workspaceId,'Idempotency-Key':crypto.randomUUID()}),f.env).then(json);
  const builder=await issue('agent'),reviewer=await issue('reviewer');
  const claim=await json(await f.agent(builder,'/api/projects/'+sample.repository.projectId+'/claim',{label:'Local workflow fixture'}));
  assert.ok(claim.runId);assert.equal(claim.credentials,null);assert.equal(claim.credentialStatus,'server-managed');
  const source=await json(await f.agent(builder,'/api/runs/'+claim.runId+'/source'));assert.equal(source.headCommit,sample.repository.baseCommit);
  await json(await f.agent(builder,'/api/runs/'+claim.runId+'/start',{}));
  const published=await json(await f.agent(builder,'/api/runs/'+claim.runId+'/source',{headCommit:source.headCommit,source:correctCheckout}));assert.match(published.headCommit,/^[a-f0-9]{40}$/);
  await json(await f.agent(builder,'/api/runs/'+claim.runId+'/submit',{headCommit:published.headCommit,summary:'Local fixture implements the declared checkout requirements.'}));
  const verified=await json(await handler(req('/api/runs/'+claim.runId+'/verify',jwt,{headCommit:published.headCommit,taskRevision:1},{'Idempotency-Key':crypto.randomUUID()}),f.env));
  const checked=verified.runs.find(run=>run.id===claim.runId);assert.equal(checked.evidence.passed,checked.evidence.total);assert.equal(checked.evidence.total,16);assert.equal(checked.evidence.commit,published.headCommit);
  assert.equal((await f.agent(reviewer,'/api/runs/'+claim.runId+'/source',{headCommit:source.headCommit,source:correctCheckout})).status,403);
  const context=await json(await handler(req('/api/runs/'+claim.runId+'/review-context',jwt),f.env));
  await json(await handler(req('/api/runs/'+claim.runId+'/review-assignments',jwt,{contextId:context.contextId,expectedVersion:verified.version,reviewerIds:[reviewer.principal.id]}, {'Idempotency-Key':crypto.randomUUID()}),f.env));
  const assigned=await json(await f.agent(reviewer,'/api/runs/'+claim.runId+'/review-context'));
  await json(await f.agent(reviewer,'/api/runs/'+claim.runId+'/code-review',{format:'projects-code-review-assessment/v2',contextId:assigned.contextId,verdict:'pass',summary:'Local test review of the exact fixture candidate.',findings:[],resolvedPriorFindingIds:[]}));
  const fresh=await json(await handler(req('/api/workspace',jwt),f.env)),task=fresh.tasks.find(task=>task.id===claim.taskId);
  await json(await handler(req('/api/runs/'+claim.runId+'/review',jwt,{decision:'accept',note:'Local fixture owner decision.',headCommit:published.headCommit,taskRevision:task.revision,ownerVersion:task.ownerVersion,comparisons:[]}),f.env));
  const merged=await json(await handler(req('/api/runs/'+claim.runId+'/merge',jwt,{headCommit:published.headCommit}),f.env));
  assert.equal(merged.runs.find(run=>run.id===claim.runId).status,'merged');
  assert.equal((await f.repositories.get(sample.repository.name).log({ref:'main',limit:1}))[0].hash,published.headCommit);
  assert.equal(f.registry.admissions.resources.checkStatus(grant.workspaceId).trial.used,2);
  await json(await handler(req('/api/projects/'+sample.repository.projectId+'/policy',jwt,{acceptingWork:false,expectedVersion:merged.projects[sample.repository.projectId].policyVersion}),f.env));
  const exported=await json(await handler(req('/api/projects/'+sample.repository.projectId+'/export',jwt),f.env));assert.ok(exported);
  const completeExport=await json(await handler(req('/api/trial/export',jwt),f.env));assert.equal(completeExport.sources.length,2);assert.equal(completeExport.format,'projects-git-trial-export/v1');
  await json(await handler(req('/api/trial/close',jwt,{}),f.env));assert.equal((await f.agent(builder,'/api/workspace')).status,403);
  f.sql.storage.sql.exec('UPDATE trial_admissions SET created_at=created_at-600000,expires_at=expires_at-600000,closed_at=closed_at-600000 WHERE workspace_id=?',grant.workspaceId);
  await f.registry.alarm();
  const end=await json(await handler(req('/api/trial',jwt),f.env));assert.equal(end.cleanup,'complete',JSON.stringify(f.sql.storage.sql.exec('SELECT * FROM trial_cleanup').toArray()));assert.equal(f.repositories.size,0);
  assert.equal(f.sql.storage.sql.exec('SELECT count(*) n FROM trial_credentials WHERE workspace_id=?',grant.workspaceId).one().n,0);
});

test('two admitted owners and scoped agent/reviewer credentials cannot cross trial boundaries',async t=>{
  const f=await trialWorkflowFixture(t),a=await token('owner-a'),b=await token('owner-b'),ga=await admit(f,a),gb=await admit(f,b);
  const pa=await json(await handler(req('/api/trial/sample',a,{}),f.env)),pb=await json(await handler(req('/api/trial/sample',b,{}),f.env));
  const credential=await json(await handler(req('/api/trial/credentials',a,{role:'agent'},{'X-Workspace-Id':ga.workspaceId,'Idempotency-Key':crypto.randomUUID()}),f.env));
  const before=f.calls.length;
  assert.equal((await f.agent(credential,'/api/workspace',undefined,{'X-Workspace-Id':gb.workspaceId})).status,403);
  assert.equal((await handler(req('/api/workspace',b,undefined,{'X-Workspace-Id':ga.workspaceId}),f.env)).status,403);
  assert.equal((await f.agent(credential,'/api/projects/'+pb.repository.projectId+'/claim',{label:'Foreign attempt'})).status,403);
  assert.equal(f.calls.length,before);
  const own=await json(await f.agent(credential,'/api/workspace'));assert.ok(own.projects[pa.repository.projectId]);assert.ok(!own.projects[pb.repository.projectId]);
});

test('expired owners have a bounded export-only window; closed and late requests are denied',async t=>{
  const f=await trialWorkflowFixture(t),jwt=await token(),grant=await admit(f,jwt);
  await json(await handler(req('/api/trial/sample',jwt,{}),f.env));
  f.sql.storage.sql.exec('UPDATE trial_admissions SET created_at=created_at-3600001,expires_at=expires_at-3600001 WHERE workspace_id=?',grant.workspaceId);
  assert.equal((await handler(req('/api/workspace',jwt),f.env)).status,403);
  for(let i=0;i<3;i++)assert.equal((await handler(req('/api/trial/export',jwt),f.env)).status,200);
  assert.equal((await handler(req('/api/trial/export',jwt),f.env)).status,429);
  assert.equal((await handler(req('/api/trial/export',jwt,undefined,{'Sec-Fetch-Site':'cross-site'}),f.env)).status,403);
  f.sql.storage.sql.exec('UPDATE trial_admissions SET created_at=created_at-600000,expires_at=expires_at-600000 WHERE workspace_id=?',grant.workspaceId);
  assert.equal((await handler(req('/api/trial/export',jwt),f.env)).status,403);
  await json(await handler(req('/api/trial/close',jwt,{}),f.env));
  const closed=await json(await handler(req('/api/trial',jwt),f.env));assert.equal(closed.status,'closed');assert.equal((await handler(req('/api/trial/export',jwt),f.env)).status,403);
});
