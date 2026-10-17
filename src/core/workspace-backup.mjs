import {WorkflowError} from './workflow.mjs';
import {buildTaskHandoff,portableRepositoryObservation,portableRepositoryEvent} from './handoff.mjs';
import {archiveCommits} from './project-archive.mjs';
import {operationTimings,timestamp} from './operation-timing.mjs';
import {validateBackupHandoff,validateBackupCheckPolicy,portableBackupEvidence,validBackupEvidence,validBackupObservation,validBackupRepositoryEvent} from './backup-records.mjs';

export const WORKSPACE_BACKUP_FORMAT='projects-git-workspace-backup/v1';
export const MAX_WORKSPACE_BACKUP_BYTES=1024*1024;
export const BACKUP_LIMITS=Object.freeze({projects:80,currentProjects:16,historicalProjects:64,resources:64,tasks:256,runs:512,operations:2000,events:10000,policies:512,gitMappings:1024,jobs:512,
  artifactSubscriptions:128,artifactSubscriptionAttempts:4096,artifactEvents:4096,artifactEventAttempts:16384,artifactDeliveries:4096});
const encoder=new TextEncoder(),hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const fields=(value,names)=>record(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const select=(value,names)=>Object.fromEntries(names.filter(name=>value[name]!==undefined).map(name=>[name,value[name]]));
const refuse=message=>{throw new WorkflowError('WORKSPACE_BACKUP_INVALID',message,422);};
const kinds=['task','assign','claim','model','merge','checks','base-update','model-check','review-inference','restore','repository-create','project-access','workspace-restore'];
const operationFields=['fingerprint','kind','state','itemId','taskId','taskIds','projectId','resourceName','repositoryId','attemptId','executorAttemptId',
  'baseCommit','pendingCommit','sourceRunId','errorCode','leaseUntil','timestamp','contextId','assignmentId','reviewerId','reviewerIssuer','model','startedAt',
  'reservesExecution','cancelled','accessVersion','revokeRunIds','revokedRunIds','timings','report','idleResult','recoveryImportId'];
const boundary='Historical recovery data only. No credentials, access grants, runnable jobs, current approval or automatic retry authority are restored. Pending effects remain unresolved.';
const providerId=value=>typeof value==='string'&&/^[a-f0-9-]{16,64}$/.test(value);
const repositoryName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const errorCode=value=>value===null||typeof value==='string'&&/^[A-Z_]{1,80}$/.test(value);
const branch=value=>typeof value==='string'&&/^refs\/heads\/[A-Za-z0-9._/-]{1,250}$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!/[/.]$/.test(value);
const dated=value=>typeof value==='string'&&value.length<=32&&Number.isFinite(Date.parse(value));

function validateBackupLedgers(value){
  if(!fields(value,['capture','artifactSubscriptions','artifactSubscriptionAttempts','artifactEvents','artifactEventAttempts','artifactDeliveries'])
    ||value.capture!=='coherent-sqlite-transaction')refuse('A coherent coordinator ledger capture is required.');
  for(const name of ['artifactSubscriptions','artifactSubscriptionAttempts','artifactEvents','artifactEventAttempts','artifactDeliveries'])
    if(!Array.isArray(value[name]))refuse('Coordinator backup ledgers must be complete arrays.');
  const ledgers=structuredClone(value),subscriptions=new Map(),subscriptionAttempts=new Map(),events=new Map(),eventAttempts=new Map(),deliveries=new Set(),subscriptionIds=new Set();
  for(const row of ledgers.artifactSubscriptions){
    if(!fields(row,['repositoryName','fingerprint','phase','subscriptionId','attemptId'])||!repositoryName(row.repositoryName)||subscriptions.has(row.repositoryName)||!hash(row.fingerprint)
      ||!['reserved','creating','bound','ready'].includes(row.phase)||row.subscriptionId!==null&&!providerId(row.subscriptionId)||!uuid(row.attemptId)
      ||['bound','ready'].includes(row.phase)!==(row.subscriptionId!==null)||row.subscriptionId!==null&&subscriptionIds.has(row.subscriptionId))refuse('Invalid or duplicate artifact subscription ledger row.');
    subscriptions.set(row.repositoryName,row);if(row.subscriptionId!==null)subscriptionIds.add(row.subscriptionId);
  }
  for(const row of ledgers.artifactSubscriptionAttempts){
    if(!fields(row,['id','repositoryName','startedAt','finishedAt','status','errorCode'])||!uuid(row.id)||subscriptionAttempts.has(row.id)||!repositoryName(row.repositoryName)
      ||timestamp(row.startedAt)===null||row.finishedAt!==null&&timestamp(row.finishedAt)===null||!['pending','complete','failed','superseded'].includes(row.status)||!errorCode(row.errorCode)
      ||row.finishedAt!==null&&timestamp(row.finishedAt)<timestamp(row.startedAt)||row.status==='pending'&&(row.finishedAt!==null||row.errorCode!==null)
      ||row.status!=='pending'&&row.finishedAt===null||row.status==='failed'&&row.errorCode===null||row.status!=='failed'&&row.errorCode!==null)refuse('Invalid or duplicate artifact subscription attempt.');
    subscriptionAttempts.set(row.id,row);
  }
  for(const row of ledgers.artifactEvents){
    if(!fields(row,['eventKey','status','attemptId','event','result'])||!hash(row.eventKey)||events.has(row.eventKey)||!['pending','complete','failed'].includes(row.status)||!uuid(row.attemptId)
      ||!fields(row.event,['subscriptionId','repositoryName','ref','before','after','timestamp'])||!providerId(row.event.subscriptionId)||!repositoryName(row.event.repositoryName)
      ||!branch(row.event.ref)||!commit(row.event.before)||!commit(row.event.after)||!dated(row.event.timestamp))refuse('Invalid or duplicate artifact event ledger row.');
    if(row.result!==null){
      const allowed=['key','state','headCommit','repositoryName','ref','runIds','projectIds'];
      if(!record(row.result)||Object.keys(row.result).some(key=>!allowed.includes(key))||!hash(row.result.key)||row.result.key!==row.eventKey
        ||!['unowned-ref','observed','superseded-notification'].includes(row.result.state)||row.result.headCommit!==undefined&&row.result.headCommit!==null&&!commit(row.result.headCommit)
        ||row.result.repositoryName!==undefined&&row.result.repositoryName!==row.event.repositoryName||row.result.ref!==undefined&&row.result.ref!==row.event.ref
        ||row.result.runIds!==undefined&&(!Array.isArray(row.result.runIds)||row.result.runIds.some(id=>!identifier(id)))
        ||row.result.projectIds!==undefined&&(!Array.isArray(row.result.projectIds)||row.result.projectIds.some(id=>!identifier(id))))refuse('Invalid artifact event outcome.');
      if(!fields(row.result,row.result.state==='unowned-ref'?['key','state']:allowed))refuse('Artifact event outcome fields are incomplete.');
    }
    if((row.status==='complete')!==(row.result!==null))refuse('Artifact event completion and its retained outcome differ.');
    events.set(row.eventKey,row);
  }
  for(const row of ledgers.artifactEventAttempts){
    if(!fields(row,['attemptId','eventKey','startedAt','finishedAt','status','errorCode'])||!uuid(row.attemptId)||eventAttempts.has(row.attemptId)||!hash(row.eventKey)
      ||timestamp(row.startedAt)===null||row.finishedAt!==null&&timestamp(row.finishedAt)===null||!['pending','complete','failed','superseded'].includes(row.status)||!errorCode(row.errorCode)
      ||row.finishedAt!==null&&timestamp(row.finishedAt)<timestamp(row.startedAt)||row.status==='pending'&&(row.finishedAt!==null||row.errorCode!==null)
      ||row.status!=='pending'&&row.finishedAt===null||row.status==='failed'&&row.errorCode===null||row.status!=='failed'&&row.errorCode!==null)refuse('Invalid or duplicate artifact event attempt.');
    eventAttempts.set(row.attemptId,row);
  }
  for(const row of ledgers.artifactDeliveries){
    if(!fields(row,['messageId','eventKey'])||typeof row.messageId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(row.messageId)||deliveries.has(row.messageId)||!hash(row.eventKey))refuse('Invalid or duplicate artifact delivery.');
    deliveries.add(row.messageId);
  }
  for(const row of subscriptions.values()){
    const attempt=subscriptionAttempts.get(row.attemptId);if(!attempt||attempt.repositoryName!==row.repositoryName||attempt.status==='superseded'
      ||(row.phase==='ready')!==(attempt.status==='complete'))refuse('Artifact subscription current-attempt reference is missing or inconsistent.');
  }
  for(const row of subscriptionAttempts.values())if(!subscriptions.has(row.repositoryName))refuse('Artifact subscription attempt has no retained subscription.');
  for(const row of events.values()){
    const attempt=eventAttempts.get(row.attemptId);if(!attempt||attempt.eventKey!==row.eventKey||attempt.status!==row.status)refuse('Artifact event current-attempt reference differs.');
  }
  for(const row of eventAttempts.values())if(!events.has(row.eventKey))refuse('Artifact event attempt has no retained event.');
  for(const row of ledgers.artifactDeliveries)if(!events.has(row.eventKey))refuse('Artifact delivery has no retained event.');
  return ledgers;
}

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
  if(operation.recoveryImportId!==undefined&&(!hash(operation.recoveryImportId)||operation.kind!=='workspace-restore'))refuse('Invalid recovery import receipt.');
  if(operation.idleResult!==undefined&&(!fields(operation.idleResult,['idle','reason','waitingTaskIds'])||typeof operation.idleResult.idle!=='boolean'
    ||typeof operation.idleResult.reason!=='string'||!Array.isArray(operation.idleResult.waitingTaskIds)||operation.idleResult.waitingTaskIds.some(id=>!identifier(id))))refuse('Invalid retained idle result.');
  operationTimings(operation);
}
function referencedCommits(project,operations,handoffs,jobs,events){
  const commits=new Set(archiveCommits([...project.history,...handoffs],project.mainCommit));
  if(project.repositoryObservation?.headCommit)commits.add(project.repositoryObservation.headCommit);
  for(const handoff of [...project.history,...handoffs])for(const run of handoff.payload.runs)
    for(const head of [run.execution?.pendingCommit,run.repositoryObservation?.headCommit].filter(Boolean)){
      if(!commit(head))refuse('Invalid uncertain execution/observation commit.');commits.add(head);
    }
  const taskIds=new Set(handoffs.map(item=>item.payload.task.id)),runIds=new Set(handoffs.flatMap(item=>item.payload.runs.map(run=>run.id)));
  for(const {receipt} of operations)if(receipt.projectId===project.id||taskIds.has(receipt.taskId)||taskIds.has(receipt.itemId)||runIds.has(receipt.itemId)||runIds.has(receipt.sourceRunId))
    for(const value of [receipt.baseCommit,receipt.pendingCommit,receipt.report?.commit])if(value)commits.add(value);
  for(const job of jobs)if(runIds.has(job.runId)&&job.pendingCommit)commits.add(job.pendingCommit);
  for(const event of [...events,...project.history.flatMap(item=>item.payload.events)])if(event.projectId===project.id||taskIds.has(event.taskId)||runIds.has(event.runId))
    if(event.repositoryEvent?.headCommit)commits.add(event.repositoryEvent.headCommit);
  if(commits.size>128)refuse('A backup project exceeds 128 referenced commits; nothing was truncated.');
  return [...commits].sort();
}
function recoveryResources(projects,handoffs,operations,jobs,events,priorImports){
  const taskProjects=new Map(handoffs.map(item=>[item.payload.task.id,item.payload.task.projectId]));
  const runProjects=new Map(handoffs.flatMap(item=>item.payload.runs.map(run=>[run.id,item.payload.task.projectId])));
  const resources=projects.map(project=>({id:project.id,kind:'project',projectId:project.id,repositoryName:project.repositoryName,anchorCommit:project.mainCommit,
    defaultBranch:project.defaultBranch,commits:referencedCommits(project,operations,handoffs.filter(item=>item.payload.task.projectId===project.id),jobs,events)}));
  for(const {key,receipt} of operations){
    const owners=new Set([receipt.projectId,taskProjects.get(receipt.taskId),taskProjects.get(receipt.itemId),runProjects.get(receipt.itemId),runProjects.get(receipt.sourceRunId)].filter(Boolean));
    if(owners.size>1)refuse('An operation contradicts its repository/task/candidate ownership.');
    const projectId=[...owners][0]??null,commits=[...new Set([receipt.pendingCommit,receipt.report?.commit,receipt.baseCommit].filter(Boolean))].sort();
    if(!commits.length||projects.some(project=>project.id===projectId))continue;
    resources.push({id:'operation:'+key,kind:'unattached-operation',projectId,repositoryName:receipt.resourceName??null,
      anchorCommit:receipt.pendingCommit??receipt.report?.commit??receipt.baseCommit,defaultBranch:null,commits});
  }
  for(const prior of priorImports)for(const resource of prior.archive.payload.resources)
    resources.push({id:'import:'+prior.id+':'+resource.id,kind:'historical-import',projectId:null,repositoryName:resource.repositoryName,
      anchorCommit:resource.anchorCommit,defaultBranch:resource.defaultBranch,commits:[...resource.commits]});
  return resources;
}
function ledgerRecordCounts(ledgers){
  return {
    artifactSubscriptions:ledgers.artifactSubscriptions.length,
    pendingArtifactSubscriptions:ledgers.artifactSubscriptions.filter(row=>row.phase!=='ready').length,
    reservedArtifactSubscriptions:ledgers.artifactSubscriptions.filter(row=>row.phase==='reserved').length,
    creatingArtifactSubscriptions:ledgers.artifactSubscriptions.filter(row=>row.phase==='creating').length,
    boundArtifactSubscriptions:ledgers.artifactSubscriptions.filter(row=>row.phase==='bound').length,
    readyArtifactSubscriptions:ledgers.artifactSubscriptions.filter(row=>row.phase==='ready').length,
    artifactSubscriptionAttempts:ledgers.artifactSubscriptionAttempts.length,
    pendingArtifactSubscriptionAttempts:ledgers.artifactSubscriptionAttempts.filter(row=>row.status==='pending').length,
    completedArtifactSubscriptionAttempts:ledgers.artifactSubscriptionAttempts.filter(row=>row.status==='complete').length,
    failedArtifactSubscriptionAttempts:ledgers.artifactSubscriptionAttempts.filter(row=>row.status==='failed').length,
    supersededArtifactSubscriptionAttempts:ledgers.artifactSubscriptionAttempts.filter(row=>row.status==='superseded').length,
    artifactEvents:ledgers.artifactEvents.length,pendingArtifactEvents:ledgers.artifactEvents.filter(row=>row.status==='pending').length,
    completedArtifactEvents:ledgers.artifactEvents.filter(row=>row.status==='complete').length,failedArtifactEvents:ledgers.artifactEvents.filter(row=>row.status==='failed').length,
    artifactEventAttempts:ledgers.artifactEventAttempts.length,
    pendingArtifactEventAttempts:ledgers.artifactEventAttempts.filter(row=>row.status==='pending').length,
    completedArtifactEventAttempts:ledgers.artifactEventAttempts.filter(row=>row.status==='complete').length,
    failedArtifactEventAttempts:ledgers.artifactEventAttempts.filter(row=>row.status==='failed').length,
    supersededArtifactEventAttempts:ledgers.artifactEventAttempts.filter(row=>row.status==='superseded').length,
    artifactDeliveries:ledgers.artifactDeliveries.length};
}
function counts(payload){
  const prior=payload.priorImports.map(item=>counts(item.archive.payload)),sum=key=>prior.reduce((n,value)=>n+value[key],0);
  const history=payload.projects.flatMap(project=>project.history),runs=items=>items.reduce((n,item)=>n+item.payload.runs.length,0);
  const currentTasks=payload.handoffs.length,historicalTasks=history.length+sum('tasks'),currentRuns=runs(payload.handoffs),historicalRuns=runs(history)+sum('runs');
  const currentEvents=payload.events.length,historicalEvents=history.reduce((n,item)=>n+item.payload.events.length,0)+sum('events');
  const currentPolicies=payload.checkPolicies.length,historicalPolicies=payload.projects.reduce((n,project)=>n+project.historicalCheckPolicies.length,0)+sum('policies');
  const currentProjects=payload.projects.length,historicalProjects=sum('projects'),currentOperations=payload.operations.length,historicalOperations=sum('operations');
  const ledgerCounts=ledgerRecordCounts(payload.ledgers);
  for(const key of Object.keys(ledgerCounts))ledgerCounts[key]+=sum(key);
  for(const name of ['artifactSubscriptions','artifactSubscriptionAttempts','artifactEvents','artifactEventAttempts','artifactDeliveries']){
    const suffix=name[0].toUpperCase()+name.slice(1);ledgerCounts['current'+suffix]=payload.ledgers[name].length;ledgerCounts['historical'+suffix]=sum(name);
  }
  return {...ledgerCounts,projects:currentProjects+historicalProjects,currentProjects,historicalProjects,resources:payload.resources.length,currentTasks,historicalTasks,tasks:currentTasks+historicalTasks,
    currentRuns,historicalRuns,runs:currentRuns+historicalRuns,currentEvents,historicalEvents,events:currentEvents+historicalEvents,
    currentPolicies,historicalPolicies,policies:currentPolicies+historicalPolicies,repositoryMappings:payload.repositories.length+sum('repositoryMappings'),forkMappings:payload.forks.length+sum('forkMappings'),
    gitMappings:payload.repositories.length+payload.forks.length+sum('gitMappings'),currentOperations,historicalOperations,operations:currentOperations+historicalOperations,
    operationReports:payload.operations.filter(row=>row.receipt.report).length+sum('operationReports'),jobs:payload.jobs.length+sum('jobs'),
    pendingOperations:payload.operations.filter(row=>row.receipt.state==='pending').length+sum('pendingOperations'),
    unsettledJobs:payload.jobs.filter(job=>['queued','running'].includes(job.status)).length+sum('unsettledJobs'),priorImports:payload.priorImports.length+sum('priorImports')};
}
function operationReferences(payload,importIds){
  const projects=new Set(payload.projects.map(project=>project.id)),tasks=new Map(payload.handoffs.map(item=>[item.payload.task.id,item.payload.task]));
  const runs=new Map(payload.handoffs.flatMap(item=>item.payload.runs.map(run=>[run.id,run])));
  const taskForRun=id=>tasks.get(runs.get(id)?.taskId);
  for(const {receipt:op} of payload.operations){
    const owners=new Set(),addTask=id=>{
      const task=tasks.get(id);if(!task)refuse('An operation references an unknown task.');owners.add(task.projectId);return task;
    },addRun=id=>{const run=runs.get(id);if(!run)refuse('An operation references an unknown candidate.');addTask(run.taskId);return run;};
    if(op.projectId!==undefined){
      if(!projects.has(op.projectId)&&!(op.kind==='repository-create'&&op.state!=='complete'))refuse('An operation references an unknown project.');owners.add(op.projectId);
    }
    if(op.taskId!==undefined)addTask(op.taskId);
    if(op.sourceRunId!==undefined){const run=addRun(op.sourceRunId);if(op.kind!=='base-update'||op.taskId!==undefined&&run.taskId!==op.taskId)refuse('Invalid source candidate role.');}
    if(op.itemId!==undefined){
      if(['task','model'].includes(op.kind))addTask(op.itemId);
      else if(['assign','claim','checks','model-check','merge','base-update','review-inference'].includes(op.kind)){
        const run=addRun(op.itemId);if(op.taskId!==undefined&&run.taskId!==op.taskId)refuse('Operation candidate/task linkage differs.');
      }else refuse('Invalid operation item role.');
    }
    for(const key of ['taskIds','revokeRunIds','revokedRunIds'])if(op[key]!==undefined){
      if(new Set(op[key]).size!==op[key].length)refuse('Duplicate operation reference.');
      if(key==='taskIds'){if(op.kind!=='task')refuse('Invalid task-list operation role.');for(const id of op[key])addTask(id);}
      else{if(op.kind!=='project-access')refuse('Invalid credential-cleanup operation role.');for(const id of op[key])addRun(id);}
    }
    if(op.revokedRunIds?.some(id=>!op.revokeRunIds?.includes(id)))refuse('Revoked candidates are not a subset of the retained cleanup list.');
    for(const id of op.idleResult?.waitingTaskIds??[])addTask(id);
    if(owners.size>1)refuse('An operation mixes repository ownership.');
    if(op.kind==='task'&&op.state==='complete'&&(!op.itemId||!op.taskIds?.includes(op.itemId)))refuse('Completed task operation lacks its created tasks.');
    if(op.kind==='model'&&op.state==='complete'&&!op.itemId)refuse('Completed model operation lacks its task.');
    if(['assign','checks','model-check','merge','review-inference'].includes(op.kind)&&!op.itemId)refuse('Candidate operation lacks its retained candidate.');
    if(op.kind==='claim'&&!op.itemId&&!(op.state==='complete'&&op.idleResult?.idle))refuse('Claim has neither a retained candidate nor an idle result.');
    if(op.kind==='base-update'&&(!op.sourceRunId||!taskForRun(op.sourceRunId)))refuse('Base-update source candidate is missing.');
    if(['project-access','restore','repository-create'].includes(op.kind)&&!op.projectId)refuse('Repository operation lacks its project identity.');
    if(op.kind==='workspace-restore'&&(!op.recoveryImportId||!importIds.has(op.recoveryImportId)))refuse('Workspace recovery receipt lacks its immutable import.');
  }
}

/** Capture a complete revision. Raw coordinator state and provider responses are never selected. */
export async function buildWorkspaceBackup(snapshot,exportedAt=new Date().toISOString(),backupLedgers){
  if(!snapshot?.workspace||Object.hasOwn(snapshot,'page')||Object.hasOwn(snapshot.workspace,'page')||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)
    refuse('A complete retained workspace revision is required. A page is not a backup.');
  const source=structuredClone(snapshot),state=source.workspace,ledgers=validateBackupLedgers(backupLedgers);
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
    historicalCheckPolicies:structuredClone(project.restoredCheckPolicies??[]),
    ...(project.repositoryObservation?{repositoryObservation:portableRepositoryObservation(project.repositoryObservation)}:{}),
    ...(project.restoredFrom?{restoredFrom:select(project.restoredFrom,['archiveSha256','workspaceId','projectId','at'])}:{})}));
  const jobs=Object.entries(source.jobs??{}).map(([runId,job])=>({runId,...select(job,['status','phase','attemptId','pendingCommit'])}));
  const priorImports=Object.entries(source.recoveryImports??{}).map(([id,value])=>({id,...select(value,['archive','importedAt','importedBy'])}));
  canonical(priorImports);
  for(const prior of priorImports)await readWorkspaceBackup(JSON.stringify(prior.archive),prior.id);
  const events=state.events.map(event=>({...select(event,['id','at','type','projectId','taskId','runId','message']),
    ...(event.repositoryEvent?{repositoryEvent:portableRepositoryEvent(event.repositoryEvent)}:{})}));
  const resources=recoveryResources(projects,handoffs,operations,jobs,events,priorImports);
  const payload={exportedAt,sourceRevision:source.revision,workspace:select(state,['id','name','version','createdAt','provider']),projects,resources,handoffs,operations,priorImports,
    events,
    jobs,
    repositories:Object.entries(source.repositories??{}).map(([taskId,name])=>({taskId,name})),
    forks:Object.entries(source.forks??{}).map(([runId,fork])=>({runId,name:fork.name})),
    checkPolicies:Object.entries(source.checkPolicies??{}).map(([runId,policy])=>({runId,...select(policy,['definition','definitionSha256','image'])})),ledgers,boundary};
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
  if(!fields(p,['exportedAt','sourceRevision','workspace','projects','resources','handoffs','operations','events','jobs','repositories','forks','checkPolicies','priorImports','ledgers','boundary'])
    ||timestamp(p.exportedAt)===null||!Number.isSafeInteger(p.sourceRevision)||p.sourceRevision<0
    ||!fields(p.workspace,['id','name','version','createdAt','provider'])||!identifier(p.workspace.id)||typeof p.workspace.name!=='string'||p.workspace.name.length>200
    ||!Number.isSafeInteger(p.workspace.version)||p.workspace.version<0||timestamp(p.workspace.createdAt)===null||p.workspace.provider!=='cloudflare-artifacts'
    ||p.boundary!==boundary)refuse('Invalid workspace backup header.');
  for(const name of ['projects','resources','handoffs','operations','events','jobs','repositories','forks','checkPolicies','priorImports'])if(!Array.isArray(p[name]))refuse('Complete backup collections are required.');
  const imports=new Set();
  for(const prior of p.priorImports){
    if(!fields(prior,['id','archive','importedAt','importedBy'])||!hash(prior.id)||imports.has(prior.id)||timestamp(prior.importedAt)===null||!identifier(prior.importedBy))refuse('Invalid prior recovery import.');
    imports.add(prior.id);await readWorkspaceBackup(JSON.stringify(prior.archive),prior.id);
  }
  if(p.handoffs.some(item=>!Array.isArray(item?.payload?.runs)))refuse('Complete candidate collections are required.');
  if(p.jobs.length>BACKUP_LIMITS.runs||p.repositories.length>BACKUP_LIMITS.tasks||p.forks.length>BACKUP_LIMITS.runs||p.checkPolicies.length>BACKUP_LIMITS.runs)refuse('Workspace backup exceeds its related-record limits.');
  const projects=new Set(),tasks=new Set(),runs=new Set(),operationKeys=new Set();
  for(const project of p.projects){
    if(!fields(project,['id','name','repositoryName','mainCommit','defaultBranch','history','historicalCheckPolicies',
      ...(project.repositoryObservation===undefined?[]:['repositoryObservation']),...(project.restoredFrom===undefined?[]:['restoredFrom'])])
      ||!identifier(project.id)||projects.has(project.id)||!identifier(project.repositoryName)||typeof project.name!=='string'||project.name.length>120
      ||!commit(project.mainCommit)||project.defaultBranch!==null&&(typeof project.defaultBranch!=='string'||!project.defaultBranch||project.defaultBranch.length>200)
      ||!Array.isArray(project.history)||project.history.length>64||!Array.isArray(project.historicalCheckPolicies)||project.historicalCheckPolicies.length>128)refuse('Invalid or duplicate backup project.');
    projects.add(project.id);
    if(project.repositoryObservation!==undefined&&!validBackupObservation(project.repositoryObservation))refuse('Invalid retained project observation.');
    if(project.restoredFrom!==undefined&&(!fields(project.restoredFrom,['archiveSha256','workspaceId','projectId','at'])||!hash(project.restoredFrom.archiveSha256)
      ||!identifier(project.restoredFrom.workspaceId)||!identifier(project.restoredFrom.projectId)||timestamp(project.restoredFrom.at)===null))refuse('Invalid historical restore provenance.');
    const historyTasks=new Set(),historyRuns=new Set(),historyPolicies=new Set();
    for(const item of project.history){
      await validateBackupHandoff(item);const taskKey=JSON.stringify([item.payload.workspace.id,item.payload.task.id]);
      if(historyTasks.has(taskKey))refuse('Duplicate historical task identity.');historyTasks.add(taskKey);
      for(const run of item.payload.runs){const key=JSON.stringify([item.payload.workspace.id,run.id]);if(historyRuns.has(key))refuse('Duplicate historical candidate identity.');historyRuns.add(key);}
    }
    for(const policy of project.historicalCheckPolicies){
      await validateBackupCheckPolicy(policy,true);const key=JSON.stringify([policy.workspaceId,policy.runId]);
      if(!historyRuns.has(key)||historyPolicies.has(key))refuse('Duplicate or orphan historical check policy.');historyPolicies.add(key);
    }
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
  for(const event of p.events)if(!record(event)||Object.keys(event).some(key=>!['id','at','type','projectId','taskId','runId','message','repositoryEvent'].includes(key))
    ||!identifier(event.id)||timestamp(event.at)===null||typeof event.type!=='string'||event.type.length>100||typeof event.message!=='string'||event.message.length>10000
    ||event.projectId!=null&&!projects.has(event.projectId)||event.taskId!=null&&!tasks.has(event.taskId)||event.runId!=null&&!runs.has(event.runId)
    ||event.repositoryEvent!==undefined&&(!validBackupRepositoryEvent(event.repositoryEvent)||event.repositoryEvent.projectIds.some(id=>!projects.has(id))||event.repositoryEvent.runIds.some(id=>!runs.has(id))))refuse('Invalid retained workspace event.');
  p.ledgers=validateBackupLedgers(p.ledgers);
  operationReferences(p,imports);
  const expectedResources=recoveryResources(p.projects,p.handoffs,p.operations,p.jobs,p.events,p.priorImports);
  if(canonical(p.resources)!==canonical(expectedResources))refuse('Recovery resource inventory differs from all retained Git roots.');
  const observed=counts(p);for(const [name,limit] of Object.entries(BACKUP_LIMITS))if(observed[name]>limit)refuse('Workspace backup exceeds its '+name+' limit; no records were truncated.');
  return archive;
}

export function workspaceBackupPreview(archive){
  const p=archive.payload;
  return {format:WORKSPACE_BACKUP_FORMAT,archiveSha256:archive.sha256,sourceWorkspaceId:p.workspace.id,sourceRevision:p.sourceRevision,exportedAt:p.exportedAt,
    ledgerCapture:p.ledgers.capture,
    counts:counts(p),projects:p.projects.map(project=>({id:project.id,name:project.name,mainCommit:project.mainCommit,commits:p.resources.find(resource=>resource.kind==='project'&&resource.projectId===project.id).commits.length})),
    priorImports:p.priorImports.map(prior=>({id:prior.id,importedAt:prior.importedAt,importedBy:prior.importedBy,workspaceId:prior.archive.payload.workspace.id,counts:counts(prior.archive.payload)})),
    resources:p.resources.map(resource=>({...resource,commits:resource.commits.length})),
    pendingReceipts:p.operations.filter(row=>row.receipt.state==='pending').map(({key,receipt})=>({key,kind:receipt.kind,projectId:receipt.projectId??null})),
    historical:true,restoresAuthority:false,resumesWork:false,boundary};
}
