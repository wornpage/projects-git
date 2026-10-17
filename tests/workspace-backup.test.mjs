import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun} from '../src/core/workflow.mjs';
import {buildWorkspaceBackup,readWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {beginOperationTiming} from '../src/core/operation-timing.mjs';
const BASE='a'.repeat(40),PENDING='b'.repeat(40),OP='c'.repeat(64),ATTEMPT='10000000-0000-4000-8000-000000000001';
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
  assert.equal(backup.payload.operations[0].receipt.timings[0].finishedAt,null);assert.deepEqual(backup.payload.projects[0].commits,[BASE,PENDING]);
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
