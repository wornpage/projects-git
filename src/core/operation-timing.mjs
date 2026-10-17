import {WorkflowError} from './workflow.mjs';

export const TIMING_PHASES=Object.freeze(['verification','recovery']);
export const TIMING_OUTCOMES=Object.freeze(['completed','reconciled','failed','unconfirmed']);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const timestamp=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return null;
  const result=Date.parse(value);return Number.isSafeInteger(result)&&new Date(result).toISOString()===value?result:null;
};
const invalid=()=>{throw new WorkflowError('TIMING_LEDGER_INVALID','Retained phase timing is malformed. Preserve the operation for inspection.',503);};

/** An absent ledger is historical missing data, never a zero-length attempt. */
export function operationTimings(operation){
  if(operation.timings===undefined)return [];
  const rows=operation.timings;
  if(!Array.isArray(rows)||rows.length>200)invalid();
  const seen=new Set();
  for(const row of rows){
    if(!row||Object.keys(row).sort().join(',')!=='attemptId,finishedAt,outcome,phase,startedAt'
      ||!TIMING_PHASES.includes(row.phase)||!uuid(row.attemptId)||timestamp(row.startedAt)===null
      ||(row.finishedAt===null?row.outcome!==null:timestamp(row.finishedAt)===null||!TIMING_OUTCOMES.includes(row.outcome)))invalid();
    const key=row.phase+':'+row.attemptId;if(seen.has(key))invalid();seen.add(key);
  }
  return rows;
}
export function beginOperationTiming(operation,phase,attemptId,at=new Date().toISOString()){
  if(operation.state!=='pending'||operation.attemptId!==attemptId||!TIMING_PHASES.includes(phase)||!uuid(attemptId)||timestamp(at)===null)
    throw new WorkflowError('TIMING_ADMISSION_REQUIRED','Phase timing needs its current admitted operation attempt.',409);
  const rows=operationTimings(operation);
  if(rows.length>=200)throw new WorkflowError('TIMING_HISTORY_FULL','This operation retains 200 timing records. Preserve it and reconcile its outcome before further work.',409);
  if(rows.some(row=>row.phase===phase&&row.attemptId===attemptId))
    throw new WorkflowError('TIMING_ALREADY_STARTED','This phase already has a retained start. It was not replaced.',409);
  operation.timings=[...rows,{phase,attemptId,startedAt:at,finishedAt:null,outcome:null}];
}
export function finishOperationTiming(operation,phase,attemptId,outcome,at=new Date().toISOString()){
  if(operation.attemptId!==attemptId||!TIMING_OUTCOMES.includes(outcome)||timestamp(at)===null)
    throw new WorkflowError('TIMING_ATTEMPT_CHANGED','Phase timing no longer belongs to this attempt.',409);
  const rows=operationTimings(operation),index=rows.findIndex(row=>row.phase===phase&&row.attemptId===attemptId);
  if(index<0||rows[index].finishedAt!==null)
    throw new WorkflowError('TIMING_START_REQUIRED','A single retained unfinished start is required. Earlier timing was not replaced.',409);
  operation.timings=rows.map((row,i)=>i===index?{...row,finishedAt:at,outcome}:row);
}
