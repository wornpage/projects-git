import test from 'node:test';
import assert from 'node:assert/strict';
import {projectOperationalMetrics,summarizeIntervals} from '../src/core/operational-metrics.mjs';
import {beginOperationTiming,finishOperationTiming,operationTimings} from '../src/core/operation-timing.mjs';

const at=seconds=>new Date(Date.UTC(2026,9,16)+seconds*1000).toISOString(),attempt='10000000-0000-4000-8000-000000000001';
function recorded(phase,start,end,outcome='completed'){
  const operation={state:'pending',kind:phase==='verification'?'checks':'merge',itemId:'run-one',attemptId:attempt};
  beginOperationTiming(operation,phase,attempt,at(start));if(end!==null){finishOperationTiming(operation,phase,attempt,outcome,at(end));operation.state='complete';}return operation;
}
function snapshot(){return {revision:7,workspace:{id:'fixture',projects:{one:{id:'one',name:'Private'},other:{id:'other',name:'Foreign'}},
  tasks:[{id:'task-one',projectId:'one',status:'review'}],
  runs:[{id:'run-one',taskId:'task-one',agent:'model',status:'awaiting_review',startedAt:at(30),finishedAt:at(60),
    evidence:{verified:true,verifiedAt:at(70)},reviewAssignments:[{id:'assignment',at:at(80)}],codeReview:{assignmentId:'assignment',at:at(100),verdict:'pass'},
    execution:{kind:'model-agent',model:'sol',requests:[{status:'received',usage:{inputTokens:10,outputTokens:5,cachedInputTokens:0}}]}}],
  events:[{type:'task.created',taskId:'task-one',at:at(0)},{type:'run.assigned',runId:'run-one',taskId:'task-one',at:at(10)}]},
  operations:{verification:recorded('verification',61,70),recovery:recorded('recovery',110,120,'reconciled')}};}

test('retained phase endpoints produce separate durations and complete entity denominators',()=>{
  const data=projectOperationalMetrics(snapshot(),'one',at(200));
  for(const [name,expected] of Object.entries({queue:10000,handoff:20000,execution:30000,reviewWait:10000,reviewTurnaround:20000,verification:9000,recovery:10000})){
    const phase=data.phases[name];assert.equal(phase.total,1);assert.equal(phase.observed,1);assert.equal(phase.medianMs,expected);assert.equal(phase.remainingMs,null);
  }
  assert.equal(data.flags.phaseTotalsMustNotBeAdded,true);assert.equal(data.cost.actual,null);assert.equal(data.cost.estimate,null);
  assert.deepEqual(data.modelProvenance.models,[{name:'sol',runs:1}]);assert.equal(data.usage.observedInputTokens,10);assert.equal(data.usage.observedUsageRequests,1);
});

test('missing, active, invalid, not-started and not-applicable observations remain disjoint',()=>{
  const rows=[{start:at(0),end:at(10)},{start:at(20),end:null,active:true},{start:null,end:null},{start:'bad',end:at(10)},
    {start:at(20),end:at(10)},{start:at(0),end:at(300)},{classification:'notStarted'},{classification:'notApplicable'}];
  const result=summarizeIntervals(rows,at(200));
  assert.deepEqual([result.total,result.observed,result.active,result.missing,result.invalid,result.notStarted,result.notApplicable],[8,1,1,1,3,1,1]);
  assert.equal(result.activeMedianElapsedMs,180000);assert.equal(result.medianMs,10000);assert.equal(result.remainingMs,null);
  assert.equal(result.total,result.observed+result.active+result.missing+result.invalid+result.notStarted+result.notApplicable);
});

test('historical verification and recovery gaps never turn into zero-duration successes',()=>{
  const source=snapshot();delete source.operations.verification.timings;delete source.operations.recovery.timings;
  const data=projectOperationalMetrics(source,'one',at(200));
  for(const name of ['verification','recovery']){
    assert.equal(data.phases[name].observed,0);assert.equal(data.phases[name].medianMs,null);
    assert.ok(data.phases[name].coverage.withoutRecords>0);assert.equal(data.phases[name].historicalAttemptsMayBeUnrecorded,true);
  }
});

test('abandoned starts remain missing while a current pending window has only elapsed active time',()=>{
  const source=snapshot();source.operations.verification=recorded('verification',100,null);source.operations.recovery=recorded('recovery',100,null);
  source.operations.recovery.state='failed';const data=projectOperationalMetrics(source,'one',at(200));
  assert.equal(data.phases.verification.active,1);assert.equal(data.phases.verification.activeMedianElapsedMs,100000);
  assert.equal(data.phases.recovery.missing,1);assert.equal(data.phases.recovery.active,0);assert.equal(data.phases.recovery.medianMs,null);
});

test('foreign repositories and contradictory operation references do not alter local denominators',()=>{
  const source=snapshot();source.workspace.tasks.push({id:'foreign-task',projectId:'other'});
  source.workspace.runs.push({id:'foreign-run',taskId:'foreign-task',execution:{model:'FORBIDDEN_NAME',requests:[{usage:{inputTokens:999,outputTokens:999}}]}});
  source.operations.foreign={kind:'checks',projectId:'other',taskId:'task-one',timings:'bad-foreign-ledger'};
  source.operations.foreignItem={kind:'checks',projectId:'one',itemId:'foreign-run',timings:'bad-foreign-ledger'};
  source.operations.foreignSource={kind:'base-update',projectId:'one',sourceRunId:'foreign-run',timings:'bad-foreign-ledger'};
  source.operations.foreignTasks={kind:'task',projectId:'one',taskIds:['task-one','foreign-task']};
  const data=projectOperationalMetrics(source,'one',at(200));assert.equal(data.counts.tasks,1);assert.equal(data.counts.candidates,1);
  assert.equal(data.counts.retainedOperations,2);assert.ok(!JSON.stringify(data).includes('FORBIDDEN_NAME'));assert.equal(data.usage.observedInputTokens,10);
});

test('an abandoned timing start stays missing after a later attempt is admitted',()=>{
  const source=snapshot(),operation=recorded('verification',100,null);
  operation.attemptId='20000000-0000-4000-8000-000000000002';
  beginOperationTiming(operation,'recovery',operation.attemptId,at(150));
  source.operations.verification=operation;
  const data=projectOperationalMetrics(source,'one',at(200));
  assert.equal(data.phases.verification.missing,1);assert.equal(data.phases.verification.active,0);
  assert.equal(data.phases.recovery.active,1);assert.equal(data.phases.recovery.activeMedianElapsedMs,50000);
});

test('a paged snapshot cannot silently establish complete metrics',()=>{
  const source=snapshot();for(const partial of [{...source,page:{}},{...source,workspace:{...source.workspace,page:{}}}])
    assert.throws(()=>projectOperationalMetrics(partial,'one',at(200)),{code:'METRICS_COMPLETE_SNAPSHOT_REQUIRED'});
  assert.throws(()=>projectOperationalMetrics(source,'unknown',at(200)),{code:'PROJECT_NOT_FOUND'});
});

test('unknown usage, missing cache usage and absent receipts preserve their own denominators',()=>{
  const source=snapshot(),receipt=source.workspace.runs[0].execution;delete receipt.requests[0].usage.cachedInputTokens;
  receipt.requests.push({status:'usage_unknown',usage:null});
  source.workspace.runs.push({id:'external',taskId:'task-one',agent:'external',origin:'external-agent',label:'Astra or Sol',status:'assigned',startedAt:null,finishedAt:null});
  const data=projectOperationalMetrics(source,'one',at(200));
  assert.equal(data.usage.knownRequests,2);assert.equal(data.usage.observedUsageRequests,1);assert.equal(data.usage.unknownUsageRequests,1);
  assert.equal(data.usage.cachedUsageKnownRequests,0);assert.equal(data.usage.observedCachedInputTokens,null);
  assert.equal(data.usage.externalRunsWithoutUsage,1);assert.equal(data.modelProvenance.unattributedRuns,1);
  assert.deepEqual(data.modelProvenance.models,[{name:'sol',runs:1}]);assert.equal(data.cost.actual,null);
});

test('unsafe token totals are flagged and never emitted as imprecise actuals',()=>{
  const source=snapshot();source.workspace.runs[0].execution.requests=[{usage:{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1,cachedInputTokens:null}},
    {usage:{inputTokens:1,outputTokens:1,cachedInputTokens:null}}];
  const data=projectOperationalMetrics(source,'one',at(200));assert.equal(data.usage.totalOverflow,true);assert.equal(data.usage.observedInputTokens,null);
  assert.equal(data.usage.observedOutputTokens,2);assert.equal(data.usage.observedUsageRequests,2);
});

test('an earlier assignment does not close a renewed verification wait, and mismatched assessments stay active',()=>{
  const source=snapshot(),run=source.workspace.runs[0];run.evidence.verifiedAt=at(90);run.codeReview.assignmentId='older-assignment';
  const data=projectOperationalMetrics(source,'one',at(200));assert.equal(data.phases.reviewWait.active,1);assert.equal(data.phases.reviewWait.observed,0);
  assert.equal(data.phases.reviewTurnaround.active,1);assert.equal(data.phases.reviewTurnaround.observed,0);
});

test('timing records are append-only per admitted attempt and cannot rebind old history',()=>{
  const operation={state:'pending',kind:'checks',attemptId:attempt};beginOperationTiming(operation,'verification',attempt,at(0));
  assert.throws(()=>beginOperationTiming(operation,'verification',attempt,at(1)),{code:'TIMING_ALREADY_STARTED'});
  finishOperationTiming(operation,'verification',attempt,'completed',at(10));const original=structuredClone(operation.timings[0]);
  assert.throws(()=>finishOperationTiming(operation,'verification',attempt,'completed',at(20)),{code:'TIMING_START_REQUIRED'});
  operation.attemptId='20000000-0000-4000-8000-000000000002';beginOperationTiming(operation,'recovery',operation.attemptId,at(20));
  finishOperationTiming(operation,'recovery',operation.attemptId,'reconciled',at(25));assert.deepEqual(operation.timings[0],original);assert.equal(operation.timings.length,2);
});

test('malformed or ambiguous timing history refuses the projection without truncating it',()=>{
  for(const change of [op=>{op.timings='bad';},op=>{op.timings.push({...op.timings[0]});},op=>{op.timings[0].startedAt='2026-02-31T00:00:00.000Z';},
    op=>{op.timings[0].outcome='passed-all-checks';}]){
    const source=snapshot();change(source.operations.verification);const original=JSON.stringify(source);
    assert.throws(()=>projectOperationalMetrics(source,'one',at(200)),{code:'TIMING_LEDGER_INVALID'});assert.equal(JSON.stringify(source),original);
  }
});
