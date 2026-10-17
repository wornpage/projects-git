import {WorkflowError} from './workflow.mjs';
import {buildTaskHandoff} from './handoff.mjs';
import {archiveCommits} from './project-archive.mjs';
import {operationTimings,timestamp} from './operation-timing.mjs';
import {validateBackupHandoff,validateBackupCheckPolicy,portableBackupEvidence,validBackupEvidence} from './backup-records.mjs';

export const WORKSPACE_BACKUP_FORMAT='projects-git-workspace-backup/v1';
export const MAX_WORKSPACE_BACKUP_BYTES=1024*1024;
export const BACKUP_LIMITS=Object.freeze({projects:16,resources:64,tasks:256,runs:512,operations:2000,events:10000,policies:512,gitMappings:1024,jobs:512});
const encoder=new TextEncoder(),hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fields=(value,names)=>record(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const select=(value,names)=>Object.fromEntries(names.filter(name=>value[name]!==undefined).map(name=>[name,value[name]]));
const refuse=message=>{throw new WorkflowError('WORKSPACE_BACKUP_INVALID',message,422);};
const kinds=['task','assign','claim','model','merge','checks','base-update','model-check','review-inference','restore','repository-create','project-access'];
const operationFields=['fingerprint','kind','state','itemId','taskId','taskIds','projectId','resourceName','repositoryId','attemptId','executorAttemptId',
  'baseCommit','pendingCommit','sourceRunId','errorCode','leaseUntil','timestamp','contextId','assignmentId','reviewerId','reviewerIssuer','model','startedAt',
  'reservesExecution','cancelled','accessVersion','revokeRunIds','revokedRunIds','timings','report','idleResult'];
const boundary='Historical recovery data only. No credentials, access grants, runnable jobs, current approval or automatic retry authority are restored. Pending effects remain unresolved.';

function canonical(value,depth=0){
  if(depth>40)refuse('Workspace backup nesting exceeds 40 levels.');
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(item=>canonical(item,depth+1)).join(',')+']';
  if(record(value)&&Object.getPrototypeOf(value)===Object.prototype)
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key],depth+1)).join(',')+'}';
  refuse('Workspace backups contain finite JSON data only.');
}
async function checksum(payload){
  const bytes=encoder.encode(canonical(payload));
  if(bytes.byteLength>MAX_WORKSPACE_BACKUP_BYTES)refuse('Workspace backup exceeds 1 MiB; no records were truncated.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function operationValid(operation){
  if(!record(operation)||Object.keys(operation).some(key=>!operationFields.includes(key))||!kinds.includes(operation.kind)
    ||!['pending','complete','failed'].includes(operation.state)||typeof operation.fingerprint!=='string'
    ||operation.fingerprint!==''&&!hash(operation.fingerprint)&&!(operation.kind==='model-check'&&uuid(operation.fingerprint)))refuse('An operation receipt has an unsupported shape.');
  for(const name of ['itemId','taskId','projectId','resourceName','repositoryId','attemptId','executorAttemptId','sourceRunId','errorCode','assignmentId','reviewerId'])
    if(operation[name]!==undefined&&!identifier(operation[name]))refuse('An operation receipt has an invalid '+name+'.');
  for(const name of ['baseCommit','pendingCommit'])if(operation[name]!==undefined&&!commit(operation[name]))refuse('Invalid operation commit.');
  for(const name of ['taskIds','revokeRunIds','revokedRunIds'])
    if(operation[name]!==undefined&&(!Array.isArray(operation[name])||operation[name].length>512||operation[name].some(value=>!identifier(value))))refuse('Invalid operation identity list.');
  for(const name of ['leaseUntil','timestamp','accessVersion'])
    if(operation[name]!==undefined&&(!Number.isSafeInteger(operation[name])||operation[name]<0))refuse('Invalid operation numeric observation.');
  for(const name of ['reservesExecution','cancelled'])if(operation[name]!==undefined&&typeof operation[name]!=='boolean')refuse('Invalid operation flag.');
  if(operation.startedAt!==undefined&&timestamp(operation.startedAt)===null)refuse('Invalid operation timestamp.');
  for(const name of ['reviewerIssuer','model','contextId'])if(operation[name]!==undefined&&(typeof operation[name]!=='string'||operation[name].length>300||/[\0\r\n]/.test(operation[name])))refuse('Invalid operation observation.');
  if(operation.report!==undefined&&!validBackupEvidence(operation.report))refuse('Invalid retained operation verifier report.');
  if(operation.idleResult!==undefined&&(!fields(operation.idleResult,['idle','reason','waitingTaskIds'])||typeof operation.idleResult.idle!=='boolean'
    ||typeof operation.idleResult.reason!=='string'||!Array.isArray(operation.idleResult.waitingTaskIds)||operation.idleResult.waitingTaskIds.some(id=>!identifier(id))))refuse('Invalid retained idle result.');
  operationTimings(operation);
}
function referencedCommits(project,operations,handoffs,jobs){
  const commits=new Set(archiveCommits([...project.history,...handoffs],project.mainCommit));
  for(const handoff of [...project.history,...handoffs])for(const run of handoff.payload.runs)if(run.execution?.pendingCommit){
    if(!commit(run.execution.pendingCommit))refuse('Invalid uncertain execution commit.');commits.add(run.execution.pendingCommit);
  }
  const taskIds=new Set(handoffs.map(item=>item.payload.task.id)),runIds=new Set(handoffs.flatMap(item=>item.payload.runs.map(run=>run.id)));
  for(const {receipt} of operations)if(receipt.projectId===project.id||taskIds.has(receipt.taskId)||taskIds.has(receipt.itemId)||runIds.has(receipt.itemId)||runIds.has(receipt.sourceRunId))
    for(const value of [receipt.baseCommit,receipt.pendingCommit,receipt.report?.commit])if(value)commits.add(value);
  for(const job of jobs)if(runIds.has(job.runId)&&job.pendingCommit)commits.add(job.pendingCommit);
  if(commits.size>128)refuse('A backup project exceeds 128 referenced commits; nothing was truncated.');
  return [...commits].sort();
}
function recoveryResources(projects,handoffs,operations,jobs){
  const taskProjects=new Map(handoffs.map(item=>[item.payload.task.id,item.payload.task.projectId]));
  const runProjects=new Map(handoffs.flatMap(item=>item.payload.runs.map(run=>[run.id,item.payload.task.projectId])));
  const resources=projects.map(project=>({id:project.id,kind:'project',projectId:project.id,repositoryName:project.repositoryName,anchorCommit:project.mainCommit,
    defaultBranch:project.defaultBranch,commits:referencedCommits(project,operations,handoffs.filter(item=>item.payload.task.projectId===project.id),jobs)}));
  for(const {key,receipt} of operations){
    const owners=new Set([receipt.projectId,taskProjects.get(receipt.taskId),taskProjects.get(receipt.itemId),runProjects.get(receipt.itemId),runProjects.get(receipt.sourceRunId)].filter(Boolean));
    if(owners.size>1)refuse('An operation contradicts its repository/task/candidate ownership.');
    const projectId=[...owners][0]??null,commits=[...new Set([receipt.pendingCommit,receipt.report?.commit,receipt.baseCommit].filter(Boolean))].sort();
    if(!commits.length||projects.some(project=>project.id===projectId))continue;
    resources.push({id:'operation:'+key,kind:'unattached-operation',projectId,repositoryName:receipt.resourceName??null,
      anchorCommit:receipt.pendingCommit??receipt.report?.commit??receipt.baseCommit,defaultBranch:null,commits});
  }
  return resources;
}
function counts(payload){
  const history=payload.projects.flatMap(project=>project.history),runs=items=>items.reduce((n,item)=>n+item.payload.runs.length,0);
  const currentTasks=payload.handoffs.length,historicalTasks=history.length,currentRuns=runs(payload.handoffs),historicalRuns=runs(history);
  const currentEvents=payload.events.length,historicalEvents=history.reduce((n,item)=>n+item.payload.events.length,0);
  const currentPolicies=payload.checkPolicies.length,historicalPolicies=payload.projects.reduce((n,project)=>n+project.historicalCheckPolicies.length,0);
  return {projects:payload.projects.length,resources:payload.resources.length,currentTasks,historicalTasks,tasks:currentTasks+historicalTasks,
    currentRuns,historicalRuns,runs:currentRuns+historicalRuns,currentEvents,historicalEvents,events:currentEvents+historicalEvents,
    currentPolicies,historicalPolicies,policies:currentPolicies+historicalPolicies,repositoryMappings:payload.repositories.length,forkMappings:payload.forks.length,
    gitMappings:payload.repositories.length+payload.forks.length,operations:payload.operations.length,operationReports:payload.operations.filter(row=>row.receipt.report).length,
    jobs:payload.jobs.length,pendingOperations:payload.operations.filter(row=>row.receipt.state==='pending').length,
    unsettledJobs:payload.jobs.filter(job=>['queued','running'].includes(job.status)).length};
}

/** Capture a complete revision. Raw coordinator state and provider responses are never selected. */
export async function buildWorkspaceBackup(snapshot,exportedAt=new Date().toISOString()){
  if(!snapshot?.workspace||Object.hasOwn(snapshot,'page')||Object.hasOwn(snapshot.workspace,'page')||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)
    refuse('A complete retained workspace revision is required. A page is not a backup.');
  const source=structuredClone(snapshot),state=source.workspace;
  if(!record(state.projects)||!Array.isArray(state.tasks)||!Array.isArray(state.runs)||!Array.isArray(state.events)||!record(source.operations))refuse('Complete retained collections are required.');
  const totals={projects:Object.keys(state.projects).length,tasks:state.tasks.length,runs:state.runs.length,operations:Object.keys(source.operations).length,events:state.events.length};
  for(const [name,limit] of Object.entries(BACKUP_LIMITS))if(totals[name]>limit)refuse('Workspace backup exceeds its '+name+' limit; no records were truncated.');
  const handoffs=await Promise.all(state.tasks.map(task=>buildTaskHandoff(state,task.id,exportedAt)));
  const operations=Object.entries(source.operations).map(([key,value])=>{
    if(!record(value))refuse('Invalid source operation receipt.');
    const receipt=select(value,operationFields);if(value.report!==undefined)receipt.report=portableBackupEvidence(value.report);
    return {key,receipt};
  });
  const projects=Object.values(state.projects).map(project=>({id:project.id,name:project.name,repositoryName:project.repositoryName,
    mainCommit:project.mainCommit,defaultBranch:project.defaultBranch??null,history:structuredClone(project.restoredHistory??[]),
    historicalCheckPolicies:structuredClone(project.restoredCheckPolicies??[])}));
  const jobs=Object.entries(source.jobs??{}).map(([runId,job])=>({runId,...select(job,['status','phase','attemptId','pendingCommit'])}));
  const resources=recoveryResources(projects,handoffs,operations,jobs);
  const payload={exportedAt,sourceRevision:source.revision,workspace:select(state,['id','name','version','createdAt','provider']),projects,resources,handoffs,operations,
    events:state.events.map(event=>select(event,['id','at','type','projectId','taskId','runId','message'])),
    jobs,
    repositories:Object.entries(source.repositories??{}).map(([taskId,name])=>({taskId,name})),
    forks:Object.entries(source.forks??{}).map(([runId,fork])=>({runId,name:fork.name})),
    checkPolicies:Object.entries(source.checkPolicies??{}).map(([runId,policy])=>({runId,...select(policy,['definition','definitionSha256','image'])})),boundary};
  const observed=counts(payload);for(const [name,limit] of Object.entries(BACKUP_LIMITS))if(observed[name]>limit)refuse('Workspace backup exceeds its '+name+' limit; no records were truncated.');
  const archive={format:WORKSPACE_BACKUP_FORMAT,sha256:await checksum(payload),payload};
  return readWorkspaceBackup(JSON.stringify(archive),archive.sha256);
}

/** A digest proves integrity, never provenance or permission to act on historical receipts. */
export async function readWorkspaceBackup(text,expectedSha256){
  if(typeof text!=='string'||encoder.encode(text).byteLength>MAX_WORKSPACE_BACKUP_BYTES)refuse('Workspace backup must be JSON no larger than 1 MiB.');
  let archive;try{archive=JSON.parse(text);}catch{refuse('Workspace backup is not JSON.');}
  if(!fields(archive,['format','sha256','payload'])||archive.format!==WORKSPACE_BACKUP_FORMAT||!hash(expectedSha256)
    ||archive.sha256!==expectedSha256||await checksum(archive.payload)!==expectedSha256)refuse('Workspace backup checksum differs from the expected digest.');
  const p=archive.payload;
  if(!fields(p,['exportedAt','sourceRevision','workspace','projects','resources','handoffs','operations','events','jobs','repositories','forks','checkPolicies','boundary'])
    ||timestamp(p.exportedAt)===null||!Number.isSafeInteger(p.sourceRevision)||p.sourceRevision<0
    ||!fields(p.workspace,['id','name','version','createdAt','provider'])||!identifier(p.workspace.id)||typeof p.workspace.name!=='string'||p.workspace.name.length>200
    ||!Number.isSafeInteger(p.workspace.version)||p.workspace.version<0||timestamp(p.workspace.createdAt)===null||p.workspace.provider!=='cloudflare-artifacts'
    ||p.boundary!==boundary)refuse('Invalid workspace backup header.');
  for(const name of ['projects','resources','handoffs','operations','events','jobs','repositories','forks','checkPolicies'])if(!Array.isArray(p[name]))refuse('Complete backup collections are required.');
  if(p.handoffs.some(item=>!Array.isArray(item?.payload?.runs)))refuse('Complete candidate collections are required.');
  if(p.jobs.length>BACKUP_LIMITS.runs||p.repositories.length>BACKUP_LIMITS.tasks||p.forks.length>BACKUP_LIMITS.runs||p.checkPolicies.length>BACKUP_LIMITS.runs)refuse('Workspace backup exceeds its related-record limits.');
  const projects=new Set(),tasks=new Set(),runs=new Set(),operationKeys=new Set();
  for(const project of p.projects){
    if(!fields(project,['id','name','repositoryName','mainCommit','defaultBranch','history','historicalCheckPolicies'])
      ||!identifier(project.id)||projects.has(project.id)||!identifier(project.repositoryName)||typeof project.name!=='string'||project.name.length>120
      ||!commit(project.mainCommit)||project.defaultBranch!==null&&(typeof project.defaultBranch!=='string'||!project.defaultBranch||project.defaultBranch.length>200)
      ||!Array.isArray(project.history)||project.history.length>64||!Array.isArray(project.historicalCheckPolicies)||project.historicalCheckPolicies.length>128)refuse('Invalid or duplicate backup project.');
    projects.add(project.id);
    for(const item of project.history)await validateBackupHandoff(item);
    for(const policy of project.historicalCheckPolicies)await validateBackupCheckPolicy(policy,true);
  }
  for(const item of p.handoffs){
    await validateBackupHandoff(item);const task=item.payload.task;
    if(item.payload.workspace.id!==p.workspace.id||item.payload.workspace.version!==p.workspace.version||!projects.has(task.projectId)||!identifier(task.id)||tasks.has(task.id))refuse('A retained task has a duplicate or foreign identity.');
    tasks.add(task.id);for(const run of item.payload.runs){if(!identifier(run.id)||runs.has(run.id))refuse('Duplicate candidate identity.');runs.add(run.id);}
  }
  for(const operation of p.operations){
    const keyValid=hash(operation.key)||operation.receipt?.kind==='model-check'&&typeof operation.key==='string'&&operation.key.startsWith('model-check:')&&uuid(operation.key.slice(12))
      ||operation.receipt?.kind==='merge'&&typeof operation.key==='string'&&operation.key.startsWith('automatic-merge:')&&uuid(operation.key.slice(16));
    if(!fields(operation,['key','receipt'])||!keyValid||operationKeys.has(operation.key))refuse('Invalid or duplicate operation key.');
    operationKeys.add(operation.key);operationValid(operation.receipt);
  }
  const unique=new Set();
  for(const [name,idField,known] of [['repositories','taskId',tasks],['forks','runId',runs]])for(const row of p[name]){
    const key=name+':'+row?.[idField];
    if(!fields(row,[idField,'name'])||!known.has(row[idField])||!identifier(row.name)||unique.has(key))refuse('Invalid or duplicate Git resource mapping.');unique.add(key);
  }
  for(const job of p.jobs){
    const key='job:'+job?.runId;
    if(!record(job)||Object.keys(job).some(key=>!['runId','status','phase','attemptId','pendingCommit'].includes(key))||!runs.has(job.runId)||unique.has(key)
      ||!['queued','running','finished','failed'].includes(job.status)||typeof job.phase!=='string'||job.phase.length>100
      ||job.attemptId!==undefined&&!identifier(job.attemptId)||job.pendingCommit!==undefined&&!commit(job.pendingCommit))refuse('Invalid or duplicate job observation.');unique.add(key);
  }
  for(const policy of p.checkPolicies){
    const key='policy:'+policy?.runId;
    if(!record(policy)||Object.keys(policy).some(key=>!['runId','definition','definitionSha256','image'].includes(key))||!runs.has(policy.runId)||unique.has(key)
      ||typeof policy.definition!=='string'||policy.definition.length>128*1024||!hash(policy.definitionSha256)
      ||policy.image!==undefined&&(typeof policy.image!=='string'||policy.image.length>300))refuse('Invalid historical check definition.');unique.add(key);
    await validateBackupCheckPolicy(policy);
  }
  for(const event of p.events)if(!record(event)||Object.keys(event).some(key=>!['id','at','type','projectId','taskId','runId','message'].includes(key))
    ||!identifier(event.id)||timestamp(event.at)===null||typeof event.type!=='string'||event.type.length>100||typeof event.message!=='string'||event.message.length>10000
    ||event.projectId!=null&&!projects.has(event.projectId)||event.taskId!=null&&!tasks.has(event.taskId)||event.runId!=null&&!runs.has(event.runId))refuse('Invalid retained workspace event.');
  const expectedResources=recoveryResources(p.projects,p.handoffs,p.operations,p.jobs);
  if(canonical(p.resources)!==canonical(expectedResources))refuse('Recovery resource inventory differs from all retained Git roots.');
  const observed=counts(p);for(const [name,limit] of Object.entries(BACKUP_LIMITS))if(observed[name]>limit)refuse('Workspace backup exceeds its '+name+' limit; no records were truncated.');
  return archive;
}

export function workspaceBackupPreview(archive){
  const p=archive.payload;
  return {format:WORKSPACE_BACKUP_FORMAT,archiveSha256:archive.sha256,sourceWorkspaceId:p.workspace.id,sourceRevision:p.sourceRevision,exportedAt:p.exportedAt,
    counts:counts(p),projects:p.projects.map(project=>({id:project.id,name:project.name,mainCommit:project.mainCommit,commits:p.resources.find(resource=>resource.kind==='project'&&resource.projectId===project.id).commits.length})),
    resources:p.resources.map(resource=>({...resource,commits:resource.commits.length})),
    pendingReceipts:p.operations.filter(row=>row.receipt.state==='pending').map(({key,receipt})=>({key,kind:receipt.kind,projectId:receipt.projectId??null})),
    historical:true,restoresAuthority:false,resumesWork:false,boundary};
}
