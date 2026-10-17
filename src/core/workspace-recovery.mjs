import {WorkflowError} from './workflow.mjs';
import {readWorkspaceBackup,workspaceBackupPreview} from './workspace-backup.mjs';

export const HISTORY_RESTORE_CONFIRMATION='RESTORE HISTORY ONLY';
const refuse=(code,message)=>{throw new WorkflowError(code,message,409);};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function recoveryDestinationEmpty(snapshot){
  const state=snapshot.workspace;
  return !state.tasks.length&&!state.runs.length&&!Object.keys(state.projects??{}).length
    &&!['repositories','forks','jobs','checkPolicies'].some(key=>Object.keys(snapshot[key]??{}).length)
    &&!Object.values(snapshot.operations).some(operation=>operation.kind!=='workspace-restore'||operation.state!=='complete');
}
export function recoveryLiveLedgerRows(ledgers){
  if(ledgers?.capture!=='coherent-sqlite-transaction')refuse('BACKUP_LEDGER_UNAVAILABLE','A coherent live-ledger capture is required before recovery.');
  return ['artifactSubscriptions','artifactSubscriptionAttempts','artifactEvents','artifactEventAttempts','artifactDeliveries'].reduce((total,name)=>{
    if(!Array.isArray(ledgers[name]))refuse('BACKUP_LEDGER_UNAVAILABLE','Complete live-ledger arrays are required before recovery.');return total+ledgers[name].length;
  },0);
}

export async function readWorkspaceRecovery(input){
  if(!exact(input,['archive','expectedSha256','expectedSourceWorkspaceId','expectedWorkspaceId','expectedRevision','confirmation'])
    ||!digest(input.expectedSha256)||typeof input.expectedSourceWorkspaceId!=='string'||typeof input.expectedWorkspaceId!=='string'
    ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.confirmation!==HISTORY_RESTORE_CONFIRMATION)
    refuse('WORKSPACE_RESTORE_INPUT','Supply the complete archive, separately pinned source/destination identities, revision, digest and explicit history-only confirmation.');
  const archive=await readWorkspaceBackup(JSON.stringify(input.archive),input.expectedSha256);
  if(archive.payload.workspace.id!==input.expectedSourceWorkspaceId)refuse('WORKSPACE_RESTORE_SOURCE','The archive belongs to another source workspace.');
  return {archive,expectedSourceWorkspaceId:input.expectedSourceWorkspaceId,expectedWorkspaceId:input.expectedWorkspaceId,expectedRevision:input.expectedRevision,
    fingerprintInput:[input.expectedSha256,input.expectedSourceWorkspaceId,input.expectedWorkspaceId,input.expectedRevision,input.confirmation]};
}

/** A digest-keyed immutable historical import; it never installs source workflow state. */
export function retainWorkspaceRecovery(snapshot,request,{ownerSubject,importedAt}){
  if(snapshot.workspace.id!==request.expectedWorkspaceId)refuse('WORKSPACE_RESTORE_DESTINATION','The current destination differs from the confirmed workspace.');
  if(snapshot.revision!==request.expectedRevision)refuse('STATE_CONFLICT','The destination changed. Preview its current revision before confirming another restore.');
  if(!ownerSubject||!Number.isFinite(Date.parse(importedAt)))refuse('WORKSPACE_RESTORE_PROVENANCE','Current owner import provenance is required.');
  if(!recoveryDestinationEmpty(snapshot))
    refuse('WORKSPACE_RESTORE_NOT_EMPTY','Restore only into an empty destination. Existing workflow and unresolved effects are preserved.');
  const id=request.archive.sha256;
  if(Object.hasOwn(snapshot.recoveryImports??{},id))refuse('WORKSPACE_RESTORE_EXISTS','This archive is already retained. Read the existing history instead of importing it again.');
  snapshot.recoveryImports??={};
  snapshot.recoveryImports[id]={archive:structuredClone(request.archive),importedAt,importedBy:ownerSubject};
  return id;
}

export function workspaceRecoverySummary(id,entry){
  const preview=workspaceBackupPreview(entry.archive);
  return {id,importedAt:entry.importedAt,importedBy:entry.importedBy,sourceWorkspaceId:preview.sourceWorkspaceId,sourceRevision:preview.sourceRevision,
    counts:preview.counts,historical:true,restoresAuthority:false,resumesWork:false,codeAvailable:false};
}

/** Original names stay quarantined, including names inside prior imports and historical ledgers. */
export function quarantinedRecoveryNames(snapshot){
  const names=new Set(),seen=new Set();
  const add=value=>{if(typeof value==='string'&&value)names.add(value);};
  const visit=archive=>{
    if(seen.has(archive.sha256))return;seen.add(archive.sha256);const p=archive.payload;
    for(const row of [...p.projects,...p.resources])add(row.repositoryName);
    for(const row of [...p.repositories,...p.forks])add(row.name);
    for(const row of p.operations)add(row.receipt.resourceName);
    for(const event of p.events)add(event.repositoryEvent?.repositoryName);
    for(const handoff of [...p.handoffs,...p.projects.flatMap(project=>project.history)]){
      add(handoff.payload.task.repositoryName);for(const event of handoff.payload.events)add(event.repositoryEvent?.repositoryName);
    }
    const ledgers=p.ledgers;
    if(ledgers){for(const row of [...ledgers.artifactSubscriptions,...ledgers.artifactSubscriptionAttempts])add(row.repositoryName);
      for(const row of ledgers.artifactEvents)add(row.event.repositoryName);}
    for(const entry of p.priorImports??[])visit(entry.archive);
  };
  for(const entry of Object.values(snapshot.recoveryImports??{}))visit(entry.archive);
  return [...names].sort();
}
export function requireFreshRecoveryResource(snapshot,name){
  if(typeof name==='string'&&quarantinedRecoveryNames(snapshot).some(original=>original.toLowerCase()===name.toLowerCase()))refuse('RECOVERY_RESOURCE_QUARANTINED','This original resource name is retained in recovery history. Use an explicitly fresh repository name; old effects are not reconciled or replayed.');
}
