import {readMetrics,PROJECT_METRIC_PHASES,PROJECT_METRIC_OUTCOMES} from './ui/project-metrics.js';

const annotations=Object.freeze({readOnlyHint:true,untrustedContentHint:true,consequentialHint:false});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const date=value=>text(value,40)&&Number.isFinite(Date.parse(value));
const OUTPUT_BYTES=256*1024;
const CATALOG_SCOPES=Object.freeze(['project-names-across-workspace','accessible-project-names']);
export const PROJECTS_GIT_WEBMCP_TOOLS=Object.freeze(['projects_git_list_repositories','projects_git_list_project_tasks','projects_git_get_task_status','projects_git_get_operational_metrics']);

function invalid(message='Invalid tool input.'){throw Error(message);}
function aborted(){const error=Error('The browser tool session changed before this read completed.');error.name='AbortError';return error;}
function output(tool,value){const envelope={format:'projects-git-webmcp/v1',tool,...value},serialized=JSON.stringify(envelope);
  if(new TextEncoder().encode(serialized).byteLength>OUTPUT_BYTES)throw Error('The complete tool result exceeds 256 KiB; narrow the requested scope. Nothing was truncated.');
  return serialized;
}
function integer(value,fallback,max){if(value===undefined)return fallback;if(!count(value)||value>max)return invalid();return value;}
function safeId(value){if(!uuid(value))invalid('Use a full repository or task UUID.');return value;}
function input(value,allowed,required=[]){if(value===undefined)value={};if(!record(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))invalid();return value;}
function status(value,max=100){if(!text(value,max)||!value.length)throw Error('The server returned invalid status metadata.');return value;}

function catalogDto(value,workspaceId){
  if(!record(value)||value.workspaceId!==workspaceId||!CATALOG_SCOPES.includes(value.scope)||!text(value.query,200)||!count(value.revision)
    ||!count(value.total)||!count(value.matched)||value.matched>value.total||!count(value.offset)||!count(value.limit)||value.limit<1||value.limit>50
    ||value.previousOffset!==null&&!count(value.previousOffset)||value.nextOffset!==null&&!count(value.nextOffset)||!Array.isArray(value.items)||value.items.length>value.limit)throw Error('The repository catalog response is incomplete.');
  const repositories=value.items.map(item=>{if(!record(item)||!uuid(item.id)||!text(item.name,120)||!count(item.taskCount)||!count(item.candidateCount))throw Error('The repository catalog contains invalid metadata.');
    return {id:item.id,name:item.name,taskCount:item.taskCount,candidateCount:item.candidateCount};});
  return {workspaceId,sourceRevision:value.revision,scope:'accessible-repository-catalog',sourceScope:value.scope,query:value.query,
    page:{totalRepositories:value.total,matchedRepositories:value.matched,offset:value.offset,limit:value.limit,previousOffset:value.previousOffset,nextOffset:value.nextOffset},repositories};
}
function pageDto(value,workspaceId,selection){
  const page=value?.page,totals=page?.workspaceTotals,projects=value?.projects;
  if(!record(value)||value.id!==workspaceId||value.provider!=='cloudflare-artifacts'||!count(value.sourceRevision)||!count(value.version)
    ||!record(page)||page.scope!=='loaded-projects'||page.limit!==1||!count(page.offset)||!count(page.totalProjects)||page.revision!==value.sourceRevision
    ||page.previousOffset!==null&&!count(page.previousOffset)||page.nextOffset!==null&&!count(page.nextOffset)
    ||!record(totals)||totals.projects!==page.totalProjects||!count(totals.tasks)||!count(totals.runs)||!record(projects)||Object.keys(projects).length!==1
    ||!Array.isArray(value.tasks)||!Array.isArray(value.runs))throw Error('The workspace project page is incomplete.');
  const project=Object.values(projects)[0];
  if(!record(project)||!uuid(project.id)||!text(project.name,120)||!sha(project.mainCommit)||project.defaultBranch!=null&&!text(project.defaultBranch,200))throw Error('The workspace project metadata is invalid.');
  if(selection.projectId&&project.id!==selection.projectId)throw Error('The returned repository differs from the requested repository.');
  const tasks=value.tasks;if(tasks.some(task=>!record(task)||!uuid(task.id)||task.projectId!==project.id)||new Set(tasks.map(task=>task.id)).size!==tasks.length)throw Error('The project task collection is incomplete.');
  const taskIds=new Set(tasks.map(task=>task.id));if(value.runs.some(run=>!record(run)||!uuid(run.id)||!taskIds.has(run.taskId))||new Set(value.runs.map(run=>run.id)).size!==value.runs.length)throw Error('The project candidate collection is incomplete.');
  if(totals.tasks<tasks.length||totals.runs<value.runs.length)throw Error('Workspace totals contradict the complete project page.');
  if(selection.taskId&&!tasks.some(task=>task.id===selection.taskId))throw Error('The requested task is unavailable in the returned project.');
  return {project,tasks,runs:value.runs,page:{sourceRevision:value.sourceRevision,workspaceVersion:value.version,projectOffset:page.offset,totalProjects:page.totalProjects,
    previousProjectOffset:page.previousOffset,nextProjectOffset:page.nextOffset,
    workspaceTotals:{projects:totals.projects,tasks:totals.tasks,candidates:totals.runs},scope:'complete-selected-project'}};
}
function projectTasksDto(value,workspaceId,projectId){const data=pageDto(value,workspaceId,{projectId}),runCounts=new Map();
  for(const run of data.runs)runCounts.set(run.taskId,(runCounts.get(run.taskId)??0)+1);
  const tasks=data.tasks.map(task=>{
    if(!text(task.title,180)||!status(task.status)||!date(task.createdAt)||!count(task.revision??1)||task.dependsOn!==undefined&&(!Array.isArray(task.dependsOn)||task.dependsOn.some(id=>!uuid(id)))
      ||task.acceptedRunId!=null&&!uuid(task.acceptedRunId)||task.mergedCommit!=null&&!sha(task.mergedCommit))throw Error('A project task summary is invalid.');
    return {id:task.id,title:task.title,status:task.status,createdAt:task.createdAt,revision:task.revision??1,dependsOn:[...(task.dependsOn??[])],candidateCount:runCounts.get(task.id)??0,
      acceptedRunId:uuid(task.acceptedRunId)?task.acceptedRunId:null,mergedCommit:sha(task.mergedCommit)?task.mergedCommit:null};});
  if(typeof data.project.acceptingWork!=='boolean'||data.project.codeConnected!==undefined&&typeof data.project.codeConnected!=='boolean')throw Error('Repository policy metadata is invalid.');
  return {workspaceId,project:{id:data.project.id,name:data.project.name,mainCommit:data.project.mainCommit,defaultBranch:data.project.defaultBranch??null,
    acceptingWork:data.project.acceptingWork,codeConnected:data.project.codeConnected!==false},page:data.page,
    counts:{tasks:tasks.length,candidates:data.runs.length},tasks};
}
function evidenceDto(value){if(value==null)return null;if(!record(value)||typeof value.verified!=='boolean'||!sha(value.commit)||!count(value.passed)||!count(value.total)
  ||value.passed>value.total||!count(value.exitCode)||!text(value.source,100)||!text(value.verifiedAt,40)||!count(value.taskRevision??1))throw Error('Candidate evidence metadata is invalid.');
  return {verified:value.verified,commit:value.commit,passed:value.passed,total:value.total,exitCode:value.exitCode,source:value.source,verifiedAt:value.verifiedAt,taskRevision:value.taskRevision??1};}
function taskStatusDto(value,workspaceId,taskId){const data=pageDto(value,workspaceId,{taskId}),task=data.tasks.find(item=>item.id===taskId),runs=data.runs.filter(run=>run.taskId===taskId);
  if(!text(task.title,180)||!text(task.purpose,4000)||!Array.isArray(task.criteria)||task.criteria.some(item=>!text(item,500))||!status(task.status)||!sha(task.baseCommit)
    ||!date(task.createdAt)||!count(task.revision??1)||task.dependsOn!==undefined&&(!Array.isArray(task.dependsOn)||task.dependsOn.some(id=>!uuid(id)))
    ||task.acceptedRunId!=null&&!uuid(task.acceptedRunId)||task.mergedCommit!=null&&!sha(task.mergedCommit))throw Error('The selected task metadata is invalid.');
  const candidates=runs.map(run=>{
    if(!text(run.label,160)||!status(run.status)||!sha(run.baseCommit)||run.headCommit!==null&&!sha(run.headCommit)||!text(run.agent,40)
      ||run.origin!==undefined&&!text(run.origin,40)||run.startedAt!==null&&!text(run.startedAt,40)||run.finishedAt!==null&&!text(run.finishedAt,40)
      ||!Array.isArray(run.changedFiles)||!text(run.summary??'',4000))throw Error('A candidate summary is invalid.');
    if(run.review!=null&&(!record(run.review)||!['accept','reject'].includes(run.review.decision)||!date(run.review.at)||!sha(run.review.headCommit)
      ||run.review.taskRevision!==undefined&&!count(run.review.taskRevision)||run.review.ownerVersion!==undefined&&!count(run.review.ownerVersion)))throw Error('Candidate owner decision metadata is invalid.');
    const review=run.review==null?null:{decision:run.review.decision,at:run.review.at,headCommit:run.review.headCommit,
      taskRevision:run.review.taskRevision??null,ownerVersion:run.review.ownerVersion??null};
    if(run.codeReview!=null&&(!record(run.codeReview)||!status(run.codeReview.verdict,40)||!date(run.codeReview.at)
      ||run.codeReview.unresolvedFindingIds!==undefined&&!Array.isArray(run.codeReview.unresolvedFindingIds)))throw Error('Candidate independent review metadata is invalid.');
    const assessment=run.codeReview==null?null:{verdict:run.codeReview.verdict,at:run.codeReview.at,unresolvedFindings:run.codeReview.unresolvedFindingIds?.length??0};
    return {id:run.id,label:run.label,agent:run.agent,origin:run.origin??null,status:run.status,baseCommit:run.baseCommit,headCommit:run.headCommit,
      startedAt:run.startedAt,finishedAt:run.finishedAt,changedFiles:run.changedFiles.length,summary:run.summary??'',evidence:evidenceDto(run.evidence),ownerDecision:review,independentReview:assessment};});
  return {workspaceId,project:{id:data.project.id,name:data.project.name},page:data.page,task:{id:task.id,title:task.title,purpose:task.purpose,criteria:[...task.criteria],status:task.status,
    createdAt:task.createdAt,revision:task.revision??1,baseCommit:task.baseCommit,acceptedRunId:uuid(task.acceptedRunId)?task.acceptedRunId:null,mergedCommit:sha(task.mergedCommit)?task.mergedCommit:null,
    dependsOn:Array.isArray(task.dependsOn)?[...task.dependsOn]:[]},counts:{candidates:candidates.length},candidates};
}
function metricsDto(value,projectId){
  const parsed=readMetrics(value,projectId),phases={};
  for(const name of PROJECT_METRIC_PHASES){
    const row=parsed.phases[name],outcomes={};
    for(const outcome of PROJECT_METRIC_OUTCOMES[name])if(Object.hasOwn(row.outcomes,outcome))outcomes[outcome]=row.outcomes[outcome];
    phases[name]={label:row.label,definition:row.definition,unit:row.unit,total:row.total,observed:row.observed,active:row.active,missing:row.missing,
      invalid:row.invalid,notStarted:row.notStarted,notApplicable:row.notApplicable,outcomes,medianMs:row.medianMs,minimumMs:row.minimumMs,
      maximumMs:row.maximumMs,activeMedianElapsedMs:row.activeMedianElapsedMs,remainingMs:row.remainingMs};
    if(['verification','recovery'].includes(name)){
      phases[name].coverage={operations:row.coverage.operations,withRecords:row.coverage.withRecords,withoutRecords:row.coverage.withoutRecords};
      phases[name].historicalAttemptsMayBeUnrecorded=row.historicalAttemptsMayBeUnrecorded;
    }
  }
  return {schemaVersion:parsed.schemaVersion,projectId:parsed.projectId,sourceRevision:parsed.sourceRevision,observedAt:parsed.observedAt,scope:parsed.scope,
    counts:{tasks:parsed.counts.tasks,candidates:parsed.counts.candidates,retainedOperations:parsed.counts.retainedOperations},phases,
    modelProvenance:{totalRuns:parsed.modelProvenance.totalRuns,recordedRuns:parsed.modelProvenance.recordedRuns,unattributedRuns:parsed.modelProvenance.unattributedRuns,
      models:parsed.modelProvenance.models.map(model=>({name:model.name,runs:model.runs}))},
    usage:{knownRequests:parsed.usage.knownRequests,unknownUsageRequests:parsed.usage.unknownUsageRequests,observedUsageRequests:parsed.usage.observedUsageRequests,
      modelRunsWithoutReceipt:parsed.usage.modelRunsWithoutReceipt,externalRunsWithoutUsage:parsed.usage.externalRunsWithoutUsage,
      cachedUsageKnownRequests:parsed.usage.cachedUsageKnownRequests,totalOverflow:parsed.usage.totalOverflow,observedInputTokens:parsed.usage.observedInputTokens,
      observedOutputTokens:parsed.usage.observedOutputTokens,observedCachedInputTokens:parsed.usage.observedCachedInputTokens,scope:parsed.usage.scope},
    cost:{currency:parsed.cost.currency,actual:parsed.cost.actual,measuredRequests:parsed.cost.measuredRequests,knownRequests:parsed.cost.knownRequests,
      estimate:parsed.cost.estimate,reason:parsed.cost.reason},
    flags:{phaseWindowsMayOverlap:parsed.flags.phaseWindowsMayOverlap,phaseTotalsMustNotBeAdded:parsed.flags.phaseTotalsMustNotBeAdded,
      historicalRecoveryMayBeUnrecorded:parsed.flags.historicalRecoveryMayBeUnrecorded}};
}

function eligibility(context,connected){const workspace=context?.workspace,principal=workspace?.authentication?.principal;
  if(!connected||context?.demo||workspace?.provider!=='cloudflare-artifacts'||workspace?.authentication?.mode!=='cloudflare-access'
    ||!record(principal)||!['owner','member','agent'].includes(principal.kind)||!text(workspace.id,100))return null;
  return {workspaceId:workspace.id,key:JSON.stringify([workspace.id,principal])};
}
function toolDefinitions(run){const integerSchema=(maximum,minimum=0)=>({type:'integer',minimum,maximum});
  return [
    {name:PROJECTS_GIT_WEBMCP_TOOLS[0],description:'List repositories visible to the current signed-in Projects Git identity, with explicit paging and complete authorization-scoped denominators.',
      inputSchema:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:200},offset:integerSchema(100000),limit:integerSchema(50,1),at:integerSchema(Number.MAX_SAFE_INTEGER)}},
      execute:(args,options)=>run(PROJECTS_GIT_WEBMCP_TOOLS[0],args,options,async(value,workspaceId)=>{value=input(value,['q','offset','limit','at']);const q=value.q===undefined?'':text(value.q,200)?value.q.trim():invalid();
        const offset=integer(value.offset,0,100000),limit=integer(value.limit,20,50),at=integer(value.at,null,Number.MAX_SAFE_INTEGER);if(limit<1)invalid();const params=new URLSearchParams({q,offset:String(offset),limit:String(limit)});if(at!==null)params.set('at',String(at));
        return catalogDto(await run.api('/api/projects/catalog?'+params),workspaceId);})},
    {name:PROJECTS_GIT_WEBMCP_TOOLS[1],description:'List every retained task and candidate denominator for one accessible repository at a pinned workspace revision.',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string',pattern:'^[a-f0-9-]{36}$'},at:integerSchema(Number.MAX_SAFE_INTEGER)},required:['projectId']},
      execute:(args,options)=>run(PROJECTS_GIT_WEBMCP_TOOLS[1],args,options,async(value,workspaceId)=>{value=input(value,['projectId','at'],['projectId']);const projectId=safeId(value.projectId),at=integer(value.at,null,Number.MAX_SAFE_INTEGER);
        return projectTasksDto(await run.api('/api/workspace?limit=1&project='+encodeURIComponent(projectId)+(at===null?'':'&at='+at)),workspaceId,projectId);})},
    {name:PROJECTS_GIT_WEBMCP_TOOLS[2],description:'Read one accessible task and all of its retained candidate status summaries without diffs, logs, credentials, or identity details.',
      inputSchema:{type:'object',additionalProperties:false,properties:{taskId:{type:'string',pattern:'^[a-f0-9-]{36}$'},at:integerSchema(Number.MAX_SAFE_INTEGER)},required:['taskId']},
      execute:(args,options)=>run(PROJECTS_GIT_WEBMCP_TOOLS[2],args,options,async(value,workspaceId)=>{value=input(value,['taskId','at'],['taskId']);const taskId=safeId(value.taskId),at=integer(value.at,null,Number.MAX_SAFE_INTEGER);
        return taskStatusDto(await run.api('/api/workspace?limit=1&task='+encodeURIComponent(taskId)+(at===null?'':'&at='+at)),workspaceId,taskId);})},
    {name:PROJECTS_GIT_WEBMCP_TOOLS[3],description:'Read validated operational timing, model attribution, usage coverage, and unknown cost metrics for one accessible repository.',
      inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string',pattern:'^[a-f0-9-]{36}$'}},required:['projectId']},
      execute:(args,options)=>run(PROJECTS_GIT_WEBMCP_TOOLS[3],args,options,async(value,workspaceId)=>{value=input(value,['projectId'],['projectId']);const projectId=safeId(value.projectId);
        return metricsDto(await run.api('/api/projects/'+encodeURIComponent(projectId)+'/metrics'),projectId);})},
  ].map(tool=>({...tool,annotations}));
}

export function createProjectsGitWebMcp({document,getContext,captureSession,api,isConnected=()=>true,onStatus=()=>{},pageWindow=globalThis.window}){
  const modelContext=document?.modelContext,supported=typeof modelContext?.registerTool==='function';let generation=0,current=null,previous=Promise.resolve(),ended=false,state={phase:'inactive',message:'Browser tools are off outside an authenticated hosted workspace.'};
  const report=(phase,message)=>{state={phase,message};onStatus({...state});};
  const stop=(message='Browser tools are off outside an authenticated hosted workspace.')=>{generation++;if(current)current.controller.abort();previous=current?.promise??previous;current=null;report(supported?'inactive':'unsupported',supported?message:'Browser tools are unavailable in this browser.');};
  const assertCurrent=(entry,callerSignal)=>{const available=eligibility(getContext(),isConnected());if(callerSignal?.aborted||entry.controller.signal.aborted||current!==entry||entry.id!==generation
      ||!entry.session()||!available||available.key!==entry.key)throw aborted();return available.workspaceId;};
  const sync=()=>{
    const available=eligibility(getContext(),isConnected());if(ended||!supported||!available){stop(ended?'Browser tools stopped when this page was closed.':undefined);return Promise.resolve(false);}
    if(current?.key===available.key&&current.session())return current.promise;
    const wait=previous.catch(()=>{});if(current)current.controller.abort();const entry={id:++generation,key:available.key,controller:new AbortController(),session:captureSession(),promise:null};current=entry;
    report('registering','Connecting four read-only browser tools…');
    const invoke=async(tool,args,options,operation)=>{const workspaceId=assertCurrent(entry,options?.signal);let result;
      try{result=await operation(args,workspaceId);}catch(error){assertCurrent(entry,options?.signal);throw error;}
      assertCurrent(entry,options?.signal);return output(tool,result);};
    invoke.api=api;
    entry.promise=(async()=>{try{await wait;assertCurrent(entry);for(const tool of toolDefinitions(invoke)){await modelContext.registerTool(tool,{signal:entry.controller.signal});assertCurrent(entry);}
        report('available','Four read-only browser tools are available for this signed-in workspace.');return true;
      }catch(error){entry.controller.abort();if(current===entry){current=null;report(error?.name==='AbortError'?'inactive':'unavailable',error?.name==='AbortError'
          ?'Browser tools are off outside an authenticated hosted workspace.':'Browser tools could not be registered for this session.');}return false;}})();previous=entry.promise;return entry.promise;
  };
  const pagehide=()=>{ended=true;stop('Browser tools stopped when this page was closed.');};pageWindow?.addEventListener?.('pagehide',pagehide,{once:true});
  onStatus({...state});
  return {sync,disable:stop,status:()=>({...state})};
}
