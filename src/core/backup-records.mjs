import {WorkflowError} from './workflow.mjs';
import {readTaskHandoff} from './handoff.mjs';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length<=1024*1024;
const number=value=>Number.isSafeInteger(value)&&value>=0;
const bool=value=>typeof value==='boolean';
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const nil=rule=>value=>value===null||rule(value);
const list=rule=>value=>Array.isArray(value)&&value.every(rule);
const oneOf=values=>value=>values.includes(value);
const shape=(rules,required=[])=>value=>record(value)&&required.every(key=>Object.hasOwn(value,key))
  &&Object.entries(value).every(([key,item])=>Object.hasOwn(rules,key)&&rules[key](item));
const refuse=()=>{throw new WorkflowError('WORKSPACE_BACKUP_INVALID','A nested backup record has unsupported fields or invalid data.',422);};
const identity=shape({provider:text,kind:text,issuer:text,id:text,workspaceId:text,displayName:text});
const check=shape({name:text,passed:bool,detail:text},['name','passed','detail']);
const verification=shape({kind:text,definitionSha256:hash,verifierSha256:hash,inputHandoffSha256:hash,requirementsSha256:hash,image:text,tree:commit});
const evidenceShape=shape({operation:text,attemptId:text,verified:bool,commit,passed:number,total:number,command:text,exitCode:number,output:text,verifiedAt:date,source:text,
  verification,taskRevision:number,checks:list(check)},['verified','commit','passed','total','command','exitCode','output','verifiedAt','source','checks']);
export const validBackupEvidence=value=>evidenceShape(value)&&value.total===value.checks.length&&value.passed===value.checks.filter(check=>check.passed).length;
const reviewPolicy=shape({mode:text,enabled:bool,version:number,at:date,ownerAudience:text,sessionsValidAfter:number,projectId:text,decisionId:text,enabledBy:identity});
const review=shape({decision:oneOf(['accept','reject']),note:text,reviewer:text,at:date,headCommit:commit,taskRevision:number,ownerVersion:number,
  comparisons:list(shape({runId:text,headCommit:commit},['runId','headCommit'])),codeReviewId:text,identity,policy:reviewPolicy});
const contextEvidence=shape({commit,taskRevision:number,source:text,verified:bool,passed:number,total:number,exitCode:number,command:text,
  checks:list(shape({name:text,passed:bool},['name','passed'])),verification:nil(verification)});
const context=shape({workspaceId:text,taskId:text,runId:text,headCommit:commit,baseCommit:commit,taskRevision:number,ownerVersion:number,reviewAssignmentId:nil(text),
  requirements:shape({title:text,purpose:text,criteria:list(text)}),evidence:nil(contextEvidence)});
const finding=shape({id:text,oid:commit,title:text,body:text,priority:oneOf([0,1,2,3]),evidence:text,
  location:shape({path:text,side:oneOf(['head','base']),startLine:number,endLine:number},['path','side','startLine','endLine'])});
const codeReview=shape({id:text,at:date,assignmentId:text,format:text,contextId:hash,context,verdict:text,summary:text,findings:list(finding),
  resolvedPriorFindingIds:list(text),unresolvedFindingIds:list(text),identity,repositoryAccessVersion:number});
const limits=shape({maxRequests:number,maxInputBytes:number,maxOutputTokens:number,timeoutMs:number});
const usage=shape({inputTokens:number,outputTokens:number,cachedInputTokens:nil(number)},['inputTokens','outputTokens']);
const execution=shape({kind:text,model:text,startedAt:date,finishedAt:nil(date),status:text,inputTokens:number,outputTokens:number,cachedInputTokens:nil(number),
  usageComplete:bool,error:nil(text),elapsedMs:number,pendingCommit:commit,limits,
  requests:list(shape({number:number,inputBytes:number,outputTokenLimit:number,status:text,usage:nil(usage)},['number','inputBytes','outputTokenLimit','status','usage']))});
const publicationPR=shape({number:number,url:text,headCommit:commit,status:text,mergedAt:nil(date),mergeCommit:nil(commit)});
const publication=shape({id:text,previewId:text,createdAt:date,lastCheckedAt:date,status:text,stage:text,pushStartedAt:nil(date),prStartedAt:nil(date),branchHead:nil(commit),
  binding:shape({repository:text,repositoryId:number,baseBranch:text,headBranch:text,
    local:shape({workspaceId:text,taskId:text,runId:text,headCommit:commit,baseCommit:commit,taskRevision:number,ownerVersion:number,requirementsSha256:hash,reviewSha256:hash})}),
  pr:nil(publicationPR),error:nil(shape({code:text,message:text})),
  observations:list(shape({at:date,status:text,stage:text,message:text,pr:nil(publicationPR)}))});
export const validBackupRepositoryEvent=shape({key:hash,state:text,headCommit:nil(commit),repositoryName:text,ref:text,runIds:list(text),projectIds:list(text)},['key','state','headCommit','repositoryName','ref','runIds','projectIds']);
const event=shape({id:text,at:date,type:text,projectId:text,taskId:nil(text),runId:nil(text),message:text,repositoryEvent:validBackupRepositoryEvent},['id','at','type','taskId','runId','message']);
export const validBackupObservation=shape({eventKey:hash,ref:text,headCommit:nil(commit),observedAt:date,eventTimestamp:date,requiresSubmission:bool},['eventKey','ref','headCommit','observedAt','eventTimestamp','requiresSubmission']);
const task=shape({id:text,title:text,purpose:text,criteria:list(text),status:text,baseCommit:commit,
  baseHistory:list(shape({baseCommit:commit,revision:number,acceptedRunId:nil(text),sourceRunId:text,at:date})),projectId:text,createdAt:date,
  acceptedRunId:nil(text),mergedCommit:nil(commit),owner:nil(text),ownerVersion:number,origin:text,repositoryName:text,resultBranch:text,dependsOn:list(text),revision:number,
  verificationProfile:text,ownerHistory:list(shape({owner:nil(text),version:number,at:date})),revisions:list(shape({revision:number,purpose:text,criteria:list(text),reason:text,at:date}))},
  ['id','title','purpose','criteria','status','baseCommit','createdAt','revision']);
const run=shape({id:text,taskId:text,origin:text,agent:text,label:text,status:text,baseCommit:commit,headCommit:nil(commit),branch:text,startedAt:nil(date),finishedAt:nil(date),
  changedFiles:list(text),diff:text,summary:text,error:nil(text),ownerVersion:number,reconcilesRunId:text,verificationPending:bool,checkoutState:text,repositoryObservation:validBackupObservation,
  agentIdentity:identity,assignedRevision:number,evidence:nil(validBackupEvidence),
  reviewAssignments:list(shape({id:text,at:date,sourceContextId:hash,contextId:hash,reviewerIds:list(text),identity})),
  codeReview:nil(codeReview),codeReviewHistory:list(codeReview),findingDecisions:list(shape({id:text,at:date,assessmentId:text,findingId:text,decision:text,note:text,identity})),
  evidenceHistory:list(validBackupEvidence),review:nil(review),reviewHistory:list(review),automaticMergeStop:shape({decisionId:text,code:text,at:date,phase:text}),
  execution:nil(execution),publication},['id','taskId','agent','label','status','baseCommit','headCommit','branch','startedAt','finishedAt','changedFiles','diff','summary','error']);
const counters=names=>shape(Object.fromEntries(names.map(name=>[name,number])),names);
const recordedMetrics=shape({tasks:counters(['total','open','running','review','accepted','merged']),
  runs:counters(['total','assigned','running','awaitingReview','accepted','rejected','failed','merged','superseded']),
  checks:counters(['passed','total','verifiedRuns','evidencedRuns']),acceptedCandidates:counters(['numerator','denominator'])},['tasks','runs','checks','acceptedCandidates']);
const payload=shape({exportedAt:date,workspace:shape({id:text,name:text,provider:text,version:number},['id','name','provider','version']),task,runs:list(run),events:list(event),
  recordedMetrics,nextAction:shape({kind:text,text},['kind','text']),boundaries:list(text)},['exportedAt','workspace','task','runs','events','recordedMetrics','nextAction','boundaries']);

/** The generic handoff reader proves integrity; recovery additionally closes every nested schema. */
export async function validateBackupHandoff(value){
  try{await readTaskHandoff(JSON.stringify(value));}catch{refuse();}
  if(!shape({format:oneOf(['projects-git-handoff/v1']),sha256:hash,payload},['format','sha256','payload'])(value))refuse();
  return value;
}
export function portableBackupEvidence(value){
  if(!record(value))refuse();
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
  const report=pick(value,['operation','attemptId','verified','commit','passed','total','command','exitCode','output','verifiedAt','source','taskRevision']);
  if(value.verification)report.verification=pick(value.verification,['kind','definitionSha256','verifierSha256','inputHandoffSha256','requirementsSha256','image','tree']);
  if(!Array.isArray(value.checks))refuse();report.checks=value.checks.map(check=>pick(check,['name','passed','detail']));
  if(!validBackupEvidence(report))refuse();return report;
}
export async function validateBackupCheckPolicy(policy,historical=false){
  if(!shape({workspaceId:text,runId:text,definition:text,definitionSha256:hash,image:text},['runId','definition','definitionSha256',...(historical?['workspaceId']:[])])(policy))refuse();
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(policy.definition)))].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(digest!==policy.definitionSha256)refuse();let definition;try{definition=JSON.parse(policy.definition);}catch{refuse();}
  if(!shape({format:oneOf(['repository-command-checks/v1']),commit,taskRevision:number,requirementsSha256:hash,timeoutMs:number,
    checks:list(shape({name:text,argv:list(text),stdin:text,expected:shape({exitCode:number,stdout:text},['exitCode','stdout'])},['name','argv','stdin','expected']))},
  ['format','commit','taskRevision','requirementsSha256','timeoutMs','checks'])(definition))refuse();
}
