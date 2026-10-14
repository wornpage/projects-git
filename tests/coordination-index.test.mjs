import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,coordination,workspaceCoordination} from '../src/core/workflow.mjs';
import {createExampleWorkspace,exampleIds} from '../public/demo/workspace.js';

const base='a'.repeat(40),otherBase='b'.repeat(40),head='c'.repeat(40);
function fixture(){
  const state=createWorkspace();
  const task=repositoryKey=>createTask(state,{title:'Retain coordination',purpose:'Keep the current comparison boundary.',criteria:['Show all relevant work.'],owner:'Test owner',baseCommit:base,repositoryKey});
  const first=task('shared'),second=task('shared'),separate=task('other');
  const add=(task,label,status='awaiting_review',baseCommit=base,changedFiles=['src/a.py'])=>{
    const run=assignRun(state,task.id,{agent:label,label,branch:'test/'+label});
    Object.assign(run,{status,baseCommit,changedFiles,headCommit:status==='assigned'?null:head});return run;
  };
  const target=add(first,'target'),directory=add(second,'directory','awaiting_review',base,['src']);
  const oldSameTask=add(first,'same-task-old-base','awaiting_review',otherBase);
  const unrelatedBase=add(second,'other-base','awaiting_review',otherBase);
  const prefix=add(second,'not-a-directory-match','awaiting_review',base,['src-other/a.py']);
  const rejected=add(first,'rejected','rejected'),superseded=add(first,'superseded','superseded');
  const isolated=add(separate,'isolated'),active=add(second,'active','assigned');
  const reserved=add(second,'reserved','accepted');
  return {state,first,second,target,directory,oldSameTask,unrelatedBase,prefix,rejected,superseded,isolated,active,reserved};
}

test('bulk coordination retains exact order, directory overlaps, active work and accepted reservations',()=>{
  const f=fixture(),before=structuredClone(f.state),result=workspaceCoordination(f.state)[f.target.id];
  assert.deepEqual(result.overlaps.map(item=>item.runId),[f.directory.id,f.oldSameTask.id,f.reserved.id]);
  assert.deepEqual(result.overlaps.map(item=>item.paths),[['src/a.py'],['src/a.py'],['src/a.py']]);
  assert.deepEqual(result.activeRunIds,[f.active.id]);
  assert.deepEqual(result.blockingRunIds,[f.reserved.id]);
  assert.equal(result.acceptance.find(rule=>rule.code==='work_in_progress').met,false);
  assert.equal(result.acceptance.find(rule=>rule.code==='overlap_blocked').met,false);
  assert.deepEqual(coordination(f.state,f.target.id),result);
  assert.deepEqual(f.state,before,'Computing the projection cannot alter current or retained records.');
});

test('no coordination index survives status, base, membership or file changes',()=>{
  const f=fixture(),before=workspaceCoordination(f.state)[f.target.id];
  f.active.status='failed';f.reserved.status='rejected';f.directory.baseCommit=otherBase;
  f.oldSameTask.changedFiles=['unrelated.py'];
  const added=assignRun(f.state,f.second.id,{agent:'new',label:'New work',branch:'test/new'});
  const next=workspaceCoordination(f.state)[f.target.id];
  assert.deepEqual(next.overlaps,[]);
  assert.deepEqual(next.activeRunIds,[added.id]);
  assert.deepEqual(next.blockingRunIds,[]);
  assert.deepEqual(before.activeRunIds,[f.active.id],'Previously returned results stay historical values.');
  assert.deepEqual(coordination(f.state,f.target.id),next);
});

test('repository-free tasks still compare their alternatives and isolate other tasks',()=>{
  const f=fixture();f.first.repositoryKey=null;
  const value=workspaceCoordination(f.state)[f.target.id];
  assert.deepEqual(value.overlaps.map(item=>item.runId),[f.oldSameTask.id]);
  assert.deepEqual(value.activeRunIds,[]);assert.deepEqual(value.blockingRunIds,[]);
});

test('missing task references retain refusals, while superseded unrelated records stay excluded',()=>{
  const f=fixture();
  assert.throws(()=>coordination(f.state,'missing'),{code:'run_not_found',status:404});
  f.isolated.taskId='missing-task';
  assert.throws(()=>coordination(f.state,f.target.id),{code:'task_not_found',status:404});
  f.isolated.status='superseded';
  assert.doesNotThrow(()=>coordination(f.state,f.target.id));
  assert.throws(()=>workspaceCoordination(f.state),{code:'task_not_found',status:404},'The orphan still refuses when it is itself a displayed candidate.');
});

test('fresh bulk views keep independent-review revocation and project-base gates',()=>{
  const state=createExampleWorkspace(),run=state.runs.find(run=>run.id===exampleIds.safe);
  const task=state.tasks.find(task=>task.id===run.taskId);
  state.provider='cloudflare-artifacts';run.status='awaiting_review';task.status='review';task.acceptedRunId=null;task.mergedCommit=null;
  state.reviewRequests={[run.id]:'reviewer-unavailable'};
  const first=workspaceCoordination(state)[run.id];
  const review=first.acceptance.find(rule=>rule.code==='independent_review_required');
  assert.equal(review.met,false);assert.match(review.label,/Reviewer access changed/);
  state.projects[task.projectId].mainCommit=task.baseCommit;
  assert.equal(workspaceCoordination(state)[run.id].acceptance.find(rule=>rule.code==='project_advanced').met,true);
  state.projects[task.projectId].mainCommit='d'.repeat(40);
  assert.equal(workspaceCoordination(state)[run.id].acceptance.find(rule=>rule.code==='project_advanced').met,false);
});

test('empty workspaces and arbitrary retained ordering preserve the projection contract',()=>{
  assert.deepEqual(workspaceCoordination(createWorkspace()),{});
  const f=fixture();f.state.runs.reverse();
  assert.deepEqual(workspaceCoordination(f.state)[f.target.id].overlaps.map(item=>item.runId),[f.reserved.id,f.oldSameTask.id,f.directory.id]);
});
