import {codeReviewContext} from "../src/core/workflow.mjs";
import {testAuthority, testReviewerAuthority, AGENT_CLIENT, REVIEWER_CLIENT} from './helpers/hosted-authority.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { HostedController, initialSnapshot, migrateSnapshot } from "../src/cloudflare/controller.ts";
import { branchHead, exactCommit, inspectResult, safeRemote } from "../src/cloudflare/artifacts.ts";
import { ApiError, bodyJson, errorResponse, idempotencyKey, requireSameOrigin } from "../src/cloudflare/security.ts";
import { readTaskHandoff } from '../src/core/handoff.mjs';
import { createHash } from 'node:crypto';
import { digest as checkDigest, requirementsDigest } from '../src/core/check-definition.mjs';
import { systemAuthority, authorizeRoute } from '../src/cloudflare/access.ts';
import { approveRunByPolicy } from '../src/core/workflow.mjs';
import { independentReviewBinding, independentReviewStatus } from '../public/review-boundary.js';
import {snapshotPage} from './helpers/snapshot-page.mjs';
import { candidateOutcome } from '../public/workbench-state.js';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';

const workerFile=new URL('../src/cloudflare/index.ts',import.meta.url),workerRequire=createRequire(workerFile),workerModule={exports:{}};
new Function('require','module','exports',transformSync(readFileSync(workerFile,'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code)(
  name=>name==='cloudflare:workers'?{DurableObject:class{},WorkerEntrypoint:class{}}:name==='./check-container.ts'?{RepositoryCheckContainer:class{}}:workerRequire(name),workerModule,workerModule.exports);

function retainedCoordinator(c) {
  const instance=Object.create(workerModule.exports.WorkspaceCoordinator.prototype),old=testAuthority().policy;
  instance.env={WORKSPACE_ID:old.workspaceId,ACCESS_TEAM_DOMAIN:old.issuer,ACCESS_AUD:old.audience,ACCESS_OWNER_SUB:old.ownerSubject,
    ACCESS_AGENT_CLIENT_IDS:JSON.stringify(old.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(old.reviewerClientIds),ACCESS_REVIEWER_SUBJECTS:'[]'};
  instance.store=c.store;instance.schedule=async()=>{};
  instance.controller=authority=>new HostedController(c.store,c.artifacts,authority,c.runtime);
  return instance;
}

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);
const BASE_TREE = "d".repeat(40);
const HEAD_TREE = "e".repeat(40);
const OLD_BLOB = "1".repeat(40);
const NEW_BLOB = "2".repeat(40);
const CONTROL_TOKEN = "test-control-token-" + "x".repeat(40);
const LONG_TOKEN = "initial-provider-credential-sensitive";
const SHORT_TOKEN = "short-provider-credential-sensitive";
const reviewInput=(contextId,summary='Inspected the exact source and trusted checks.',verdict='pass',findings=[])=>({
  format:'projects-code-review-assessment/v2',contextId,summary,verdict,findings,resolvedPriorFindingIds:[]});
async function assignTestReview(c,runId,reviewerIds=[REVIEWER_CLIENT],controller=c.controller){
  const workspace=c.store.read().workspace;
  return controller.assignReviewers(runId,{contextId:codeReviewContext(workspace,runId).contextId,expectedVersion:workspace.version,reviewerIds},crypto.randomUUID());
}
function bindValidBaseBlob(c) {
 const bytes=Buffer.from('before\n'),oid=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
 c.fork.trees.get(BASE_TREE)[0].hash=oid;c.fork.blobs.set(oid,new Blob([bytes]));return oid;
}
async function acceptAfterIndependentReview(c, runId, input) {
  await assignTestReview(c,runId);
  const reviewer = new HostedController(c.store,c.artifacts,testReviewerAuthority(c.store.read().workspace.id),c.runtime);
  const packet=codeReviewContext(c.store.read().workspace,runId);
  await reviewer.codeReview(runId,reviewInput(packet.contextId,'Explicit independent assessment fixture for this owner/merge regression.'),crypto.randomUUID());
  return c.controller.review(runId,input);
}

test('owner reviewer names persist without changing assignments, evidence or authenticated attribution',async()=>{
  const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'name-checks');
  bindValidBaseBlob(c);
  await assignTestReview(c,id);const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
  const packet=await reviewer.reviewContext(id);await reviewer.codeReview(id,reviewInput(packet.contextId),'name-review');
  const before=c.store.read(),run=before.workspace.runs.find(run=>run.id===id);
  const result=c.controller.reviewerName({reviewerId:REVIEWER_CLIENT,name:'Security review agent',expectedVersion:before.workspace.version});
  assert.deepEqual(result,{reviewerId:REVIEWER_CLIENT,name:'Security review agent'});
  const after=c.store.read();assert.deepEqual(after.workspace.runs,before.workspace.runs);assert.deepEqual(after.operations,before.operations);
  assert.deepEqual(after.workspace.authentication,before.workspace.authentication);
  assert.equal(after.workspace.version,before.workspace.version+1);
  const restarted=new HostedController(c.store,c.artifacts,testAuthority(),c.runtime);
  assert.equal(restarted.workspace().reviewerNames[REVIEWER_CLIENT],'Security review agent');
  assert.equal(restarted.workspace().reviewRequests[id],'pass');
  assert.equal(reviewer.reviewInbox().reviewerName,'Security review agent');
  assert.equal(reviewer.reviewInbox().principal.displayName,REVIEWER_CLIENT);
  assert.equal(codeReviewContext(after.workspace,id).contextId,packet.contextId);
  assert.equal(after.workspace.runs.find(item=>item.id===id).codeReview.identity.displayName,run.codeReview.identity.displayName);
  const builder=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT),c.runtime);
  assert.equal(builder.workspace().reviewerNames,undefined);
});

test('reviewer naming refuses unauthorized, foreign, stale and identity-bearing writes before mutation',async()=>{
  const c=await commandContext(),before=c.store.read(),input={reviewerId:REVIEWER_CLIENT,name:'Review agent',expectedVersion:before.workspace.version};
  const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
  const builder=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT),c.runtime);
  for(const actor of [reviewer,builder])assert.throws(()=>actor.reviewerName(input),{code:'OWNER_REQUIRED'});
  for(const changed of [{reviewerId:'unknown'},{reviewerId:AGENT_CLIENT},{reviewerId:'__proto__'},{reviewerId:'fixture-owner'}])
    assert.throws(()=>c.controller.reviewerName({...input,...changed}),{code:'REVIEWER_NOT_ALLOWED'});
  for(const name of ['', ' ', 'x'.repeat(81), 'Fake\nidentity', '\u202eowner'])
    assert.throws(()=>c.controller.reviewerName({...input,name}),{code:'INVALID_REVIEWER_NAME'});
  assert.throws(()=>c.controller.reviewerName({...input,principal:{kind:'reviewer'}}),{code:'INVALID_REVIEWER_NAME'});
  assert.throws(()=>c.controller.reviewerName({...input,expectedVersion:before.workspace.version-1}),{code:'STATE_CONFLICT'});
  assert.deepEqual(c.store.read(),before);
});

test('assignment status reports renewal after changed evidence and never preserves revoked reviewer passing status',async()=>{
  const c=await commandContext(),id=c.assignment.runId;assert.equal(c.controller.workspace().reviewRequests[id],'unassigned');
  await c.controller.configureChecks(id,c.plan(),'request-state-checks');await assignTestReview(c,id);
  assert.equal(c.controller.workspace().reviewRequests[id],'pending');
  const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
  const packet=codeReviewContext(c.store.read().workspace,id);await reviewer.codeReview(id,reviewInput(packet.contextId),'request-state-review');
  assert.equal(c.controller.workspace().reviewRequests[id],'pass');
  const revoked=testAuthority();revoked.policy.reviewerClientIds=[];
  assert.equal(new HostedController(c.store,c.artifacts,revoked,c.runtime).workspace().reviewRequests[id],'reviewer-unavailable');
  const snapshot=c.store.read();snapshot.workspace.runs.find(run=>run.id===id).verificationPending=true;c.store.write(snapshot,snapshot.revision);
  assert.equal(c.controller.workspace().reviewRequests[id],'stale');assert.equal(reviewer.reviewInbox().items[0].status,'stale');
});

for(const change of ['removed','foreign issuer'])test(`manual acceptance rejects a ${change} reviewer without provider I/O or mutation`,async()=>{
  const c=await automaticContext(),authority=testAuthority();
  const state=c.store.read();
  if(change==='removed')authority.policy.reviewerClientIds=[];
  else {state.workspace.runs[0].codeReview.identity.issuer='https://foreign.cloudflareaccess.com';c.store.write(state,state.revision);}
  const controller=new HostedController(c.store,c.artifacts,authority,c.runtime),before=c.store.read();
  let reads=0;const get=c.artifacts.get;c.artifacts.get=async(...args)=>{reads++;return get(...args);};
  await assert.rejects(controller.review(c.id,c.review()),{code:'REVIEWER_ACCESS_CHANGED'});
  assert.equal(reads,0);assert.deepEqual(c.store.read(),before);
  const view=controller.workspace();assert.equal(independentReviewStatus(view,view.runs[0]).passed,false);
  assert.equal(view.coordination[c.id].acceptance.find(rule=>rule.code==='independent_review_required').met,false);
});

test('reviewer removal during candidate read refuses manual acceptance at commit',async()=>{
  const c=await automaticContext(),authority=testAuthority(),controller=new HostedController(c.store,c.artifacts,authority,c.runtime);
  const before=c.store.read(),log=c.fork.log.bind(c.fork);
  // Fault injection into the controller's copied policy; this does not claim
  // that production Access configuration hot-reloads within one request.
  c.fork.log=async(...args)=>{controller.authority.policy.reviewerClientIds=[];return log(...args);};
  await assert.rejects(controller.review(c.id,c.review()),{code:'REVIEWER_ACCESS_CHANGED'});
  assert.deepEqual(c.store.read(),before);
});

test('reviewer removal after owner acceptance refuses manual merge before checks or credentials',async()=>{
  const c=await automaticContext();await c.controller.review(c.id,c.review());
  const authority=testAuthority();authority.policy.reviewerClientIds=[];
  const controller=new HostedController(c.store,c.artifacts,authority,c.runtime),before=c.store.read(),checks=c.checks();
  let reads=0;const get=c.artifacts.get;c.artifacts.get=async(...args)=>{reads++;return get(...args);};
  await assert.rejects(controller.merge(c.id,{headCommit:HEAD}),{code:'REVIEWER_ACCESS_CHANGED'});
  assert.equal(reads,0);assert.equal(c.checks(),checks);assert.equal(c.pushes(),0);assert.deepEqual(c.store.read(),before);
});

for(const action of ['review','merge'])test(`retained Durable Object uses forwarded revoked policy for ${action}, not its stale environment`,async()=>{
  const c=await automaticContext();if(action==='merge')await c.controller.review(c.id,c.review());
  const coordinator=retainedCoordinator(c),authority=testAuthority(),before=c.store.read(),checks=c.checks();authority.policy.reviewerClientIds=[];
  let reads=0;const get=c.artifacts.get;c.artifacts.get=async(...args)=>{reads++;return get(...args);};
  const response=await coordinator.api({...authority,method:'POST',path:`/api/runs/${c.id}/${action}`,body:action==='review'?c.review():{headCommit:HEAD},key:''});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'REVIEWER_ACCESS_CHANGED');
  assert.equal(reads,0);assert.equal(c.checks(),checks);assert.equal(c.pushes(),0);assert.deepEqual(c.store.read(),before);
  assert.deepEqual(JSON.parse(coordinator.env.ACCESS_REVIEWER_CLIENT_IDS),[REVIEWER_CLIENT]);
});

test('internal API calls without current policy fail closed without using the retained environment',async()=>{
 const c=await automaticContext(),coordinator=retainedCoordinator(c),before=c.store.read();
 coordinator.controller=()=>assert.fail('Missing policy reached controller');
 const response=await coordinator.api({principal:testAuthority().principal,forbiddenSecrets:[],method:'GET',path:'/api/workspace',body:{},key:''});
 assert.equal(response.status,503);assert.equal((await response.json()).code,'AUTH_POLICY_REQUIRED');assert.deepEqual(c.store.read(),before);
});

for(const enabled of [false,true])test(`background alarm retains an observed reviewer revocation with automatic policy ${enabled?'on':'off'}`,async()=>{
  const c=await automaticContext();c.toggle(enabled);
  const coordinator=retainedCoordinator(c),authority=testAuthority();authority.policy.reviewerClientIds=[];
  c.runtime.currentPolicy=async()=>structuredClone(authority.policy);
  const before=c.store.read(),checks=c.checks();
  const refusal=await coordinator.api({...authority,method:'POST',path:`/api/runs/${c.id}/review`,body:c.review(),key:''});
  assert.equal(refusal.status,409);assert.equal((await refusal.json()).code,'REVIEWER_ACCESS_CHANGED');
  assert.deepEqual(c.store.read(),before);assert.equal(c.pushes(),0);
  await coordinator.alarm();
  console.log(JSON.stringify({probe:'revocation-followed-by-alarm',automaticPolicyEnabled:enabled,status:c.store.read().workspace.runs[0].status,checksBefore:checks,checksAfter:c.checks(),pushes:c.pushes()}));
  assert.equal(c.pushes(),0,'A background alarm must not integrate the candidate after the current owner request observed its reviewer revocation.');
  assert.equal(c.checks(),checks,'No verification may begin after that revocation.');
});

test('reviewer removal at the manual before-push barrier prevents Git writes and retires issued tokens',async()=>{
  const c=await automaticContext();await c.controller.review(c.id,c.review());
  const authority=testAuthority(),controller=new HostedController(c.store,c.artifacts,authority,c.runtime);let writes=0;
  c.runtime.git.merge=async input=>{controller.authority.policy.reviewerClientIds=[];await input.beforePush();writes++;};
  await assert.rejects(controller.merge(c.id,{headCommit:HEAD}),{code:'REVIEWER_ACCESS_CHANGED'});
  assert.equal(writes,0);assert.equal(c.store.read().workspace.runs[0].status,'accepted');
  assert.ok([...c.source.tokens.values(),...c.fork.tokens.values()].every(token=>token.state==='revoked'));
  const operation=Object.values(c.store.read().operations).find(op=>op.kind==='merge');
  assert.equal(operation.state,'failed');assert.equal(operation.errorCode,'REVIEWER_ACCESS_CHANGED');
});

test('automatic authority is checked between commands and interrupted evidence keeps the full denominator',async()=>{
  const c=await automaticContext(),plan=JSON.parse(c.plan().definition);
  plan.checks.push({...plan.checks[0],name:'Read answer again'});
  const definition=JSON.stringify(plan);
  await c.controller.configureChecks(c.id,{definition,definitionSha256:checkDigest(definition)},'two-command-policy');
  await assignTestReview(c,c.id);
  const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
  await reviewer.codeReview(c.id,reviewInput(codeReviewContext(c.store.read().workspace,c.id).contextId),'two-command-review');
  c.toggle(true);const policy=testAuthority().policy;c.runtime.currentPolicy=async()=>structuredClone(policy);
  const beforeChecks=c.checks(),observe=c.runtime.repositoryChecks.observe;
  c.runtime.repositoryChecks.observe=async(...args)=>{const result=await observe(...args);policy.reviewerClientIds=[];return result;};
  await c.system().drainAutomaticMerges();
  const state=c.store.read(),run=state.workspace.runs[0];
  assert.equal(c.checks()-beforeChecks,1,'The second command must not start after reviewer revocation');
  assert.equal(c.pushes(),0);assert.equal(run.automaticMergeStop.phase,'before-write');
  const retained=run.evidenceHistory.find(report=>report.operation==='merge');
  assert.ok(retained,'Keep the interrupted merge report');assert.equal(retained.verified,false);
  assert.equal(retained.passed,1);assert.equal(retained.total,2);
  assert.equal(retained.checks[1].passed,false);
});

for(const phase of ['source-read','verification','before-push'])test(`fresh automatic authority blocks reviewer revocation during ${phase}`,async()=>{
  const c=await automaticContext();c.toggle(true);const policy=testAuthority().policy;
  c.runtime.currentPolicy=async()=>structuredClone(policy);
  let writes=0;
  const initialChecks=c.checks();
  if(phase==='source-read'){
    const read=c.fork.readBlob.bind(c.fork);c.fork.readBlob=async(...args)=>{const value=await read(...args);policy.reviewerClientIds=[];return value;};
  }
  if(phase==='verification'){
    const observe=c.runtime.repositoryChecks.observe;
    c.runtime.repositoryChecks.observe=async(...args)=>{const value=await observe(...args);policy.reviewerClientIds=[];return value;};
  }
  c.runtime.git.merge=async input=>{if(phase==='before-push')policy.reviewerClientIds=[];await input.beforePush();writes++;};
  await c.system().drainAutomaticMerges();
  const snapshot=c.store.read(),run=snapshot.workspace.runs[0];
  assert.equal(writes,0);assert.equal(run.status,'accepted');assert.equal(run.automaticMergeStop.code,'AUTOMATIC_POLICY_CHANGED');
  assert.equal(run.automaticMergeStop.phase,'before-write');
  if(phase==='source-read')assert.equal(c.checks(),initialChecks,'Revocation during source loading must stop verifier admission');
  assert.ok([...c.source.tokens.values(),...c.fork.tokens.values()].every(token=>token.state==='revoked'));
  const checks=c.checks();await c.system().drainAutomaticMerges();assert.equal(c.checks(),checks);assert.equal(writes,0);
});

for(const missing of [true,false])test(`automatic admission refuses ${missing?'missing':'unavailable'} current authority without provider work`,async()=>{
  const c=await automaticContext();c.toggle(true);
  if(missing)delete c.runtime.currentPolicy;
  else c.runtime.currentPolicy=async()=>{throw new ApiError(503,'CURRENT_POLICY_UNAVAILABLE','Controlled outage');};
  const before=c.store.read(),checks=c.checks();c.artifacts.get=async()=>assert.fail('Authority failure reached provider');
  await assert.rejects(c.system().drainAutomaticMerges(),{code:'CURRENT_POLICY_UNAVAILABLE'});
  assert.deepEqual(c.store.read(),before);assert.equal(c.checks(),checks);assert.equal(c.pushes(),0);
});

test('a restarted scheduler and an older forwarded request cannot restore a revoked reviewer',async()=>{
  const c=await automaticContext();c.toggle(true);const revoked=testAuthority();revoked.policy.reviewerClientIds=[];
  c.runtime.currentPolicy=async()=>structuredClone(revoked.policy);
  for(let restart=0;restart<2;restart++){
    const coordinator=retainedCoordinator(c),old=testAuthority();
    const response=await coordinator.api({...old,method:'GET',path:'/api/review-inbox',body:{},key:''});assert.equal(response.status,200);
    const before=c.store.read(),checks=c.checks();await coordinator.alarm();
    assert.equal(c.checks(),checks);assert.equal(c.pushes(),0);assert.deepEqual(c.store.read(),before);assert.equal(c.store.read().workspace.runs[0].review,null);
  }
});

test('a current-policy outage stops automatic work without starving the index outbox',async()=>{
  const c=await automaticContext();c.toggle(true);c.runtime.currentPolicy=async()=>{throw new ApiError(503,'CURRENT_POLICY_UNAVAILABLE','Controlled outage');};
  const coordinator=retainedCoordinator(c);let deliveries=0;coordinator.deliverIndexJobs=async()=>{deliveries++;};
  const checks=c.checks();await assert.rejects(coordinator.alarm(),{code:'CURRENT_POLICY_UNAVAILABLE'});
  assert.equal(deliveries,1);assert.equal(c.checks(),checks);assert.equal(c.pushes(),0);
});

test('unavailable or revoked current authority preserves factual automatic-write reconciliation without a second push',async()=>{
  const c=await automaticContext();c.toggle(true);c.loseAcknowledgement();await c.system().drainAutomaticMerges();assert.equal(c.pushes(),1);
  const checks=c.checks();c.runtime.currentPolicy=async()=>{throw new ApiError(503,'CURRENT_POLICY_UNAVAILABLE','Controlled outage');};
  const revoked=testAuthority();revoked.policy.reviewerClientIds=[];
  const owner=new HostedController(c.store,c.artifacts,revoked,c.runtime);
  await owner.merge(c.id,{headCommit:HEAD});assert.equal(c.store.read().workspace.runs[0].status,'merged');assert.equal(c.pushes(),1);assert.equal(c.checks(),checks);
});

test('unrelated durable writes during automatic authority lookup do not strand a valid candidate',async()=>{
  const c=await automaticContext();c.toggle(true);let readCount=0;
  c.runtime.currentPolicy=async()=>{
    if(++readCount===2){const state=c.store.read();state.workspace.name='Independent metadata update';state.workspace.version++;c.store.write(state,state.revision);}
    return testAuthority().policy;
  };
  await c.system().drainAutomaticMerges();const state=c.store.read();assert.equal(state.workspace.name,'Independent metadata update');
  assert.equal(state.workspace.runs[0].status,'merged');assert.equal(c.pushes(),1);assert.equal(state.workspace.runs[0].automaticMergeStop,undefined);
});

test('authority lookup cannot issue new Git credentials after its merge lease is displaced',async()=>{
  const c=await automaticContext();c.toggle(true);let displaced=false,issuedAfterDisplacement=0;
  const create=c.source.createToken.bind(c.source);c.source.createToken=async(...args)=>{if(displaced)issuedAfterDisplacement++;return create(...args);};
  c.runtime.currentPolicy=async()=>{
    const snapshot=c.store.read(),entry=Object.values(snapshot.operations).find(op=>op.kind==='merge'&&op.state==='pending');
    if(entry&&snapshot.workspace.runs[0].evidenceHistory?.length&&!displaced){entry.attemptId=crypto.randomUUID();c.store.write(snapshot,snapshot.revision);displaced=true;}
    return testAuthority().policy;
  };
  await c.system().drainAutomaticMerges();assert.equal(displaced,true);assert.equal(issuedAfterDisplacement,0);assert.equal(c.pushes(),0);
});

test('revoked reviewer cannot retry an uncertain manual merge while the target is still at base',async()=>{
  const c=await automaticContext();await c.controller.review(c.id,c.review());
  c.runtime.git.merge=async input=>{await input.beforePush();throw Error('Controlled disconnect before remote update');};
  await assert.rejects(c.controller.merge(c.id,{headCommit:HEAD}));
  const before=c.store.read(),checks=c.checks(),authority=testAuthority();authority.policy.reviewerClientIds=[];
  const controller=new HostedController(c.store,c.artifacts,authority,c.runtime);
  await assert.rejects(controller.merge(c.id,{headCommit:HEAD}),{code:'REVIEWER_ACCESS_CHANGED'});
  assert.equal(c.checks(),checks);assert.deepEqual(c.store.read(),before);
});

test('reviewer removal preserves completed merge replay and factual uncertain-write reconciliation',async()=>{
  const c=await automaticContext();await c.controller.review(c.id,c.review());c.loseAcknowledgement();
  await assert.rejects(c.controller.merge(c.id,{headCommit:HEAD}));
  assert.equal(c.pushes(),1);const checks=c.checks(),authority=testAuthority();authority.policy.reviewerClientIds=[];
  const controller=new HostedController(c.store,c.artifacts,authority,c.runtime);
  await controller.merge(c.id,{headCommit:HEAD});assert.equal(c.store.read().workspace.runs[0].status,'merged');
  const completed=c.store.read();await controller.merge(c.id,{headCommit:HEAD});
  assert.deepEqual(c.store.read(),completed);assert.equal(c.pushes(),1);assert.equal(c.checks(),checks);
});

test('review inbox and context stay scoped to an explicit owner assignment',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'inbox-checks');
 bindValidBaseBlob(c);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime),before=c.store.read();
 await assert.rejects(reviewer.reviewContext(id),{code:'REVIEW_ASSIGNMENT_REQUIRED'});
 assert.deepEqual(reviewer.reviewInbox().items,[]);assert.deepEqual(c.store.read(),before);
 await assert.rejects(reviewer.assignReviewers(id,{},'forged'),{code:'OWNER_REQUIRED'});
 const workspace=c.store.read().workspace,input={contextId:codeReviewContext(workspace,id).contextId,expectedVersion:workspace.version,reviewerIds:[REVIEWER_CLIENT]};
 const assigned=await c.controller.assignReviewers(id,input,'owner-assignment');
 assert.equal(reviewer.reviewInbox().total,1);assert.equal(reviewer.reviewInbox().items[0].assignmentId,assigned.assignment.id);
 assert.equal(reviewer.reviewInbox().items[0].assignmentScope,'personal');
 assert.equal(c.controller.reviewInbox().items[0].reviewerIds[0],REVIEWER_CLIENT);
 const after=c.store.read();assert.deepEqual((await c.controller.assignReviewers(id,input,'owner-assignment')).assignment,assigned.assignment);assert.deepEqual(c.store.read(),after);
 await assert.rejects(c.controller.assignReviewers(id,{...input,reviewerIds:['foreign']},'new-assignment'),{code:'reviewer_not_allowed'});
 const packet=await reviewer.reviewContext(id);assert.equal(packet.context.reviewAssignmentId,assigned.assignment.id);
});

test('review inference reserves one durable slot before provider work and fences owner changes and replay',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'reserved-review-checks');
 bindValidBaseBlob(c);await assignTestReview(c,id);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
 const packet=await reviewer.reviewContext(id);
 const input={assignmentId:packet.context.reviewAssignmentId,contextId:packet.contextId,
   model:'scripted-reviewer',maxInputBytes:8192,maxOutputTokens:1024,timeoutMs:5000};
 const before=c.controller.workspace().capacity.occupied;
 const reserved=await reviewer.reserveReviewInference(id,input,'review-attempt-1');
 assert.equal(reserved.state,'pending');assert.equal(reserved.replayed,false);
 assert.equal(c.controller.workspace().capacity.occupied,before+1);
 assert.equal(c.controller.workspace().reviewInferences.find(item=>item.attemptId===reserved.attemptId).state,'pending');
 assert.deepEqual(await reviewer.reserveReviewInference(id,input,'review-attempt-1'),{...reserved,replayed:true});
 await assert.rejects(reviewer.reserveReviewInference(id,{...input,model:'changed'},'review-attempt-1'),{code:'IDEMPOTENCY_CONFLICT'});
 assert.throws(()=>c.controller.setOwner(c.task.taskId,{owner:'Changed owner',expectedOwnerVersion:1}),{code:'TASK_OPERATION_PENDING'});
 await assert.rejects(c.controller.assignReviewers(id,{contextId:packet.contextId,expectedVersion:c.store.read().workspace.version,reviewerIds:[REVIEWER_CLIENT]},'another-assignment'),{code:'TASK_OPERATION_PENDING'});
 await assert.rejects(reviewer.codeReview(id,reviewInput(packet.contextId),'other-reviewer-key'),{code:'REVIEW_ATTEMPT_REQUIRED'});
 const result=await reviewer.codeReview(id,{...reviewInput(packet.contextId),reviewAttemptId:reserved.attemptId},'review-attempt-1');
 assert.equal(result.codeReview.contextId,packet.contextId);
 assert.equal(c.controller.workspace().capacity.occupied,before);
 assert.equal(Object.values(c.store.read().operations).find(op=>op.attemptId===reserved.attemptId).state,'complete');
 assert.equal((await reviewer.codeReview(id,{...reviewInput(packet.contextId),reviewAttemptId:reserved.attemptId},'review-attempt-1')).codeReview.id,result.codeReview.id);
});

test('inference reservation rechecks assignment after delayed Git I/O and restart retains uncertain work',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'review-recovery-checks');
 bindValidBaseBlob(c);await assignTestReview(c,id);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
 const packet=await reviewer.reviewContext(id);
 const input={assignmentId:packet.context.reviewAssignmentId,contextId:packet.contextId,
   model:'scripted-reviewer',maxInputBytes:8192,maxOutputTokens:1024,timeoutMs:5000};
 const originalLog=c.fork.log.bind(c.fork);let entered,release;
 const paused=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 c.fork.log=async(...args)=>{entered();await barrier;return originalLog(...args);};
 const pending=reviewer.reserveReviewInference(id,input,'delayed-review-reservation');
 await paused;
 c.controller.setOwner(c.task.taskId,{owner:'Changed while source was checked',expectedOwnerVersion:1});
 release();await assert.rejects(pending,{code:'STALE_REVIEW_ASSIGNMENT'});c.fork.log=originalLog;
 assert.equal(Object.values(c.store.read().operations).filter(op=>op.kind==='review-inference').length,0);
 const current=await reviewer.reviewContext(id).catch(()=>null);assert.equal(current,null);
 const ownerWorkspace=c.store.read().workspace;
 await c.controller.assignReviewers(id,{contextId:codeReviewContext(ownerWorkspace,id).contextId,
   expectedVersion:ownerWorkspace.version,reviewerIds:[REVIEWER_CLIENT]},'renewed-review-assignment');
 const fresh=await reviewer.reviewContext(id);
 const reservation=await reviewer.reserveReviewInference(id,{...input,assignmentId:fresh.context.reviewAssignmentId,contextId:fresh.contextId},'recover-review-reservation');
 const restarted=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
 assert.equal(restarted.reviewInbox().items[0].status,'pending');
 assert.equal(Object.values(c.store.read().operations).find(op=>op.attemptId===reservation.attemptId).state,'pending');
 const recovered=c.controller.reconcileReviewInference(id,reservation.attemptId,
   {expectedRevision:c.store.read().revision,note:'Operator confirmed the interrupted inference is no longer running.'});
 assert.equal(recovered.state,'failed');
 const forks=c.forks();
 await assert.rejects(restarted.codeReview(id,{...reviewInput(fresh.contextId),reviewAttemptId:reservation.attemptId},'recover-review-reservation'),{code:'REVIEW_ATTEMPT_STALE'});
 await assert.rejects(restarted.codeReview(id,reviewInput(fresh.contextId),'omit-reconciled-attempt'),{code:'REVIEW_ATTEMPT_REQUIRED'});
 assert.equal(c.forks(),forks);
});

test('a stale assignment cannot read changed source before provider I/O',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'stale-assignment-checks');
 bindValidBaseBlob(c);await assignTestReview(c,id);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
 assert.equal((await reviewer.reviewContext(id)).source.commit,HEAD);
 c.controller.setOwner(c.task.taskId,{owner:'Reassigned coordinator',expectedOwnerVersion:1});
 const before=c.store.read(),forks=c.forks(),log=c.fork.log.bind(c.fork);let reads=0;
 c.fork.log=async(...args)=>{reads++;return log(...args);};
 await assert.rejects(reviewer.reviewContext(id),{code:'STALE_REVIEW_ASSIGNMENT'});
 assert.deepEqual(c.store.read(),before);assert.equal(c.forks(),forks);assert.equal(reads,0);
 assert.equal(reviewer.reviewInbox().items[0].status,'stale');
});

test('reassignment retains prior assessment and owner decision but requires fresh review',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'reassignment-checks');
 bindValidBaseBlob(c);
 await assignTestReview(c,id);const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
 const packet=await reviewer.reviewContext(id);const first=await reviewer.codeReview(id,reviewInput(packet.contextId),'first-assessment');
 await c.controller.review(id,c.review());assert.equal(c.store.read().workspace.runs.find(run=>run.id===id).status,'accepted');
 const workspace=c.store.read().workspace;
 const next=await c.controller.assignReviewers(id,{contextId:codeReviewContext(workspace,id).contextId,expectedVersion:workspace.version,reviewerIds:[REVIEWER_CLIENT]},'renewed-assignment');
 const run=c.store.read().workspace.runs.find(run=>run.id===id);
 assert.equal(run.status,'awaiting_review');assert.equal(run.review,null);assert.equal(run.reviewHistory.length,1);
 assert.equal(run.codeReview.id,first.codeReview.id);assert.notEqual(next.assignment.id,run.codeReview.assignmentId);
 assert.equal(reviewer.reviewInbox().items[0].status,'pending');
 const current=await reviewer.reviewContext(id);assert.notEqual(current.contextId,packet.contextId);
});

test('independent reviewer has sealed read-only code access and no builder or owner capabilities',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'reviewer-checks');
 await assignTestReview(c,id);
 bindValidBaseBlob(c);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime),before=c.store.read(),forks=c.forks();
 assert.throws(()=>reviewer.workspace(),{code:'REVIEWER_READ_ONLY'});
 for(const call of [()=>reviewer.claim(c.task.projectId,{agentClientId:AGENT_CLIENT,label:'escape'},'review-claim'),()=>reviewer.assign(c.task.taskId,{agentClientId:AGENT_CLIENT,label:'escape'},'review-assign'),()=>reviewer.fail(id,{message:'escape'}),()=>reviewer.complete(id,{headCommit:HEAD,summary:'escape'}),()=>reviewer.review(id,c.review()),()=>reviewer.merge(id,{headCommit:HEAD}),()=>reviewer.configureChecks(id,c.plan(),'review-verify')])await assert.rejects(call);
 assert.throws(()=>reviewer.start(id),{code:'REVIEWER_READ_ONLY'});assert.deepEqual(c.store.read(),before);assert.equal(c.forks(),forks);
 const packet=await reviewer.reviewContext(id);assert.equal(packet.source.commit,HEAD);assert.equal(packet.source.files[0].name,'answer.txt');assert.equal(packet.boundaries.conversationIncluded,false);assert.equal(packet.context.runId,id);assert.deepEqual(c.store.read(),before);
 const input=reviewInput(packet.contextId,'Independent test reviewer inspected source and evidence.');
 await assert.rejects(c.controller.codeReview(id,input),{code:'REVIEWER_REQUIRED'});
 const agent=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT),c.runtime);await assert.rejects(agent.codeReview(id,input),{code:'REVIEWER_REQUIRED'});
 for(const field of ['reviewer','identity','principal','context'])await assert.rejects(reviewer.codeReview(id,{...input,[field]:'fake'},'assess'),{code:'identity_forged'});
 assert.deepEqual(c.store.read(),before);
 const assessed=await reviewer.codeReview(id,input,'assess');assert.equal(assessed.codeReview.identity.kind,'reviewer');assert.equal(assessed.codeReview.identity.id,REVIEWER_CLIENT);assert.equal(c.controller.workspace().runs.find(run=>run.id===id).status,'awaiting_review');
 const once=c.store.read();assert.deepEqual((await reviewer.codeReview(id,input,'assess')).codeReview,assessed.codeReview);assert.deepEqual(c.store.read(),once);
 await c.controller.review(id,c.review());assert.equal(c.controller.workspace().runs.find(run=>run.id===id).review.codeReviewId,assessed.codeReview.id);
});

test('finding lines and base-side blob identity come from the exact committed source',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'finding-location-checks');
 await assignTestReview(c,id);
 const baseOid=bindValidBaseBlob(c),reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime);
 const packet=await reviewer.reviewContext(id);assert.equal(packet.baseSource.files[0].oid,baseOid);
 const finding={title:'Stale boundary',body:'The baseline behavior needs an explicit replacement.',priority:1,
   location:{path:packet.baseSource.files[0].name,side:'base',startLine:1,endLine:1},evidence:'The committed baseline contains the old value.'};
 const before=c.store.read();
 await assert.rejects(reviewer.codeReview(id,reviewInput(packet.contextId,'Wrong line','changes_requested',
   [{...finding,location:{...finding.location,startLine:2,endLine:2}}]),'invalid-line'),{code:'INVALID_REVIEW_LOCATION'});
 assert.deepEqual(c.store.read(),before);
 const result=await reviewer.codeReview(id,reviewInput(packet.contextId,'Read baseline','changes_requested',[finding]),'valid-base');
 assert.equal(result.codeReview.findings[0].oid,baseOid);assert.equal(result.codeReview.findings[0].location.side,'base');
});

test('controller records only owner finding decisions and keeps reviewer verdict unchanged',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'decision-checks');
 await assignTestReview(c,id);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime),packet=codeReviewContext(c.store.read().workspace,id);
 const finding={title:'Unsafe result',body:'This line returns a value without checking the bound.',priority:1,
   location:{path:'answer.txt',side:'head',startLine:1,endLine:1},evidence:'The checked head contains the expression.'};
 const report=await reviewer.codeReview(id,reviewInput(packet.contextId,'Needs repair','changes_requested',[finding]),'review');
 const findingId=report.codeReview.findings[0].id,input={assessmentId:report.codeReview.id,decision:'deferred',note:'Retain for a revised candidate.',expectedVersion:c.store.read().workspace.version};
 const before=c.store.read();await assert.rejects(reviewer.findingDecision(id,findingId,input,'foreign'),{code:'OWNER_REQUIRED'});assert.deepEqual(c.store.read(),before);
 const result=await c.controller.findingDecision(id,findingId,input,'owner-note');
 assert.equal(result.findingDecision.identity.kind,'owner');assert.equal(c.store.read().workspace.runs.find(run=>run.id===id).codeReview.verdict,'changes_requested');
 assert.deepEqual((await c.controller.findingDecision(id,findingId,input,'owner-note')).findingDecision,result.findingDecision);
 await assert.rejects(c.controller.findingDecision(id,findingId,{...input,note:'Different'},'owner-note'),{code:'idempotency_conflict'});
});

test('competing assessment retries retain one receipt and scope replay to the reviewer',async()=>{
 const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'competing-review-checks');
 const authority=testReviewerAuthority();authority.principal.id='a'.repeat(32)+'.access';authority.policy.reviewerClientIds.push(authority.principal.id);
 const ownerAuthority=testAuthority();ownerAuthority.policy.reviewerClientIds.push(authority.principal.id);
 const assigningOwner=new HostedController(c.store,c.artifacts,ownerAuthority,c.runtime);
 await assignTestReview(c,id,[REVIEWER_CLIENT,authority.principal.id],assigningOwner);
 const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime),packet=codeReviewContext(c.store.read().workspace,id);
 assert.equal(reviewer.reviewInbox().items[0].assignmentScope,'team');
 const input=reviewInput(packet.contextId,'Read-only review of exact source');
 let enter,release,arrivals=0;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve),log=c.fork.log.bind(c.fork);
 c.fork.log=async(...args)=>{if(++arrivals===2)enter();await gate;return log(...args);};
 const version=c.store.read().workspace.version;
 const first=reviewer.codeReview(id,input,'shared-key'),second=reviewer.codeReview(id,input,'shared-key');
 await entered;release();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(c.store.read().workspace.version,version+1);assert.equal(c.store.read().workspace.runs.find(run=>run.id===id).codeReviewHistory?.length??0,0);
 await assert.rejects(reviewer.codeReview(id,{...input,summary:'changed'},'shared-key'),{code:'idempotency_conflict'});
 const other=new HostedController(c.store,c.artifacts,authority,c.runtime),own=await other.codeReview(id,input,'shared-key');
 assert.notEqual(own.codeReview.id,a.codeReview.id);assert.equal(own.codeReview.identity.id,authority.principal.id);
 assert.deepEqual((await reviewer.codeReview(id,input,'shared-key')).codeReview,a.codeReview);assert.equal(c.store.read().workspace.runs.find(run=>run.id===id).codeReview.id,own.codeReview.id);
});

test('a delayed independent assessment cannot cross requirements change or session revocation',async()=>{
 for(const revoke of [false,true]){
  const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'delayed-review-checks');
  await assignTestReview(c,id);
  const reviewer=new HostedController(c.store,c.artifacts,testReviewerAuthority(),c.runtime),packet=codeReviewContext(c.store.read().workspace,id);
  let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve),log=c.fork.log.bind(c.fork);
  c.fork.log=async(...args)=>{enter();await gate;return log(...args);};
  const pending=reviewer.codeReview(id,reviewInput(packet.contextId,'Delayed assessment'),'delayed').then(value=>({value}),error=>({error}));await entered;
  if(revoke)c.controller.revokeSessions({});else c.controller.revise(c.task.taskId,{expectedRevision:1,purpose:'Changed intent',criteria:['New requirement'],reason:'Race test'});
  const retained=c.store.read();release();assert.ok((await pending).error);assert.deepEqual(c.store.read(),retained);assert.equal(c.store.read().workspace.runs[0].codeReview,undefined);
 }
});

test('workspace revocation survives controller restart, refuses old owner and agent sessions, and permits fresh authentication', t=>{
  const c=setup(),agent=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT));
  const before=c.store.read();
  assert.throws(()=>agent.revokeSessions({}),{code:'OWNER_REQUIRED'});
  assert.throws(()=>c.controller.revokeSessions({sessionsValidAfter:0}),{code:'INVALID_REVOCATION'});
  assert.deepEqual(c.store.read(),before);
  const receipt=c.controller.revokeSessions({}),revoked=c.store.read();
  assert.equal(receipt.sessionsValidAfter,revoked.workspace.sessionsValidAfter);assert.equal(receipt.signInRequired,true);
  assert.throws(()=>c.controller.workspace(),{code:'SESSION_REVOKED'});
  assert.throws(()=>agent.workspace(),{code:'SESSION_REVOKED'});
  assert.throws(()=>new HostedController(c.store,c.artifacts,testAuthority()),{code:'SESSION_REVOKED'});
  assert.deepEqual(c.store.read(),revoked);
  const now=(receipt.sessionsValidAfter+1)*1000;t.mock.timers.enable({apis:['Date'],now});
  const fresh=testAuthority();fresh.principal.issuedAt=receipt.sessionsValidAfter+1;
  const restored=new HostedController(c.store,c.artifacts,fresh);
  assert.equal(restored.workspace().id,'mock-workspace');assert.deepEqual(c.store.read(),revoked);
  const next=restored.revokeSessions({});assert.ok(next.sessionsValidAfter>receipt.sessionsValidAfter);
});

test('expired trusted context refuses bootstrap before any durable mutation',()=>{
  const c=setup(),expired=testAuthority(),before=c.store.read();expired.principal.expiresAt=expired.principal.issuedAt;
  assert.throws(()=>new HostedController(c.store,c.artifacts,expired),{code:'SESSION_EXPIRED'});assert.deepEqual(c.store.read(),before);
});

test('a reviewer cannot bootstrap an unbound workspace through a read',()=>{
 const c=setup(),empty=initialSnapshot('mock-workspace');c.store.write({...empty,revision:c.store.read().revision+1},c.store.read().revision);const before=c.store.read();
 assert.throws(()=>new HostedController(c.store,c.artifacts,testReviewerAuthority()),{code:'OWNER_ADOPTION_REQUIRED'});assert.deepEqual(c.store.read(),before);
});

test('revocation during credential issuance suppresses delivery and revokes the undelivered credential',async()=>{
  const c=setup(),task=await c.controller.createTasks(taskInput(),'revocation-task');
  let entered,release;const issued=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const original=c.source.fork;let fork;
  c.source.fork=async(...args)=>{const result=await original(...args);fork=c.repositories.get(args[0]);const create=fork.createToken.bind(fork);
    fork.createToken=async(...input)=>{const credential=await create(...input);entered();await gate;return credential;};return result;};
  const request=c.controller.assign(task.taskId,{agentClientId:AGENT_CLIENT,label:'Revocation fixture'},'revocation-assignment').then(value=>({value}),error=>({error}));
  await issued;c.controller.revokeSessions({});const revoked=c.store.read();release();
  const result=await request;assert.equal(result.error.code,'SESSION_REVOKED');assert.equal(result.value,undefined);
  assert.equal(fork.tokens.get('short-id').state,'revoked');assert.equal(fork.tokenCreates,1);
  assert.deepEqual(c.store.read(),revoked);assert.equal(Object.values(revoked.operations).find(op=>op.kind==='assign').state,'pending');
});

test('revocation before a reserved fork prevents provider mutation and retains the reservation',async()=>{
  const c=setup(),task=await c.controller.createTasks(taskInput(),'revoke-before-fork');
  let entered,release;const reading=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const read=c.source.readCommit.bind(c.source);c.source.readCommit=async(...args)=>{entered();await gate;return read(...args);};
  const request=c.controller.assign(task.taskId,{agentClientId:AGENT_CLIENT,label:'Reserved'},'revocation-reserved').then(value=>({value}),error=>({error}));
  await reading;c.controller.revokeSessions({});const revoked=c.store.read();release();
  assert.equal((await request).error.code,'SESSION_REVOKED');assert.equal(c.forks(),0);assert.deepEqual(c.store.read(),revoked);
});

test('revocation before a merge push prevents Git writes and cleans temporary credentials',async()=>{
  const c=await commandContext(),id=c.assignment.runId;await c.controller.configureChecks(id,c.plan(),'revocation-merge-checks');await acceptAfterIndependentReview(c, id,c.review());
  let entered,release,writes=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  c.runtime.git.merge=async input=>{entered();await gate;await input.beforePush();writes++;return input.headCommit;};
  const request=c.controller.merge(id,{headCommit:HEAD}).then(value=>({value}),error=>({error}));
  await ready;c.controller.revokeSessions({});const revoked=c.store.read();release();
  assert.equal((await request).error.code,'SESSION_REVOKED');assert.equal(writes,0);assert.equal(c.source.branches.get('refs/heads/main'),BASE);
  assert.equal(c.source.tokens.get('short-id').state,'revoked');assert.deepEqual(c.store.read(),revoked);
});

function commit(hash, treeHash, parents = []) {
  return { hash, treeHash, parents, message: "mock", author: { name: "Mock", email: "mock@example.test" }, committer: { name: "Mock", email: "mock@example.test" }, authoredAt: 1, committedAt: 1 };
}

function mockRepo(name = "starter", description = null) {
  return {
    name, description, commits: new Map([[BASE, commit(BASE, BASE_TREE)], [HEAD, commit(HEAD, HEAD_TREE, [BASE])]]),
    trees: new Map([[BASE_TREE, [{ name: "answer.txt", mode: "100644", hash: OLD_BLOB, type: "blob" }]], [HEAD_TREE, [{ name: "answer.txt", mode: "100644", hash: NEW_BLOB, type: "blob" }]]]),
    blobs: new Map([[OLD_BLOB, new Blob(["before\n"])], [NEW_BLOB, new Blob(["after\n"])]]),
    branches: new Map([["refs/heads/main", BASE]]), tokens: new Map(), revoked: [], disposals: 0, tokenCreates: 0,
    [Symbol.dispose]() { this.disposals++; },
    async info() { return { id: this.name, name: this.name, description: this.description, defaultBranch: "main", remote: `https://artifacts.example.test/namespace/${this.name}.git`, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", lastPushAt: null, source: null, readOnly: false }; },
    async readCommit(hash) { return this.commits.get(hash) ?? null; },
    async readTree(hash) { return this.trees.get(hash) ?? null; },
    async readBlob(hash) { return this.blobs.get(hash) ?? null; },
    async log({ ref }) { const hash = this.branches.get('refs/heads/' + ref); return hash ? [this.commits.get(hash)] : []; },
    async createToken(scope, ttl) { this.tokenCreates++; this.lastTTL = ttl; this.tokens.set("short-id", { id: "short-id", state: "active", scope }); return { id: "short-id", plaintext: SHORT_TOKEN, scope, expiresAt: "2026-10-03T00:15:00Z" }; },
    async listTokens() { return { total: this.tokens.size, tokens: [...this.tokens.values()] }; },
    async revokeToken(id) { this.revoked.push(id); for (const [key, value] of this.tokens) if (key === id || value.plaintext === id) value.state = "revoked"; return true; },
  };
}

test('subscription registration failure retains a connected project and idempotent task request',async()=>{
  let calls=0;const runtime={ensureSubscription:async(name,validate)=>{validate();assert.equal(name,'starter');calls++;if(calls===1)throw Error('subscription unavailable');}};
  const c=setup(runtime),input=taskInput();
  await assert.rejects(c.controller.createTasks(input,'subscription-project'),/subscription unavailable/);
  assert.equal(c.store.read().workspace.tasks.length,1);assert.equal(Object.keys(c.store.read().workspace.projects).length,1);
  const result=await c.controller.createTasks(input,'subscription-project');assert.equal(result.replayed,true);
  assert.equal(calls,2);assert.equal(c.store.read().workspace.tasks.length,1);assert.equal(c.forks(),0);
});
test('assignment registration blocks credential issuance, preserves its slot and recovers the same fork',async()=>{
  let fail=true;const names=[];const runtime={ensureSubscription:async(name,validate)=>{
    validate();names.push(name);if(name.startsWith('agent-')&&fail)throw Error('subscription unavailable');
  }};
  const c=setup(runtime),task=await c.controller.createTasks(taskInput(),'subscription-task');
  const input={agentClientId:AGENT_CLIENT,label:'Registered builder'};
  await assert.rejects(c.controller.assign(task.taskId,input,'subscription-assignment'),/subscription unavailable/);
  const pending=c.store.read(),run=pending.workspace.runs[0];assert.equal(run.checkoutState,'preparing');assert.equal(c.controller.workspace().capacity.occupied,1);
  assert.equal(c.forks(),1);const repo=[...c.repositories.values()].find(value=>value!==c.source);
  assert.equal(repo.tokenCreates,0);assert.equal([...repo.tokens.values()].filter(token=>token.state==='active').length,0);
  fail=false;const result=await new HostedController(c.store,c.artifacts,testAuthority(),runtime).assign(task.taskId,input,'subscription-assignment');
  assert.equal(result.runId,run.id);assert.equal(c.forks(),1);assert.equal(repo.tokenCreates,1);assert.ok(result.credentials);
  assert.equal(new Set(names.filter(name=>name.startsWith('agent-'))).size,1);
});
test('foreign agent cannot use project creation to trigger registration',async()=>{
  let calls=0;const runtime={ensureSubscription:async()=>{calls++;}};const c=setup(runtime);
  const agent=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT),runtime),before=c.store.read();
  await assert.rejects(agent.createTasks(taskInput(),'forged-project-registration'),{code:'OWNER_REQUIRED'});
  assert.equal(calls,0);assert.deepEqual(c.store.read(),before);
});

function setup(runtime, workspaceId = 'mock-workspace') {
  if (runtime && !runtime.cancelVerification) runtime.cancelVerification = async () => {};
  let snapshot = initialSnapshot(workspaceId);
  const receipts = [];
  const waiters = new Set();
  const store = {
    identity: () => ({...snapshot.workspace,revision:snapshot.revision,empty:!snapshot.workspace.tasks.length&&!snapshot.workspace.runs.length&&!Object.keys(snapshot.operations).length}),
    read: () => structuredClone(snapshot),
    operation: key => structuredClone(snapshot.operations[key]),
    project: id => structuredClone(snapshot.workspace.projects?.[id]),
    readPage: request => snapshotPage(snapshot,request),
    waitForChange: (revision,signal) => {
      signal.throwIfAborted();if(snapshot.revision!==revision)return Promise.resolve();
      return new Promise((resolve,reject)=>{const done=()=>{waiters.delete(done);signal.removeEventListener('abort',abort);resolve();};const abort=()=>{waiters.delete(done);reject(signal.reason);};waiters.add(done);signal.addEventListener('abort',abort,{once:true});});
    },
    write: (value, revision) => {
      assert.equal(snapshot.revision, revision, "optimistic revision must match");
      snapshot = structuredClone(value);
      receipts.push(JSON.stringify(snapshot));
      for(const waiter of [...waiters])waiter();
    },
  };
  const source = mockRepo();
  const repositories = new Map([["starter", source]]);
  let forks = 0;
  const artifacts = {
    async get(name) {
      const repo = repositories.get(name);
      if (!repo) throw Object.assign(new Error("Missing mock repository"), { code: "NOT_FOUND" });
      return repo;
    },
  };
  source.fork = async (name, options) => {
    forks++;
    if (repositories.has(name)) throw Object.assign(new Error("Duplicate"), { code: "ALREADY_EXISTS" });
    const repo = mockRepo(name, options.description);
    repo.commits = new Map(source.commits);
    repo.trees = new Map(structuredClone([...source.trees]));
    repo.blobs = new Map(source.blobs);
    repo.branches = new Map(source.branches);
    repo.tokens.set("initial-id", { id: "initial-id", plaintext: LONG_TOKEN, state: "active", scope: "write" });
    repositories.set(name, repo);
    return { ...(await repo.info()), token: LONG_TOKEN };
  };
  return { controller: new HostedController(store, artifacts, testAuthority(workspaceId), runtime), store, source, repositories, receipts, artifacts, forks: () => forks };
}

for (const kind of ['assignment', 'resolution']) test(`superseded ${kind} token cleanup preserves its successor's delivered credential`, {timeout:5000}, async () => {
  const c = kind === 'assignment' ? setup() : await commandContext();
  const task = kind === 'assignment' ? await c.controller.createTasks(taskInput(), 'cleanup-race-task') : c.task;
  if (kind === 'resolution') advanceMain(c);
  const key = 'cleanup-race-' + kind;
  const start = () => kind === 'assignment'
    ? c.controller.assign(task.taskId, {agentClientId:AGENT_CLIENT,label:'Cleanup race'}, key)
    : c.controller.updateBase(c.assignment.runId, {headCommit:HEAD,taskRevision:1,mode:'resolve',agentClientId:AGENT_CLIENT}, key);
  let entered, release, fork, calls = 0;
  const listed = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = c.source.fork;
  c.source.fork = async (...args) => {
    const result = await original(...args); fork = c.repositories.get(args[0]);
    const list = fork.listTokens.bind(fork);
    fork.listTokens = async () => { if (++calls === 1) { entered(); await gate; } return list(); };
    return result;
  };
  const old = start().then(value => ({value}), error => ({error}));
  await listed;
  const snapshot = c.store.read();
  const operation = Object.values(snapshot.operations).find(op => op.kind === (kind === 'assignment' ? 'assign' : 'base-update') && op.state === 'pending');
  operation.leaseUntil = 0;
  c.store.write({...snapshot,revision:snapshot.revision+1}, snapshot.revision);
  const successor = await start();
  assert.equal(successor.credentialStatus, 'issued-once');
  assert.equal(fork.tokens.get('short-id').state, 'active');
  const settled = c.store.read();
  release();
  assert.equal((await old).error.code, 'STALE_OPERATION');
  assert.equal(fork.tokens.get('short-id').state, 'active', 'Late cleanup must not revoke the delivered successor credential');
  assert.deepEqual(c.store.read(), settled, 'Late attempt must not mutate completed recovery');
  assert.equal(fork.tokenCreates, 1);
  assert.equal((await start()).credentials, null);
});

test('Artifacts branch checks resolve names with slashes and refuse stale or missing heads', async () => {
  const repo = mockRepo();
  repo.branches.set('refs/heads/agents/qualification', HEAD);
  await branchHead(repo, 'agents/qualification', HEAD);
  await assert.rejects(branchHead(repo, 'agents/qualification', BASE), { code: 'STALE_HEAD' });
  await assert.rejects(branchHead(repo, 'agents/missing', HEAD), { code: 'STALE_HEAD' });
});

function executable() {
  let context, calls = 0, pushes = 0, loseAcknowledgement = false;
  const retained = new Map();
  const source = 'export function checkoutTotal(items) { return 42; }';
  const evidence = (commit, passed = true) => ({ verified: true, source: 'independent-sandbox-checks', commit,
    checks: Array.from({ length: 16 }, (_, index) => ({ name: `Behavior ${index}`, passed, detail: 'Independent verifier fixture' })),
    passed: passed ? 16 : 0, total: 16, command: 'isolated verifier fixture', exitCode: passed ? 0 : 1, output: 'Fixture verification', verifiedAt: new Date().toISOString() });
  const runtime = { cancelVerification: async () => {}, modelName: 'test-model', repository: 'starter',
    provider: async () => { calls++; return { content: JSON.stringify({ files: [{ path: 'checkout.mjs', content: source }], summary: 'Model transport fixture' }), finishReason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }; },
    checks: { verify: async (content, commit) => evidence(commit, content === source) },
    saveReceipt: async (id, receipt) => { retained.set(id, structuredClone(receipt)); },
    git: {
      commitCandidate: async input => {
        assert.ok(retained.get(input.context.runId));
        await input.beforePush(HEAD);
        const fork = [...context.repositories.values()].find(repo => input.remote.endsWith(`/${repo.name}.git`));
        fork.blobs.set(NEW_BLOB, new Blob([input.files[0].content]));
        fork.branches.set('refs/heads/' + input.branch, HEAD);
        return HEAD;
      },
      merge: async input => {
        pushes++; await input.beforePush();
        assert.equal(context.source.branches.get('refs/heads/main'), input.baseCommit);
        context.source.branches.set('refs/heads/main', input.headCommit);
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Transport ended after remote update'); }
        return input.headCommit;
      },
    },
  };
  context = setup(runtime);
  context.source.trees.set(BASE_TREE, [{ name: 'checkout.mjs', mode: '100644', hash: OLD_BLOB, type: 'blob' }]);
  context.source.trees.set(HEAD_TREE, [{ name: 'checkout.mjs', mode: '100644', hash: NEW_BLOB, type: 'blob' }]);
  context.source.blobs.set(OLD_BLOB, new Blob(['export const checkoutTotal = () => 0;']));
  return { ...context, runtime, retained, calls: () => calls, pushes: () => pushes, loseAcknowledgement: () => { loseAcknowledgement = true; } };
}
const modelInput = () => ({ candidates: 2, limits: { maxRequests: 1, maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 5000 } });

test('four model executors share two verification reservations and retain waiting work', {timeout:5000}, async()=>{
  const c=executable();await c.controller.queueModels({...modelInput(),candidates:4},'model-verification-capacity');
  const original=c.runtime.checks.verify;let release,active=0,peak=0;const gate=new Promise(resolve=>release=resolve);
  c.runtime.checks.verify=async(...args)=>{active++;peak=Math.max(peak,active);try{await gate;return await original(...args);}finally{active--;}};
  const drain=c.controller.drainJobs(),signal=AbortSignal.timeout(4000);
  while(c.controller.workspace().capacity.verification.waiting<2){const state=c.store.read();await c.store.waitForChange(state.revision,signal);}
  assert.equal(active,2);assert.equal(c.controller.workspace().capacity.running,4);
  assert.deepEqual(c.controller.workspace().capacity.verification,{limit:2,occupied:2,waiting:2});
  release();await drain;assert.equal(peak,2);assert.equal(active,0);
  assert.equal(c.controller.workspace().runs.filter(run=>run.status==='awaiting_review').length,4);
  const checks=Object.values(c.store.read().operations).filter(op=>op.kind==='model-check');
  assert.equal(checks.length,8);assert.ok(checks.every(op=>op.state==='complete'&&op.report));
});

test('external reservations and queued models share four execution slots', {timeout:5000}, async()=>{
  const c=executable(),task=await c.controller.createTasks(taskInput(),'mixed-external-task');
  await c.controller.assign(task.taskId,{agentClientId:AGENT_CLIENT,label:'External one'},'mixed-external-one');
  await c.controller.assign(task.taskId,{agentClientId:AGENT_CLIENT,label:'External two'},'mixed-external-two');
  await c.controller.queueModels({...modelInput(),candidates:4},'mixed-models');
  const provider=c.runtime.provider;let release;const gate=new Promise(resolve=>release=resolve);
  c.runtime.provider=async(...args)=>{await gate;return provider(...args);};
  const drain=c.controller.drainJobs(),state=c.controller.workspace();
  assert.deepEqual([state.capacity.reserved,state.capacity.running,state.capacity.occupied,state.capacity.queued],[2,2,4,2]);
  await assert.rejects(c.controller.assign(task.taskId,{agentClientId:AGENT_CLIENT,label:'Extra'},'mixed-extra'),{code:'CAPACITY_FULL'});
  release();await drain;assert.equal(c.controller.workspace().capacity.queued,2);assert.equal(c.calls(),2);
});

test('recovery fences delayed model checks before releasing their two slots and never restarts inference', {timeout:5000}, async()=>{
  const c=executable();await c.controller.queueModels({...modelInput(),candidates:4},'recover-model-checks');
  const original=c.runtime.checks.verify,entries=[];let active=0;
  c.runtime.checks.verify=async(...args)=>{active++;try{await new Promise(resolve=>entries.push({attempt:args[3],release:resolve}));return await original(...args);}finally{active--;}};
  const oldDrain=c.controller.drainJobs(),signal=AbortSignal.timeout(4000);
  while(c.controller.workspace().capacity.verification.waiting<2){const state=c.store.read();await c.store.waitForChange(state.revision,signal);}
  let releaseStop,entered;const stopping=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>releaseStop=resolve);
  c.runtime.cancelVerification=async attempt=>{entered();await gate;entries.find(entry=>entry.attempt===attempt).release();};
  const recovery=new HostedController(c.store,c.artifacts,testAuthority(),c.runtime).drainJobs();await stopping;
  assert.equal(active,2);assert.equal(c.controller.workspace().capacity.verification.occupied,2);
  releaseStop();await recovery;await oldDrain;
  const retained=c.store.read();assert.equal(c.calls(),4);assert.equal(entries.length,2);assert.equal(active,0);
  assert.ok(Object.values(retained.jobs).every(job=>job.status==='failed'&&job.phase==='interrupted'));
  assert.ok(Object.values(retained.operations).filter(op=>op.kind==='model-check').every(op=>op.state==='failed'&&op.errorCode==='MODEL_INTERRUPTED'&&!op.report));
  await new HostedController(c.store,c.artifacts,testAuthority(),c.runtime).drainJobs();assert.deepEqual(c.store.read(),retained);
});

test('resolution preparation reserves capacity before provider work and binds the chosen agent', {timeout:5000}, async()=>{
  const c=await commandContext(),id=c.assignment.runId;advanceMain(c);
  const batch=await c.controller.createTasks({source:'project',projectId:c.task.projectId,tasks:Array.from({length:3},taskBrief)},'resolution-competitors');
  const original=c.source.fork;let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  c.source.fork=async(...args)=>{if(args[0].startsWith('update-')){entered();await gate;}return original(...args);};
  const input={headCommit:HEAD,taskRevision:1,mode:'resolve',agentClientId:AGENT_CLIENT};
  const resolve=c.controller.updateBase(id,input,'held-resolution');await started;
  assert.equal(c.controller.workspace().capacity.reserved,1);
  for(const [index,taskId] of batch.taskIds.entries())await c.controller.assign(taskId,{agentClientId:AGENT_CLIENT,label:'Competing '+index},'resolution-competitor-'+index);
  assert.equal(c.controller.workspace().capacity.occupied,4);
  await assert.rejects(c.controller.assign(batch.taskIds[0],{agentClientId:AGENT_CLIENT,label:'Overflow'},'resolution-overflow'),{code:'CAPACITY_FULL'});
  release();const result=await resolve;assert.equal(c.controller.workspace().capacity.occupied,4);
  assert.equal(c.controller.workspace().runs.find(run=>run.id===result.runId).agentIdentity.id,AGENT_CLIENT);
  const actor=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT),c.runtime);actor.start(result.runId);
});

test('hosted task handoff is read-only and excludes fork credentials and coordinator state', async () => {
  const context = setup();
  const { task, fork } = await assigned(context);
  const before = context.store.read();
  const tokenCreates = fork.tokenCreates;
  const handoff = await context.controller.handoff(task.taskId);
  const serialized = JSON.stringify(handoff);
  await readTaskHandoff(serialized);
  assert.ok(!serialized.includes(SHORT_TOKEN) && !serialized.includes(LONG_TOKEN));
  assert.equal(handoff.payload.nextAction.kind, 'wait');
  assert.equal(fork.tokenCreates, tokenCreates);
  assert.deepEqual(context.store.read(), before);
  await assert.rejects(context.controller.handoff('missing'), { code: 'task_not_found', status: 404 });
});

test('hosted queue consumes each finite model allowance once and retains independent exact-head evidence', async () => {
  const c = executable();
  const first = await c.controller.queueModels(modelInput(), 'model-operation-one');
  const replay = await c.controller.queueModels(modelInput(), 'model-operation-one');
  assert.equal(replay.taskId, first.taskId);
  assert.equal(c.forks(), 2);
  assert.equal(c.calls(), 0);
  await c.controller.drainJobs();
  await c.controller.drainJobs();
  assert.equal(c.calls(), 2);
  const state = c.controller.workspace();
  assert.equal(state.runs.length, 2);
  for (const run of state.runs) {
    assert.equal(run.status, 'awaiting_review');
    assert.equal(run.evidence.verified, true);
    assert.equal(run.evidence.taskRevision, 1);
    assert.equal(run.evidence.commit, HEAD);
    assert.equal(run.execution.requests.length, 1);
    assert.equal(c.retained.get(run.id).status, 'finished');
  }
  assert.ok(c.receipts.every(receipt => !receipt.includes(SHORT_TOKEN) && !receipt.includes(LONG_TOKEN)));
});

test('queue retry retains its original base after partial preparation and source drift', async () => {
  const c = executable();
  const fork = c.source.fork;
  let attempts = 0;
  c.source.fork = async (...args) => { attempts++; if (attempts === 2) throw new Error('Temporary fork refusal'); return fork(...args); };
  await assert.rejects(c.controller.queueModels(modelInput(), 'partial-queue-one'));
  c.source.branches.set('refs/heads/main', HEAD);
  await c.controller.queueModels(modelInput(), 'partial-queue-one');
  const state = c.controller.workspace();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].baseCommit, BASE);
  assert.equal(state.runs.length, 2);
  assert.equal(c.calls(), 0);
});

test('queued model jobs use four shared slots, preserve waiting assignments and never repeat an allowance', async () => {
  const c = executable();
  await c.controller.queueModels({ ...modelInput(), candidates: 4 }, 'capacity-first-four');
  await c.controller.queueModels({ ...modelInput(), candidates: 4 }, 'capacity-next-four');
  assert.deepEqual(c.controller.workspace().capacity, { limit: 4, running: 0, reserved: 0, occupied: 0, queued: 8, verification: {limit:2,occupied:0,waiting:0} });
  assert.equal(c.calls(), 0);
  await c.controller.drainJobs();
  assert.equal(c.calls(), 4);
  assert.deepEqual(c.controller.workspace().capacity, { limit: 4, running: 0, reserved: 0, occupied: 0, queued: 4, verification: {limit:2,occupied:0,waiting:0} });
  const first = c.controller.workspace().runs[0];
  await assert.rejects(c.controller.review(first.id, { decision: 'accept', ownerVersion: 1, headCommit: HEAD, note: 'Too early' }), { code: 'work_in_progress' });
  await c.controller.drainJobs();
  await c.controller.drainJobs();
  assert.equal(c.calls(), 8);
  assert.equal(c.controller.workspace().runs.length, 8);
  assert.ok(c.receipts.every(text => JSON.parse(text).workspace.runs.filter(run => run.status === 'running').length <= 4));
});

test('changed queued requirements fail before inference and external assignments respect the shared cap', async () => {
  const c = executable();
  const { taskId } = await c.controller.queueModels(modelInput(), 'stale-queue-test');
  c.controller.revise(taskId, { expectedRevision: 1, purpose: 'Changed before execution', criteria: ['Current criterion'], reason: 'Stop obsolete queued intent' });
  await c.controller.drainJobs();
  assert.equal(c.calls(), 0);
  assert.ok(c.controller.workspace().runs.every(run => run.status === 'failed'));
  const context = setup();
  const task = await context.controller.createTasks(taskInput(), 'external-capacity-task');
  for (let i = 0; i < 4; i++) await context.controller.assign(task.taskId, { agent: `agent-${i}`, agentClientId: AGENT_CLIENT, label: `Worker ${i}` }, `external-capacity-${i}`);
  const forks = context.forks();
  await assert.rejects(context.controller.assign(task.taskId, { agent: 'extra', agentClientId: AGENT_CLIENT, label: 'Extra' }, 'external-capacity-extra'), { code: 'CAPACITY_FULL' });
  assert.equal(context.forks(), forks);
  assert.equal(context.controller.workspace().capacity.reserved, 4);
  assert.equal(context.controller.workspace().capacity.running, 0);
});

test('hosted requirement revision reuses retained commits but demands current proof and human review', async () => {
  const c = executable();
  const { taskId } = await c.controller.queueModels(modelInput(), 'revision-model-one');
  await c.controller.drainJobs();
  const run = c.controller.workspace().runs[0];
  await acceptAfterIndependentReview(c, run.id, { decision: 'accept', ownerVersion: 1, comparisons: c.controller.workspace().coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), note: 'Reviewed revision 1', headCommit: HEAD, taskRevision: 1 });
  c.controller.revise(taskId, { expectedRevision: 1, purpose: 'Updated owner intent', criteria: ['Current checkout criterion'], reason: 'Requirement changed' });
  await assert.rejects(c.controller.merge(run.id, { headCommit: HEAD }), { code: 'acceptance_required' });
  await assert.rejects(c.controller.review(run.id, { decision: 'accept', ownerVersion: 1, comparisons: c.controller.workspace().coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), note: 'Current review', headCommit: HEAD, taskRevision: 2 }), { code: 'stale_evidence' });
  await c.controller.verify(run.id, { headCommit: HEAD, taskRevision: 2 }, 'revision-verify');
  await acceptAfterIndependentReview(c, run.id, { decision: 'accept', ownerVersion: 1, comparisons: c.controller.workspace().coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), note: 'Reviewed current intent and proof', headCommit: HEAD, taskRevision: 2 });
  const acceptedEvidence = structuredClone(c.controller.workspace().runs[0].evidence);
  await c.controller.merge(run.id, { headCommit: HEAD });
  assert.equal(c.calls(), 2);
  assert.equal(c.pushes(), 1);
  assert.equal(c.controller.workspace().tasks[0].status, 'merged');
  assert.equal(c.controller.workspace().runs[0].evidenceHistory.length, 2);
  assert.deepEqual(c.controller.workspace().runs[0].evidence, acceptedEvidence);
  assert.equal(c.controller.workspace().runs[0].evidenceHistory.at(-1).operation, 'merge');
  assert.ok(c.controller.workspace().runs[0].evidenceHistory.at(-1).attemptId);
});

test('interrupted checkout verification retains all sixteen declared checks', async () => {
  const c = executable();
  await c.controller.queueModels(modelInput(), 'fixed-contract-interruption'); await c.controller.drainJobs();
  const run = c.controller.workspace().runs[0];
  c.runtime.checks.verify = async () => { throw new Error('Runtime not available'); };
  await c.controller.verify(run.id, { headCommit: HEAD, taskRevision: 1 }, 'fixed-contract-recheck');
  const report = c.controller.workspace().runs[0].evidence;
  assert.equal(report.verified, false); assert.equal(report.passed, 0); assert.equal(report.total, 16);
});

test('lost merge acknowledgement locks revisions until exact remote-head reconciliation without another push', async () => {
  const c = executable();
  const { taskId } = await c.controller.queueModels(modelInput(), 'merge-recovery-one');
  await c.controller.drainJobs();
  const run = c.controller.workspace().runs[0];
  await acceptAfterIndependentReview(c, run.id, { decision: 'accept', ownerVersion: 1, comparisons: c.controller.workspace().coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), note: 'Reviewed', headCommit: HEAD, taskRevision: 1 });
  c.loseAcknowledgement();
  await assert.rejects(c.controller.merge(run.id, { headCommit: HEAD }));
  const interrupted = c.controller.workspace();
  assert.equal(interrupted.mergeStateByRun[run.id], 'recovery-required');
  assert.deepEqual(interrupted.recovery, { pendingMergeIntents: 1, activeMergeIntents: 0, recoveryRequiredMergeIntents: 1 });
  const retainedReports = interrupted.runs[0].evidenceHistory.length;
  assert.throws(() => c.controller.revise(taskId, { expectedRevision: 1, purpose: 'changed', criteria: ['changed'], reason: 'changed' }), { code: 'MERGE_PENDING' });
  const projectId = c.controller.workspace().tasks[0].projectId;
  await c.controller.createTasks({ source: 'project', projectId, tasks: [taskBrief()] }, 'queued-during-merge-recovery');
  await assert.rejects(c.controller.claim(projectId, { agentClientId: AGENT_CLIENT, label: 'Wait for merge recovery' }, 'claim-during-merge-recovery'), { code: 'MERGE_PENDING' });
  await c.controller.merge(run.id, { headCommit: HEAD });
  assert.equal(c.pushes(), 1);
  assert.equal(c.controller.workspace().runs[0].evidenceHistory.length, retainedReports, 'exact-head replay does not duplicate merge proof');
  assert.deepEqual(c.controller.workspace().mergeStateByRun, {});
  assert.equal(c.controller.workspace().tasks[0].mergedCommit, HEAD);
  assert.equal(c.controller.workspace().projects[projectId].mainCommit, HEAD);
  assert.equal((await c.controller.claim(projectId, { agentClientId: AGENT_CLIENT, label: 'After recovery' }, 'claim-after-merge-recovery')).credentials.baseCommit, HEAD);
});

test('merge revokes its target credential when candidate token creation fails', async () => {
  const c = executable();
  await c.controller.queueModels({ ...modelInput(), candidates: 1 }, 'token-cleanup-model-one');
  await c.controller.drainJobs();
  const run = c.controller.workspace().runs[0];
  await acceptAfterIndependentReview(c, run.id, { decision: 'accept', ownerVersion: 1, comparisons: c.controller.workspace().coordination[run.id].overlaps.map(({runId,headCommit}) => ({runId,headCommit})), note: 'Reviewed', headCommit: HEAD, taskRevision: 1 });
  const fork = c.repositories.get(c.store.read().forks[run.id].name);
  fork.createToken = async () => { throw new Error('Token creation refused'); };
  const prior = c.source.revoked.length;
  await assert.rejects(c.controller.merge(run.id, { headCommit: HEAD }));
  assert.equal(c.source.revoked.length, prior + 1);
  assert.equal(c.source.tokens.get('short-id').state, 'revoked');
  assert.equal(c.pushes(), 0);
});

test('interrupted hosted alarm never repeats an already admitted model attempt', async () => {
  const c = executable();
  await c.controller.queueModels({ ...modelInput(), candidates: 1 }, 'interrupted-model-one');
  const snapshot = c.store.read();
  const id = snapshot.workspace.runs[0].id;
  snapshot.jobs[id].status = 'running';
  c.store.write({ ...snapshot, revision: snapshot.revision + 1 }, snapshot.revision);
  await c.controller.drainJobs();
  assert.equal(c.calls(), 0);
  assert.equal(c.controller.workspace().runs[0].status, 'failed');
  assert.equal(c.store.read().jobs[id].phase, 'interrupted');
});

const taskBrief = () => ({ title: 'Build an answer', purpose: 'Two candidates from one pinned base', criteria: ['Answer is correct'], owner: 'QA coordinator' });
const taskInput = () => ({ source: 'repository', projectName: 'QA project', repo: 'starter', baseCommit: BASE, tasks: [taskBrief()] });
const report = () => ({ verified: true, source: "independent-local-checks", commit: HEAD, checks: [{ name: "reported test", passed: true, detail: "Agent says it passed" }], passed: 1, total: 1, command: "node --test", exitCode: 0, output: "1 passed" });
async function assigned(context, key = "assignment-one") {
  const task = await context.controller.createTasks(taskInput(), "task-request-one");
  const assignment = await context.controller.assign(task.taskId, { agent: "agent-a", agentClientId: AGENT_CLIENT, label: "Agent A" }, key);
  context.controller.start(assignment.runId);
  const resource = context.store.read().forks[assignment.runId];
  const fork = context.repositories.get(resource.name);
  fork.branches.set("refs/heads/" + assignment.credentials.branch, HEAD);
  return { task, assignment, fork };
}

test('old assignment receipts beyond 500 remain principal-bound and never issue credentials twice',async()=>{
  const c=setup(),seed=c.store.read();
  for(let i=0;i<700;i++)seed.operations['older-'+i]={kind:'checks',fingerprint:'retained-'+i,state:i%2?'complete':'failed'};
  seed.revision++;c.store.write(seed,seed.revision-1);
  const {task,assignment}=await assigned(c,'long-lived-assignment');
  const restarted=new HostedController(c.store,c.artifacts,testAuthority());
  const replay=await restarted.assign(task.taskId,{agent:'agent-a',agentClientId:AGENT_CLIENT,label:'Agent A'},'long-lived-assignment');
  assert.equal(replay.runId,assignment.runId);assert.equal(replay.replayed,true);assert.ok(!replay.credentials);assert.equal(c.forks(),1);
  await assert.rejects(restarted.assign(task.taskId,{agent:'agent-a',agentClientId:AGENT_CLIENT,label:'Changed'},'long-lived-assignment'),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(Object.keys(c.store.read().operations).length,702);assert.equal(c.forks(),1);
});

async function commandContext() {
  const c = executable();
  const blob = createHash('sha1').update('blob 6\0after\n').digest('hex');
  c.source.trees.set(HEAD_TREE, [{ name: 'answer.txt', type: 'blob', mode: '100644', hash: blob }]);
  c.source.blobs.set(blob, new Blob(['after\n']));
  const { task, assignment, fork } = await assigned(c);
  await c.controller.complete(assignment.runId, { headCommit: HEAD, summary: 'Ordinary project change' });
  let checks = 0;
  c.runtime.repositoryChecks = { observe: async (_attempt, _index, files, argv, stdin) => {
    checks++; assert.equal(files[0].name, 'answer.txt'); assert.deepEqual(argv, ['cat', 'answer.txt']); assert.equal(stdin, '');
    return { stdout: 'after\n', exitCode: 0, image: 'sha256:' + 'a'.repeat(64) };
  } };
  const plan = (runId = assignment.runId, stdout = 'after\n') => {
    const state = c.controller.workspace(), run = state.runs.find(run => run.id === runId), currentTask = state.tasks.find(task => task.id === run.taskId);
    const definition = JSON.stringify({ format: 'repository-command-checks/v1', commit: run.headCommit, taskRevision: currentTask.revision, requirementsSha256: requirementsDigest(currentTask), timeoutMs: 5000,
      checks: [{ name: 'Read answer', argv: ['cat', 'answer.txt'], stdin: '', expected: { exitCode: 0, stdout } }] });
    return { definition, definitionSha256: checkDigest(definition) };
  };
  const review = (runId = assignment.runId) => {
    const state = c.controller.workspace(), run = state.runs.find(run => run.id === runId), current = state.tasks.find(task => task.id === run.taskId);
    return { decision: 'accept', note: 'Checked intended behavior and diff', headCommit: run.headCommit, taskRevision: current.revision, ownerVersion: current.ownerVersion, comparisons: state.coordination[runId].overlaps.map(({ runId, headCommit }) => ({ runId, headCommit })) };
  };
  return { ...c, task, assignment, fork, plan, review, checks: () => checks };
}

async function automaticContext() {
  const c = await commandContext(), id = c.assignment.runId;
  c.runtime.currentPolicy=async()=>testAuthority().policy;
  await c.controller.configureChecks(id, c.plan(), 'automatic-checks');
  await assignTestReview(c, id);
  const reviewer = new HostedController(c.store, c.artifacts, testReviewerAuthority(), c.runtime);
  await reviewer.codeReview(id, reviewInput(codeReviewContext(c.store.read().workspace, id).contextId), 'automatic-review');
  const system = () => new HostedController(c.store, c.artifacts, systemAuthority(testAuthority().policy), c.runtime);
  const toggle = enabled => c.controller.automaticMergePolicy(c.task.projectId, { enabled,
    expectedVersion: c.store.read().workspace.projects[c.task.projectId].automaticMergePolicy?.version ?? 0 });
  return { ...c, id, system, toggle };
}

test('automatic approval defaults off, requires a real owner and rejects forged policy context', async () => {
  const c = await automaticContext(), before = c.store.read();
  assert.equal(c.system().hasAutomaticMergeWork(), false);
  await c.system().drainAutomaticMerges(); assert.deepEqual(c.store.read(), before);
  for (const authority of [testAuthority('mock-workspace', AGENT_CLIENT), testReviewerAuthority(), systemAuthority(testAuthority().policy)]) {
    const caller = new HostedController(c.store, c.artifacts, authority, c.runtime);
    assert.throws(() => caller.automaticMergePolicy(c.task.projectId, { enabled: true, expectedVersion: 0 }), { code: 'OWNER_REQUIRED' });
    if (authority.principal.kind !== 'system') assert.throws(() => authorizeRoute(authority.principal, 'POST', '/api/projects/' + c.task.projectId + '/automatic-merge'));
  }
  await assert.rejects(c.controller.drainAutomaticMerges(), { code: 'ALARM_REQUIRED' });
  assert.throws(() => c.controller.automaticMergePolicy(crypto.randomUUID(), { enabled: true, expectedVersion: 0 }), { code: 'project_not_found' });
  assert.throws(() => c.controller.automaticMergePolicy(c.task.projectId, { enabled: true, expectedVersion: 0, enabledBy: {} }), { code: 'stale_automatic_merge_policy' });
  await assert.rejects(c.controller.review(c.id, { ...c.review(), policy: { enabled: true } }), { code: 'IDENTITY_FORGED' });
  assert.deepEqual(c.store.read(), before); assert.equal(c.pushes(), 0);
});

test('the private alarm approves and merges once with policy attribution and fresh checks', async () => {
  const c = await automaticContext(); c.toggle(true);
  await c.system().drainAutomaticMerges();
  const state = c.store.read(), run = state.workspace.runs[0];
  assert.equal(run.status, 'merged'); assert.equal(c.pushes(), 1); assert.equal(c.checks(), 2);
  assert.equal(run.review.identity, undefined); assert.equal(run.review.reviewer, 'Automatic merge policy');
  assert.equal(run.review.policy.enabledBy.kind, 'owner'); assert.equal(run.review.policy.enabledBy.issuedAt, undefined);
  assert.equal(run.review.policy.version, 1); assert.equal(run.review.codeReviewId, run.codeReview.id);
  await c.system().drainAutomaticMerges(); assert.equal(c.pushes(), 1); assert.deepEqual(c.store.read(), state);
  assert.equal(c.source.branches.get('refs/heads/main'), HEAD);
  const handoff = (await c.controller.handoff(c.task.taskId)).payload;
  assert.equal(handoff.runs[0].review.policy.decisionId, run.review.policy.decisionId);
  assert.equal(handoff.runs[0].review.identity, undefined);
});

test('automatic approval will not choose alternatives or consume either of two occupied verifier slots', async () => {
  const c = await automaticContext(); c.toggle(true);
  const saved = c.store.read();
  for (const alter of [
    s => s.workspace.runs.push({ ...structuredClone(s.workspace.runs[0]), id: crypto.randomUUID() }),
    s => { s.operations.one = { kind: 'checks', state: 'pending' }; s.operations.two = { kind: 'checks', state: 'pending' }; },
    s => { s.workspace.runs[0].evidence.passed = 0; },
    s => { s.workspace.tasks[0].revision++; },
    s => { s.workspace.runs[0].codeReview.verdict = 'changes_requested'; },
    s => { s.workspace.projects[c.task.projectId].mainCommit = OTHER; },
    s => { s.workspace.runs[0].repositoryObservation = { requiresSubmission: true }; },
  ]) {
    const state = structuredClone(saved); alter(state); c.store.write(state, c.store.read().revision);
    assert.equal(c.system().hasAutomaticMergeWork(), false); await c.system().drainAutomaticMerges();
    assert.equal(c.pushes(), 0); assert.deepEqual(c.store.read(), state);
  }
});

test('policy authorization cannot outlive the current owner or reviewer allowlist', async () => {
  const c = await automaticContext(); c.toggle(true);
  const authority = testAuthority(); authority.policy.reviewerClientIds = [];
  c.runtime.currentPolicy=async()=>structuredClone(authority.policy);
  const controller = new HostedController(c.store, c.artifacts, systemAuthority(authority.policy), c.runtime);
  assert.equal(controller.hasAutomaticMergeWork(), false); await controller.drainAutomaticMerges();
  const changedOwner = testAuthority(); changedOwner.policy.ownerSubject = 'replacement-owner';
  assert.throws(() => new HostedController(c.store, c.artifacts, systemAuthority(changedOwner.policy), c.runtime), { code: 'WORKSPACE_OWNER_MISMATCH' });
  assert.equal(c.pushes(), 0);
});

for (const change of ['disable', 'replace policy', 'revoke sessions']) test(`automatic merge stops before Git push when the owner chooses ${change}`, async () => {
  const c = await automaticContext(); c.toggle(true);
  let entered, release, writes = 0;
  const reached = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  c.runtime.git.merge = async input => { entered(); await gate; await input.beforePush(); writes++; };
  const work = c.system().drainAutomaticMerges(); await reached;
  if (change === 'revoke sessions') c.controller.revokeSessions({});
  else { c.toggle(false); if (change === 'replace policy') c.toggle(true); }
  release(); await work;
  const run = c.store.read().workspace.runs[0];
  assert.equal(writes, 0); assert.equal(run.status, 'accepted'); assert.equal(run.automaticMergeStop.code, 'AUTOMATIC_POLICY_CHANGED');
  assert.ok([...c.source.tokens.values(), ...c.fork.tokens.values()].every(token => token.state === 'revoked'));
  await c.system().drainAutomaticMerges(); assert.equal(writes, 0);
});

test('a failed automatic attempt is retained without an automatic retry and the owner can supersede its decision', async () => {
  const c = await automaticContext(); c.toggle(true);
  c.runtime.repositoryChecks.observe = async () => ({ stdout: 'failure\n', exitCode: 1, image: 'sha256:' + 'a'.repeat(64) });
  await c.system().drainAutomaticMerges();
  const state = c.store.read(), run = state.workspace.runs[0];
  assert.equal(run.status, 'awaiting_review'); assert.equal(run.evidenceHistory.at(-1).passed, 0);
  assert.equal(run.reviewHistory[0].policy.version, 1); assert.equal(run.automaticMergeStop.code, 'CHECKS_FAILED');
  await c.system().drainAutomaticMerges(); assert.deepEqual(c.store.read(), state); assert.equal(c.pushes(), 0);
});

test('restart between automatic acceptance and merge can continue, but a reserved or uncertain write cannot replay', async () => {
  const c = await automaticContext(); c.toggle(true);
  const state = c.store.read(); approveRunByPolicy(state.workspace, c.id); c.store.write(state, state.revision);
  assert.equal(c.system().hasAutomaticMergeWork(), true);
  c.loseAcknowledgement(); await c.system().drainAutomaticMerges();
  const uncertain = c.store.read(); assert.equal(c.pushes(), 1); assert.equal(uncertain.workspace.runs[0].status, 'accepted');
  await c.system().drainAutomaticMerges(); assert.deepEqual(c.store.read(), uncertain); assert.equal(c.pushes(), 1);
  c.toggle(false);
  await c.controller.merge(c.id, { headCommit: HEAD });
  assert.equal(c.store.read().workspace.runs[0].status, 'merged'); assert.equal(c.pushes(), 1); assert.equal(c.checks(), 2);
});

test('a disabled policy decision can be replaced by explicit owner review without relabeling the policy record', async () => {
  const c = await automaticContext(); c.toggle(true);
  const state = c.store.read(); approveRunByPolicy(state.workspace, c.id); c.store.write(state, state.revision);
  c.toggle(false); await c.controller.review(c.id, c.review());
  const run = c.store.read().workspace.runs[0];
  assert.equal(run.review.identity.kind, 'owner'); assert.equal(run.review.policy, undefined); assert.equal(run.reviewHistory[0].policy.version, 1);
  assert.equal(run.reviewHistory[0].identity, undefined);
  await c.controller.merge(c.id, { headCommit: HEAD }); assert.equal(c.pushes(), 1);
});

test('failed automatic operation and its stop receipt survive the first durable failure write together', async () => {
  const c = await automaticContext(); c.toggle(true);
  c.source.createToken = async () => { throw Error('Controlled token creation failure before push'); };
  let firstFailure;
  const write = c.store.write;
  c.store.write = (snapshot, revision) => {
    write(snapshot, revision);
    if (!firstFailure && Object.values(snapshot.operations).some(op => op.kind === 'merge' && op.state === 'failed')) firstFailure = structuredClone(snapshot);
  };
  await c.system().drainAutomaticMerges();
  assert.ok(firstFailure);
  assert.equal(firstFailure.workspace.runs[0].automaticMergeStop.phase, 'before-write');
  assert.equal(firstFailure.workspace.events.filter(event => event.type === 'run.automatic_merge_stopped').length, 1);
  assert.match(firstFailure.workspace.events.at(-2).message, /before Git write/);
  c.store.write = write; write(firstFailure, c.store.read().revision);
  assert.equal(candidateOutcome(c.controller.workspace(), firstFailure.workspace.runs[0]).label, 'Automatic merge stopped');
  const before = c.store.read(); await c.system().drainAutomaticMerges(); assert.deepEqual(c.store.read(), before); assert.equal(c.pushes(), 0);
});

test('restart terminalizes an orphaned failed policy operation without repeating checks or Git work', async () => {
  const c = await automaticContext(); c.toggle(true);
  c.source.createToken = async () => { throw Error('Controlled failure before write'); };
  await c.system().drainAutomaticMerges();
  const interrupted = c.store.read(); delete interrupted.workspace.runs[0].automaticMergeStop;
  interrupted.workspace.events = interrupted.workspace.events.filter(event => event.type !== 'run.automatic_merge_stopped');
  c.store.write(interrupted, interrupted.revision);
  const checks = c.checks(); assert.equal(c.system().hasAutomaticMergeWork(), true);
  await c.system().drainAutomaticMerges();
  assert.equal(c.checks(), checks); assert.equal(c.pushes(), 0);
  assert.equal(c.store.read().workspace.runs[0].automaticMergeStop.phase, 'before-write');
  assert.equal(c.system().hasAutomaticMergeWork(), false);
  const record = c.store.read(); await c.system().drainAutomaticMerges(); assert.deepEqual(c.store.read(), record);
});

test('automatic stop messages distinguish failed checks from a lost Git acknowledgement', async () => {
  for (const uncertain of [false, true]) {
    const c = await automaticContext(); c.toggle(true);
    if (uncertain) c.loseAcknowledgement();
    else c.runtime.repositoryChecks.observe = async () => ({ stdout: 'failed\n', exitCode: 1, image: 'sha256:' + 'a'.repeat(64) });
    await c.system().drainAutomaticMerges();
    const state = c.store.read().workspace, message = state.events.find(event => event.type === 'run.automatic_merge_stopped').message;
    assert.equal(state.runs[0].automaticMergeStop.phase, uncertain ? 'uncertain-write' : 'before-write');
    assert.equal(c.pushes(), uncertain ? 1 : 0);
    assert.match(message, uncertain ? /write may have started.*Reconcile/ : /before Git write/);
    if (!uncertain) assert.doesNotMatch(message, /uncertain|reconcil/i);
  }
});

async function addDisjointManualCandidate(c) {
  // Synthetic coordinator records isolate admission ordering. The provider
  // fixture supplies verified blobs; changed-path inspection has separate tests.
  const snapshot = c.store.read(), original = snapshot.workspace.runs.find(run => run.id === c.id);
  const task = {...structuredClone(snapshot.workspace.tasks[0]), id:crypto.randomUUID(), title:'Other disjoint task', acceptedRunId:null, status:'review'};
  const run = {...structuredClone(original), id:crypto.randomUUID(), taskId:task.id, label:'Other candidate', headCommit:OTHER, changedFiles:['other.txt'], branch:'other-candidate', review:null};
  run.evidence.commit = OTHER; run.evidence.verification.requirementsSha256 = requirementsDigest(task);
  const definition = {...JSON.parse(snapshot.checkPolicies[c.id].definition), commit:OTHER, requirementsSha256:requirementsDigest(task)};
  snapshot.checkPolicies[run.id] = {definition:JSON.stringify(definition), definitionSha256:checkDigest(JSON.stringify(definition))};
  run.evidence.verification.definitionSha256 = snapshot.checkPolicies[run.id].definitionSha256;
  run.reviewAssignments = [{...run.reviewAssignments[0], id:crypto.randomUUID()}];
  snapshot.workspace.tasks.push(task);snapshot.workspace.runs.push(run);
  run.codeReview = {...run.codeReview, id:crypto.randomUUID(), assignmentId:run.reviewAssignments[0].id, context:independentReviewBinding(snapshot.workspace,run)};
  run.codeReview.contextId = codeReviewContext(snapshot.workspace,run.id).contextId;
  const name = 'manual-' + run.id; await c.source.fork(name,{description:'Disjoint project-merge admission fixture'});
  const fork=c.repositories.get(name);fork.commits.set(OTHER,commit(OTHER,HEAD_TREE,[BASE]));fork.branches.set('refs/heads/'+run.branch,OTHER);
  c.source.commits.set(OTHER,commit(OTHER,HEAD_TREE,[BASE]));
  snapshot.repositories[task.id]='starter';snapshot.forks[run.id]={name,remote:(await fork.info()).remote};
  c.store.write(snapshot,snapshot.revision);
  await c.controller.review(run.id,c.review(run.id));
  return run;
}

test('a manual merge waits behind an automatic merge in the same project before verification or credentials', async () => {
  const c=await automaticContext(),other=await addDisjointManualCandidate(c);c.toggle(true);
  let entered,release,calls=0;
  const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),observe=c.runtime.repositoryChecks.observe;
  c.runtime.repositoryChecks.observe=async(...args)=>{calls++;entered();await gate;return observe(...args);};
  const automatic=c.system().drainAutomaticMerges();await reached;
  const credentials=c.source.tokenCreates;
  await assert.rejects(c.controller.merge(other.id,{headCommit:OTHER}),{code:'PROJECT_MERGE_PENDING'});
  assert.equal(calls,1);assert.equal(c.source.tokenCreates,credentials);
  const view=c.controller.workspace();assert.equal(candidateOutcome(view,view.runs.find(run=>run.id===other.id)).label,'Waiting for project merge');
  release();await automatic;assert.equal(c.pushes(),1);
});

test('automatic admission racing with a manual project reservation waits and resumes without a failed decision', async t => {
  const c=await automaticContext(),other=await addDisjointManualCandidate(c);c.toggle(true);
  let hashEntered,releaseHash,checkEntered,releaseCheck;
  const hashing=new Promise(resolve=>hashEntered=resolve),hashGate=new Promise(resolve=>releaseHash=resolve);
  const checking=new Promise(resolve=>checkEntered=resolve),checkGate=new Promise(resolve=>releaseCheck=resolve);
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(algorithm,bytes)=>{
    if(new TextDecoder().decode(bytes)===`${HEAD}:${BASE}:1`){hashEntered();await hashGate;}
    return digest(algorithm,bytes);
  });
  const observe=c.runtime.repositoryChecks.observe;let checks=0;
  c.runtime.repositoryChecks.observe=async(...args)=>{
    if(checks++===0){checkEntered();await checkGate;return {stdout:'controlled failure\n',exitCode:1,image:'sha256:'+'a'.repeat(64)};}
    return observe(...args);
  };
  const automatic=c.system().drainAutomaticMerges();await hashing;
  const manual=c.controller.merge(other.id,{headCommit:OTHER}).then(()=>null,error=>error);await checking;
  releaseHash();await automatic;
  assert.equal(c.store.read().workspace.runs.find(run=>run.id===c.id).automaticMergeStop,undefined);
  assert.equal(c.system().hasAutomaticMergeWork(),false);assert.equal(c.pushes(),0);
  releaseCheck();assert.equal((await manual).code,'CHECKS_FAILED');
  assert.equal(c.system().hasAutomaticMergeWork(),true);
  await c.system().drainAutomaticMerges();assert.equal(c.pushes(),1);
  assert.equal(c.store.read().workspace.runs.find(run=>run.id===c.id).status,'merged');
});

test('ordinary hosted projects require explicit checks and replay does not execute twice', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await assert.rejects(c.controller.verify(id, { headCommit: HEAD, taskRevision: 1 }, 'missing-plan'), { code: 'CHECK_DEFINITION_REQUIRED' });
  await assert.rejects(c.controller.configureChecks(id, { ...c.plan(), definitionSha256: '0'.repeat(64) }, 'bad-plan'), { code: 'INVALID_CHECK_DEFINITION' });
  assert.equal(c.checks(), 0);
  const first = await c.controller.configureChecks(id, c.plan(), 'ordinary-checks');
  assert.equal(first.runs[0].evidence.passed, 1); assert.equal(first.runs[0].evidence.verified, true);
  await c.controller.configureChecks(id, c.plan(), 'ordinary-checks'); assert.equal(c.checks(), 1);
  await acceptAfterIndependentReview(c, id, c.review());
  await c.controller.merge(id, { headCommit: HEAD });
  assert.equal(c.checks(), 2); assert.equal(c.pushes(), 1);
  assert.equal(c.controller.workspace().tasks[0].status, 'merged');
  assert.equal(c.controller.workspace().runs[0].evidenceHistory.at(-1).operation, 'merge');
  assert.ok(c.controller.workspace().runs[0].evidenceHistory.at(-1).attemptId);
  assert.ok(c.receipts.every(receipt => !receipt.includes(SHORT_TOKEN) && !receipt.includes(LONG_TOKEN)));
});

test('delayed hosted merge exposes running state until its retained check finishes', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await c.controller.configureChecks(id, c.plan(), 'delayed-merge-plan');
  await acceptAfterIndependentReview(c, id, c.review());
  let release, reached;
  const entered = new Promise(resolve => reached = resolve);
  c.runtime.repositoryChecks.observe = async () => {
    reached();
    return new Promise(resolve => release = () => resolve({ stdout: 'after\n', exitCode: 0, image: 'sha256:' + 'a'.repeat(64) }));
  };
  const pending = c.controller.merge(id, { headCommit: HEAD });
  await entered;
  assert.equal(c.controller.workspace().mergeStateByRun[id], 'running');
  assert.deepEqual(c.controller.workspace().recovery, { pendingMergeIntents: 1, activeMergeIntents: 1, recoveryRequiredMergeIntents: 0 });
  release();
  await pending;
  assert.deepEqual(c.controller.workspace().mergeStateByRun, {});
});

test('expired merge reconciliation cannot complete a successor active attempt', async () => {
  const c = executable();
  await c.controller.queueModels({ ...modelInput(), candidates: 1 }, 'reconciliation-fence-model');
  await c.controller.drainJobs();
  const run = c.controller.workspace().runs[0];
  await acceptAfterIndependentReview(c, run.id, { decision: 'accept', ownerVersion: 1, comparisons: [], note: 'Reviewed exact candidate', headCommit: HEAD, taskRevision: 1 });
  c.loseAcknowledgement();
  await assert.rejects(c.controller.merge(run.id, { headCommit: HEAD }));
  const originalLog = c.source.log.bind(c.source);
  c.source.log = async input => {
    const snapshot = c.store.read();
    const [key, operation] = Object.entries(snapshot.operations).find(([, value]) => value.kind === 'merge' && value.itemId === run.id);
    snapshot.operations[key] = { ...operation, attemptId: 'successor-attempt', leaseUntil: Date.now() + 60_000 };
    c.store.write({ ...snapshot, revision: snapshot.revision + 1 }, snapshot.revision);
    return originalLog(input);
  };
  await assert.rejects(c.controller.merge(run.id, { headCommit: HEAD }), { code: 'STALE_OPERATION' });
  const retained = c.store.read();
  const operation = Object.values(retained.operations).find(value => value.kind === 'merge' && value.itemId === run.id);
  assert.equal(retained.workspace.runs[0].status, 'accepted');
  assert.equal(operation.state, 'pending');
  assert.equal(operation.attemptId, 'successor-attempt');
});

test('changed merge runtime invalidates acceptance and retains fresh and prior proof', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await c.controller.configureChecks(id, c.plan(), 'accepted-runtime'); await acceptAfterIndependentReview(c, id, c.review());
  c.runtime.repositoryChecks.observe = async () => ({ stdout: 'after\n', exitCode: 0, image: 'sha256:' + 'b'.repeat(64) });
  await assert.rejects(c.controller.merge(id, { headCommit: HEAD }), { code: 'VERIFIER_CHANGED' });
  const result = c.controller.workspace().runs[0];
  assert.equal(c.pushes(), 0); assert.equal(result.status, 'awaiting_review'); assert.equal(result.review, null);
  assert.equal(result.reviewHistory[0].decision, 'accept'); assert.equal(result.evidence.passed, 1);
  assert.equal(result.evidence.verification.image, 'sha256:' + 'b'.repeat(64));
  assert.equal(result.evidenceHistory[0].verification.image, 'sha256:' + 'a'.repeat(64));
  assert.equal(result.evidenceHistory.at(-1).operation, 'merge');
  assert.equal(result.evidenceHistory[0].operation, undefined);
  await acceptAfterIndependentReview(c, id, c.review()); await c.controller.merge(id, { headCommit: HEAD }); assert.equal(c.pushes(), 1);
});

test('a failed merge check revokes acceptance before any push', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await c.controller.configureChecks(id, c.plan(), 'merge-failure-plan'); await acceptAfterIndependentReview(c, id, c.review());
  c.runtime.repositoryChecks.observe = async () => ({ stdout: 'wrong\n', exitCode: 0, image: 'sha256:' + 'a'.repeat(64) });
  await assert.rejects(c.controller.merge(id, { headCommit: HEAD }), { code: 'CHECKS_FAILED' });
  assert.equal(c.pushes(), 0); assert.equal(c.controller.workspace().tasks[0].acceptedRunId, null);
  assert.equal(c.controller.workspace().runs[0].evidence.passed, 0);
  assert.equal(c.controller.workspace().runs[0].evidence.operation, 'merge');
  assert.equal(c.controller.workspace().runs[0].evidenceHistory.at(-1).attemptId, c.controller.workspace().runs[0].evidence.attemptId);
  await assert.rejects(c.controller.review(id, c.review()), { code: 'checks_failed' });
});

test('running and interrupted hosted checks cannot reuse an old passing report', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await c.controller.configureChecks(id, c.plan(), 'initial-passing');
  let release, reached;
  const entered = new Promise(resolve => reached = resolve);
  c.runtime.repositoryChecks.observe = async () => { reached(); return new Promise((_, reject) => release = () => reject(new Error('secret failure details'))); };
  const pending = c.controller.verify(id, { headCommit: HEAD, taskRevision: 1 }, 'recheck-pending');
  await entered;
  assert.equal(c.controller.workspace().runs[0].evidence.passed, 1);
  assert.equal(c.controller.workspace().runs[0].verificationPending, true);
  await assert.rejects(c.controller.review(id, c.review()), { code: 'TASK_OPERATION_PENDING' });
  assert.throws(() => c.controller.revise(c.task.taskId, { expectedRevision: 1, purpose: 'New purpose', criteria: ['New criterion'], reason: 'Changed' }), { code: 'TASK_OPERATION_PENDING' });
  release(); await pending;
  const result = c.controller.workspace().runs[0];
  assert.equal(result.evidence.verified, false); assert.equal(result.evidence.total, 1); assert.equal(result.evidenceHistory[0].passed, 1);
  assert.equal(result.verificationPending, false); assert.ok(!JSON.stringify(result).includes('secret failure'));
  await assert.rejects(c.controller.review(id, c.review()), { code: 'verification_required' });
  c.runtime.repositoryChecks.observe = async () => { throw new Error('Replay must not run'); };
  await c.controller.verify(id, { headCommit: HEAD, taskRevision: 1 }, 'recheck-pending');
});

test('expired hosted verification is closed without starting another container', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  let release, reached;
  const entered = new Promise(resolve => reached = resolve);
  c.runtime.repositoryChecks.observe = async () => { reached(); return new Promise(resolve => release = () => resolve({ stdout: 'after\n', exitCode: 0, image: 'sha256:' + 'a'.repeat(64) })); };
  const old = c.controller.configureChecks(id, c.plan(), 'expired-checks');
  const stale = assert.rejects(old, { code: 'STALE_OPERATION' });
  await entered;
  c.runtime.cancelVerification = async () => { release(); await stale; };
  const snapshot = c.store.read(), op = Object.values(snapshot.operations).find(op => op.kind === 'checks');
  op.leaseUntil = 0; c.store.write({ ...snapshot, revision: snapshot.revision + 1 }, snapshot.revision);
  await c.controller.configureChecks(id, c.plan(), 'expired-checks');
  assert.equal(c.controller.workspace().runs[0].evidence.verified, false);
  await stale;
});

function advanceMain(c) {
  c.source.commits.set(OTHER, commit(OTHER, BASE_TREE, [BASE]));
  c.source.branches.set('refs/heads/main', OTHER);
}
function reapplyFixture(c, { conflict = false, lost = false } = {}) {
  let pushes = 0;
  const updated = 'f'.repeat(40);
  c.runtime.git.reapply = async input => {
    assert.equal(input.baseCommit, BASE); assert.equal(input.headCommit, HEAD); assert.equal(input.currentBase, OTHER);
    if (conflict) throw Object.assign(new Error('conflict'), { code: 'REBASE_CONFLICT' });
    await input.beforePush(updated); pushes++;
    const fork = [...c.repositories.values()].find(repo => input.remote.endsWith('/' + repo.name + '.git'));
    fork.commits.set(updated, commit(updated, HEAD_TREE, [OTHER])); fork.branches.set('refs/heads/' + input.branch, updated);
    if (lost) { lost = false; throw new Error('Lost acknowledgement'); }
    return updated;
  };
  return { updated, pushes: () => pushes };
}

test('hosted base updates retain approval history, carry check definitions and need new proof', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await c.controller.configureChecks(id, c.plan(), 'old-base-checks'); await acceptAfterIndependentReview(c, id, c.review());
  advanceMain(c); const fixture = reapplyFixture(c, { lost: true });
  const input = { headCommit: HEAD, taskRevision: 1, mode: 'reapply' };
  await assert.rejects(c.controller.updateBase(id, input, 'base-update-lost'));
  assert.equal(c.controller.workspace().tasks[0].baseCommit, BASE);
  assert.throws(() => c.controller.setOwner(c.task.taskId, { owner: 'Other owner', expectedOwnerVersion: 1 }), { code: 'TASK_OPERATION_PENDING' });
  const result = await new HostedController(c.store, c.artifacts, testAuthority(), c.runtime).updateBase(id, input, 'base-update-lost');
  assert.equal(fixture.pushes(), 1);
  assert.equal((await c.controller.updateBase(id, input, 'base-update-lost')).runId, result.runId);
  const state = c.controller.workspace(), previous = state.runs.find(run => run.id === id), replacement = state.runs.find(run => run.id === result.runId);
  assert.equal(previous.status, 'superseded'); assert.equal(previous.evidence.passed, 1); assert.equal(previous.reviewHistory[0].decision, 'accept');
  assert.equal(replacement.reconcilesRunId, id); assert.equal(replacement.headCommit, fixture.updated); assert.equal(replacement.evidence, null); assert.equal(replacement.checksConfigured, true);
  assert.equal(state.tasks[0].baseCommit, OTHER); assert.equal(state.tasks[0].revision, 2); assert.equal(state.tasks[0].acceptedRunId, null);
  assert.equal(c.source.branches.get('refs/heads/main'), OTHER);
  await assert.rejects(c.controller.review(result.runId, c.review(result.runId)), { code: 'verification_required' });
  const verified = await c.controller.verify(result.runId, { headCommit: fixture.updated, taskRevision: 2 }, 'new-base-checks');
  assert.equal(verified.runs.find(run => run.id === result.runId).evidence.passed, 1);
});

test('conflict refusal leaves the old base intact; resolution is isolated and credentials issue once', async () => {
  const c = await commandContext(), id = c.assignment.runId;
  await c.controller.configureChecks(id, c.plan(), 'conflict-old-checks'); advanceMain(c);
  reapplyFixture(c, { conflict: true });
  const input = { headCommit: HEAD, taskRevision: 1, mode: 'reapply' };
  await assert.rejects(c.controller.updateBase(id, input, 'conflict-reapply'), { code: 'REBASE_CONFLICT' });
  await assert.rejects(c.controller.updateBase(id, input, 'conflict-reapply'), { code: 'REBASE_CONFLICT' });
  assert.equal(c.controller.workspace().tasks[0].baseCommit, BASE);
  const resolved = await c.controller.updateBase(id, { ...input, mode: 'resolve', agentClientId: AGENT_CLIENT }, 'resolution-work');
  assert.equal(resolved.credentialStatus, 'issued-once'); assert.equal(resolved.credentials.baseCommit, OTHER);
  const replay = await c.controller.updateBase(id, { ...input, mode: 'resolve', agentClientId: AGENT_CLIENT }, 'resolution-work');
  assert.equal(replay.credentials, null); assert.equal(replay.runId, resolved.runId);
  const run = c.controller.workspace().runs.find(run => run.id === resolved.runId);
  assert.equal(run.origin, 'external-agent'); assert.equal(run.status, 'assigned'); assert.equal(run.reconcilesRunId, id); assert.equal(run.evidence, null);
  c.controller.start(run.id);
  const fork = c.repositories.get(c.store.read().forks[run.id].name), head = '9'.repeat(40);
  fork.commits.set(head, commit(head, HEAD_TREE, [OTHER])); fork.branches.set('refs/heads/' + run.branch, head);
  await c.controller.complete(run.id, { headCommit: head, summary: 'Resolved by external agent' });
  assert.equal(c.controller.workspace().runs.find(item => item.id === run.id).checksConfigured, true);
  const verified = await c.controller.verify(run.id, { headCommit: head, taskRevision: 2 }, 'resolution-checks');
  assert.equal(verified.runs.find(item => item.id === run.id).evidence.passed, 1);
  assert.equal(c.source.branches.get('refs/heads/main'), OTHER);
  assert.ok(c.receipts.every(receipt => !receipt.includes(SHORT_TOKEN) && !receipt.includes(LONG_TOKEN)));
});

test('migrating retained hosted evidence declares the old checkout profile once', () => {
  const state = initialSnapshot('legacy'); delete state.checkPolicies;
  state.workspace.tasks.push({ id: 'retained', verificationProfile: undefined });
  assert.equal(migrateSnapshot(state), true); assert.equal(state.workspace.tasks[0].verificationProfile, 'checkout');
  assert.equal(migrateSnapshot(state), false);
});


test("browser mutations reject foreign and same-site origins but permit CLI", () => {
  assert.throws(() => requireSameOrigin(new Request("https://app.example.test/api/tasks", { headers: { Origin: "https://evil.example.test" } })), { code: "CROSS_ORIGIN" });
  assert.throws(() => requireSameOrigin(new Request("https://app.example.test/api/tasks", { headers: { "Sec-Fetch-Site": "same-site" } })), { code: "CROSS_ORIGIN" });
  requireSameOrigin(new Request("https://app.example.test/api/tasks", { headers: { Origin: "https://app.example.test", "Sec-Fetch-Site": "same-origin" } }));
  requireSameOrigin(new Request("https://app.example.test/api/tasks"));
});

test("JSON ingress checks limits, fatal UTF-8, object form, and credential redaction", async () => {
  const request = (body) => new Request("https://app.example.test/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  await assert.rejects(bodyJson(request("\"text\"")), { code: "INVALID_JSON" });
  await assert.rejects(bodyJson(request(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]))), { code: "INVALID_JSON" });
  await assert.rejects(bodyJson(request(" ".repeat(32_769))), { code: "BODY_TOO_LARGE" });
  const stackBody = { note: 'x'.repeat(65_536) };
  assert.deepEqual(await bodyJson(request(JSON.stringify(stackBody)), undefined, 128 * 1024), stackBody);
  await assert.rejects(bodyJson(request(' '.repeat(128 * 1024 + 1)), undefined, 128 * 1024), { code: 'BODY_TOO_LARGE' });
  await assert.rejects(bodyJson(request(JSON.stringify({ note: CONTROL_TOKEN })), [CONTROL_TOKEN]), { code: "SECRET_IN_BODY" });
  assert.deepEqual(await bodyJson(request("{\"title\":\"ok\"}")), { title: "ok" });
});

test("provider errors are generic and all JSON responses are no-store", async () => {
  const response = errorResponse(new Error("Upstream failed with " + SHORT_TOKEN));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.ok(!(await response.text()).includes(SHORT_TOKEN));
});

test("creation idempotency is explicit", () => {
  assert.throws(() => idempotencyKey(new Request("https://app.example.test")), { code: "IDEMPOTENCY_REQUIRED" });
  assert.equal(idempotencyKey(new Request("https://app.example.test", { headers: { "Idempotency-Key": "task-create-01" } })), "task-create-01");
});

test("empty hosted workspace is valid and exposes unavailable capabilities", () => {
  const value = setup().controller.workspace();
  assert.deepEqual(value.tasks, []);
  assert.equal(value.metrics.acceptedCandidates.denominator, 0);
  assert.deepEqual(value.capabilities, { repository: true, repositoryCatalog: true, demo: false, model: false, merge: false, verify: false, repositoryChecks: false, baseUpdate: false, revise: true, handoff: true, coordination: true, dependencies: true, providerVerified: false });
});

test("task verifies exact pinned commit and replay preserves one task", async () => {
  const context = setup();
  const first = await context.controller.createTasks(taskInput(), "task-create-01");
  const replay = await context.controller.createTasks(taskInput(), "task-create-01");
  assert.equal(replay.taskId, first.taskId);
  assert.equal(context.controller.workspace().tasks.length, 1);
  await assert.rejects(context.controller.createTasks({ ...taskInput(), tasks: [{ ...taskBrief(), title: "different" }] }, "task-create-01"), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(setup().controller.createTasks({ ...taskInput(), baseCommit: OTHER }, "task-create-02"), { code: "COMMIT_NOT_FOUND" });
  await assert.rejects(context.controller.createTasks({ ...taskInput(), baseCommit: "a".repeat(64) }, "task-create-03"), { code: "ARTIFACTS_COMMIT_FORMAT" });
  assert.ok(context.source.disposals > 0);
});

test("concurrent queued task batches preserve both results", async () => {
  const context = setup();
  const project = await context.controller.createTasks(taskInput(), "connect-initial");
  const queued = { source: "project", projectId: project.projectId, tasks: [taskBrief()] };
  const results = await Promise.all([
    context.controller.createTasks(queued, "task-create-01"),
    context.controller.createTasks({ ...queued, tasks: [{ ...taskBrief(), title: "second" }] }, "task-create-02"),
  ]);
  assert.equal(new Set(results.map((item) => item.taskId)).size, 2);
  assert.equal(context.controller.workspace().tasks.length, 3);
});

test("assignment forks once, revokes initial credential, issues 15-minute token only once", async () => {
  const context = setup();
  const { task, assignment, fork } = await assigned(context);
  assert.equal(context.forks(), 1);
  assert.equal(fork.lastTTL, 900);
  assert.ok(fork.revoked.includes(LONG_TOKEN));
  assert.equal(assignment.credentials.token, SHORT_TOKEN);
  const replay = await context.controller.assign(task.taskId, { agent: "agent-a", agentClientId: AGENT_CLIENT, label: "Agent A" }, "assignment-one");
  assert.equal(replay.runId, assignment.runId);
  assert.equal(replay.credentials, null);
  assert.equal(fork.tokenCreates, 1);
  for (const receipt of context.receipts) {
    assert.ok(!receipt.includes(SHORT_TOKEN));
    assert.ok(!receipt.includes(LONG_TOKEN));
  }
  const serialized = JSON.stringify(context.controller.workspace());
  assert.ok(!serialized.includes(SHORT_TOKEN));
  assert.ok(!serialized.includes(LONG_TOKEN));
});

test("assignment recovers its durably reserved fork without duplicating it", async () => {
  const context = setup();
  const task = await context.controller.createTasks(taskInput(), "task-request-one");
  const original = context.source.fork;
  let failure = true;
  context.source.fork = async (...args) => {
    const result = await original(...args);
    if (failure) { failure = false; throw new Error("response interrupted " + LONG_TOKEN); }
    return result;
  };
  await assert.rejects(context.controller.assign(task.taskId, { agent: "a", agentClientId: AGENT_CLIENT, label: "A" }, "assignment-recovery"));
  const recovered = await context.controller.assign(task.taskId, { agent: "a", agentClientId: AGENT_CLIENT, label: "A" }, "assignment-recovery");
  assert.equal(context.forks(), 1);
  assert.equal(recovered.credentials.token, SHORT_TOKEN);
  const fork = context.repositories.get(context.store.read().forks[recovered.runId].name);
  assert.ok(fork.revoked.includes("initial-id"));
});

test("in-flight same-key assignment is rejected while independent agents can fork", async () => {
  const context = setup();
  const task = await context.controller.createTasks(taskInput(), "task-request-one");
  let began;
  let finish;
  const providerStarted = new Promise((resolve) => { began = resolve; });
  const providerReleased = new Promise((resolve) => { finish = resolve; });
  const originalFork = context.source.fork;
  context.source.fork = async (...args) => { began(); await providerReleased; return originalFork(...args); };
  const first = context.controller.assign(task.taskId, { agent: "a", agentClientId: AGENT_CLIENT, label: "A" }, "assignment-race");
  await providerStarted;
  await assert.rejects(context.controller.assign(task.taskId, { agent: "a", agentClientId: AGENT_CLIENT, label: "A" }, "assignment-race"), { code: "OPERATION_IN_PROGRESS" });
  finish();
  await first;
  await context.controller.assign(task.taskId, { agent: "b", agentClientId: AGENT_CLIENT, label: "B" }, "assignment-second");
  assert.equal(context.forks(), 2);
});

test("completion derives actual changes and prevents self-verified hosted acceptance", async () => {
  const context = setup();
  const { assignment } = await assigned(context);
  const completed = await context.controller.complete(assignment.runId, { headCommit: HEAD, summary: "Changed answer", report: report(), diff: "fabricated diff", changedFiles: ["fake.txt"] });
  const run = completed.runs[0];
  assert.deepEqual(run.changedFiles, ["answer.txt"]);
  assert.match(run.diff, /-before\n\+after/);
  assert.equal(run.evidence.verified, false);
  assert.equal(run.evidence.source, "hosted-harness-report");
  assert.equal(completed.metrics.checks.verifiedRuns, 0);
  await assert.rejects(context.controller.review(run.id, { decision: "accept", note: "Looks good", headCommit: HEAD }), { code: "verification_required" });
  const rejected = await context.controller.review(run.id, { decision: "reject", note: "Needs independent verification", headCommit: HEAD });
  assert.equal(rejected.runs[0].status, "rejected");
});

test("completion rejects stale branch heads and missing exact commits", async () => {
  const context = setup();
  const { assignment, fork } = await assigned(context);
  fork.branches.set("refs/heads/" + assignment.credentials.branch, BASE);
  await assert.rejects(context.controller.complete(assignment.runId, { headCommit: HEAD, summary: "change", report: report() }), { code: "STALE_HEAD" });
  assert.equal(context.controller.workspace().runs[0].status, "running");
  await assert.rejects(exactCommit(fork, OTHER), { code: "COMMIT_NOT_FOUND" });
});

test("Git inspection rejects unrelated ancestry and provider hash mismatches", async () => {
  const repo = mockRepo();
  repo.branches.set("refs/heads/agents/test", HEAD);
  repo.commits.set(HEAD, commit(HEAD, HEAD_TREE));
  await assert.rejects(inspectResult(repo, BASE, HEAD, "agents/test"), { code: "UNRELATED_COMMIT" });
  repo.commits.set(HEAD, commit(OTHER, HEAD_TREE, [BASE]));
  await assert.rejects(exactCommit(repo, HEAD), { code: "COMMIT_NOT_FOUND" });
});

test("Git inspection bounds changed blobs and rejects traversal paths", async () => {
  const repo = mockRepo();
  repo.branches.set("refs/heads/agents/test", HEAD);
  repo.blobs.set(NEW_BLOB, new Blob(["x".repeat(65_537)]));
  await assert.rejects(inspectResult(repo, BASE, HEAD, "agents/test"), { code: "DIFF_LIMIT" });
  repo.trees.set(HEAD_TREE, [{ name: "..", mode: "100644", hash: NEW_BLOB, type: "blob" }]);
  await assert.rejects(inspectResult(repo, BASE, HEAD, "agents/test"), { code: "INVALID_GIT_PATH" });
});

test("review detects a branch changed after completion", async () => {
  const context = setup();
  const { assignment, fork } = await assigned(context);
  await context.controller.complete(assignment.runId, { headCommit: HEAD, summary: "change", report: report() });
  fork.branches.set("refs/heads/" + assignment.credentials.branch, BASE);
  await assert.rejects(context.controller.review(assignment.runId, { decision: "reject", note: "Retry", headCommit: HEAD }), { code: "STALE_HEAD" });
});

test("harness denominators cannot be inflated", async () => {
  const context = setup();
  const { assignment } = await assigned(context);
  await assert.rejects(context.controller.complete(assignment.runId, { headCommit: HEAD, summary: "change", report: { ...report(), total: 10 } }), { code: "DENOMINATOR_MISMATCH" });
});

test("provider remotes never embed credentials", () => {
  assert.throws(() => safeRemote("https://secret@artifacts.example.test/repo.git"), { code: "UNSAFE_REMOTE" });
  assert.throws(() => safeRemote("http://artifacts.example.test/repo.git"), { code: "UNSAFE_REMOTE" });
  assert.throws(() => safeRemote("https://artifacts.example.test/repo.git?token=secret"), { code: "UNSAFE_REMOTE" });
  assert.equal(safeRemote("https://artifacts.example.test/repo.git"), "https://artifacts.example.test/repo.git");
});

test('stack creation is atomic and one Artifacts repository has one project', async () => {
  const c = setup();
  await assert.rejects(c.controller.createTasks({ ...taskInput(), tasks: [taskBrief(), { ...taskBrief(), criteria: [] }] }, 'bad-stack'), { code: 'invalid_criteria' });
  assert.equal(c.store.read().workspace.tasks.length, 0);
  const input = { ...taskInput(), tasks: [taskBrief(), { ...taskBrief(), title: 'Next task' }] };
  const first = await c.controller.createTasks(input, 'two-task-stack');
  const retry = await c.controller.createTasks(input, 'two-task-stack');
  assert.deepEqual(retry.taskIds, first.taskIds);
  assert.equal(Object.keys(c.controller.workspace().projects).length, 1);
  await assert.rejects(c.controller.createTasks(taskInput(), 'duplicate-project'), { code: 'PROJECT_EXISTS' });
  assert.equal(c.forks(), 0);
});

test('concurrent connections to the same Artifacts repository cannot create two projects', async () => {
  const c = setup();
  const results = await Promise.allSettled([c.controller.createTasks(taskInput(), 'connect-one'), c.controller.createTasks(taskInput(), 'connect-two')]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'PROJECT_EXISTS');
  assert.equal(c.controller.workspace().tasks.length, 1);
});

test('claims reserve different oldest tasks before provider I/O and survive restart', async () => {
  const c = setup();
  const stack = await c.controller.createTasks({ ...taskInput(), tasks: Array.from({ length: 3 }, (_, index) => ({ ...taskBrief(), title: `Task ${index}` })) }, 'queue-three');
  let began, release;
  const started = new Promise(resolve => { began = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const fork = c.source.fork;
  let count = 0;
  c.source.fork = async (...args) => { if (++count === 1) { began(); await wait; } return fork(...args); };
  const first = c.controller.claim(stack.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent A' }, 'claim-agent-one');
  await started;
  assert.equal(c.controller.workspace().runs[0].checkoutState, 'preparing');
  await assert.rejects(c.controller.claim(stack.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent A' }, 'claim-agent-one'), { code: 'OPERATION_IN_PROGRESS' });
  const second = await c.controller.claim(stack.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent B' }, 'claim-agent-two');
  release();
  const result = await first;
  assert.deepEqual([result.taskId, second.taskId], stack.taskIds.slice(0, 2));
  const restarted = new HostedController(c.store, c.artifacts, testAuthority());
  const replay = await restarted.claim(stack.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent A' }, 'claim-agent-one');
  assert.equal(replay.runId, result.runId); assert.equal(replay.credentials, null);
  assert.equal(c.forks(), 2);
  await assert.rejects(restarted.claim(stack.projectId, { agentClientId: AGENT_CLIENT, label: 'Different' }, 'claim-agent-one'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('hosted dependency claims skip waiting work, preserve idle replay and bind the integrated head', async () => {
  const c = executable();
  const original = await c.controller.queueModels({ ...modelInput(), candidates: 1 }, 'dependency-foundation');
  const foundation = c.controller.workspace().tasks.find(task => task.id === original.taskId);
  const stack = await c.controller.createTasks({ source: 'project', projectId: foundation.projectId,
    tasks: [{ ...taskBrief(), title: 'Dependent', dependsOn: [foundation.id] }, { ...taskBrief(), title: 'Independent' }] }, 'dependency-stack');
  const independent = await c.controller.claim(foundation.projectId, { agentClientId: AGENT_CLIENT, label: 'Independent agent' }, 'dependency-independent');
  assert.equal(independent.taskId, stack.taskIds[1]);
  const forks = c.forks();
  await assert.rejects(c.controller.assign(stack.taskIds[0], { agentClientId: AGENT_CLIENT, label: 'Too early' }, 'dependency-direct'), { code: 'dependency_waiting' });
  assert.equal(c.forks(), forks);
  await c.controller.fail(independent.runId, { message: 'Scripted fixture stops independent work; no generation requested.' });
  const idle = await c.controller.claim(foundation.projectId, { agentClientId: AGENT_CLIENT, label: 'Waiting agent' }, 'dependency-idle');
  assert.equal(idle.idle, true); assert.deepEqual(idle.waitingTaskIds, [stack.taskIds[0]]);
  await c.controller.drainJobs();
  const run = c.controller.workspace().runs.find(run => run.taskId === foundation.id);
  await acceptAfterIndependentReview(c, run.id, { decision: 'accept', ownerVersion: 1, taskRevision: 1, headCommit: HEAD,
    comparisons: [], note: 'Bounded synthetic verifier and transport qualification.' });
  await assert.rejects(c.controller.assign(stack.taskIds[0], { agentClientId: AGENT_CLIENT, label: 'Accepted is not merged' }, 'dependency-before-merge'), { code: 'dependency_waiting' });
  await c.controller.merge(run.id, { headCommit: HEAD });
  const restarted = new HostedController(c.store, c.artifacts, testAuthority(), c.runtime);
  const replay = await restarted.claim(foundation.projectId, { agentClientId: AGENT_CLIENT, label: 'Waiting agent' }, 'dependency-idle');
  assert.equal(replay.idle, true); assert.deepEqual(replay.waitingTaskIds, idle.waitingTaskIds);
  const claim = await restarted.claim(foundation.projectId, { agentClientId: AGENT_CLIENT, label: 'Now eligible' }, 'dependency-after-merge');
  assert.equal(claim.taskId, stack.taskIds[0]); assert.equal(claim.credentials.baseCommit, HEAD);
  assert.equal(c.calls(), 1, 'Only the explicitly requested synthetic provider attempt ran');
});

test('project pause is versioned and permits queueing, submissions and credential cleanup', async () => {
  const c = setup();
  const { task, assignment } = await assigned(c);
  c.controller.policy(task.projectId, { acceptingWork: false, expectedVersion: 1 });
  assert.throws(() => c.controller.policy(task.projectId, { acceptingWork: true, expectedVersion: 1 }), { code: 'stale_project_policy' });
  await c.controller.createTasks({ source: 'project', projectId: task.projectId, tasks: [taskBrief()] }, 'queue-while-paused');
  await assert.rejects(c.controller.claim(task.projectId, { agentClientId: AGENT_CLIENT, label: 'New agent' }, 'paused-claim'), { code: 'project_paused' });
  await c.controller.complete(assignment.runId, { headCommit: HEAD, summary: 'Existing work can finish' });
  const completed = c.controller.workspace().runs[0];
  assert.equal(completed.status, 'awaiting_review'); assert.equal(completed.evidence, null);
  await assert.rejects(c.controller.review(completed.id, { headCommit: HEAD, taskRevision: 1, ownerVersion: 1, decision: 'accept', note: 'No independent checks', }));
  c.controller.policy(task.projectId, { acceptingWork: true, expectedVersion: 2 });
  assert.ok((await c.controller.claim(task.projectId, { agentClientId: AGENT_CLIENT, label: 'New agent' }, 'unpaused-claim')).runId);
});

test('pause during fork preparation prevents credentials from escaping and retry recovers one fork', async () => {
  const c = setup(), project = await c.controller.createTasks(taskInput(), 'pause-race-stack');
  const fork = c.source.fork;
  c.source.fork = async (...args) => { const result = await fork(...args); c.controller.policy(project.projectId, { acceptingWork: false, expectedVersion: 1 }); return result; };
  await assert.rejects(c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent' }, 'pause-race-claim'), { code: 'project_paused' });
  const reserved = c.controller.workspace().runs[0];
  assert.equal(reserved.checkoutState, 'preparing');
  const resource = [...c.repositories.values()].find(item => item.name !== 'starter');
  assert.ok([...resource.tokens.values()].every(token => token.state === 'revoked'));
  c.controller.policy(project.projectId, { acceptingWork: true, expectedVersion: 2 });
  const retry = await c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent' }, 'pause-race-claim');
  assert.equal(retry.runId, reserved.id); assert.equal(c.forks(), 1);
});

test('an abandoned preparation can be closed and reclaimed without reviving its old key', async () => {
  const c = setup(), project = await c.controller.createTasks(taskInput(), 'failed-prep-stack');
  const fork = c.source.fork;
  c.source.fork = async () => { throw new Error('fixture provider unavailable'); };
  await assert.rejects(c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent' }, 'failed-prep-claim'));
  const reserved = c.controller.workspace().runs[0];
  await c.controller.fail(reserved.id, { message: 'Close the interrupted preparation' });
  await assert.rejects(c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent' }, 'failed-prep-claim'), { code: 'ASSIGNMENT_CLOSED' });
  c.source.fork = fork;
  const next = await c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent' }, 'reclaim-after-close');
  assert.equal(next.taskId, project.taskId); assert.notEqual(next.runId, reserved.id);
});

test('unstarted tasks bind the real default branch when claimed, even after outside changes', async () => {
  const c = setup(), project = await c.controller.createTasks(taskInput(), 'fresh-head-stack');
  c.source.branches.set('refs/heads/main', HEAD);
  const result = await c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent' }, 'fresh-head-claim');
  assert.equal(result.credentials.baseCommit, HEAD);
  assert.equal(c.controller.workspace().tasks[0].baseCommit, HEAD);
  assert.ok(c.controller.workspace().events.some(item => item.type === 'task.base_bound'));
  assert.equal(c.controller.workspace().projects[project.projectId].mainCommit, HEAD);
  assert.equal(c.controller.workspace().runs[0].status, 'assigned');
  c.controller.policy(project.projectId, { acceptingWork: false, expectedVersion: 1 });
  assert.throws(() => c.controller.start(result.runId), { code: 'project_paused' });
  await c.controller.fail(result.runId, { message: 'Credentials lost by client' });
  const resource = c.repositories.get(c.store.read().forks[result.runId].name);
  assert.ok([...resource.tokens.values()].every(token => token.state === 'revoked'));
});

test('all external reservations occupy slots, idle claims remain idempotent, and no tokens persist', async () => {
  const c = setup(), project = await c.controller.createTasks({ ...taskInput(), tasks: Array.from({ length: 5 }, taskBrief) }, 'capacity-stack');
  await Promise.all(Array.from({ length: 4 }, (_, index) => c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: `Agent ${index}` }, `capacity-claim-${index}`)));
  await assert.rejects(c.controller.claim(project.projectId, { agentClientId: AGENT_CLIENT, label: 'Agent 5' }, 'capacity-claim-five'), { code: 'CAPACITY_FULL' });
  assert.equal(c.forks(), 4); assert.equal(c.controller.workspace().runs.length, 4);
  assert.ok(c.receipts.every(value => !value.includes(SHORT_TOKEN) && !value.includes(LONG_TOKEN)));
  const empty = setup(), single = await empty.controller.createTasks(taskInput(), 'single-stack');
  await empty.controller.claim(single.projectId, { agentClientId: AGENT_CLIENT, label: 'First' }, 'single-claim');
  assert.equal((await empty.controller.claim(single.projectId, { agentClientId: AGENT_CLIENT, label: 'Idle' }, 'idle-claim')).idle, true);
  await empty.controller.createTasks({ source: 'project', projectId: single.projectId, tasks: [taskBrief()] }, 'later-stack');
  assert.equal((await empty.controller.claim(single.projectId, { agentClientId: AGENT_CLIENT, label: 'Idle' }, 'idle-claim')).idle, true);
});

test('releasing an uncertain task request prevents a late provider response from publishing tasks', async () => {
  const c = setup();
  let began, release;
  const started = new Promise(resolve => { began = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const info = c.source.info;
  c.source.info = async () => { began(); await wait; return info.call(c.source); };
  const pending = c.controller.createTasks(taskInput(), 'release-late-task');
  await started;
  await c.controller.releaseTaskRequest('release-late-task');
  release();
  await assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  assert.equal(c.controller.workspace().tasks.length, 0);
  const result = await c.controller.createTasks(taskInput(), 'next-task-request');
  assert.equal((await c.controller.releaseTaskRequest('next-task-request')).result.taskId, result.taskId);
});

test('legacy hosted task snapshots migrate once into one project per repository', async () => {
  const c = setup(), project = await c.controller.createTasks(taskInput(), 'legacy-project');
  await c.controller.createTasks({ source: 'project', projectId: project.projectId, tasks: [taskBrief()] }, 'legacy-task-two');
  const snapshot = c.store.read(); delete snapshot.workspace.projects;
  for (const task of snapshot.workspace.tasks) { delete task.projectId; delete task.origin; task.repositoryKey = 'starter'; }
  assert.equal(migrateSnapshot(snapshot), true);
  assert.equal(Object.keys(snapshot.workspace.projects).length, 1);
  assert.equal(snapshot.workspace.tasks[0].projectId, snapshot.workspace.tasks[1].projectId);
  assert.equal(migrateSnapshot(snapshot), false);
});

test('paused model projects stop alarms and resume without a repeated allowance', async () => {
  const c = executable(), task = await c.controller.queueModels(modelInput(), 'pause-model-queue');
  const projectId = c.controller.workspace().tasks.find(item => item.id === task.taskId).projectId;
  c.controller.policy(projectId, { acceptingWork: false, expectedVersion: 1 });
  assert.equal(c.controller.hasQueuedWork(), false);
  await c.controller.drainJobs(); assert.equal(c.calls(), 0);
  c.controller.policy(projectId, { acceptingWork: true, expectedVersion: 2 });
  assert.equal(c.controller.hasQueuedWork(), true);
  await c.controller.drainJobs(); await c.controller.drainJobs();
  assert.equal(c.calls(), 2);
});

test('eight authenticated clients share four durable reservations across delayed fork calls', {timeout:5000}, async () => {
  const c=setup(), stack=await c.controller.createTasks({...taskInput(),tasks:Array.from({length:8},taskBrief)},'identity-eight-tasks');
  const pending=[],fork=c.source.fork;let active=0,peak=0,reachedFour;
  const four=new Promise(resolve=>reachedFour=resolve);
  c.source.fork=async(...args)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>{pending.push(resolve);if(pending.length===4)reachedFour();});try{return await fork(...args);}finally{active--;}};
  const clients=testAuthority().policy.agentClientIds.map(id=>new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',id)));
  const jobs=clients.map((client,index)=>client.claim(stack.projectId,{label:'Client '+index},'client-'+index+'-claim').then(value=>({value}),error=>({error})));
  await Promise.race([four,Promise.all(jobs).then(()=>{throw Error('Four admissions never reached the provider barrier');})]);
  assert.equal(pending.length,4);assert.equal(c.controller.workspace().capacity.occupied,4);assert.equal(c.controller.workspace().capacity.reserved,4);
  for(const release of pending)release();const results=await Promise.all(jobs);
  assert.equal(results.filter(item=>item.value?.runId).length,4);assert.equal(results.filter(item=>item.error?.code==='CAPACITY_FULL').length,4);assert.equal(peak,4);assert.equal(c.forks(),4);
  assert.equal(new Set(results.filter(item=>item.value).map(item=>item.value.taskId)).size,4);
  const restored=new HostedController(c.store,c.artifacts,testAuthority());assert.equal(restored.workspace().capacity.occupied,4);assert.equal(restored.workspace().tasks.length,8);
  const first=results[0].value;assert.equal(c.store.read().workspace.runs.find(run=>run.id===first.runId).agentIdentity.id,AGENT_CLIENT);
  const replay=await clients[0].claim(stack.projectId,{label:'Client 0'},'client-0-claim');assert.equal(replay.runId,first.runId);assert.equal(replay.credentials,null);assert.equal(c.forks(),4);
  await assert.rejects(clients[0].claim(stack.projectId,{label:'Changed'},'client-0-claim'),{code:'IDEMPOTENCY_CONFLICT'});
});

test('agent clients cannot operate another assignment, select another identity or invoke owner actions',async()=>{
  const c=setup(), {assignment}=await assigned(c), actor=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace','2'.repeat(32)+'.access'));
  const before=c.store.read(),created=c.forks();
  assert.throws(()=>actor.start(assignment.runId),{code:'ASSIGNMENT_FORBIDDEN'});
  await assert.rejects(actor.complete(assignment.runId,{headCommit:HEAD,summary:'Forged submission'}),{code:'ASSIGNMENT_FORBIDDEN'});
  await assert.rejects(actor.fail(assignment.runId,{reason:'Forged close'}),{code:'ASSIGNMENT_FORBIDDEN'});
  await assert.rejects(actor.createTasks(taskInput(),'forbidden-create'),{code:'OWNER_REQUIRED'});
  await assert.rejects(actor.review(assignment.runId,{}),{code:'OWNER_REQUIRED'});
  await assert.rejects(actor.merge(assignment.runId,{}),{code:'OWNER_REQUIRED'});
  await assert.rejects(actor.verify(assignment.runId,{},'forbidden-check'),{code:'OWNER_REQUIRED'});
  await assert.rejects(actor.drainJobs(),{code:'OWNER_REQUIRED'});
  await assert.rejects(actor.claim(before.workspace.tasks[0].projectId,{label:'Spoof',agentClientId:AGENT_CLIENT},'forged-client'),{code:'IDENTITY_FORGED'});
  assert.deepEqual(c.store.read(),before);assert.equal(c.forks(),created);assert.equal(actor.workspace().capabilities.merge,false);
});

test('idempotency results and credentials cannot be replayed by another principal',async()=>{
  const c=setup(), stack=await c.controller.createTasks(taskInput(),'principal-scoped-task');
  const a=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT));
  const b=new HostedController(c.store,c.artifacts,testAuthority('mock-workspace','2'.repeat(32)+'.access'));
  const first=await a.claim(stack.projectId,{label:'Agent'},'shared-request-key');
  const other=await b.claim(stack.projectId,{label:'Agent'},'shared-request-key');
  assert.equal(other.idle,true);assert.equal(other.runId,undefined);assert.equal(other.credentials,null);assert.equal(c.forks(),1);
  assert.equal((await a.claim(stack.projectId,{label:'Agent'},'shared-request-key')).runId,first.runId);
});

test('workspace capacity is independent and foreign resource identities are refused before provider work',async()=>{
  const a=setup(),b=setup(undefined,'second-workspace');
  const stack=await a.controller.createTasks({...taskInput(),tasks:Array.from({length:4},taskBrief)},'first-workspace-stack');
  for(let index=0;index<4;index++)await a.controller.claim(stack.projectId,{agentClientId:AGENT_CLIENT,label:'A'+index},'first-claim-'+index);
  const second=await b.controller.createTasks(taskInput(),'second-workspace-task');
  await b.controller.claim(second.projectId,{agentClientId:AGENT_CLIENT,label:'B'},'second-claim');
  assert.equal(a.controller.workspace().capacity.occupied,4);assert.equal(b.controller.workspace().capacity.occupied,1);
  const before=b.store.read(),forks=b.forks();
  assert.throws(()=>new HostedController(b.store,b.artifacts,testAuthority()),{code:'WORKSPACE_FORBIDDEN'});
  await assert.rejects(b.controller.claim(stack.projectId,{agentClientId:AGENT_CLIENT,label:'Foreign'},'foreign-workspace-request'));
  assert.deepEqual(b.store.read(),before);assert.equal(b.forks(),forks);
});

test('review identity is server-derived, spoof fields refuse mutation and handoffs retain its provenance',async()=>{
  const c=await commandContext(),id=c.assignment.runId;
  await c.controller.configureChecks(id,c.plan(),'identity-review-checks');
  const before=c.store.read();
  for(const field of ['reviewer','identity','reviewerIdentity','principal'])await assert.rejects(c.controller.review(id,{...c.review(),[field]:'Forged owner'}),{code:'IDENTITY_FORGED'});
  assert.deepEqual(c.store.read(),before);
  await acceptAfterIndependentReview(c, id,c.review());
  const review=c.store.read().workspace.runs.find(run=>run.id===id).review;
  const {issuedAt,expiresAt,...identity}=testAuthority().principal;
  assert.deepEqual(review.identity,identity);assert.equal(review.reviewer,'owner@example.test');
  const handoff=await c.controller.handoff(c.task.taskId);
  assert.deepEqual(handoff.payload.runs[0].review.identity,review.identity);
  assert.equal(JSON.stringify(handoff).includes(CONTROL_TOKEN),false);
});

test('adoption preserves historical attribution and invalidates only unmerged legacy acceptance',async()=>{
  const c=await commandContext(),id=c.assignment.runId;
  await c.controller.configureChecks(id,c.plan(),'adoption-check');await acceptAfterIndependentReview(c, id,c.review());
  const old=c.store.read();delete old.workspace.authentication;delete old.workspace.runs[0].review.identity;
  const legacy=structuredClone(old.workspace.runs[0].review);c.store.write({...old,revision:old.revision+1},old.revision);
  const owner=new HostedController(c.store,c.artifacts,testAuthority(),c.runtime);
  assert.equal(owner.workspace().authentication.adoptionRequired,true);
  await assert.rejects(owner.merge(id,{headCommit:HEAD}),{code:'OWNER_ADOPTION_REQUIRED'});
  owner.adoptOwner();const result=c.store.read().workspace.runs[0];
  assert.equal(result.review,null);assert.equal(result.status,'awaiting_review');assert.deepEqual(result.reviewHistory.at(-1),legacy);assert.equal(result.reviewHistory.at(-1).identity,undefined);
  await owner.review(id,c.review());assert.equal(c.store.read().workspace.runs[0].review.identity.kind,'owner');
});

test('pending operations and owner rebinding refuse adoption without changing retained records',async()=>{
  const c=setup(),{assignment}=await assigned(c),before=c.store.read();delete before.workspace.authentication;
  c.store.write({...before,revision:before.revision+1},before.revision);const saved=c.store.read();
  const owner=new HostedController(c.store,c.artifacts,testAuthority());assert.throws(()=>owner.adoptOwner(),{code:'ADOPTION_OPERATIONS_PENDING'});assert.deepEqual(c.store.read(),saved);
  assert.throws(()=>new HostedController(c.store,c.artifacts,testAuthority('mock-workspace',AGENT_CLIENT)),{code:'OWNER_ADOPTION_REQUIRED'});
  const original=setup(),changed=testAuthority();changed.policy.ownerSubject='new-owner';changed.principal.id='new-owner';
  assert.throws(()=>new HostedController(original.store,original.artifacts,changed),{code:'WORKSPACE_OWNER_MISMATCH'});
});

test('expired delayed checks retain two-slot occupancy until cancellation settles, then late results stay fenced', {timeout:5000}, async()=>{
  const c=await commandContext(), firstId=c.assignment.runId;
  const batch=await c.controller.createTasks({source:'project',projectId:c.task.projectId,tasks:[taskBrief(),taskBrief()]},'delayed-checks-tasks');
  const ids=[firstId];
  for(const [index,taskId]of batch.taskIds.entries()){
    const assignment=await c.controller.assign(taskId,{agentClientId:AGENT_CLIENT,label:'Verifier candidate '+index},'delayed-checks-agent-'+index);
    c.controller.start(assignment.runId);const fork=c.repositories.get(c.store.read().forks[assignment.runId].name);fork.branches.set('refs/heads/'+assignment.credentials.branch,HEAD);
    await c.controller.complete(assignment.runId,{headCommit:HEAD,summary:'Check capacity fixture'});ids.push(assignment.runId);
  }
  const entries=[],waiters=[];let active=0,peak=0;
  const entered=count=>entries.length>=count?Promise.resolve():new Promise(resolve=>waiters.push({count,resolve}));
  c.runtime.repositoryChecks.observe=async(attempt)=>{
    active++;peak=Math.max(peak,active);
    try{return await new Promise(resolve=>{entries.push({attempt,release:()=>resolve({stdout:'after\n',exitCode:0,image:'sha256:'+'a'.repeat(64)})});for(const waiter of waiters)if(entries.length>=waiter.count)waiter.resolve();});}
    finally{active--;}
  };
  const first=c.controller.configureChecks(ids[0],c.plan(ids[0]),'held-first').then(value=>({value}),error=>({error}));
  const second=c.controller.configureChecks(ids[1],c.plan(ids[1]),'held-second');await entered(2);
  assert.equal(active,2);assert.equal(c.controller.workspace().capacity.verification.occupied,2);
  await assert.rejects(c.controller.configureChecks(ids[2],c.plan(ids[2]),'held-third'),{code:'VERIFICATION_CAPACITY'});
  const old=c.store.read(),operation=Object.values(old.operations).find(op=>op.kind==='checks'&&op.itemId===ids[0]);operation.leaseUntil=0;c.store.write({...old,revision:old.revision+1},old.revision);
  await assert.rejects(c.controller.configureChecks(ids[2],c.plan(ids[2]),'held-third'),{code:'VERIFICATION_CAPACITY'});
  let releaseStop,stopEntered;const stopping=new Promise(resolve=>stopEntered=resolve),stopGate=new Promise(resolve=>releaseStop=resolve);
  c.runtime.cancelVerification=async(attempt)=>{stopEntered();await stopGate;entries.find(entry=>entry.attempt===attempt).release();await first;assert.equal(active,1);};
  const recovery=c.controller.configureChecks(ids[0],c.plan(ids[0]),'held-first');await stopping;
  assert.equal(c.controller.workspace().capacity.verification.occupied,2);assert.equal(active,2);
  releaseStop();await recovery;assert.equal((await first).error.code,'STALE_OPERATION');
  assert.equal(c.controller.workspace().runs.find(run=>run.id===ids[0]).evidence.verified,false);
  const third=c.controller.configureChecks(ids[2],c.plan(ids[2]),'held-third');await entered(3);assert.equal(active,2);
  for(const entry of entries)entry.release();await Promise.all([second,third]);assert.equal(active,0);assert.equal(peak,2);assert.equal(c.controller.workspace().capacity.verification.occupied,0);
});
