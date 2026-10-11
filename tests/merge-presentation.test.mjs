import {createCollectionPager} from '../public/ui/collection.js';
const makePager=workspace=>createCollectionPager({getScope:()=>workspace.id,render(){}});
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {candidateOutcome, taskOutcome, mergeState, mergeIntentSummary, mergeReports, completedVerification, workspacePresentationKey, independentlyVerified} from '../public/workbench-state.js';
import {candidateSummary, projectStatus} from '../src/local/repository-cli-view.mjs';
import {mergeStatusNotice, mergeReportPanel, earlierReportPanel, createWorkbenchParts} from '../public/ui/workbench-parts.js';
import {metrics} from '../src/core/workflow.mjs';
import {createReviewView} from '../public/ui/views/review.js';
import {createEvidenceView} from '../public/ui/views/evidence.js';
import {createReviewForm} from '../public/ui/review-form.js';
import {createWorkspaceConnection} from '../public/workspace-connection.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';

const url = new URL('http://127.0.0.1:8818');
function fixture() {
  const task = {id:'task', projectId:'project', title:'Merge progress', purpose:'Truthful integration', criteria:['Keep proof'],
    revision:1, owner:'Human', ownerVersion:1, origin:'connected-git', baseCommit:'a'.repeat(40), acceptedRunId:'run'};
  const report = {verified:true, source:'independent-local-checks', commit:'b'.repeat(40), taskRevision:1,
    passed:1, total:1, checks:[{name:'Contract', passed:true, detail:'Passed'}], command:'node --test', exitCode:0,
    output:'Passed', verifiedAt:'2026-10-05T20:00:00Z', verification:{kind:'repository-command-checks/v1', image:'sha256:'+'c'.repeat(64)}};
  const run = {id:'run', taskId:task.id, status:'accepted', label:'Chosen candidate', headCommit:report.commit,
    baseCommit:task.baseCommit, changedFiles:[], diff:'', evidence:report, evidenceHistory:[],
    review:{decision:'accept', reviewer:'Human', note:'Reviewed', headCommit:report.commit, ownerVersion:1, comparisons:[]}};
  const workspace = {id:'workspace', version:1, provider:'local-git', tasks:[task], runs:[run], events:[],
    projects:{project:{id:'project', name:'Project', mainCommit:task.baseCommit, acceptingWork:true}},
    capacity:{running:0, queued:0, limit:2}, capabilities:{merge:true},
    coordination:{run:{acceptance:[{met:true}], activeRunIds:[], blockingRunIds:[], overlaps:[]}},
    recovery:{pendingMergeIntents:1, errors:[]}, mergeStateByRun:{run:'running'}};
  return {workspace, task, run, report};
}
const tagged = report => ({...structuredClone(report), operation:'merge', attemptId:'attempt-1'});
const disclosure = (id,title,...body) => el('details',{id},el('summary',{},title),...body);

test('latest-report KPI and earlier failures retain separate populations without altering source state',()=>{
  installFakeDOM();const {workspace,task,run,report}=fixture();task.status='accepted';
  run.evidence={...report,passed:3,total:3,checks:[{passed:true},{passed:true},{passed:true}]};
  const previous={...report,passed:0,total:2,checks:[{passed:false},{passed:false}],exitCode:1,verifiedAt:'2026-10-05T19:00:00Z'};
  run.evidenceHistory=[previous,tagged(report)];const before=JSON.stringify(workspace),count=metrics(workspace).checks,panel=earlierReportPanel(workspace,run,disclosure);
  assert.equal(count.passed,3);assert.equal(count.total,3);assert.match(panel.textContent,/Earlier check reports · 1/);assert.match(panel.textContent,/0 \/ 2 checks/);
  assert.match(panel.textContent,/2026-10-05T19:00:00Z/);assert.ok(panel.textContent.includes(previous.commit));assert.match(panel.textContent,/Requirementsr1/);assert.match(panel.textContent,/Recorded exit code1/);
  assert.ok(!panel.textContent.includes('attempt-1'));assert.equal(mergeReports(workspace,run).length,1);assert.equal(JSON.stringify(workspace),before);
});

test('earlier-report list does not invent missing fields or hide malformed history',()=>{
  installFakeDOM();const {workspace,run}=fixture();run.evidenceHistory=[null,{passed:0,total:2}];
  const panel=earlierReportPanel(workspace,run,disclosure);assert.match(panel.textContent,/Malformed data/);assert.match(panel.textContent,/0 \/ 2 checks/);assert.match(panel.textContent,/CommitNot retained/);
  run.evidenceHistory=[];assert.equal(earlierReportPanel(workspace,run,disclosure),null);
});

test('shared selectors keep browser and CLI running/recovery states consistent without altering totals', () => {
  const {workspace, task, run} = fixture();
  for (const state of ['running','recovery-required']) {
    workspace.mergeStateByRun.run = state;
    const cli = candidateSummary(workspace, run.id, url);
    assert.equal(cli.merge.state, state);
    assert.deepEqual(cli.outcome, candidateOutcome(workspace,run));
    assert.equal(taskOutcome(workspace,task).label, cli.outcome.label);
    assert.deepEqual(projectStatus(workspace,'project',url).mergeIntents, {scope:'workspace',...mergeIntentSummary(workspace)});
    assert.equal(mergeIntentSummary(workspace).total,1);
  }
  delete workspace.mergeStateByRun.run;
  assert.equal(mergeState(workspace,run),null);
  assert.equal(mergeIntentSummary(workspace).unclassified,1);
  assert.equal(candidateOutcome(workspace,run).label,'Accepted · merge next');
});

test('off-page merge intents retain workspace-wide progress and recovery warnings',()=>{
  installFakeDOM();const {workspace}=fixture();
  for(const state of ['running','recovery-required']){
    workspace.mergeStateByRun={'off-page-run':state};workspace.recovery={pendingMergeIntents:1};
    const summary=mergeIntentSummary(workspace);assert.equal(summary.unclassified,0);
    assert.equal(state==='running'?summary.running:summary.recoveryRequired,1);
    assert.deepEqual(projectStatus(workspace,'project',url).mergeIntents,{scope:'workspace',...summary});
    const notice=mergeStatusNotice(workspace);
    assert.equal(notice.attrs.role,state==='running'?'status':'alert');
    assert.match(notice.textContent,state==='running'?/Merge in progress/:/Workspace recovery needs attention/);
  }
});

test('active merge notice is a progress status; recovery uses an alert with the unchanged total', () => {
  installFakeDOM();
  const {workspace} = fixture();
  const active = mergeStatusNotice(workspace);
  assert.equal(active.attrs.role,'status');
  assert.match(active.textContent,/1 pending merge intents total · 1 running · 0 recovery required/);
  assert.ok(!active.textContent.includes('needs attention'));
  workspace.mergeStateByRun.run='recovery-required';
  const recovery = mergeStatusNotice(workspace);
  assert.equal(recovery.attrs.role,'alert');
  assert.match(recovery.textContent,/1 pending merge intents total · 0 running · 1 recovery required/);
});

test('tagged merge reports preserve complete provenance and never relabel historical unmarked reports', () => {
  const {workspace,run,report} = fixture();
  const fresh=tagged(report); run.evidenceHistory=[structuredClone(report),fresh,{...fresh,attemptId:''}];
  const before=JSON.stringify(workspace);
  const reports=mergeReports(workspace,run);
  assert.equal(reports.length,1); assert.equal(reports[0].report,fresh); assert.equal(reports[0].passing,true);
  assert.equal(candidateSummary(workspace,run.id,url).merge.reports[0].report.verification.image,fresh.verification.image);
  assert.equal(run.evidence,report); assert.equal(JSON.stringify(workspace),before);
  assert.equal(run.evidenceHistory[0].operation,undefined);
});

test('failed, stale, malformed and unverified merge reports cannot become current passing proof', () => {
  const {workspace,run,report}=fixture();
  const bad=[
    {passed:0, checks:[{name:'Failed',passed:false}], exitCode:1},
    {commit:'d'.repeat(40)}, {taskRevision:0}, {verified:false}, {source:'hosted-harness-report'},
    {checks:[]}, {total:0,passed:0,checks:[]}, {passed:2}, {exitCode:null}, {verifiedAt:'invalid'}, {output:null},
  ];
  for(const patch of bad){
    run.evidenceHistory=[{...tagged(report),...patch}];
    const [result]=mergeReports(workspace,run);
    assert.equal(result.passing,false,JSON.stringify(patch));
    assert.ok(!result.label.includes('passed'));
    assert.equal(run.evidence,report);
  }
  run.evidence={...report,commit:'e'.repeat(40)};run.status='awaiting_review';
  workspace.mergeStateByRun={};workspace.tasks[0].acceptedRunId=null;
  assert.equal(independentlyVerified(workspace,run),false);
  assert.equal(candidateOutcome(workspace,run).label,'Recheck needed');
});

test('same-version running-to-recovery transition changes the actual render signature',async()=>{
  const {workspace,run,report}=fixture(), prior=workspacePresentationKey(workspace);
  workspace.mergeStateByRun.run='recovery-required';
  assert.notEqual(workspacePresentationKey(workspace),prior);
  const next=workspacePresentationKey(workspace);run.evidenceHistory.push(tagged(report));
  assert.notEqual(workspacePresentationKey(workspace),next);
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/const key = .*workspacePresentationKey\(workspace\)/);
  assert.match(app,/mergeState\(workspace, run\) === 'running'/);
});

test('refresh consumes same-version state changes through GET reads while preserving selected identities',async()=>{
  let {workspace}=fixture(); const selected={taskId:'task',runId:'run'};
  const incoming=structuredClone(workspace);incoming.mergeStateByRun.run='recovery-required';
  const calls=[],signals=[];
  const connection=createWorkspaceConnection({api:async(...args)=>{calls.push(args);return incoming;},
    getWorkspace:()=>workspace,setWorkspace:value=>{workspace=value;},activity:()=>({active:false}),
    onChange(){},onSnapshot:(data,previous)=>signals.push(workspacePresentationKey(data)!==workspacePresentationKey(previous)),
    onError:error=>{throw error;},setTimer:()=>1,clearTimer(){}});
  await connection.refresh(true);
  assert.deepEqual(calls,[['/api/workspace']]);assert.deepEqual(signals,[true]);
  assert.equal(workspace.tasks[0].id,selected.taskId);assert.equal(workspace.runs[0].id,selected.runId);
});

function recoveryForm(state='recovery-required', onMutationSettled=()=>{}) {
  installFakeDOM();const f=fixture(),context={workspace:f.workspace,busy:false},calls=[],refreshes=[],errors=[];
  context.workspace.mergeStateByRun.run=state;
  const heads=run=>(context.workspace.coordination[run.id]?.overlaps??[]).map(({runId,headCommit})=>({runId,headCommit}));
  const form=createReviewForm({getContext:()=>context,drafts:new Map(),getReviewerName:()=>'',rememberReviewerName(){},
    runCoordination:run=>context.workspace.coordination[run.id],comparisonHeads:heads,comparisonKey:run=>JSON.stringify(heads(run)),
    acceptanceReady:run=>independentlyVerified(context.workspace,run)&&run.evidence.total>0&&run.evidence.passed===run.evidence.total&&run.evidence.checks.every(check=>check.passed),
    disclosure,saveSession(){},showError:message=>errors.push(message),switchView(){},
    api:(path,body)=>new Promise((resolve,reject)=>calls.push({path,body,resolve,reject})),
    mutate:async action=>{try{return await action();}catch(error){errors.push(error.message);return false;}finally{onMutationSettled(form.reviewPanel(f.run,f.task));}},refresh:async force=>refreshes.push(force)});
  const panel=form.reviewPanel(f.run,f.task),buttons=[];
  function visit(node){if(node.tagName==='BUTTON')buttons.push(node);for(const child of node.children??[])visit(child);}visit(panel);
  return {...f,context,form,panel,calls,refreshes,errors,button:label=>buttons.find(button=>button.textContent===label)};
}

test('active merge stays blocked while refresh in either operation state only reads',async()=>{
  for(const state of ['running','recovery-required']){
    const f=recoveryForm(state);
    if(state==='running'){const button=f.button('Merge in progress…');assert.equal(button.disabled,true);await button.dispatch('click');}
    await f.button('Refresh merge status').dispatch('click');
    assert.equal(f.calls.length,0);assert.deepEqual(f.refreshes,[true]);
  }
});

test('a different merge in this project disables manual merge and stale buttons cannot dispatch it',async()=>{
  const f=recoveryForm(null),old=f.button('Merge accepted candidate');assert.equal(old.disabled,false);
  const otherTask={...f.task,id:'other-task'},other={...f.run,id:'other-run',taskId:otherTask.id};
  f.workspace.tasks.push(otherTask);f.workspace.runs.push(other);f.workspace.mergeStateByRun['other-run']='running';
  const panel=f.form.reviewPanel(f.run,f.task);
  assert.equal(document.getElementById('merge-run').disabled,true);assert.match(panel.textContent,/Another merge owns this project/);
  await old.dispatch('click');assert.equal(f.calls.length,0);
  otherTask.projectId='another-project';f.form.reviewPanel(f.run,f.task);
  assert.equal(document.getElementById('merge-run').disabled,false,'A different project retains its own merge admission');
});

test('explicit recovery explains both possible actions and coalesces double clicks',async()=>{
  const f=recoveryForm(),button=f.button('Reconcile or retry merge');
  assert.equal(button.disabled,false);
  assert.match(f.panel.textContent,/without another check or Git update/);
  assert.match(f.panel.textContent,/run fresh checks and retry/);
  assert.match(f.panel.textContent,/different commit: stop/);
  const first=button.dispatch('click'),duplicate=button.dispatch('click');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/runs/run/merge');assert.deepEqual(f.calls[0].body,{headCommit:f.run.headCommit});
  f.calls[0].resolve({});await Promise.all([first,duplicate]);assert.deepEqual(f.refreshes,[true]);
});

test('a stale displayed recovery control cannot dispatch against changed authority or evidence',async()=>{
  const changes=[
    f=>{f.context.busy=true;},f=>{f.workspace.capabilities.merge=false;},f=>{f.workspace.mergeStateByRun.run='running';},
    f=>{f.run.headCommit='c'.repeat(40);},f=>{f.task.revision++;},f=>{f.task.ownerVersion++;},
    f=>{f.run.evidence.verified=false;},f=>{f.run.evidence.passed=0;f.run.evidence.checks[0].passed=false;},
    f=>{f.run.evidence.exitCode=1;},f=>{f.run.review.decision='reject';},f=>{f.run.status='rejected';},
    f=>{f.task.acceptedRunId='other';},f=>{f.run.baseCommit='c'.repeat(40);},
    f=>{f.workspace.coordination.run.activeRunIds=['other'];},f=>{f.workspace.coordination.run.blockingRunIds=['other'];},
    f=>{f.workspace.coordination.run.overlaps=[{runId:'other',headCommit:'c'.repeat(40)}];},
    f=>{f.context.workspace={...structuredClone(f.workspace),id:'another-workspace'};},
  ];
  for(const change of changes){const f=recoveryForm();change(f);await f.button('Reconcile or retry merge').dispatch('click');assert.equal(f.calls.length,0,change.toString());}
});

test('uncertain recovery has no automatic retry and a changed target remains the server decision',async()=>{
  const f=recoveryForm();f.workspace.projects.project.mainCommit='c'.repeat(40);
  const button=f.button('Reconcile or retry merge'),request=button.dispatch('click');
  assert.equal(f.calls.length,1,'Recovery must read the target even when the last observed project head differs');
  f.calls[0].reject(new Error('Target is different; recovery retained'));await request;
  assert.equal(f.calls.length,1);assert.equal(f.workspace.mergeStateByRun.run,'recovery-required');assert.deepEqual(f.refreshes,[]);
  await f.button('Refresh merge status').dispatch('click');assert.equal(f.calls.length,1);assert.deepEqual(f.refreshes,[true]);
});

test('the action settlement render leaves explicit recovery available after an error',async()=>{
  let settledPanel;const f=recoveryForm('recovery-required',panel=>settledPanel=panel);
  const request=f.button('Reconcile or retry merge').dispatch('click');
  f.calls[0].reject(new Error('Outcome remains uncertain'));await request;
  const nodes=[];function visit(node){nodes.push(node);for(const child of node.children??[])visit(child);}visit(settledPanel);
  const retry=nodes.find(node=>node.tagName==='BUTTON'&&node.textContent==='Reconcile or retry merge');
  assert.equal(retry.disabled,false);assert.equal(f.calls.length,1);
  assert.equal(f.workspace.mergeStateByRun.run,'recovery-required');
});

test('actual review and evidence view modules expose tagged reports separately from acceptance',()=>{
  installFakeDOM();const {workspace,task,run,report}=fixture();
  run.evidenceHistory=[{...structuredClone(report),output:'Historical unmarked'}, {...tagged(report),output:'Fresh retained output'}];
  const context={workspace,busy:false,view:'review',selectedRun:run.id};
  const ports={getContext:()=>context,currentTask:()=>task,currentRun:()=>run,currentProject:()=>workspace.projects.project,
    taskRuns:()=>[run],tasksInProject:()=>[task],taskNumber:()=>1,taskLabel:()=>task.title,disclosure,
    independentlyVerified:()=>true,checksFailed:()=>false,reviewPanel:()=>el('div',{},'Human decision'),publicationPanel:()=>null,
    switchView(){},showError(){},announce(){},openContinuation(){},retainedSearches:new Map(),verificationDrafts:new Map(),
    actionFeedback:new Map(),actionKey:()=> 'action',actionNotice:()=>null,downloadHandoff(){},downloadEvidence(){},
    mutate(){throw new Error('Rendering must not mutate');},runOperation(){throw new Error('Rendering must not mutate');}};
  ports.collections=makePager(workspace);
  ports.parts=createWorkbenchParts(ports);
  for(const create of [createReviewView,createEvidenceView]){
    const text=create(ports)().textContent;
    assert.match(text,/Fresh merge verification/);assert.match(text,/Merge checks passed · attempt attempt-1/);
    assert.match(text,/Fresh retained output/);assert.match(text,/acceptance-time report remains separate/);
    assert.equal(run.evidence,report);
  }
  const text=mergeReportPanel(workspace,run,disclosure).textContent;
  assert.ok(!text.includes('Historical unmarked'));
});

function completedFixture() {
  const f=fixture();
  f.run.status='merged';f.task.status='merged';f.task.mergedCommit=f.run.headCommit;
  f.workspace.mergeStateByRun={};f.workspace.recovery.pendingMergeIntents=0;
  f.report.total=2;f.report.passed=2;f.report.checks.push({name:'Acceptance-only check',passed:true});
  const merge=tagged(f.report);
  merge.verifiedAt='2026-10-05T20:10:30Z';merge.total=3;merge.passed=3;
  merge.checks.push({name:'Merge-only check',passed:true});
  f.run.evidenceHistory=[structuredClone(f.report),merge];
  return {...f,merge};
}

function completedViewPorts(f) {
  const {workspace,task,run}=f;
  const ports={getContext:()=>({workspace,busy:false,view:'review',selectedRun:run.id}),
    currentTask:()=>task,currentRun:()=>run,currentProject:()=>workspace.projects.project,
    taskRuns:()=>[run],tasksInProject:()=>[task],taskNumber:()=>1,taskLabel:()=>task.title,disclosure,
    independentlyVerified:()=>independentlyVerified(workspace,run),checksFailed:()=>false,
    reviewPanel:()=>el('div',{},'Human decision'),publicationPanel:()=>null,switchView(){},showError(){},announce(){},openContinuation(){},
    retainedSearches:new Map(),verificationDrafts:new Map(),actionFeedback:new Map(),actionKey:()=> 'action',
    actionNotice:()=>null,downloadHandoff(){},downloadEvidence(){},onSectionChange(){},
    mutate(){throw new Error('Completed views must only read');},runOperation(){throw new Error('Completed views must only read');}};
  ports.collections=makePager(workspace);
  ports.parts=createWorkbenchParts(ports);
  return ports;
}

test('r2 completed selector and CLI retain separate verification moments, timestamps and denominators',()=>{
  const {workspace,run,report,merge}=completedFixture();
  const before=JSON.stringify(workspace);
  const moments=completedVerification(workspace,run);
  assert.deepEqual([moments.acceptance.label,moments.acceptance.passed,moments.acceptance.total,moments.acceptance.verifiedAt],
    ['Acceptance-time checks',2,2,'2026-10-05T20:00:00Z']);
  assert.deepEqual([moments.mergeAttempts[0].label,moments.mergeAttempts[0].passed,moments.mergeAttempts[0].total,moments.mergeAttempts[0].verifiedAt],
    ['Merge-attempt checks',3,3,'2026-10-05T20:10:30Z']);
  assert.equal(moments.acceptance.report,report);assert.equal(moments.mergeAttempts[0].report,merge);
  assert.deepEqual(candidateSummary(workspace,run.id,url).completedVerification,moments);
  assert.equal(projectStatus(workspace,'project',url).counters.reportedChecks.denominator,2,'Acceptance checks exclude merge-attempt counts');
  assert.equal(moments.total,undefined,'There is no combined denominator');
  assert.equal(moments.missingMergeReport,null);assert.equal(JSON.stringify(workspace),before);
  run.status='accepted';assert.equal(completedVerification(workspace,run),null,'Acceptance does not imply completion');
});

test('r2 completed actual review and evidence views label both reports with distinct counts and timestamps',()=>{
  installFakeDOM();const f=completedFixture(),ports=completedViewPorts(f);
  for(const create of [createReviewView,createEvidenceView]){
    const text=create(ports)().textContent;
    assert.match(text,/Acceptance-time checks/);assert.match(text,/Merge-attempt checks/);
    assert.match(text,/2 \/ 2/);assert.match(text,/3 \/ 3/);
    assert.ok(text.includes(f.report.verifiedAt));assert.ok(text.includes(f.merge.verifiedAt));
    assert.ok(!text.includes('5 / 5'),'The two denominators remain separate');
  }
  f.merge.taskRevision=0;assert.equal(completedVerification(f.workspace,f.run).mergeAttempts[0].passing,false);
  assert.match(mergeReportPanel(f.workspace,f.run,disclosure).textContent,/Stale or unverified merge report/);
});

test('r2 older merged outcomes explicitly lack tagged merge-time proof and never infer it from unmarked history',()=>{
  installFakeDOM();const f=completedFixture();
  f.run.evidenceHistory=[structuredClone(f.report),{...structuredClone(f.merge),operation:undefined,attemptId:undefined},
    {...structuredClone(f.merge),attemptId:''}];
  const before=JSON.stringify(f.workspace),moments=completedVerification(f.workspace,f.run);
  assert.equal(moments.mergeAttempts.length,0);
  assert.equal(moments.missingMergeReport,'No tagged merge-time report was retained.');
  assert.deepEqual(candidateSummary(f.workspace,f.run.id,url).completedVerification,moments);
  for(const create of [createReviewView,createEvidenceView]){
    const text=create(completedViewPorts(f))().textContent;
    assert.match(text,/Acceptance-time checks/);assert.match(text,/Merge-attempt checks/);
    assert.match(text,/No tagged merge-time report was retained\./);
    assert.ok(!text.includes('Merge checks passed · attempt'));
  }
  assert.equal(JSON.stringify(f.workspace),before);
});
