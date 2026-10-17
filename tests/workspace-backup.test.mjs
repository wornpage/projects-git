import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup,readWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {beginOperationTiming} from '../src/core/operation-timing.mjs';
import {createHash} from 'node:crypto';
const BASE='a'.repeat(40),PENDING='b'.repeat(40),OP='c'.repeat(64),ATTEMPT='10000000-0000-4000-8000-000000000001';
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
  const source=fixture(),before=structuredClone(source),backup=await buildWorkspaceBackup(source),preview=workspaceBackupPreview(backup);
  assert.deepEqual(source,before);assert.equal(preview.counts.projects,1);assert.equal(preview.counts.tasks,1);assert.equal(preview.counts.runs,1);
  assert.equal(preview.counts.pendingOperations,1);assert.equal(preview.resumesWork,false);assert.equal(preview.restoresAuthority,false);
  assert.equal(backup.payload.operations[0].receipt.state,'pending');assert.equal(backup.payload.operations[0].receipt.leaseUntil,0);
  assert.equal(backup.payload.operations[0].receipt.timings[0].finishedAt,null);assert.deepEqual(backup.payload.resources[0].commits,[BASE,PENDING]);
  assert.ok(!JSON.stringify(backup).includes('SECRET_'));assert.equal(backup.payload.handoffs[0].payload.runs[0].status,'running');
  assert.deepEqual(await readWorkspaceBackup(JSON.stringify(backup),backup.sha256),backup);
});
test('partial pages, corrupt bytes and a wrong expected digest never become a recovery archive',async()=>{
  const source=fixture();await assert.rejects(buildWorkspaceBackup({...source,page:{}}),{code:'WORKSPACE_BACKUP_INVALID'});
  const backup=await buildWorkspaceBackup(source);
  await assert.rejects(readWorkspaceBackup(JSON.stringify(backup),'0'.repeat(64)),{code:'WORKSPACE_BACKUP_INVALID'});
  const changed=structuredClone(backup);changed.payload.operations[0].receipt.state='complete';
  await assert.rejects(readWorkspaceBackup(JSON.stringify(changed),backup.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
  await assert.rejects(readWorkspaceBackup('{',backup.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
});
test('missing Git references and foreign retained records fail explicitly rather than truncate the backup',async()=>{
  for(const mutate of [s=>{s.workspace.projects[Object.keys(s.workspace.projects)[0]].mainCommit=null;},
    s=>{s.workspace.tasks[0].projectId='foreign';},s=>{s.forks.foreign={name:'foreign'};},
    s=>{s.operations[OP].pendingCommit='bad';},s=>{s.operations[OP].timings[0].startedAt='bad';}]){
    const source=fixture();mutate(source);await assert.rejects(buildWorkspaceBackup(source));
  }
});

test('admission limits reject a whole source collection without silently dropping records',async()=>{
  const source=fixture();source.workspace.events=Array.from({length:10001},()=>({}));
  await assert.rejects(buildWorkspaceBackup(source),error=>error.code==='WORKSPACE_BACKUP_INVALID'&&/events limit/.test(error.message));
  assert.equal(source.workspace.events.length,10001);
});

test('pending creation before any project exists has its own recoverable Git resource',async()=>{
  const source=fixture(),projectId=crypto.randomUUID();source.operations['f'.repeat(64)]={kind:'repository-create',state:'pending',fingerprint:'e'.repeat(64),
    projectId,resourceName:'not-yet-connected',pendingCommit:'d'.repeat(40),attemptId:ATTEMPT,leaseUntil:0};
  const backup=await buildWorkspaceBackup(source),preview=workspaceBackupPreview(backup),resource=backup.payload.resources.find(resource=>resource.kind==='unattached-operation');
  assert.equal(preview.counts.projects,1);assert.equal(preview.counts.resources,2);assert.equal(resource.projectId,projectId);
  assert.equal(resource.repositoryName,'not-yet-connected');assert.equal(resource.anchorCommit,'d'.repeat(40));assert.deepEqual(resource.commits,['d'.repeat(40)]);
  assert.ok(!backup.payload.projects.some(project=>project.id===projectId));
});

test('historical records and policies remain visible in totals and global admission limits',async()=>{
  const source=fixture(),historical=structuredClone((await buildWorkspaceBackup(source)).payload.handoffs[0]);
  source.workspace.tasks=[];source.workspace.runs=[];source.workspace.events=[];source.operations={};source.repositories={};source.forks={};
  const project=Object.values(source.workspace.projects)[0];project.restoredHistory=[historical];
  const definition=JSON.stringify({format:'repository-command-checks/v1',commit:BASE,taskRevision:1,requirementsSha256:'e'.repeat(64),timeoutMs:1000,
    checks:[{name:'Recorded check',argv:['node','--version'],stdin:'',expected:{exitCode:0,stdout:''}}]});
  project.restoredCheckPolicies=[{workspaceId:historical.payload.workspace.id,runId:historical.payload.runs[0].id,definition,
    definitionSha256:createHash('sha256').update(definition).digest('hex')}];
  const backup=await buildWorkspaceBackup(source),c=workspaceBackupPreview(backup).counts;
  assert.deepEqual([c.currentTasks,c.historicalTasks,c.tasks,c.currentRuns,c.historicalRuns,c.runs],[0,1,1,0,1,1]);
  assert.equal(c.historicalEvents,historical.payload.events.length);assert.equal(c.events,c.historicalEvents);
  assert.deepEqual([c.currentPolicies,c.historicalPolicies,c.policies],[0,1,1]);
  for(let i=0;i<5;i++){const id=crypto.randomUUID();source.workspace.projects[id]={...structuredClone(project),id,repositoryName:'history-'+i,restoredHistory:Array(64).fill(historical)};}
  await assert.rejects(buildWorkspaceBackup(source),error=>error.code==='WORKSPACE_BACKUP_INVALID'&&/tasks limit/.test(error.message));
});

test('valid recomputed digests cannot admit excluded fields in nested current/history records or policies',async()=>{
  const original=await buildWorkspaceBackup(fixture());
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
  assert.equal(run.evidence,null);const backup=await buildWorkspaceBackup(source),stored=backup.payload.operations.find(op=>op.key===modelKey);
  assert.deepEqual(stored.receipt.report,report);assert.equal(stored.receipt.fingerprint,ATTEMPT);
  assert.ok(backup.payload.operations.some(op=>op.key===automaticKey));assert.equal(workspaceBackupPreview(backup).counts.operationReports,1);
  const corrupted=structuredClone(backup);corrupted.payload.operations.find(op=>op.key===modelKey).receipt.report.rawCredentials={token:'forbidden'};seal(corrupted);
  await assert.rejects(readWorkspaceBackup(JSON.stringify(corrupted),corrupted.sha256),{code:'WORKSPACE_BACKUP_INVALID'});
});
