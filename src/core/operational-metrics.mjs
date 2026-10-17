import {WorkflowError} from './workflow.mjs';
import {timestamp,operationTimings} from './operation-timing.mjs';

const definitions=Object.freeze({
  queue:{label:'Task queue wait',unit:'tasks',definition:'Task-created event to its first assigned-run event; includes prerequisite and admission waiting.'},
  handoff:{label:'Assignment to start',unit:'candidates',definition:'Assignment event to reported start; includes fork preparation, handoff and operator waiting.'},
  execution:{label:'Reported execution window',unit:'candidates',definition:'Reported start to submission or failure. Includes coding, tests and waiting; it is not measured CPU or coding time.'},
  reviewWait:{label:'Verification to review assignment',unit:'candidates',definition:'Last retained trusted verification timestamp to the latest review assignment; earlier assignments do not close this wait.'},
  reviewTurnaround:{label:'Assigned review turnaround',unit:'candidates',definition:'Latest review assignment to its matching assessment. Includes reviewer work and waiting.'},
  verification:{label:'Recorded verification windows',unit:'windows',definition:'Explicitly retained verification start/end observations; legacy operations without them remain unmeasured.'},
  recovery:{label:'Recorded recovery windows',unit:'windows',definition:'Explicit resume/reconcile start/end observations. Absence does not prove no recovery happened.'},
});
const median=values=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
const count=value=>Number.isSafeInteger(value)&&value>=0;

/** Complete, disjoint observation categories; elapsed active time is separate. */
export function summarizeIntervals(rows,observedAt){
  const now=timestamp(observedAt);if(now===null)throw new WorkflowError('METRICS_TIME_INVALID','Metrics require an explicit UTC observation time.',422);
  const counts={observed:0,active:0,missing:0,invalid:0,notStarted:0,notApplicable:0},durations=[],activeDurations=[],outcomes=new Map();
  let minimumMs=null,maximumMs=null;
  for(const row of rows){
    if(['notStarted','notApplicable'].includes(row.classification)){counts[row.classification]++;continue;}
    const endValue=row.end??null,start=timestamp(row.start),end=endValue===null?null:timestamp(endValue);
    if(row.start===null||row.start===undefined){counts.missing++;continue;}
    if(start===null||endValue!==null&&end===null){counts.invalid++;continue;}
    if(endValue===null){
      if(row.active&&now>=start&&Number.isSafeInteger(now-start)){counts.active++;activeDurations.push(now-start);}
      else if(row.active){counts.invalid++;}else counts.missing++;
      continue;
    }
    const elapsed=end-start;
    if(elapsed<0||end>now||!Number.isSafeInteger(elapsed)){counts.invalid++;continue;}
    counts.observed++;durations.push(elapsed);minimumMs=minimumMs===null?elapsed:Math.min(minimumMs,elapsed);maximumMs=maximumMs===null?elapsed:Math.max(maximumMs,elapsed);
    const outcome=row.outcome??'completed';outcomes.set(outcome,(outcomes.get(outcome)??0)+1);
  }
  return {total:rows.length,...counts,outcomes:Object.fromEntries(outcomes),medianMs:median(durations),minimumMs,
    maximumMs,activeMedianElapsedMs:median(activeDurations),remainingMs:null};
}
function startEvents(events,taskIds,runIds){
  const index=new Map();
  for(const event of events){
    const key=event.type==='task.created'&&taskIds.has(event.taskId)?'task:'+event.taskId
      :event.type==='run.assigned'&&runIds.has(event.runId)?'run:'+event.runId:null;
    if(!key)continue;const previous=index.get(key);
    if(previous==='invalid'||timestamp(event.at)===null)index.set(key,'invalid');
    else if(!previous||event.at<previous)index.set(key,event.at);
  }
  return index;
}
function timingSummary(operations,phase,observedAt,kinds){
  const eligible=operations.filter(operation=>kinds.includes(operation.kind)),rows=[];let withRecords=0;
  for(const operation of eligible){
    const recorded=operationTimings(operation).filter(row=>row.phase===phase);if(recorded.length)withRecords++;
    for(const row of recorded)rows.push({start:row.startedAt,end:row.finishedAt,
      active:operation.state==='pending'&&row.attemptId===operation.attemptId,outcome:row.outcome});
  }
  return {...definitions[phase],...summarizeIntervals(rows,observedAt),coverage:{operations:eligible.length,withRecords,withoutRecords:eligible.length-withRecords},
    historicalAttemptsMayBeUnrecorded:true};
}

/** This is a projection of a complete authoritative snapshot, never a UI page. */
export function projectOperationalMetrics(snapshot,projectId,observedAt=new Date().toISOString()){
  const workspace=snapshot?.workspace;
  if(!workspace||Object.hasOwn(snapshot,'page')||Object.hasOwn(workspace,'page')||!Number.isSafeInteger(snapshot.revision)
    ||!Array.isArray(workspace.tasks)||!Array.isArray(workspace.runs)||!Array.isArray(workspace.events)
    ||!snapshot.operations||typeof snapshot.operations!=='object'||Array.isArray(snapshot.operations))
    throw new WorkflowError('METRICS_COMPLETE_SNAPSHOT_REQUIRED','Metrics need a complete retained snapshot; a page cannot establish their denominators.',409);
  if(!workspace.projects?.[projectId])throw new WorkflowError('PROJECT_NOT_FOUND','Repository not found.',404);
  const tasks=workspace.tasks.filter(task=>task.projectId===projectId),taskIds=new Set(tasks.map(task=>task.id));
  const runs=workspace.runs.filter(run=>taskIds.has(run.taskId)),runIds=new Set(runs.map(run=>run.id)),events=startEvents(workspace.events,taskIds,runIds);
  const operations=Object.values(snapshot.operations).filter(op=>op&&(!op.projectId||op.projectId===projectId)&&(!op.taskId||taskIds.has(op.taskId))
    &&(!op.itemId||runIds.has(op.itemId)||taskIds.has(op.itemId))&&(!op.sourceRunId||runIds.has(op.sourceRunId))
    &&(!op.taskIds||Array.isArray(op.taskIds)&&op.taskIds.every(id=>taskIds.has(id)))
    &&(op.projectId===projectId||taskIds.has(op.taskId)||runIds.has(op.itemId)||taskIds.has(op.itemId)));
  const assignedByTask=new Map();
  for(const run of runs){const at=events.get('run:'+run.id),previous=assignedByTask.get(run.taskId);if(at&&(at==='invalid'||!previous||previous!=='invalid'&&at<previous))assignedByTask.set(run.taskId,at);}
  const phase=(name,rows)=>({...definitions[name],...summarizeIntervals(rows,observedAt)});
  const queue=tasks.map(task=>{
    const start=events.get('task:'+task.id)??null,assigned=assignedByTask.get(task.id)??null;
    return {start,end:assigned,active:!assigned,outcome:'assigned'};
  });
  const handoff=runs.map(run=>({start:events.get('run:'+run.id)??null,end:run.startedAt,
    active:run.status==='assigned',classification:['existing-git','reconciled-git'].includes(run.origin)?'notApplicable':undefined,outcome:'started'}));
  const execution=runs.map(run=>({start:run.startedAt,end:run.finishedAt,active:run.status==='running',outcome:run.status==='failed'?'failed':'submitted',
    classification:['existing-git','reconciled-git'].includes(run.origin)&&!run.startedAt?'notApplicable':run.status==='assigned'&&!run.startedAt?'notStarted':undefined}));
  const reviewWait=runs.map(run=>{
    const evidence=run.evidence,assignment=run.reviewAssignments?.at(-1),start=evidence?.verified===true?evidence.verifiedAt:null;
    const end=assignment&&timestamp(assignment.at)===null?assignment.at
      :assignment&&timestamp(start)!==null&&timestamp(assignment.at)>=timestamp(start)?assignment.at:null;
    return {start,end,active:Boolean(start)&&!end,classification:!run.finishedAt&&run.status!=='awaiting_review'?'notApplicable':undefined,outcome:'assigned'};
  });
  const reviewTurnaround=runs.map(run=>{
    const assignment=run.reviewAssignments?.at(-1),assessment=run.codeReview;
    return {start:assignment?.at??null,end:assessment?.assignmentId===assignment?.id?assessment?.at??null:null,active:Boolean(assignment),
      classification:!assignment?'notStarted':undefined,outcome:assessment?.verdict??'unconfirmed'};
  });
  const modelNames=new Map(),usage={knownRequests:0,unknownUsageRequests:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,cachedUsageKnownRequests:0,
    modelRunsWithoutReceipt:0,externalRunsWithoutUsage:0,totalOverflow:false};
  const add=(key,value)=>{if(usage[key]===null)return;if(!Number.isSafeInteger(usage[key]+value)){usage[key]=null;usage.totalOverflow=true;}else usage[key]+=value;};
  let modelNamedRuns=0,unattributedRuns=0;
  for(const run of runs){
    const receipt=run.execution,name=receipt?.model;
    if(typeof name==='string'&&name.length>0&&name.length<=160&&!/[\0\r\n]/.test(name)){modelNames.set(name,(modelNames.get(name)??0)+1);modelNamedRuns++;}else unattributedRuns++;
    if(run.agent==='model'&&!Array.isArray(receipt?.requests)){usage.modelRunsWithoutReceipt++;continue;}
    if(run.origin==='external-agent'&&!Array.isArray(receipt?.requests)){usage.externalRunsWithoutUsage++;continue;}
    if(receipt?.requests!==undefined&&!Array.isArray(receipt.requests))throw new WorkflowError('METRICS_USAGE_INVALID','Retained model requests are malformed; their count cannot be established.',503);
    for(const request of receipt?.requests??[]){
      const record=request?.usage;usage.knownRequests++;
      if(!record||!count(record.inputTokens)||!count(record.outputTokens)||record.cachedInputTokens!=null&&(!count(record.cachedInputTokens)||record.cachedInputTokens>record.inputTokens)){
        usage.unknownUsageRequests++;continue;
      }
      add('inputTokens',record.inputTokens);add('outputTokens',record.outputTokens);
      if(record.cachedInputTokens!=null){add('cachedInputTokens',record.cachedInputTokens);usage.cachedUsageKnownRequests++;}
    }
  }
  const observedUsageRequests=usage.knownRequests-usage.unknownUsageRequests;
  const {inputTokens,outputTokens,cachedInputTokens,...usageCounts}=usage;
  return {schemaVersion:1,projectId,sourceRevision:snapshot.revision,observedAt,scope:'complete-repository-history',
    counts:{tasks:tasks.length,candidates:runs.length,retainedOperations:operations.length},
    phases:{queue:phase('queue',queue),handoff:phase('handoff',handoff),execution:phase('execution',execution),reviewWait:phase('reviewWait',reviewWait),
      reviewTurnaround:phase('reviewTurnaround',reviewTurnaround),verification:timingSummary(operations,'verification',observedAt,['checks','model-check','merge']),
      recovery:timingSummary(operations,'recovery',observedAt,['assign','claim','checks','model-check','merge','base-update','restore','repository-create','project-access'])},
    modelProvenance:{totalRuns:runs.length,recordedRuns:modelNamedRuns,unattributedRuns,models:[...modelNames].map(([name,runs])=>({name,runs}))},
    usage:{...usageCounts,observedInputTokens:observedUsageRequests?inputTokens:null,observedOutputTokens:observedUsageRequests?outputTokens:null,
      observedCachedInputTokens:usage.cachedUsageKnownRequests?cachedInputTokens:null,observedUsageRequests,scope:'retained-coding-agent-requests-only'},
    cost:{currency:'USD',actual:null,measuredRequests:0,knownRequests:usage.knownRequests,estimate:null,reason:'No verified billing measurements are retained. External-agent requests and other Cloudflare charges are not included.'},
    flags:{phaseWindowsMayOverlap:true,phaseTotalsMustNotBeAdded:true,historicalRecoveryMayBeUnrecorded:true}};
}
