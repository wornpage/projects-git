import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,assignRun,startRun} from '../src/core/workflow.mjs';
import {queueProjectTasks,taskBriefs,eligibleQueuedTasks,queuedTasks,queueIdle} from '../src/core/project-work.mjs';
import {dependencyState} from '../public/task-dependencies.js';
import {taskOutcome} from '../public/workbench-state.js';
const brief=(title,dependsOn=[])=>({title,purpose:'Implement '+title,criteria:['Observable result'],owner:'Reviewer',dependsOn});
function setup(){const workspace=createWorkspace();const project={id:crypto.randomUUID(),name:'Dependency QA',mainCommit:'a'.repeat(40),kind:'connected',repositoryName:'qa',acceptingWork:true,policyVersion:1};workspace.projects={[project.id]:project};return{workspace,project};}

test('batch prerequisites resolve to durable IDs, enforce integration and let eligible work pass',()=>{
  const {workspace,project}=setup();
  const [first,second,third]=queueProjectTasks(workspace,project,[brief('Foundation'),brief('Client',['draft:1']),brief('Docs')]);
  assert.deepEqual(second.dependsOn,[first.id]);
  assert.deepEqual(queuedTasks(workspace,project.id).map(task=>task.id),[first.id,second.id,third.id]);
  assert.deepEqual(eligibleQueuedTasks(workspace,project.id).map(task=>task.id),[first.id,third.id]);
  const before=structuredClone(workspace);
  assert.throws(()=>assignRun(workspace,second.id,{agent:'external',label:'Premature',branch:'qa'}),{code:'dependency_waiting'});
  assert.deepEqual(workspace,before);
  first.acceptedRunId=crypto.randomUUID();first.status='accepted';
  assert.equal(dependencyState(workspace,second).ready,false);
  assert.match(taskOutcome(workspace,second).detail,/Accepted candidates/);
  first.mergedCommit='b'.repeat(40);first.status='merged';project.mainCommit=first.mergedCommit;
  assert.equal(dependencyState(workspace,second).ready,true);
  // Admission's normal base-binding happens before assignment; the domain rule
  // itself never changes main or an existing retained candidate.
  second.baseCommit=project.mainCommit;
  const run=assignRun(workspace,second.id,{agent:'external',label:'Eligible',branch:'qa'});
  assert.equal(startRun(workspace,run.id).status,'running');
});

test('invalid, foreign, self, duplicate and cyclic references refuse the entire batch',()=>{
  for(const dependencies of [['draft:1'],['draft:8'],['draft:2','draft:2'],[crypto.randomUUID()]]){
    const {workspace,project}=setup(),before=structuredClone(workspace);
    assert.throws(()=>queueProjectTasks(workspace,project,[brief('A',dependencies),brief('B')]),{code:'invalid_dependencies'});
    assert.deepEqual(workspace,before);
  }
  const {workspace,project}=setup(),before=structuredClone(workspace);
  assert.throws(()=>queueProjectTasks(workspace,project,[brief('A',['draft:2']),brief('B',['draft:1'])]),{code:'dependency_cycle'});
  assert.deepEqual(workspace,before);
  const foreign={...project,id:crypto.randomUUID()};workspace.projects[foreign.id]=foreign;
  const [other]=queueProjectTasks(workspace,foreign,[brief('Foreign')]);
  const saved=structuredClone(workspace);
  assert.throws(()=>queueProjectTasks(workspace,project,[brief('A',[other.id])]),{code:'invalid_dependencies'});
  assert.deepEqual(workspace,saved);
  assert.throws(()=>taskBriefs({tasks:[brief('A',[3])]}),{code:'invalid_dependencies'});
});

test('multiple prerequisites remain waiting until each integration; malformed state fails closed at start',()=>{
  const {workspace,project}=setup();
  const [a,b,c]=queueProjectTasks(workspace,project,[brief('A'),brief('B'),brief('C',['draft:1','draft:2'])]);
  a.mergedCommit='b'.repeat(40);assert.equal(dependencyState(workspace,c).waiting[0].id,b.id);
  b.mergedCommit='c'.repeat(40);c.baseCommit='d'.repeat(40);
  const run=assignRun(workspace,c.id,{agent:'external',label:'Ready',branch:'qa'});
  c.dependsOn=[crypto.randomUUID()];
  assert.throws(()=>startRun(workspace,run.id),{code:'invalid_dependency_state'});
  assert.equal(run.status,'assigned');
  assert.equal(taskOutcome(workspace,c).label,'Waiting for agent start');
});

test('waiting queue has an actionable idle reason and is retained distinctly from an empty queue',()=>{
  const {workspace,project}=setup();
  const [a,b]=queueProjectTasks(workspace,project,[brief('A'),brief('B',['draft:1'])]);
  assignRun(workspace,a.id,{agent:'external',label:'A',branch:'qa'});
  assert.deepEqual(eligibleQueuedTasks(workspace,project.id),[]);
  assert.deepEqual(queueIdle(workspace,project.id).waitingTaskIds,[b.id]);
  assert.match(queueIdle(workspace,project.id).reason,/prerequisite integration/);
  assert.deepEqual(JSON.parse(JSON.stringify(workspace)).tasks[1].dependsOn,[a.id]);
});

test('ordinary briefs retain their saved request fingerprint shape; empty dependencies are equivalent',()=>{
  const prior={title:'A',purpose:'Implement A',criteria:['Observable result'],owner:'Reviewer'};
  assert.deepEqual(taskBriefs({tasks:[prior]}),[prior]);
  assert.deepEqual(taskBriefs({tasks:[{...prior,dependsOn:[]}]}),[prior]);
});
