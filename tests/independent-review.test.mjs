import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun,completeRun,verifyRun,reviewRun,mergeRun,codeReviewContext,recordCodeReview,recordFindingDecision,assignReviewers,independentReviewStatus,reviseTask,setTaskOwner} from '../src/core/workflow.mjs';
import {buildTaskHandoff} from '../src/core/handoff.mjs';
const base='a'.repeat(40),head='b'.repeat(40);
const finding=(path='index.mjs')=>({title:'Incorrect boundary',body:'The changed expression can return the wrong result.',priority:1,
 location:{path,side:'head',startLine:1,endLine:1},evidence:'The committed diff adds this expression.'});
const assessment=(contextId,verdict='pass',findings=verdict==='pass'?[]:[finding()],resolvedPriorFindingIds=[])=>({format:'projects-code-review-assessment/v2',contextId,
 verdict,summary:'Inspected requirements, candidate and trusted evidence.',findings,resolvedPriorFindingIds});
function fixture(){
 const state=createWorkspace({id:'review-workspace',provider:'cloudflare-artifacts'});
 const task=createTask(state,{title:'Independent review',purpose:'Require a separate assessment',criteria:['Preserve the boundary'],baseCommit:base,owner:'Owner'});
 const run=assignRun(state,task.id,{agent:'external',label:'Builder',branch:'candidate'});
 run.agentIdentity={provider:'cloudflare-access',kind:'agent',issuer:'https://fixture.cloudflareaccess.com',id:'builder',workspaceId:state.id,displayName:'Builder'};
 startRun(state,run.id);completeRun(state,run.id,{headCommit:head,changedFiles:['index.mjs'],diff:'+ source',summary:'Builder claims success'});
 verifyRun(state,run.id,{verified:true,commit:head,taskRevision:1,passed:1,total:1,checks:[{name:'Trusted check',passed:true,detail:'observed'}],command:'node trusted.mjs',exitCode:0,output:'pass',verifiedAt:new Date().toISOString(),source:'independent-sandbox-checks',verification:{kind:'repository-command-checks/v1',definitionSha256:'1'.repeat(64),verifierSha256:'2'.repeat(64),inputHandoffSha256:'3'.repeat(64),requirementsSha256:'4'.repeat(64),image:'sha256:'+'5'.repeat(64),tree:'6'.repeat(40)}});
 const reviewer={...run.agentIdentity,id:'reviewer',kind:'reviewer',displayName:'Read-only reviewer'};
 assignReviewers(state,run.id,{contextId:codeReviewContext(state,run.id).contextId,expectedVersion:state.version,reviewerIds:[reviewer.id]},
   {...reviewer,kind:'owner',id:'owner',displayName:'Owner'},[reviewer.id],'initial-assignment');
 const assess=(verdict='pass',key=crypto.randomUUID())=>recordCodeReview(state,run.id,assessment(codeReviewContext(state,run.id).contextId,verdict,
   verdict==='pass'?[]:[finding()],verdict==='pass'?run.codeReview?.unresolvedFindingIds??[]:[]),reviewer,key);
 const accept=()=>reviewRun(state,run.id,{decision:'accept',note:'Owner approved',reviewer:'Owner',headCommit:head,taskRevision:task.revision,ownerVersion:task.ownerVersion,comparisons:[]});
 return {state,task,run,reviewer,assess,accept};
}
test('passing automated checks cannot substitute for independent review or owner acceptance',()=>{
 const c=fixture();assert.throws(c.accept,{code:'independent_review_required'});c.assess();assert.equal(c.run.status,'awaiting_review');assert.equal(c.task.acceptedRunId,null);
 assert.throws(()=>mergeRun(c.state,c.run.id,{headCommit:head,baseCommit:base,mergedCommit:head}),{code:'acceptance_required'});
 c.accept();assert.equal(c.run.review.codeReviewId,c.run.codeReview.id);mergeRun(c.state,c.run.id,{headCommit:head,baseCommit:base,mergedCommit:head});assert.equal(c.task.mergedCommit,head);
});
test('owner, builder, foreign workspace, self-review and forged identity/context fields cannot supply review',()=>{
 const c=fixture(),input=assessment(codeReviewContext(c.state,c.run.id).contextId);
 for(const actor of [{...c.reviewer,kind:'owner'},{...c.reviewer,kind:'agent'},{...c.reviewer,workspaceId:'foreign'}])assert.throws(()=>recordCodeReview(c.state,c.run.id,input,actor),{code:'reviewer_required'});
 assert.throws(()=>recordCodeReview(c.state,c.run.id,input,{...c.reviewer,id:'builder'}),{code:'self_review'});
 for(const key of ['identity','reviewer','context','principal'])assert.throws(()=>recordCodeReview(c.state,c.run.id,{...input,[key]:'forged'},c.reviewer),{code:'identity_forged'});
 assert.equal(c.run.codeReview,undefined);
});
test('a contributor to an alternative cannot independently review the task',()=>{
 const c=fixture(),other=assignRun(c.state,c.task.id,{agent:'external',label:'Other',branch:'other'});other.agentIdentity={...c.reviewer,kind:'agent'};
 assert.throws(c.assess,{code:'self_review'});
});
test('each exact context change invalidates the assessment and prevents replay',()=>{
 for(const mutate of [c=>c.run.headCommit='c'.repeat(40),c=>c.task.criteria.push('New requirement'),c=>c.task.revision++,c=>c.task.baseCommit='d'.repeat(40),c=>c.task.ownerVersion++,c=>c.run.evidence.verification.verifierSha256='7'.repeat(64),c=>c.run.evidence.verification.definitionSha256='8'.repeat(64),c=>c.run.evidence.verification.image='sha256:'+'9'.repeat(64)]){
  const c=fixture();c.assess();const old=structuredClone(c.run.codeReview);mutate(c);assert.equal(independentReviewStatus(c.state,c.run).passed,false);assert.deepEqual(c.run.codeReview,old);
 }
 const c=fixture(),packet=codeReviewContext(c.state,c.run.id);c.task.ownerVersion++;
 assert.throws(()=>recordCodeReview(c.state,c.run.id,assessment(packet.contextId),c.reviewer,'stale'),{code:'stale_code_review'});
});
test('duplicate assessment is stable; replacement preserves history and revokes owner acceptance',()=>{
 const c=fixture();c.assess('pass','original');const first=structuredClone(c.run.codeReview),version=c.state.version;c.assess('pass','original');assert.equal(c.state.version,version);assert.deepEqual(c.run.codeReview,first);
 c.accept();c.assess('changes_requested');assert.equal(c.run.status,'awaiting_review');assert.equal(c.task.acceptedRunId,null);assert.equal(c.run.reviewHistory.length,1);assert.deepEqual(c.run.codeReviewHistory,[first]);assert.throws(c.accept,{code:'independent_review_required'});
 c.assess();c.accept();assert.notEqual(c.run.review.codeReviewId,first.id);
});
test('legacy acceptance is not grandfathered or relabeled as independent review',()=>{
 const c=fixture();c.run.status='accepted';c.task.acceptedRunId=c.run.id;c.run.review={decision:'accept',headCommit:head,taskRevision:1,ownerVersion:1,comparisons:[],reviewer:'Historical owner'};
 assert.throws(()=>mergeRun(c.state,c.run.id,{headCommit:head,baseCommit:base,mergedCommit:head}),{code:'independent_review_required'});
 c.assess();assert.equal(c.run.reviewHistory[0].reviewer,'Historical owner');assert.equal(c.run.review,null);assert.equal(c.run.status,'awaiting_review');
});
test('a retained prose assessment is readable history and cannot authorize a new owner decision',()=>{
 const c=fixture();c.assess();const old=structuredClone(c.run.codeReview);delete old.format;old.findings='Prior prose assessment';delete old.summary;c.run.codeReview=old;
 assert.equal(independentReviewStatus(c.state,c.run).state,'historical');assert.throws(c.accept,{code:'independent_review_required'});
 assert.equal(c.run.codeReview.findings,'Prior prose assessment');
});
test('structured findings require changed paths, bounded source ranges and an honest verdict',()=>{
 const c=fixture(),contextId=codeReviewContext(c.state,c.run.id).contextId,before=structuredClone(c.state);
 for(const changed of [
   {findings:[finding('../outside.mjs')]},
   {findings:[{...finding(),location:{...finding().location,endLine:30}}]},
   {verdict:'pass',findings:[finding()]},
   {verdict:'changes_requested',findings:[]},
 ])assert.throws(()=>recordCodeReview(c.state,c.run.id,{...assessment(contextId),...changed},c.reviewer,crypto.randomUUID()));
 assert.deepEqual(c.state,before);
 c.assess('changes_requested');assert.equal(c.run.codeReview.findings[0].location.path,'index.mjs');assert.match(c.run.codeReview.findings[0].id,/^[a-f0-9-]{36}$/);
});
test('owner finding decisions retain history without converting a failed review into acceptance',async()=>{
 const c=fixture();c.assess('changes_requested');const findingId=c.run.codeReview.findings[0].id;
 const owner={...c.reviewer,kind:'owner',id:'owner',displayName:'Owner'};
 const input={assessmentId:c.run.codeReview.id,decision:'resolved',note:'The candidate will be fixed in a new commit.',expectedVersion:c.state.version};
 const before=structuredClone(c.state);
 assert.throws(()=>recordFindingDecision(c.state,c.run.id,findingId,input,c.reviewer,'decision'),{code:'owner_required'});assert.deepEqual(c.state,before);
 const first=recordFindingDecision(c.state,c.run.id,findingId,input,owner,'decision');assert.equal(first.identity.kind,'owner');
 assert.equal(c.run.findingDecisions.length,1);assert.equal(c.run.codeReview.verdict,'changes_requested');assert.equal(independentReviewStatus(c.state,c.run).passed,false);
 assert.throws(c.accept,{code:'independent_review_required'});
 const version=c.state.version;assert.deepEqual(recordFindingDecision(c.state,c.run.id,findingId,input,owner,'decision'),first);assert.equal(c.state.version,version);
 assert.throws(()=>recordFindingDecision(c.state,c.run.id,findingId,{...input,note:'Different'},owner,'decision'),{code:'idempotency_conflict'});
 assert.throws(()=>recordFindingDecision(c.state,c.run.id,'foreign-id',{...input,expectedVersion:version},owner,'other'),{code:'finding_not_found'});
 const handoff=await buildTaskHandoff(c.state,c.task.id);assert.equal(handoff.payload.runs[0].findingDecisions[0].id,first.id);
 assert.ok(!JSON.stringify(handoff).includes('requestKey'));
});
test('blocking findings carry across reviews until the reviewer explicitly resolves them',()=>{
 const c=fixture();c.assess('changes_requested');const firstId=c.run.codeReview.findings[0].id;
 const input=assessment(codeReviewContext(c.state,c.run.id).contextId,'pass');const before=structuredClone(c.state);
 assert.throws(()=>recordCodeReview(c.state,c.run.id,input,c.reviewer,'unresolved-pass'),{code:'unresolved_prior_findings'});
 assert.deepEqual(c.state,before);
 c.assess('changes_requested');assert.ok(c.run.codeReview.unresolvedFindingIds.includes(firstId));
 assert.equal(independentReviewStatus(c.state,c.run).passed,false);
 c.assess('pass');assert.deepEqual(c.run.codeReview.unresolvedFindingIds,[]);
 assert.ok(c.run.codeReview.resolvedPriorFindingIds.includes(firstId));assert.equal(independentReviewStatus(c.state,c.run).passed,true);
});
test('review input excludes builder conversations and assessment identity retains no session secret',async()=>{
 const c=fixture();c.run.execution={secretConversation:'do not reveal'};const packet=codeReviewContext(c.state,c.run.id);assert.ok(!JSON.stringify(packet).includes('secretConversation'));
 recordCodeReview(c.state,c.run.id,assessment(packet.contextId), {...c.reviewer,token:'secret-session',expiresAt:123},'secret-check');
 delete c.run.execution;const handoff=await buildTaskHandoff(c.state,c.task.id);assert.equal(handoff.payload.runs[0].codeReview.identity.kind,'reviewer');assert.ok(!JSON.stringify(handoff).includes('secret-session'));
 assert.equal(handoff.payload.nextAction.kind,'human_review');
});
test('timestamps and handoff digests do not invalidate an otherwise identical verification policy',()=>{
 const c=fixture();c.assess();c.run.evidence.verifiedAt=new Date(Date.now()+1000).toISOString();c.run.evidence.verification.inputHandoffSha256='f'.repeat(64);assert.equal(independentReviewStatus(c.state,c.run).passed,true);
 c.run.verificationPending=true;assert.equal(independentReviewStatus(c.state,c.run).passed,false);
});
test('local loopback is explicitly unqualified for authenticated independent review',()=>{
 const c=fixture();c.state.provider='local-git';assert.equal(independentReviewStatus(c.state,c.run).state,'unavailable');assert.throws(()=>codeReviewContext(c.state,c.run.id),{code:'review_identity_unavailable'});
});

test('assessment history is bounded without deleting retained assessments',()=>{
 const c=fixture();c.assess();c.run.codeReviewHistory=Array.from({length:99},()=>structuredClone(c.run.codeReview));const before=structuredClone(c.state);
 assert.throws(()=>c.assess('changes_requested'),{code:'review_history_full'});assert.deepEqual(c.state,before);c.assess('pass',c.run.codeReview.requestKey);assert.deepEqual(c.state,before);
});

test('lost responses replay the reviewer’s own immutable receipt after merge without changing state',()=>{
 const c=fixture();const packet=codeReviewContext(c.state,c.run.id);c.assess();const original=structuredClone(c.run.codeReview);c.accept();mergeRun(c.state,c.run.id,{headCommit:head,baseCommit:base,mergedCommit:head});const before=structuredClone(c.state);
 const input=assessment(packet.contextId);const result=recordCodeReview(c.state,c.run.id,input,c.reviewer,original.requestKey);assert.deepEqual(result.codeReview,original);assert.deepEqual(c.state,before);
 assert.throws(()=>recordCodeReview(c.state,c.run.id,input,{...c.reviewer,id:'another-reviewer'},original.requestKey),{code:'review_assignment_required'});assert.deepEqual(c.state,before);
});

test('assessment idempotency requires a key and conflicts on changed payload or resource',()=>{
 const c=fixture(),input=assessment(codeReviewContext(c.state,c.run.id).contextId);
 assert.throws(()=>recordCodeReview(c.state,c.run.id,input,c.reviewer),{code:'idempotency_required'});
 recordCodeReview(c.state,c.run.id,input,c.reviewer,'request');
 for(const change of [{summary:'different'},{findings:[{...finding(),priority:2}]},{contextId:'changed'}])assert.throws(()=>recordCodeReview(c.state,c.run.id,{...input,...change},c.reviewer,'request'),{code:'idempotency_conflict'});
 const other=assignRun(c.state,c.task.id,{agent:'external',label:'Other',branch:'other'});
 assert.throws(()=>recordCodeReview(c.state,other.id,input,c.reviewer,'request'),{code:'idempotency_conflict'});
});
