import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup,readWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {beginOperationTiming} from '../src/core/operation-timing.mjs';
import {createHash} from 'node:crypto';
const BASE='a'.repeat(40),PENDING='b'.repeat(40),OP='c'.repeat(64),ATTEMPT='10000000-0000-4000-8000-000000000001';
const testLedgers=()=>({capture:'coherent-sqlite-transaction',artifactSubscriptions:[],artifactSubscriptionAttempts:[],artifactEvents:[],artifactEventAttempts:[],artifactDeliveries:[]});
const buildBackup=(snapshot,exportedAt)=>buildWorkspaceBackup(snapshot,exportedAt,testLedgers());
function retainedLedgers(){
  const subscriptionAttempt='20000000-0000-4000-8000-000000000002',boundAttempt='40000000-0000-4000-8000-000000000004',eventAttempt='30000000-0000-4000-8000-000000000003',eventKey='e'.repeat(64);
  return {capture:'coherent-sqlite-transaction',
    artifactSubscriptions:[{repositoryName:'fixture',fingerprint:'f'.repeat(64),phase:'creating',subscriptionId:null,attemptId:subscriptionAttempt},
      {repositoryName:'fixture-bound',fingerprint:'d'.repeat(64),phase:'bound',subscriptionId:'bbbbbbbbbbbbbbbb',attemptId:boundAttempt}],
    artifactSubscriptionAttempts:[{id:subscriptionAttempt,repositoryName:'fixture',startedAt:'2026-10-16T10:00:00.000Z',finishedAt:null,status:'pending',errorCode:null},
      {id:boundAttempt,repositoryName:'fixture-bound',startedAt:'2026-10-16T09:00:00.000Z',finishedAt:'2026-10-16T09:01:00.000Z',status:'failed',errorCode:'SUBSCRIPTION_ENABLE_UNCONFIRMED'}],
    artifactEvents:[{eventKey,status:'pending',attemptId:eventAttempt,event:{subscriptionId:'abcdef0123456789',repositoryName:'fixture',ref:'refs/heads/main',before:BASE,after:PENDING,timestamp:'2026-10-16T10:01:00Z'},result:null}],
    artifactEventAttempts:[{attemptId:eventAttempt,eventKey,startedAt:'2026-10-16T10:01:01.000Z',finishedAt:null,status:'pending',errorCode:null}],
    artifactDeliveries:[{messageId:'delivery:fixture',eventKey}]};
}
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const seal=value=>{value.sha256=createHash('sha256').update(JSON.stringify(ordered(value.payload))).digest('hex');return value;};
function fixture(){
  const workspace=createWorkspace({provider:'cloudflare-artifacts'}),id=crypto.randomUUID();
  workspace.projects={[id]:{id,name:'Private fixture',repositoryName:'fixture',defaultBranch:'main',mainCommit:BASE,kind:'artifacts',acceptingWork:true,
    policyVersion:1,access:{SECRET_ACCESS:'not-portable'},automaticMergePolicy:{SECRET_POLICY:'not-portable'}}};
  workspace.authentication={SECRET_AUTH:'not-portable'};workspace.reviewerNames={SECRET_NAME:'not-portable'};
  const task=createTask(workspace,{title:'Recover carefully',purpose:'Retain uncertainty',criteria:['Never repeat the effect'],baseCommit:BASE,owner:'Fixture owner'});task.projectId=id;
  const run=assignRun(workspace,task.id,{agent:'external',label:'Fixture',branch:'agents/fixture'});run.origin='external-agent';startRun(workspace,run.id);
  const operation={fingerprint:'d'.repeat(64),kind:'merge',state:'pending',itemId:run.id,projectId:id,attemptId:ATTEMPT,leaseUntil:0,pendingCommit:PENDING,
    marker:'SECRET_MARKER',accessRequest:{SECRET_REQUEST:'not-portable'},credential:'SECRET_CREDENTIAL'};
  beginOperationTiming(operation,'verification',ATTEMPT);
  return {revision:8,workspace,repositories:{[task.id]:'fixture'},forks:{[run.id]:{name:'fixture-run',remote:'https://SECRET_REMOTE@invalid.test/fork.git'}},
    operations:{[OP]:operation},jobs:{},checkPolicies:{}};
}
test('complete backup retains running history, uncertain effects and Git references without operational secrets or authority',async()=>{
  const source=fixture(),before=structuredClone(source),backup=await buildBackup(source),preview=workspaceBackupPreview(backup);
  assert.deepEqual(source,before);assert.equal(preview.counts.projects,1);assert.equal(preview.counts.tasks,1);assert.equal(preview.counts.runs,1);
  assert.equal(preview.counts.pendingOperations,1);assert.equal(preview.resumesWork,false);assert.equal(preview.restoresAuthority,false);
  assert.equal(backup.payload.operations[0].receipt.state,'pending');assert.equal(backup.payload.operations[0].receipt.leaseUntil,0);
  assert.equal(backup.payload.operations[0].receipt.timings[0].finishedAt,null);assert.deepEqual(backup.payload.resources[0].commits,[BASE,PENDING]);
  assert.ok(!JSON.stringify(backup).includes('SECRET_'));assert.equal(backup.payload.handoffs[0].payload.runs[0].status,'running');
  assert.deepEqual(await readWorkspaceBackup(JSON.stringify(backup),backup.sha256),backup);
});
test('partial pages, corrupt bytes and a wrong expected digest never become a recovery archive',async()=>{
  const source=fixture();await assert.rejects(buildBackup({...source,page:{}}),{code:'WORKSPACE_BACKUP_INVALID'});
  const backup=await buildBackup(source);
  await assert.rejects(readWorkspaceBackup(JSON.stringify(backup),'0'.repeat(64)),{code:'WORKSPACE_BACKUP_INVALID'});
  const changed=structuredClone(backup);changed.payload.operations[0].receipt.state='complete';
  await assert.rejects(readWorkspaceBackup(JSON.stringify(changed),backup.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
  await assert.rejects(readWorkspaceBackup('{',backup.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
});
test('missing Git references and foreign retained records fail explicitly rather than truncate the backup',async()=>{
  for(const mutate of [s=>{s.workspace.projects[Object.keys(s.workspace.projects)[0]].mainCommit=null;},
    s=>{s.workspace.tasks[0].projectId='foreign';},s=>{s.forks.foreign={name:'foreign'};},
    s=>{s.operations[OP].pendingCommit='bad';},s=>{s.operations[OP].timings[0].startedAt='bad';}]){
    const source=fixture();mutate(source);await assert.rejects(buildBackup(source));
  }
});

test('admission limits reject a whole source collection without silently dropping records',async()=>{
  const source=fixture();source.workspace.events=Array.from({length:10001},()=>({}));
  await assert.rejects(buildBackup(source),error=>error.code==='WORKSPACE_BACKUP_INVALID'&&/events limit/.test(error.message));
  assert.equal(source.workspace.events.length,10001);
});

test('pending creation before any project exists has its own recoverable Git resource',async()=>{
  const source=fixture(),projectId=crypto.randomUUID();source.operations['f'.repeat(64)]={kind:'repository-create',state:'pending',fingerprint:'e'.repeat(64),
    projectId,resourceName:'not-yet-connected',pendingCommit:'d'.repeat(40),attemptId:ATTEMPT,leaseUntil:0};
  const backup=await buildBackup(source),preview=workspaceBackupPreview(backup),resource=backup.payload.resources.find(resource=>resource.kind==='unattached-operation');
  assert.equal(preview.counts.projects,1);assert.equal(preview.counts.resources,2);assert.equal(resource.projectId,projectId);
  assert.equal(resource.repositoryName,'not-yet-connected');assert.equal(resource.anchorCommit,'d'.repeat(40));assert.deepEqual(resource.commits,['d'.repeat(40)]);
  assert.ok(!backup.payload.projects.some(project=>project.id===projectId));
});

test('historical records and policies remain visible in totals and global admission limits',async()=>{
  const source=fixture(),historical=structuredClone((await buildBackup(source)).payload.handoffs[0]);
  source.workspace.tasks=[];source.workspace.runs=[];source.workspace.events=[];source.operations={};source.repositories={};source.forks={};
  const project=Object.values(source.workspace.projects)[0];project.restoredHistory=[historical];
  const definition=JSON.stringify({format:'repository-command-checks/v1',commit:BASE,taskRevision:1,requirementsSha256:'e'.repeat(64),timeoutMs:1000,
    checks:[{name:'Recorded check',argv:['node','--version'],stdin:'',expected:{exitCode:0,stdout:''}}]});
  project.restoredCheckPolicies=[{workspaceId:historical.payload.workspace.id,runId:historical.payload.runs[0].id,definition,
    definitionSha256:createHash('sha256').update(definition).digest('hex')}];
  const backup=await buildBackup(source),c=workspaceBackupPreview(backup).counts;
  assert.deepEqual([c.currentTasks,c.historicalTasks,c.tasks,c.currentRuns,c.historicalRuns,c.runs],[0,1,1,0,1,1]);
  assert.equal(c.historicalEvents,historical.payload.events.length);assert.equal(c.events,c.historicalEvents);
  assert.deepEqual([c.currentPolicies,c.historicalPolicies,c.policies],[0,1,1]);
  for(let i=0;i<5;i++){const id=crypto.randomUUID();source.workspace.projects[id]={...structuredClone(project),id,repositoryName:'history-'+i,restoredHistory:Array(64).fill(historical)};}
  await assert.rejects(buildBackup(source),error=>error.code==='WORKSPACE_BACKUP_INVALID'&&/tasks limit/.test(error.message));
});

test('valid recomputed digests cannot admit excluded fields in nested current/history records or policies',async()=>{
  const original=await buildBackup(fixture());
  for(const mutate of [
    archive=>{archive.payload.handoffs[0].payload.runs[0].credential={token:'forbidden'};seal(archive.payload.handoffs[0]);},
    archive=>{archive.payload.handoffs[0].payload.task.access={grants:[]};seal(archive.payload.handoffs[0]);},
    archive=>{archive.payload.handoffs[0].payload.runs[0].codeReview={context:{credentials:'forbidden'}};seal(archive.payload.handoffs[0]);},
    archive=>{const item=structuredClone(archive.payload.handoffs[0]);item.payload.runs[0].credential='forbidden';seal(item);archive.payload.projects[0].history.push(item);},
    archive=>{archive.payload.projects[0].historicalCheckPolicies.push({credential:'forbidden'});},
  ]){
    const changed=structuredClone(original);mutate(changed);seal(changed);
    await assert.rejects(readWorkspaceBackup(JSON.stringify(changed),changed.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
  }
});

test('real operation key grammars and sole durable model-check reports survive backup unchanged',async()=>{
  const source=fixture(),run=source.workspace.runs[0],modelKey='model-check:'+crypto.randomUUID(),automaticKey='automatic-merge:'+crypto.randomUUID();
  const report={verified:true,commit:PENDING,passed:1,total:1,checks:[{name:'Retained check',passed:true,detail:'Completed before outer job interruption'}],
    command:'Independent checks',exitCode:0,output:'pass',verifiedAt:new Date().toISOString(),source:'independent-sandbox-checks'};
  source.operations[modelKey]={kind:'model-check',fingerprint:ATTEMPT,state:'complete',itemId:run.id,taskId:run.taskId,attemptId:ATTEMPT,report};
  source.operations[automaticKey]={kind:'merge',fingerprint:'f'.repeat(64),state:'failed',itemId:run.id,taskId:run.taskId};
  assert.equal(run.evidence,null);const backup=await buildBackup(source),stored=backup.payload.operations.find(op=>op.key===modelKey);
  assert.deepEqual(stored.receipt.report,report);assert.equal(stored.receipt.fingerprint,ATTEMPT);
  assert.ok(backup.payload.operations.some(op=>op.key===automaticKey));assert.equal(workspaceBackupPreview(backup).counts.operationReports,1);
  const corrupted=structuredClone(backup);corrupted.payload.operations.find(op=>op.key===modelKey).receipt.report.rawCredentials={token:'forbidden'};seal(corrupted);
  await assert.rejects(readWorkspaceBackup(JSON.stringify(corrupted),corrupted.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
});

test('project, candidate and event observations plus restore provenance survive without raw replies',async()=>{
  const source=fixture(),project=Object.values(source.workspace.projects)[0],run=source.workspace.runs[0],now=new Date().toISOString();
  const observation={eventKey:'e'.repeat(64),ref:'refs/heads/main',headCommit:'d'.repeat(40),observedAt:now,eventTimestamp:now,requiresSubmission:true};
  project.repositoryObservation={...observation,rawCredentials:'SECRET_PROJECT_OBSERVATION'};run.repositoryObservation={...observation,rawReply:'SECRET_RUN_OBSERVATION'};
  project.restoredFrom={archiveSha256:'f'.repeat(64),workspaceId:'previous-workspace',projectId:'previous-project',at:now,token:'SECRET_RESTORE'};
  source.workspace.events.push({id:crypto.randomUUID(),at:now,type:'repository.push_observed',taskId:null,runId:run.id,projectId:project.id,message:'Source head changed',
    repositoryEvent:{key:observation.eventKey,state:'observed',headCommit:observation.headCommit,repositoryName:project.repositoryName,ref:observation.ref,
      runIds:[run.id],projectIds:[project.id],rawReply:'SECRET_EVENT'}});
  const backup=await buildBackup(source);assert.deepEqual(backup.payload.projects[0].repositoryObservation,observation);
  assert.deepEqual(backup.payload.handoffs[0].payload.runs[0].repositoryObservation,observation);
  assert.equal(backup.payload.projects[0].restoredFrom.workspaceId,'previous-workspace');
  assert.equal(backup.payload.events.at(-1).repositoryEvent.key,observation.eventKey);
  assert.ok(backup.payload.resources[0].commits.includes(observation.headCommit));assert.ok(!JSON.stringify(backup).includes('SECRET_'));
});

test('reserved, partially started and finished publication timestamps round-trip as uncertainty',async()=>{
  for(const [pushStartedAt,prStartedAt] of [[null,null],[new Date().toISOString(),null],[new Date().toISOString(),new Date().toISOString()]]){
    const source=fixture(),task=source.workspace.tasks[0],run=source.workspace.runs[0];
    run.publication={id:crypto.randomUUID(),previewId:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'pending',stage:'reserved',pushStartedAt,prStartedAt,branchHead:null,pr:null,error:null,observations:[],
      binding:{repository:'fixture/repository',repositoryId:1,baseBranch:'main',headBranch:'projects/fixture',local:{workspaceId:source.workspace.id,taskId:task.id,runId:run.id,
        headCommit:PENDING,baseCommit:BASE,taskRevision:1,ownerVersion:1,requirementsSha256:'e'.repeat(64),reviewSha256:'f'.repeat(64)}}};
    const backup=await buildBackup(source),record=backup.payload.handoffs[0].payload.runs[0].publication;
    assert.equal(record.pushStartedAt,pushStartedAt);assert.equal(record.prStartedAt,prStartedAt);
  }
});

test('historical identities and policy references cannot be duplicated or orphaned',async()=>{
  const source=fixture(),old=(await buildBackup(fixture())).payload.handoffs[0],project=Object.values(source.workspace.projects)[0];
  project.restoredHistory=[old,structuredClone(old)];await assert.rejects(buildBackup(source),/Duplicate historical task identity/);
  project.restoredHistory=[old];const definition=JSON.stringify({format:'repository-command-checks/v1',commit:BASE,taskRevision:1,requirementsSha256:'e'.repeat(64),timeoutMs:1000,checks:[]});
  const policy={workspaceId:old.payload.workspace.id,runId:old.payload.runs[0].id,definition,definitionSha256:createHash('sha256').update(definition).digest('hex')};
  project.restoredCheckPolicies=[policy,structuredClone(policy)];await assert.rejects(buildBackup(source),/Duplicate or orphan/);
  project.restoredCheckPolicies=[{...policy,runId:crypto.randomUUID()}];await assert.rejects(buildBackup(source),/Duplicate or orphan/);
  project.restoredCheckPolicies=[{...policy,workspaceId:'foreign-workspace'}];await assert.rejects(buildBackup(source),/Duplicate or orphan/);
});

test('operation role references reject unknown identities, duplicates and cleanup supersets',async()=>{
  for(const change of [
    (s,op)=>{op.taskId='unknown-task';},(s,op)=>{op.itemId='unknown-run';},(s,op)=>{op.sourceRunId='unknown-run';},
    (s,op)=>{op.kind='task';op.itemId=s.workspace.tasks[0].id;op.taskIds=[op.itemId,'unknown-task'];},
    (s,op)=>{op.kind='project-access';delete op.itemId;op.revokeRunIds=[s.workspace.runs[0].id];op.revokedRunIds=['unknown-run'];},
    (s,op)=>{op.kind='project-access';delete op.itemId;op.revokeRunIds=[s.workspace.runs[0].id,s.workspace.runs[0].id];},
  ]){const source=fixture();change(source,source.operations[OP]);await assert.rejects(buildBackup(source),{code:'WORKSPACE_BACKUP_INVALID'});}
});

test('restored whole-workspace journals and their uncertain Git roots survive re-export as historical records',async()=>{
  const previous=await buildBackup(fixture()),source=fixture();source.workspace.projects={};source.workspace.tasks=[];source.workspace.runs=[];source.workspace.events=[];
  source.repositories={};source.forks={};source.jobs={};source.checkPolicies={};
  source.recoveryImports={[previous.sha256]:{archive:previous,importedAt:new Date().toISOString(),importedBy:'new-owner'}};
  source.operations={['e'.repeat(64)]:{kind:'workspace-restore',state:'complete',fingerprint:'f'.repeat(64),recoveryImportId:previous.sha256}};
  const backup=await buildBackup(source),preview=workspaceBackupPreview(backup);
  assert.deepEqual(backup.payload.priorImports[0].archive,previous);
  assert.equal(preview.counts.currentTasks,0);assert.equal(preview.counts.historicalTasks,1);assert.equal(preview.counts.priorImports,1);
  assert.equal(preview.counts.currentOperations,1);assert.equal(preview.counts.historicalOperations,1);assert.equal(preview.counts.pendingOperations,1);
  assert.equal(backup.payload.resources[0].kind,'historical-import');assert.deepEqual(backup.payload.resources[0].commits,[BASE,PENDING]);
  assert.equal(backup.payload.operations.length,1);assert.equal(backup.payload.handoffs.length,0);
});

test('coherent provider-effect ledgers retain pending uncertainty with explicit denominators',async()=>{
  const backup=await buildWorkspaceBackup(fixture(),undefined,retainedLedgers()),preview=workspaceBackupPreview(backup),counts=preview.counts;
  assert.deepEqual([counts.artifactSubscriptions,counts.pendingArtifactSubscriptions,counts.artifactSubscriptionAttempts,counts.pendingArtifactSubscriptionAttempts],[2,2,2,1]);
  assert.deepEqual([counts.reservedArtifactSubscriptions,counts.creatingArtifactSubscriptions,counts.boundArtifactSubscriptions,counts.readyArtifactSubscriptions],[0,1,1,0]);
  assert.deepEqual([counts.completedArtifactSubscriptionAttempts,counts.failedArtifactSubscriptionAttempts,counts.supersededArtifactSubscriptionAttempts],[0,1,0]);
  assert.deepEqual([counts.artifactEvents,counts.pendingArtifactEvents,counts.artifactEventAttempts,counts.pendingArtifactEventAttempts,counts.artifactDeliveries],[1,1,1,1,1]);
  assert.equal(backup.payload.ledgers.capture,'coherent-sqlite-transaction');assert.equal(backup.payload.ledgers.artifactSubscriptions[0].phase,'creating');
  assert.equal(backup.payload.ledgers.artifactSubscriptions[1].phase,'bound');assert.equal(backup.payload.ledgers.artifactSubscriptionAttempts[1].errorCode,'SUBSCRIPTION_ENABLE_UNCONFIRMED');
  assert.equal(backup.payload.ledgers.artifactEvents[0].result,null);
  await assert.rejects(buildWorkspaceBackup(fixture()),{code:'WORKSPACE_BACKUP_INVALID'});
});

test('recomputed archives cannot add ledger secrets or break ledger references',async()=>{
  const original=await buildWorkspaceBackup(fixture(),undefined,retainedLedgers());
  for(const mutate of [
    archive=>{archive.payload.ledgers.artifactSubscriptions[0].plan={ownerKey:'forbidden'};},
    archive=>{archive.payload.ledgers.artifactSubscriptionAttempts[0].repositoryName='missing';},
    archive=>{archive.payload.ledgers.artifactEvents[0].attemptId=crypto.randomUUID();},
    archive=>{archive.payload.ledgers.artifactDeliveries[0].eventKey='0'.repeat(64);},
  ]){
    const changed=structuredClone(original);mutate(changed);seal(changed);
    await assert.rejects(readWorkspaceBackup(JSON.stringify(changed),changed.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
  }
});

test('coordinator ledger row ceilings refuse the complete capture without truncation',async()=>{
  const ledgers=testLedgers();
  for(let index=0;index<129;index++){
    const id=crypto.randomUUID(),repositoryName='repository-'+index;
    ledgers.artifactSubscriptions.push({repositoryName,fingerprint:'f'.repeat(64),phase:'reserved',subscriptionId:null,attemptId:id});
    ledgers.artifactSubscriptionAttempts.push({id,repositoryName,startedAt:'2026-10-16T10:00:00.000Z',finishedAt:null,status:'pending',errorCode:null});
  }
  await assert.rejects(buildWorkspaceBackup(fixture(),undefined,ledgers),error=>error.code==='WORKSPACE_BACKUP_INVALID'&&/artifactSubscriptions limit/.test(error.message));
  assert.equal(ledgers.artifactSubscriptions.length,129);
});
