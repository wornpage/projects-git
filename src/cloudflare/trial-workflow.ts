import {ApiError} from './security.ts';
import type {HostedSnapshot} from './controller.ts';
import {trialSampleName} from '../core/trial-sample.mjs';

// Limits on stored work and accepted source, separate from the registry's daily
// admission/spending reservations. Failed and retained runs still consume totals.
export const TRIAL_WORKFLOW_LIMITS=Object.freeze({projects:1,tasks:10,runs:10,activeRuns:1,operations:100,sourceBytes:32768,metadataBytes:4*1024*1024});
export function trialWorkflowUsage(snapshot:HostedSnapshot) {
  return {projects:Object.keys(snapshot.workspace.projects??{}).length,tasks:snapshot.workspace.tasks.length,runs:snapshot.workspace.runs.length,
    activeRuns:snapshot.workspace.runs.filter(run=>['assigned','running'].includes(run.status)).length,
    operations:Object.keys(snapshot.operations).length,metadataBytes:new TextEncoder().encode(JSON.stringify(snapshot)).byteLength};
}
export function assertTrialWorkflowSnapshot(snapshot:HostedSnapshot):void {
  const name=trialSampleName(snapshot.workspace.id),usage=trialWorkflowUsage(snapshot);
  for(const key of ['projects','tasks','runs','activeRuns','operations','metadataBytes'] as const)
    if(usage[key]>TRIAL_WORKFLOW_LIMITS[key])throw new ApiError(429,'TRIAL_WORKFLOW_LIMIT','Trial '+key+' limit reached: '+usage[key]+' / '+TRIAL_WORKFLOW_LIMITS[key]+'. Retained work still counts.');
  const projects=Object.values(snapshot.workspace.projects??{});
  if(projects.some(project=>project.repositoryName!==name||project.kind!=='artifacts')||Object.values(snapshot.repositories).some(repository=>repository!==name))
    throw new ApiError(403,'TRIAL_REPOSITORY_FORBIDDEN','Trial workflows can use only their supplied sample repository.');
  if(Object.values(snapshot.jobs??{}).length)throw new ApiError(403,'TRIAL_MODEL_UNAVAILABLE','Operator-funded model runs are unavailable in this trial.');
  for(const [runId,fork] of Object.entries(snapshot.forks)){
    const operation=Object.values(snapshot.operations).find(op=>op.itemId===runId&&op.resourceName===fork.name&&['assign','claim','base-update'].includes(op.kind));
    if(!operation||!snapshot.workspace.runs.some(run=>run.id===runId))throw new ApiError(403,'TRIAL_REPOSITORY_FORBIDDEN','A candidate repository needs its retained assignment.');
  }
}
export function trialCandidateSource(input:Record<string,unknown>):{source:string;headCommit:string} {
  if(Object.keys(input).sort().join(',')!=='headCommit,source'||typeof input.source!=='string'||typeof input.headCommit!=='string'||!/^[a-f0-9]{40}$/.test(input.headCommit))
    throw new ApiError(400,'INVALID_TRIAL_SOURCE','Supply checkout.mjs source and the current assigned head commit.');
  const bytes=new TextEncoder().encode(input.source);
  if(!bytes.length||bytes.length>TRIAL_WORKFLOW_LIMITS.sourceBytes||input.source.includes('\0')||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==input.source)
    throw new ApiError(413,'TRIAL_SOURCE_LIMIT','Checkout source must be valid UTF-8 within 32 KiB.');
  return {source:input.source,headCommit:input.headCommit};
}
