import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun,completeRun,verifyRun,assignReviewers,codeReviewContext,recordCodeReview,reviewRun,mergeRun,coordination} from '../src/core/workflow.mjs';
import {reviewNextStep} from '../public/review-handoff.js';

function fixture() {
  const workspace=createWorkspace({id:'review-guidance',provider:'cloudflare-artifacts'});
  const task=createTask(workspace,{title:'Fix totals',purpose:'Exact totals',criteria:['Reject invalid input'],baseCommit:'a'.repeat(40),owner:'Owner'});
  task.projectId='project';workspace.projects={project:{mainCommit:task.baseCommit}};
  workspace.authentication={subject:'owner',principal:{kind:'owner',id:'owner',displayName:'Alex'},reviewerClientIds:['reviewer'],reviewerSubjects:[]};
  workspace.reviewerNames={reviewer:'Code reviewer'};
  const run=assignRun(workspace,task.id,{agent:'external',label:'Builder A',branch:'candidate'});
  run.agentIdentity={provider:'cloudflare-access',kind:'agent',issuer:'https://fixture.cloudflareaccess.com',id:'builder',workspaceId:workspace.id,displayName:'Builder A'};
  startRun(workspace,run.id);completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['index.mjs'],diff:'+ checked',summary:'Candidate'});
  const checks=()=>verifyRun(workspace,run.id,{verified:true,source:'independent-sandbox-checks',commit:run.headCommit,taskRevision:task.revision,
    passed:1,total:1,exitCode:0,checks:[{name:'Input',passed:true,detail:'Observed'}],command:'node check.mjs',output:'pass',verifiedAt:new Date().toISOString()});
  checks();
  const reviewer={...run.agentIdentity,kind:'reviewer',id:'reviewer',displayName:'Code reviewer'};
  const assign=()=>assignReviewers(workspace,run.id,{contextId:codeReviewContext(workspace,run.id).contextId,expectedVersion:workspace.version,reviewerIds:[reviewer.id]},
    {...reviewer,kind:'owner',id:'owner'},[reviewer.id],crypto.randomUUID());
  const assess=()=>recordCodeReview(workspace,run.id,{format:'projects-code-review-assessment/v2',contextId:codeReviewContext(workspace,run.id).contextId,
    verdict:'pass',summary:'Reviewed the source.',findings:[],resolvedPriorFindingIds:[]},reviewer,crypto.randomUUID());
  const choose=()=>reviewRun(workspace,run.id,{decision:'accept',note:'Inspected',reviewer:'Owner',headCommit:run.headCommit,taskRevision:task.revision,ownerVersion:task.ownerVersion,comparisons:[]});
  const read=()=>{workspace.coordination={[run.id]:coordination(workspace,run.id)};const before=structuredClone(workspace),value=reviewNextStep(workspace,run);assert.deepEqual(workspace,before);return value;};
  return {workspace,task,run,checks,assign,assess,choose,read};
}

test('unassigned review belongs to the owner; rendering does not satisfy the review gate',()=>{
  const f=fixture(),next=f.read();assert.match(next.owner,/Workspace owner · Alex/);assert.match(next.waiting.join(' '),/assignment/);
  assert.throws(f.choose,{code:'independent_review_required'});
});
test('saved assignment identifies the reviewer without claiming dispatch',()=>{
  const f=fixture();f.assign();const next=f.read();assert.equal(next.owner,'Assigned reviewer · Code reviewer');
  assert.match(next.next,/coding host must start or continue/);assert.match(next.waiting[0],/does not confirm that review has started/);
  f.workspace.reviewInferences=[{runId:f.run.id,state:'pending'}];assert.match(f.read().next,/reserved an attempt/);
});
test('redacted reviewer lists do not claim that workspace reviewer configuration is missing',()=>{
  const f=fixture();f.workspace.authentication.principal.kind='agent';f.workspace.authentication.reviewerClientIds=[];
  assert.match(f.read().next,/Choose a configured independent reviewer/);f.assign();assert.equal(f.read().owner,'Assigned independent reviewer');
});
test('missing, failed and running checks identify the actual next responsible actor',()=>{
  const f=fixture();f.run.evidence=null;assert.match(f.read().owner,/Workspace owner/);assert.match(f.read().next,/Configure and run/);
  f.checks();f.run.evidence.passed=0;f.run.evidence.exitCode=1;assert.equal(f.read().owner,'Builder · Builder A');
  assert.match(f.read().waiting[0],/Every required check/);
  f.run.verificationPending=true;assert.equal(f.read().owner,'Verifier');
});
test('stale and revoked review never hand the next step to automatic integration',()=>{
  for(const change of [f=>f.task.ownerVersion++,f=>f.workspace.reviewRequests={[f.run.id]:'reviewer-unavailable'}]) {
    const f=fixture();f.assign();f.assess();f.workspace.projects.project.automaticMergePolicy={enabled:true,version:1};change(f);
    assert.match(f.read().owner,/Workspace owner/);assert.match(f.read().next,/Renew the review request/);
    assert.throws(f.choose,{code:'independent_review_required'});
  }
});
test('blocking findings return work to the builder and leave acceptance refused',()=>{
  const f=fixture();f.assign();f.assess();f.run.codeReview.unresolvedFindingIds=['earlier-blocker'];
  assert.equal(f.read().owner,'Builder · Builder A');assert.match(f.read().waiting[0],/resolution of blocking findings/);
  assert.throws(f.choose,{code:'independent_review_required'});
});
test('passing review separates manual choice, automatic evaluation and explicit merge',()=>{
  const f=fixture();f.assign();f.assess();assert.match(f.read().owner,/Workspace owner/);assert.match(f.read().integration,/automatic integration off/);
  f.workspace.projects.project.automaticMergePolicy={enabled:true,version:1};assert.equal(f.read().owner,'Automatic merge policy');
  assert.match(f.read().waiting.join(' '),/Policy evaluation.*fresh merge checks/);
  f.choose();assert.match(f.read().owner,/Workspace owner/);assert.match(f.read().next,/Request the guarded merge/);
  assert.equal(f.task.mergedCommit,null);
});
test('automatic integration still explains competing candidates, overlaps and server blockers',()=>{
  const f=fixture();f.assign();f.assess();f.workspace.projects.project.automaticMergePolicy={enabled:true,version:1};
  const other={...structuredClone(f.run),id:'other',changedFiles:['other.mjs']};f.workspace.runs.push(other);
  assert.match(f.read().owner,/Workspace owner/);assert.match(f.read().waiting[0],/explicit choice/);
  other.status='running';assert.equal(f.read().owner,'Related builders');
  f.workspace.runs.pop();delete f.task.owner;assert.match(f.read().waiting.join(' '),/current named task owner/);
});
test('missing prerequisite projection explicitly withholds an eligibility claim',()=>{
  const f=fixture();f.assign();f.assess();f.workspace.projects.project.automaticMergePolicy={enabled:true,version:1};
  const next=reviewNextStep(f.workspace,f.run);assert.match(next.waiting[0],/Eligibility has not been established/);
  assert.match(next.owner,/Workspace owner/);
});
test('a newer passing assessment cannot reuse an older owner acceptance in the guidance',()=>{
  const f=fixture();f.assign();f.assess();f.choose();f.run.review.codeReviewId='old-assessment';
  assert.match(f.read().next,/Renew the candidate decision/);assert.match(f.read().waiting[0],/bound to this assessment/);
});
test('policy queued, stopped and uncertain merges have distinct responsibility',()=>{
  const f=fixture();f.assign();f.assess();f.choose();
  f.workspace.projects.project.automaticMergePolicy={enabled:true,version:1};f.run.review.policy={version:1,decisionId:'decision'};
  assert.equal(f.read().owner,'Automatic merge policy');
  f.run.automaticMergeStop={decisionId:'decision',phase:'before-write'};assert.match(f.read().owner,/Workspace owner/);
  f.workspace.mergeStateByRun={[f.run.id]:'running'};assert.equal(f.read().owner,'Merge verifier');
  f.workspace.mergeStateByRun[f.run.id]='recovery-required';assert.match(f.read().owner,/Workspace owner/);assert.match(f.read().waiting[0],/Refresh does not retry/);
});
test('completed results and read-only examples do not manufacture pending live work',()=>{
  const f=fixture();f.assign();f.assess();f.choose();mergeRun(f.workspace,f.run.id,{headCommit:f.run.headCommit,baseCommit:f.task.baseCommit,mergedCommit:f.run.headCommit});
  assert.equal(f.read().owner,'No action required');assert.deepEqual(f.read().waiting,[]);
  const demo=reviewNextStep(f.workspace,f.run,{demo:true});assert.equal(demo.owner,'Viewer');assert.match(demo.waiting[0],/No live work/);
  assert.equal(demo.integration,'Read-only example');
  f.workspace.mergeStateByRun={[f.run.id]:'recovery-required'};
  assert.match(f.read().owner,/Workspace owner/,'A retained operation still needs reconciliation even beside a completed candidate record');
});
test('local attribution remains distinct from hosted independent review',()=>{
  const f=fixture();f.workspace.provider='local-git';assert.equal(f.read().integration,'Local operator decisions');
});
