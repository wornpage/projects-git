import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateLifecycle} from '../public/task-lifecycle.js';
import {taskLifecycle} from '../public/ui/task-lifecycle.js';
import {independentReviewBinding} from '../public/review-boundary.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

function fixture() {
  const task={id:'task',projectId:'project',title:'Useful change',purpose:'Agreed result',criteria:['Works'],revision:1,ownerVersion:1,baseCommit:'a'.repeat(40)};
  const run={id:'candidate',taskId:task.id,label:'Builder A',status:'awaiting_review',headCommit:'b'.repeat(40),changedFiles:['report.py'],review:null,
    reviewAssignments:[{id:'assignment',reviewerIds:['reviewer']}],
    evidence:{verified:true,source:'independent-sandbox-checks',commit:'b'.repeat(40),taskRevision:1,passed:2,total:2,exitCode:0,command:'checks',checks:[{name:'One',passed:true},{name:'Two',passed:true}]}};
  const workspace={id:'workspace',provider:'cloudflare-artifacts',tasks:[task],runs:[run]};
  const stage=id=>candidateLifecycle(workspace,run).find(stage=>stage.id===id);
  const passReview=()=>{run.codeReview={id:'assessment',format:'projects-code-review-assessment/v2',assignmentId:'assignment',
    identity:{id:'reviewer',issuer:'https://access.example.test',kind:'reviewer',provider:'cloudflare-access',workspaceId:workspace.id},
    context:independentReviewBinding(workspace,run),verdict:'pass',unresolvedFindingIds:[]};};
  const accept=()=>{task.acceptedRunId=run.id;run.status='accepted';run.review={decision:'accept',headCommit:run.headCommit,taskRevision:task.revision,
    ownerVersion:task.ownerVersion,codeReviewId:run.codeReview?.id,
    identity:{id:'owner',kind:'owner',provider:'cloudflare-access',workspaceId:workspace.id}};};
  return {workspace,task,run,stage,passReview,accept};
}

test('checks, independent review, owner acceptance and merge are separate facts',()=>{
  const f=fixture();
  assert.deepEqual(candidateLifecycle(f.workspace,f.run).map(s=>s.label),['Commit submitted','Passed','Awaiting reviewer','Not recorded','Not merged']);
  f.passReview();assert.equal(f.stage('review').label,'Passed');assert.equal(f.stage('decision').label,'Not recorded');
  f.accept();assert.equal(f.stage('decision').label,'Accepted');assert.equal(f.stage('merge').label,'Not merged');
  f.run.status='merged';f.task.mergedCommit=f.run.headCommit;
  assert.equal(f.stage('merge').label,'Merged');assert.match(f.stage('checks').detail,/Acceptance-time report: 2 \/ 2/);
});

test('a later merge does not manufacture missing check, reviewer or owner receipts',()=>{
  const f=fixture();f.run.status='merged';f.task.acceptedRunId=f.run.id;f.task.mergedCommit=f.run.headCommit;f.run.evidence=null;
  assert.deepEqual(candidateLifecycle(f.workspace,f.run).map(s=>s.label),['Commit submitted','Not recorded','Historical / missing','Not recorded','Merged']);
});

test('policy approval is displayed separately from authenticated human acceptance',()=>{
  const f=fixture();f.passReview();f.accept();delete f.run.review.identity;
  f.run.review.policy={mode:'checks-and-independent-review',version:2,enabledBy:{displayName:'Workspace owner'}};
  assert.equal(f.stage('decision').title,'Policy decision');assert.equal(f.stage('decision').label,'Accepted');
  assert.match(f.stage('decision').detail,/Automatic policy v2/);assert.doesNotMatch(f.stage('decision').detail,/Authenticated owner decision/);
});

test('local attribution and unavailable independent review stay explicit after merge',()=>{
  const f=fixture();f.workspace.provider='local-git';f.accept();delete f.run.review.identity;
  f.run.status='merged';f.task.mergedCommit=f.run.headCommit;
  assert.equal(f.stage('review').label,'Hosted only');assert.equal(f.stage('review').tone,'history');
  assert.equal(f.stage('decision').label,'Accepted');assert.equal(f.stage('decision').detail,'Local attribution.');
});

test('verification in progress retains the previous denominator without claiming it passed',()=>{
  const f=fixture();f.passReview();f.run.verificationPending=true;
  assert.equal(f.stage('checks').label,'Running');assert.equal(f.stage('checks').detail,'Previous report: 2 / 2 checks passing');
  assert.equal(f.stage('review').label,'Stale');
});

test('zero checks, nonzero exit, failing and stale reports never display a passing stage',()=>{
  for(const patch of [{total:0,passed:0},{exitCode:1},{passed:1},{taskRevision:2},{commit:'c'.repeat(40)},{verified:false}]){
    const f=fixture();Object.assign(f.run.evidence,patch);
    assert.notEqual(f.stage('checks').label,'Passed',JSON.stringify(patch));
    assert.notEqual(f.stage('checks').tone,'complete');
  }
});

test('changed requirements, reviewer requests and owner identity invalidate acceptance presentation',()=>{
  for(const change of [f=>f.task.revision++,f=>f.task.ownerVersion++,f=>f.run.codeReview.unresolvedFindingIds=['finding'],
    f=>f.run.reviewAssignments.push({id:'next',reviewerIds:['reviewer']}),f=>delete f.run.review.identity,
    f=>f.run.review.identity.workspaceId='foreign']){
    const f=fixture();f.passReview();f.accept();change(f);
    assert.notEqual(f.stage('decision').label,'Accepted');assert.notEqual(f.stage('decision').tone,'complete');
  }
});

test('historical hosted acceptance remains historical even when the merge is retained',()=>{
  const f=fixture();f.passReview();f.accept();delete f.run.review.identity;f.run.status='merged';f.task.mergedCommit=f.run.headCommit;
  assert.equal(f.stage('decision').label,'Historical acceptance');assert.equal(f.stage('decision').detail,'Unauthenticated historical attribution.');
  assert.equal(f.stage('merge').label,'Merged');
});

test('rejected decisions and failed attempts remain visible with retained commits',()=>{
  const f=fixture();f.run.status='rejected';f.run.review={decision:'reject',headCommit:f.run.headCommit,taskRevision:1};
  assert.equal(f.stage('decision').label,'Rejected');assert.equal(f.stage('merge').label,'Not merged');
  f.run.status='failed';assert.equal(f.stage('work').label,'Execution failed');assert.match(f.stage('work').detail,/commit was retained/);
});

test('an alternative never inherits another candidate acceptance or merge',()=>{
  const f=fixture();f.task.acceptedRunId='other';f.task.mergedCommit='c'.repeat(40);f.run.status='superseded';
  assert.equal(f.stage('decision').label,'Not recorded');assert.equal(f.stage('merge').label,'Not merged');
  assert.equal(f.stage('merge').detail,'Another candidate was integrated.');
});

test('uncertain and active merge operations override a completion presentation',()=>{
  const f=fixture();f.passReview();f.accept();
  for(const [state,label] of [['running','In progress'],['recovery-required','Recovery required']]){
    f.workspace.mergeStateByRun={[f.run.id]:state};assert.equal(f.stage('merge').label,label);assert.notEqual(f.stage('merge').tone,'complete');
  }
});

test('uncommitted work has readable waiting states and no links to missing candidate evidence',()=>{
  const f=fixture();f.run.headCommit=null;f.run.evidence=null;f.run.status='assigned';
  assert.equal(f.stage('work').label,'Waiting to start');assert.ok(candidateLifecycle(f.workspace,f.run).every(s=>!s.section&&!s.view));
});

test('stage navigation keeps candidate identity, supports modified links and never mutates workspace state',async()=>{
  installFakeDOM();const f=fixture(),before=structuredClone(f.workspace),calls=[];
  const view=taskLifecycle(f.workspace,f.run,(...args)=>calls.push(args));
  const link=view.querySelector('#lifecycle-checks-candidate');
  assert.match(link.attrs.href,/view=review&task=task&candidate=candidate#verification$/);
  await link.dispatch('click',{button:0,ctrlKey:true});assert.equal(calls.length,0);
  await link.dispatch('click',{button:0});assert.deepEqual(calls,[['review','task','candidate',{section:'verification'}]]);
  assert.deepEqual(f.workspace,before);assert.equal(view.querySelector('ol').children.length,5);
  assert.equal(view.querySelector('ol').attrs.role,'list','Markerless stages retain explicit list semantics');
});
