import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {ArtifactEventReceipts,artifactEventPolicy,parseArtifactPush,artifactEventKey,reconcileArtifactPush} from '../src/cloudflare/artifact-events.ts';
import {initialSnapshot} from '../src/cloudflare/controller.ts';
import {createTask,assignRun,startRun,completeRun,verifyRun,coordination,mergeRun,metrics} from '../src/core/workflow.mjs';
import {candidateOutcome,independentlyVerified,taskOutcome} from '../public/workbench-state.js';

const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),sub='2'.repeat(32);
const env={WORKSPACE_ID:'fixture-workspace',ARTIFACTS_EVENTS_ACCOUNT_ID:'1'.repeat(32),ARTIFACTS_EVENTS_NAMESPACE:'fixture',ARTIFACTS_EVENTS_QUEUE:'fixture-artifact-events',ARTIFACTS_EVENTS_SUBSCRIPTIONS:JSON.stringify([{id:sub,repositoryName:'agent-fork'}])};
const policy=artifactEventPolicy(env);
function body(after=c,timestamp='2026-10-08T00:00:00.000Z') {return {type:'cf.artifacts.repo.pushed',source:{type:'artifacts.repo',namespace:'fixture',repoName:'agent-fork'},payload:{ref:'refs/heads/newwork/fixture',before:a,after,commits:[{author:{name:'Forged owner'},message:'Untrusted text'}]},metadata:{accountId:'1'.repeat(32),eventSubscriptionId:sub,eventSchemaVersion:1,eventTimestamp:timestamp}};}
function fixture(t,{accepted=true,submitted=true}={}) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const storage={sync:async()=>{},sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args).map(r=>({...r}));return {toArray:()=>rows,one(){assert.equal(rows.length,1);return rows[0]}}}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const store=new WorkspaceStore(storage,env.WORKSPACE_ID),receipts=new ArtifactEventReceipts(storage);
 const snapshot=initialSnapshot(env.WORKSPACE_ID);
 const task=createTask(snapshot.workspace,{title:'Retain pushed work',purpose:'Require current evidence',criteria:['Keep prior attempts'],baseCommit:a,owner:'Fixture owner'});
 const projectId=crypto.randomUUID();task.projectId=projectId;
 snapshot.workspace.projects[projectId]={id:projectId,name:'Fixture',repositoryName:'project-main',mainCommit:a,defaultBranch:'main',kind:'artifacts',acceptingWork:true,policyVersion:1};
 const run=assignRun(snapshot.workspace,task.id,{agent:'external',label:'Fixture agent',branch:'newwork/fixture'});run.origin='external-agent';startRun(snapshot.workspace,run.id);
 if(submitted){completeRun(snapshot.workspace,run.id,{headCommit:b,changedFiles:['file.py'],diff:'+pass',summary:'Fixture submission'});verifyRun(snapshot.workspace,run.id,{commit:b,verified:true,source:'independent-sandbox-checks',taskRevision:1,passed:1,total:1,exitCode:0,checks:[{name:'Fixture check',passed:true,detail:'Retained'}],command:'fixture',output:'PASS',verifiedAt:'2026-10-07T00:00:00.000Z'});}
 if(accepted&&submitted){run.status='accepted';run.review={headCommit:b,decision:'accept',note:'Fixture attribution',reviewer:'Fixture owner',at:'2026-10-07T00:00:00.000Z'};task.acceptedRunId=run.id;task.status='accepted';}
 snapshot.forks[run.id]={name:'agent-fork',remote:'https://example.test/fixture.git'};snapshot.revision=1;store.write(snapshot,0);
 let reads=0,head=c;
 const artifacts={get:async name=>{assert.equal(name,'agent-fork');reads++;return {log:async()=>head===null?[]:[{hash:head}],[Symbol.dispose](){}}}};
 const event=parseArtifactPush(body(),policy);
 const reconcile=(value=event,messageId='delivery-1',owner=()=>{})=>reconcileArtifactPush(store,receipts,artifacts,value,messageId,env.WORKSPACE_ID,owner);
 return {db,storage,store,receipts,artifacts,event,reconcile,taskId:task.id,runId:run.id,projectId,reads:()=>reads,head:value=>head=value};
}

test('event admission pins account, namespace, repository, subscription, branch and schema before state access',()=>{
 for(const edit of [x=>x.source.namespace='foreign',x=>x.source.repoName='foreign',x=>x.source.type='artifacts',x=>x.metadata.accountId='3'.repeat(32),x=>x.metadata.eventSubscriptionId='4'.repeat(32),x=>x.metadata.eventSchemaVersion=2,x=>x.payload.ref='refs/heads/../bad',x=>x.payload.after='forged',x=>x.type='cf.artifacts.repo.forked']){const value=body();edit(value);assert.throws(()=>parseArtifactPush(value,policy));}
 for(const field of ['ARTIFACTS_EVENTS_ACCOUNT_ID','ARTIFACTS_EVENTS_NAMESPACE','ARTIFACTS_EVENTS_QUEUE','ARTIFACTS_EVENTS_SUBSCRIPTIONS'])assert.throws(()=>artifactEventPolicy({...env,[field]:''}),{code:'ARTIFACT_EVENTS_NOT_CONFIGURED'});
 const parsed=parseArtifactPush(body(),policy);assert.equal(JSON.stringify(parsed).includes('Forged owner'),false);assert.equal(Object.hasOwn(parsed,'commits'),false);
});

test('provider observation retains commit/evidence/history and revokes unmerged acceptance without using Git authors as identity',async t=>{
 const f=fixture(t);const before=f.store.read();await f.reconcile();const state=f.store.read(),run=state.workspace.runs[0];
 assert.equal(run.headCommit,b);assert.deepEqual(run.evidence,before.workspace.runs[0].evidence);assert.equal(run.review,null);assert.deepEqual(run.reviewHistory,[before.workspace.runs[0].review]);
 assert.equal(state.workspace.tasks[0].acceptedRunId,null);assert.equal(run.status,'awaiting_review');assert.equal(run.repositoryObservation.headCommit,c);
 assert.equal(independentlyVerified(state.workspace,run),false);assert.equal(candidateOutcome(state.workspace,run).label,'New push observed');
 assert.equal(coordination(state.workspace,run.id).acceptance.find(r=>r.code==='repository_head_changed').met,false);
 assert.throws(()=>mergeRun(state.workspace,run.id,{headCommit:b,baseCommit:a,mergedCommit:b}),{code:'repository_head_changed'});
 assert.equal(state.workspace.projects[f.projectId].mainCommit,a);assert.deepEqual(state.operations,before.operations);assert.equal(JSON.stringify(state).includes('Forged owner'),false);
});

test('reservation precedes provider reads and duplicate/lost-response delivery binds IDs without repeating observations',async t=>{
 const f=fixture(t);const original=f.artifacts.get;f.artifacts.get=async name=>{assert.equal(f.receipts.summary().pending,1);return original(name)};
 const first=await f.reconcile();const revision=f.store.read().revision;
 assert.equal((await f.reconcile(f.event,'delivery-2')).replayed,true);assert.equal((await f.reconcile()).key,first.key);
 assert.equal(f.reads(),1);assert.equal(f.store.read().revision,revision);assert.equal(f.receipts.summary().deliveries,2);
 const changed=parseArtifactPush(body(b),policy);await assert.rejects(f.reconcile(changed,'delivery-2'),{code:'ARTIFACT_DELIVERY_CONFLICT'});assert.equal(f.reads(),1);
});

test('an old notification reads the live ref and never rolls a newer observation back; reverted refs do not revive passing evidence',async t=>{
 const f=fixture(t);await f.reconcile();const old=parseArtifactPush(body(b,'2026-10-07T00:00:00.000Z'),policy);
 assert.equal((await f.reconcile(old,'old-delivery')).state,'superseded-notification');assert.equal(f.store.read().workspace.runs[0].repositoryObservation.headCommit,c);
 f.head(b);const reverted=parseArtifactPush(body(b,'2026-10-08T00:01:00.000Z'),policy);await f.reconcile(reverted,'reverted-delivery');
 assert.equal(f.store.read().workspace.runs[0].repositoryObservation.requiresSubmission,true);assert.equal(independentlyVerified(f.store.read().workspace,f.store.read().workspace.runs[0]),false);
});

test('restart after reservation and interruption after workflow commit recover with retained attempts and no repeated provider effect',async t=>{
 const f=fixture(t);const key=artifactEventKey(f.event,env.WORKSPACE_ID),first=f.receipts.reserve('delivery-1',key,f.event);
 const restarted=new ArtifactEventReceipts(f.storage);let interrupt=true;const finish=restarted.finish.bind(restarted);restarted.finish=(...args)=>{if(interrupt){interrupt=false;throw Error('Controlled interruption')}return finish(...args)};
 await assert.rejects(reconcileArtifactPush(f.store,restarted,f.artifacts,f.event,'delivery-1',env.WORKSPACE_ID,()=>{}),/Controlled interruption/);
 assert.equal(f.store.read().workspace.events.filter(e=>e.repositoryEvent).length,1);const reads=f.reads();
 const result=await reconcileArtifactPush(f.store,new ArtifactEventReceipts(f.storage),f.artifacts,f.event,'delivery-1',env.WORKSPACE_ID,()=>{});
 assert.equal(result.replayed,true);assert.equal(f.reads(),reads);assert.equal(f.store.read().workspace.events.filter(e=>e.repositoryEvent).length,1);
 assert.equal(f.db.prepare('SELECT status FROM artifact_event_attempts WHERE attempt_id = ?').get(first.attemptId).status,'superseded');
 assert.equal(f.receipts.summary().attempts,3);assert.equal(f.receipts.summary().completed,1);
});

test('deterministic delayed read cannot overwrite a changed workspace or a superseding attempt',async t=>{
 const f=fixture(t);let entered,release;const barrier=new Promise(done=>release=done),started=new Promise(done=>entered=done);
 f.artifacts.get=async()=>({log:async()=>{entered();await barrier;return [{hash:c}]},[Symbol.dispose](){}});
 const pending=f.reconcile();await started;
 const key=artifactEventKey(f.event,env.WORKSPACE_ID);f.receipts.reserve('delivery-1',key,f.event);
 const next=f.store.read();next.workspace.tasks[0].purpose='Owner changed intent';next.revision++;f.store.write(next,next.revision-1);
 release();await assert.rejects(pending,{code:'ARTIFACT_OBSERVATION_CHANGED'});
 assert.equal(f.store.read().workspace.runs[0].headCommit,b);assert.equal(f.store.read().workspace.events.some(e=>e.repositoryEvent),false);
 assert.equal(f.db.prepare("SELECT count(*) n FROM artifact_event_attempts WHERE status = 'superseded'").get().n,1);
});

test('pending verification/merge blocks observation before I/O and retains both the operation and failed reconciliation',async t=>{
 const f=fixture(t),next=f.store.read();next.operations.pending={kind:'merge',fingerprint:'fixture',state:'pending',itemId:f.runId};next.revision++;f.store.write(next,next.revision-1);
 await assert.rejects(f.reconcile(),{code:'ARTIFACT_RECONCILIATION_BUSY'});assert.equal(f.reads(),0);assert.equal(f.store.read().operations.pending.state,'pending');assert.equal(f.receipts.summary().failed,1);
});

test('owner-binding rejection has no durable delivery or provider read; foreign refs never read an unowned repository',async t=>{
 const f=fixture(t),before=f.store.read();await assert.rejects(f.reconcile(f.event,'delivery-1',()=>{throw Error('Owner mismatch')}),/Owner mismatch/);
 assert.deepEqual(f.store.read(),before);assert.equal(f.receipts.summary().deliveries,0);assert.equal(f.reads(),0);
 const foreign={...f.event,ref:'refs/heads/foreign'};assert.equal((await f.reconcile(foreign)).state,'unowned-ref');assert.equal(f.reads(),0);assert.deepEqual(f.store.read(),before);
});

test('unsubmitted pushes preserve execution occupancy, and historical merged decisions are never relabeled',async t=>{
 const f=fixture(t,{submitted:false});await f.reconcile();let state=f.store.read();assert.equal(state.workspace.runs[0].status,'running');assert.equal(state.workspace.runs[0].headCommit,null);assert.equal(state.workspace.runs[0].repositoryObservation.requiresSubmission,true);
 state.workspace.runs[0].status='merged';state.workspace.runs[0].headCommit=b;state.workspace.runs[0].review={decision:'accept',note:'Historical',reviewer:'Attribution',headCommit:b,at:'2026-10-07T00:00:00.000Z'};state.workspace.tasks[0].mergedCommit=b;state.revision++;f.store.write(state,state.revision-1);
 await f.reconcile({...f.event,timestamp:'2026-10-08T00:02:00.000Z'},'history-delivery');const after=f.store.read().workspace.runs[0];assert.equal(after.status,'merged');assert.deepEqual(after.review,state.workspace.runs[0].review);assert.equal(after.repositoryObservation.requiresSubmission,false);
});

test('project-main events invalidate unmerged acceptance without adopting an unreviewed baseline or rewriting historical merges',async t=>{
 const f=fixture(t);const event={...f.event,repositoryName:'project-main',ref:'refs/heads/main'};
 const provider={get:async name=>{assert.equal(name,'project-main');return {log:async()=>[{hash:c}],[Symbol.dispose](){}}}};
 await reconcileArtifactPush(f.store,f.receipts,provider,event,'project-delivery',env.WORKSPACE_ID,()=>{});
 const state=f.store.read();assert.equal(state.workspace.projects[f.projectId].mainCommit,a);assert.equal(state.workspace.projects[f.projectId].repositoryObservation.headCommit,c);
 assert.equal(state.workspace.tasks[0].acceptedRunId,null);assert.equal(state.workspace.runs[0].reviewHistory.length,1);assert.equal(taskOutcome(state.workspace,state.workspace.tasks[0]).label,'Update base needed');
 assert.equal(coordination(state.workspace,f.runId).acceptance.find(x=>x.code==='project_advanced').met,false);
 assert.equal(independentlyVerified(state.workspace,state.workspace.runs[0]),false);assert.equal(metrics(state.workspace).checks.verifiedRuns,0);
 assert.equal(metrics(state.workspace).checks.passed,1);assert.equal(metrics(state.workspace).checks.total,1,'Retained check denominators remain visible');
 assert.equal(candidateOutcome(state.workspace,state.workspace.runs[0]).label,'Update base needed');
});

test('missing live refs retain their absence and cannot authorize the notified commit',async t=>{
 const f=fixture(t);f.head(null);await f.reconcile();const run=f.store.read().workspace.runs[0];assert.equal(run.repositoryObservation.headCommit,null);assert.equal(run.repositoryObservation.requiresSubmission,true);assert.equal(run.headCommit,b);
});

test('provider I/O waits for durable reservation confirmation and confirmation failure starts no read',async t=>{
 const f=fixture(t);let confirmed=false;f.storage.sync=async()=>{confirmed=true};const get=f.artifacts.get;f.artifacts.get=async name=>{assert.equal(confirmed,true);return get(name)};await f.reconcile();
 const second={...f.event,timestamp:'2026-10-08T00:04:00.000Z'};f.storage.sync=async()=>{throw Error('Controlled disk confirmation failure')};const before=f.reads();await assert.rejects(f.reconcile(second,'confirmation-denied'),/Controlled disk confirmation failure/);assert.equal(f.reads(),before);
});

test('event changes mark history stale without dispatchable jobs or embedding retry use; explicit rebuild renews indexing',async t=>{
 const f=fixture(t);await f.reconcile();const held=f.store.indexState(f.projectId);assert.equal(held.automatic,0);assert.equal(held.attempts,0);assert.equal(held.error_code,'INDEX_REBUILD_REQUIRED');
 assert.deepEqual(f.store.pendingIndex(Number.MAX_SAFE_INTEGER),[]);assert.equal(f.store.nextIndexAttempt(),null);
 const renewed=f.store.rebuild(f.projectId,held.revision);assert.equal(renewed.automatic,1);assert.equal(renewed.attempts,0);assert.equal(f.store.pendingIndex(Number.MAX_SAFE_INTEGER).length,1);
});
