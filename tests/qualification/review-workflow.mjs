// Private hosted boundary qualification. Every assessment here is scripted;
// this script never invokes a model provider or claims review quality.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory,reviewers,setup,receipt,request,ok,control,passed,save} from './client.mjs';

const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
const sourceCommit=git('rev-parse','HEAD'),sourceTree=git('rev-parse','HEAD^{tree}');
const config=await readFile('qa/identity-concurrency/hosted.wrangler.jsonc');
receipt.source={commit:sourceCommit,tree:sourceTree};
receipt.configuration={sha256:createHash('sha256').update(config).digest('hex'),audience:setup.audience,
  issuer:setup.issuer,hostname:setup.hostname,workspace:setup.workspace,reviewerClientIds:reviewers.map(item=>item.client_id)};
let failure;
try{
  const candidates=JSON.parse(await readFile(join(privateDirectory,'container-candidates.json'),'utf8'));
  const candidate=candidates[1];
  if(!candidate)throw Error('Prepare three committed candidate fixtures before review qualification.');
  const runId=candidate.runId,contextPath=`/api/runs/${runId}/review-context`;
  const initial=await ok('owner','/api/workspace');
  const run=initial.runs.find(item=>item.id===runId),task=initial.tasks.find(item=>item.id===candidate.taskId);
  assert.equal(run?.evidence?.verified,true);assert.equal(run.evidence.passed,run.evidence.total);
  assert.equal(run.status,'awaiting_review');
  assert.deepEqual(reviewers.map(item=>item.client_id).sort(),initial.authentication.reviewerClientIds.slice().sort());
  assert.ok(!reviewers.some(item=>JSON.stringify(initial).includes(item.client_secret)));
  for(const who of ['reviewer:0','reviewer:1'])assert.equal((await request(who,'/api/workspace')).status,403);
  assert.equal((await request('reviewer:0',contextPath)).status,403);
  assert.equal((await request('reviewer:1',`/api/runs/${crypto.randomUUID()}/review-context`)).status,404);
  passed('two verified reviewer identities have no workspace or foreign-candidate access before assignment');

  const beforeContext=await ok('owner',contextPath);
  const personal=await ok('owner',`/api/runs/${runId}/review-assignments`,{
    contextId:beforeContext.contextId,expectedVersion:initial.version,reviewerIds:[reviewers[0].client_id]});
  assert.equal(personal.assignment.reviewerIds.length,1);
  assert.equal((await ok('reviewer:0','/api/review-inbox')).items.find(item=>item.runId===runId).assignmentScope,'personal');
  assert.equal((await ok('reviewer:1','/api/review-inbox')).total,0);
  assert.equal((await request('reviewer:1',contextPath)).status,403);
  passed('personal inbox and source are scoped to the assigned reviewer');

  const afterPersonal=await ok('owner','/api/workspace');
  const teamContext=await ok('owner',contextPath);
  await ok('owner',`/api/runs/${runId}/review-assignments`,{
    contextId:teamContext.contextId,expectedVersion:afterPersonal.version,reviewerIds:reviewers.map(item=>item.client_id)});
  const packet0=await ok('reviewer:0',contextPath),packet1=await ok('reviewer:1',contextPath);
  assert.equal(packet0.contextId,packet1.contextId);
  assert.equal(packet0.context.headCommit,candidate.head);
  assert.equal(packet0.context.reviewAssignmentId,packet1.context.reviewAssignmentId);
  for(const who of ['reviewer:0','reviewer:1']){
    const inbox=await ok(who,'/api/review-inbox');
    assert.equal(inbox.items.find(item=>item.runId===runId).assignmentScope,'team');
    for(const action of ['start','submit','checks','review','merge'])
      assert.equal((await request(who,`/api/runs/${runId}/${action}`,{})).status,403);
  }
  passed('team inbox shares only assigned sealed source; neither reviewer gains builder or owner actions');

  const original={format:'projects-code-review-assessment/v2',contextId:packet0.contextId,verdict:'changes_requested',
    summary:'Scripted boundary finding only; no product defect is claimed.',resolvedPriorFindingIds:[],
    findings:[{title:'Scripted review boundary',body:'This injected finding tests retained decisions and cross-reviewer resolution.',priority:1,
      location:{path:'qualification.txt',side:'head',startLine:1,endLine:1},evidence:'Synthetic fixture line only.'}]};
  const first=await ok('reviewer:0',`/api/runs/${runId}/code-review`,original);
  assert.equal(first.codeReview.identity.id,reviewers[0].client_id);
  const findingId=first.codeReview.findings[0].id;
  const ownerState=await ok('owner','/api/workspace');
  const decision=await ok('owner',`/api/runs/${runId}/findings/${findingId}/decision`,{
    assessmentId:first.codeReview.id,decision:'deferred',note:'Scripted hosted boundary case; await explicit reviewer resolution.',expectedVersion:ownerState.version});
  assert.equal(decision.findingDecision.identity.id,setup.ownerSubject);
  const unresolved={...original,verdict:'pass',summary:'Scripted attempt to discard a prior finding.',findings:[]};
  const refused=await request('reviewer:1',`/api/runs/${runId}/code-review`,unresolved);
  assert.equal(refused.status,409);assert.equal(refused.result.code,'unresolved_prior_findings');
  const resolved=await ok('reviewer:1',`/api/runs/${runId}/code-review`,{
    ...unresolved,summary:'Scripted second reviewer explicitly resolved the retained fixture finding.',resolvedPriorFindingIds:[findingId]});
  assert.equal(resolved.codeReview.identity.id,reviewers[1].client_id);
  assert.deepEqual(resolved.codeReview.unresolvedFindingIds,[]);
  const historical=await ok('owner','/api/workspace');
  const retained=historical.runs.find(item=>item.id===runId);
  assert.equal(retained.codeReviewHistory.at(-1).id,first.codeReview.id);
  assert.equal(retained.findingDecisions.at(-1).id,decision.findingDecision.id);
  assert.equal(retained.review,null);
  passed('cross-reviewer finding history, owner deferral, blocked premature pass and explicit resolution remain separate');

  const attemptKey=crypto.randomUUID(),reservationInput={assignmentId:packet0.context.reviewAssignmentId,
    contextId:packet0.contextId,model:'scripted-reviewer',maxInputBytes:8192,maxOutputTokens:1024,timeoutMs:5000};
  const reservation=await ok('reviewer:0',`/api/runs/${runId}/review-inference`,reservationInput,attemptKey);
  assert.equal(reservation.replayed,false);
  const occupied=await ok('owner','/api/workspace');
  receipt.peakOccupied=Math.max(receipt.peakOccupied,occupied.capacity.occupied);
  assert.equal(occupied.reviewInferences.find(item=>item.attemptId===reservation.attemptId).state,'pending');
  assert.equal((await ok('reviewer:0',`/api/runs/${runId}/review-inference`,reservationInput,attemptKey)).replayed,true);
  assert.equal((await request('reviewer:0',`/api/runs/${runId}/review-inference`,{...reservationInput,model:'changed'},attemptKey)).status,409);
  assert.equal((await request('reviewer:0',`/api/runs/${runId}/code-review`,unresolved)).status,409);
  await control('/restart');
  assert.equal((await ok('owner','/api/workspace')).reviewInferences.find(item=>item.attemptId===reservation.attemptId).state,'pending');
  assert.equal((await request('owner',`/api/tasks/${task.id}/owner`,{owner:'Changed during inference',expectedOwnerVersion:task.ownerVersion})).status,409);
  const beforeRecovery=await ok('owner','/api/workspace');
  await ok('owner',`/api/runs/${runId}/review-inference/${reservation.attemptId}/reconcile`,{
    expectedRevision:beforeRecovery.sourceRevision,note:'Scripted operator confirms no provider request was started.'});
  assert.equal((await request('reviewer:0',`/api/runs/${runId}/code-review`,{...unresolved,reviewAttemptId:reservation.attemptId},attemptKey)).status,409);
  assert.equal((await request('reviewer:0',`/api/runs/${runId}/code-review`,unresolved)).status,409);
  const after=await ok('owner','/api/workspace');
  assert.equal(after.reviewInferences.find(item=>item.attemptId===reservation.attemptId).state,'failed');
  assert.equal(after.runs.find(item=>item.id===runId).codeReview.id,resolved.codeReview.id);
  passed('reserved inference survives restart, fences changes, and rejects late results after owner reconciliation');
}catch(error){failure=error;}finally{await save('review-workflow',failure);}if(failure)throw failure;
