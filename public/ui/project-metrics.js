import {el} from './dom.js';

export const PROJECT_METRIC_PHASES=Object.freeze(['queue','handoff','execution','reviewWait','reviewTurnaround','verification','recovery']);
export const PROJECT_METRIC_OUTCOMES=Object.freeze({
  queue:Object.freeze(['assigned']),handoff:Object.freeze(['started']),execution:Object.freeze(['submitted','failed']),reviewWait:Object.freeze(['assigned']),
  reviewTurnaround:Object.freeze(['pass','changes_requested','unconfirmed']),verification:Object.freeze(['completed','reconciled','failed','unconfirmed']),
  recovery:Object.freeze(['completed','reconciled','failed','unconfirmed']),
});
const count=value=>Number.isSafeInteger(value)&&value>=0;
const metricText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\0\r\n]/.test(value);
const metricTime=value=>metricText(value,40)&&Number.isSafeInteger(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;
export function durationLabel(value){
  if(value===null)return 'Not recorded';
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('Invalid recorded duration.');
  const [amount,unit]=value<1000?[value,'ms']:value<60000?[value/1000,'s']:value<3600000?[value/60000,'min']:[value/3600000,'h'];
  return new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(amount)+' '+unit;
}
export function readMetrics(value,projectId){
  const fail=()=>{throw Error('Metrics are incomplete or use a different schema. Reload the complete repository metrics.');};
  if(value?.schemaVersion!==1||value.projectId!==projectId||value.scope!=='complete-repository-history'||!count(value.sourceRevision)||!metricTime(value.observedAt)
    ||!value.counts||!count(value.counts.tasks)||!count(value.counts.candidates)||!count(value.counts.retainedOperations))fail();
  for(const name of PROJECT_METRIC_PHASES){
    const row=value.phases?.[name],categories=['observed','active','missing','invalid','notStarted','notApplicable'];
    if(!row||!count(row.total)||categories.some(key=>!count(row[key]))||categories.reduce((n,key)=>n+row[key],0)!==row.total
      ||!metricText(row.label,160)||!metricText(row.definition,1000)||!metricText(row.unit,40)||row.remainingMs!==null||row.observed===0&&row.medianMs!==null
      ||row.observed>0&&[row.medianMs,row.minimumMs,row.maximumMs].some(value=>value===null))fail();
    for(const key of ['medianMs','minimumMs','maximumMs','activeMedianElapsedMs'])if(row[key]!==null&&(typeof row[key]!=='number'||!Number.isFinite(row[key])||row[key]<0))fail();
    if(!row.outcomes||typeof row.outcomes!=='object'||Array.isArray(row.outcomes)||Object.keys(row.outcomes).some(key=>!PROJECT_METRIC_OUTCOMES[name].includes(key))
      ||Object.values(row.outcomes).some(value=>!count(value))
      ||Object.values(row.outcomes).reduce((n,value)=>n+value,0)!==row.observed)fail();
    if(row.coverage&&(!count(row.coverage.operations)||!count(row.coverage.withRecords)||!count(row.coverage.withoutRecords)
      ||row.coverage.withRecords+row.coverage.withoutRecords!==row.coverage.operations))fail();
    if(['verification','recovery'].includes(name)?!row.coverage||row.historicalAttemptsMayBeUnrecorded!==true:row.coverage!==undefined||row.historicalAttemptsMayBeUnrecorded!==undefined)fail();
  }
  if(!value.modelProvenance||value.modelProvenance.totalRuns!==value.counts.candidates||!Array.isArray(value.modelProvenance.models)
    ||!count(value.modelProvenance.recordedRuns)||!count(value.modelProvenance.unattributedRuns)
    ||value.modelProvenance.recordedRuns+value.modelProvenance.unattributedRuns!==value.counts.candidates)fail();
  if(value.modelProvenance.models.some(model=>typeof model?.name!=='string'||!model.name||model.name.length>160||!count(model.runs)||model.runs<1)
    ||value.modelProvenance.models.reduce((n,model)=>n+model.runs,0)!==value.modelProvenance.recordedRuns)fail();
  const usage=value.usage;
  if(!usage||!count(usage.knownRequests)||!count(usage.observedUsageRequests)||!count(usage.unknownUsageRequests)
    ||usage.observedUsageRequests+usage.unknownUsageRequests!==usage.knownRequests
    ||!count(usage.modelRunsWithoutReceipt)||!count(usage.externalRunsWithoutUsage)||!count(usage.cachedUsageKnownRequests)||typeof usage.totalOverflow!=='boolean'
    ||usage.scope!=='retained-coding-agent-requests-only')fail();
  for(const key of ['observedInputTokens','observedOutputTokens','observedCachedInputTokens'])if(usage[key]!==null&&!count(usage[key]))fail();
  if(value.cost?.currency!=='USD'||value.cost.actual!==null||value.cost.estimate!==null||value.cost.measuredRequests!==0
    ||value.cost.knownRequests!==usage.knownRequests||!metricText(value.cost.reason,500))fail();
  if(value.flags?.phaseWindowsMayOverlap!==true||value.flags.phaseTotalsMustNotBeAdded!==true||value.flags.historicalRecoveryMayBeUnrecorded!==true)fail();
  return value;
}
export function canInspectProjectMetrics({workspace,demo},projectId){
  return !demo&&workspace?.authentication?.mode==='cloudflare-access'&&Object.hasOwn(workspace.projects??{},projectId);
}
export function createProjectMetricsPanel({projectId,getContext,captureSession,api}){
  const root=el('section',{id:'project-operational-metrics','aria-label':'Operational metrics'}),session=captureSession();
  let data=null,error='',reading=false,selection=0;
  const current=()=>root.isConnected&&session()&&getContext().selectedProject===projectId&&canInspectProjectMetrics(getContext(),projectId);
  async function load(){
    if(!current()||reading)return;reading=true;error='';const request=++selection;render();
    try{const result=readMetrics(await api('/api/projects/'+projectId+'/metrics'),projectId);if(!current()||request!==selection)return;data=result;}
    catch(failure){if(!current()||request!==selection)return;data=null;error=failure.message;}
    if(!current()||request!==selection)return;reading=false;render();
  }
  const number=value=>value===null?'Not recorded':new Intl.NumberFormat('en-US').format(value);
  function render(){
    if(!canInspectProjectMetrics(getContext(),projectId)){root.replaceChildren(el('p',{},'Repository metrics are unavailable in this session.'));return;}
    const body=data?[
      el('p',{class:'small'},`${data.counts.tasks} tasks · ${data.counts.candidates} candidates · ${data.counts.retainedOperations} retained operations · revision ${data.sourceRevision}`),
      el('p',{class:'small'},'Medians include every measured outcome, including failed and unconfirmed windows. Phases may overlap; their times must not be added.'),
      el('div',{class:'project-metrics-table'},el('table',{},el('caption',{},'Retained timing observations'),
        el('thead',{},el('tr',{},...['Phase','Median','Coverage','Other observations'].map(label=>el('th',{scope:'col'},label)))),
        el('tbody',{},...PROJECT_METRIC_PHASES.map(name=>{const row=data.phases[name];return el('tr',{},
          el('th',{scope:'row'},row.label),el('td',{},durationLabel(row.medianMs)),
          el('td',{},`${row.observed}/${row.total} ${row.unit} measured`,row.coverage?el('p',{class:'small'},`${row.coverage.withRecords}/${row.coverage.operations} operations have records`):null),
          el('td',{},`Open ${row.active} · missing ${row.missing} · invalid ${row.invalid} · not started ${row.notStarted} · N/A ${row.notApplicable}`,
            el('p',{class:'small'},'Measured outcomes: '+(Object.entries(row.outcomes).map(([name,count])=>`${name} ${count}`).join(' · ')||'None'))));})))),
      el('h4',{},'Model and usage observations'),
      el('p',{},`${data.modelProvenance.recordedRuns}/${data.modelProvenance.totalRuns} candidates have a recorded model selection. ${data.modelProvenance.unattributedRuns} are unattributed.`),
      ...data.modelProvenance.models.map(model=>el('p',{class:'small'},`${model.name}: ${model.runs} candidates`)),
      data.modelProvenance.models.length>1?el('p',{class:'capability-note'},'Timing comparisons include multiple recorded models.'):null,
      el('p',{},`${data.usage.observedUsageRequests}/${data.usage.knownRequests} retained model requests have usage. ${data.usage.unknownUsageRequests} have unknown usage.`),
      el('p',{class:'small'},`Observed tokens: input ${number(data.usage.observedInputTokens)} · output ${number(data.usage.observedOutputTokens)}. Cache usage recorded for ${data.usage.cachedUsageKnownRequests}/${data.usage.observedUsageRequests} observed requests.`),
      data.usage.totalOverflow?el('p',{role:'alert',class:'inline-error'},'A token total exceeded safe arithmetic limits and is unavailable. The other observed counts remain separate.'):null,
      el('p',{class:'small'},`Model candidates without a receipt: ${data.usage.modelRunsWithoutReceipt}. External candidates without request usage: ${data.usage.externalRunsWithoutUsage}.`),
      el('p',{},'Dollar spend: not recorded. No price estimate is included.'),
      el('details',{},el('summary',{},'Definitions and missing history'),
        ...PROJECT_METRIC_PHASES.map(name=>el('p',{class:'small'},el('strong',{},data.phases[name].label+': '),data.phases[name].definition)),
        el('p',{class:'small'},'Open windows describe unsettled observations, not proof that a process is running. Remaining time is unknown. Historical retries may lack records. External-agent model selection and usage are unknown unless retained explicitly. These figures cover coding-agent requests, not the full Cloudflare bill.')),
    ]:[];
    root.replaceChildren(...[el('h3',{},'Operational metrics'),reading?el('p',{role:'status'},'Reading complete repository history…'):null,
      error?el('p',{role:'alert'},error):null,...body,el('button',{class:'button button-small',type:'button',disabled:reading,onclick:load},'Refresh metrics')].filter(Boolean));
  }
  render();queueMicrotask(load);return root;
}
