import {createCollectionPager} from '../public/ui/collection.js';
const makePager=workspace=>createCollectionPager({getScope:()=>workspace.id,render(){}});
import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {createWorkbenchParts} from '../public/ui/workbench-parts.js';
import {createTaskViews} from '../public/ui/views/queue.js';
import {createWorkView} from '../public/ui/views/work.js';
import {createReviewView} from '../public/ui/views/review.js';
import {createEvidenceView} from '../public/ui/views/evidence.js';
import {createWorkspace,createTask,assignRun,startRun,completeRun} from '../src/core/workflow.mjs';
import {independentlyVerified} from '../public/workbench-state.js';

function fixture(){
  installFakeDOM();
  const workspace=createWorkspace();workspace.capabilities={verify:true,revise:true};
  const project={id:crypto.randomUUID(),name:'Customer portal',mainCommit:'a'.repeat(40),acceptingWork:true};
  const foreign={...project,id:crypto.randomUUID(),name:'Other project'};
  workspace.projects={[project.id]:project,[foreign.id]:foreign};
  function add(ownerProject,title,label){
    const task=createTask(workspace,{title,purpose:'An agreed result',criteria:['Behavior works'],owner:'Reviewer',baseCommit:project.mainCommit});
    Object.assign(task,{projectId:ownerProject.id,origin:'connected-git'});
    const run=assignRun(workspace,task.id,{agent:'external',label,branch:'newwork/test'});startRun(workspace,run.id);
    completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['index.js'],diff:'+change',summary:'Retained result'});
    return {task,run};
  }
  const {task,run}=add(project,'Selected work','Selected candidate');add(foreign,'Foreign work','Foreign candidate');
  const context={workspace,busy:false,view:'overview',selectedRun:run.id,pendingTaskStart:null};
  const currentTask=()=>task,currentRun=()=>run,currentProject=()=>project;
  const taskRuns=id=>workspace.runs.filter(run=>run.taskId===id);
  const calls=[];
  const ports={getContext:()=>context,currentTask,currentRun,currentProject,taskRuns,
    taskNumber:task=>workspace.tasks.indexOf(task)+1,taskLabel:task=>task.title,
    tasksInProject:project=>workspace.tasks.filter(task=>task.projectId===project.id),
    disclosure:(id,title,...body)=>el('details',{id},el('summary',{},title),...body),
    independentlyVerified:run=>independentlyVerified(workspace,run),checksFailed:run=>Boolean(run.evidence&&run.evidence.passed<run.evidence.total),
    switchView:(...args)=>calls.push(args),showError(){},announce(){},selectProject(){},openTaskComposer(){},openRevision(){},openContinuation(){},
    repositoryAgents:()=>null,taskSettings:()=>null,externalHandoff:()=>null,reviewPanel:()=>el('div',{},'Decision controls'),publicationPanel:()=>null,downloadReviewContext:run=>calls.push(['review-context',run.id]),
    verificationDrafts:new Map(),actionFeedback:new Map(),retainedSearches:new Map(),actionKey:()=> 'key',actionNotice:()=>null,
    mutate(){throw new Error('Rendering must not mutate');},runOperation(){throw new Error('Rendering must not request work');},sha256Text(){},refresh(){},finishBaseUpdate(){},
    loadIndexedSearch(){throw new Error('Local view must not issue an indexed search');},rebuildSearch(){},render(){},downloadHandoff(){},downloadEvidence(){},onSectionChange(){},
  };
  ports.collections=makePager(workspace);
  ports.parts=createWorkbenchParts(ports);
  return {workspace,task,run,context,ports,calls};
}

function ownerReviewFixture(){
  const f=fixture();location.pathname='/workspace/';location.search='?token=must-not-copy';
  f.workspace.provider='cloudflare-artifacts';
  f.workspace.authentication={mode:'cloudflare-access',principal:{kind:'owner',id:'owner'},permissions:{manage:true,review:true,merge:true},
    agentClientIds:[],reviewerClientIds:['review-service'],reviewerSubjects:['review-person']};
  f.workspace.reviewerNames={'review-service':'Code review agent','review-person':'Alex Chen'};
  f.workspace.reviewRequests={[f.run.id]:'pending'};
  f.run.reviewAssignments=[{id:'assignment-a',at:'2026-10-10T12:00:00Z',reviewerIds:['review-service','review-person']}];
  f.run.evidence={verified:true,source:'independent-sandbox-checks',commit:f.run.headCommit,taskRevision:1,passed:1,total:1,exitCode:0,checks:[{name:'check',passed:true}]};
  const view=createReviewView(f.ports);f.page=()=>view();
  return f;
}

test('task handoff is reachable before any candidates exist and retains capability gating',async()=>{
  const f=fixture();f.workspace.runs=[];f.workspace.capabilities.handoff=true;
  f.ports.downloadHandoff=task=>f.calls.push(['handoff',task.id]);
  const views=createTaskViews(f.ports),nodes=node=>[node,...node.children.flatMap(nodes)];
  const button=()=>nodes(views.task()).find(node=>node.tagName==='BUTTON'&&node.textContent==='Download task handoff');
  assert.equal(button().disabled,false);await button().dispatch('click');assert.deepEqual(f.calls,[['handoff',f.task.id]]);
  f.context.busy=true;assert.equal(button().disabled,true);
  f.context.busy=false;f.workspace.capabilities.handoff=false;assert.equal(button().disabled,true);
  f.context.demo=true;assert.equal(button(),undefined);
});

test('review handoff shows names, roles and actual delivery expectations without granting access',()=>{
  const f=ownerReviewFixture(),before=structuredClone(f.workspace),page=f.page();
  for(const phrase of ['Alex Chen','Code review agent','Human reviewer','Agent reviewer','Awaiting review',
    'No email is sent and no reviewer agent is launched.','does not invite anyone','Renew review request'])assert.ok(page.textContent.includes(phrase),phrase);
  assert.deepEqual(f.workspace,before);assert.deepEqual(f.calls,[]);
  f.context.demo=true;assert.equal(f.page().querySelector('#human-review-link-'+f.run.id),null);
  f.context.demo=false;f.workspace.authentication.principal.kind='agent';assert.equal(f.page().querySelector('#human-review-link-'+f.run.id),null);
});

test('human link copying includes only the saved assignment and has an explicit clipboard failure path',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
  const copied=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copied.push(text)}}});
  const f=ownerReviewFixture(),page=f.page(),nodes=node=>[node,...node.children.flatMap(nodes)];
  const copy=nodes(page).find(node=>node.tagName==='BUTTON'&&node.textContent==='Copy human review link');
  await copy.dispatch('click');const link=new URL(copied[0]);
  assert.equal(link.pathname,'/workspace/reviewer');assert.deepEqual([...link.searchParams.keys()],['workspace','run','assignment']);
  assert.equal(link.searchParams.get('assignment'),'assignment-a');assert.equal(link.searchParams.get('run'),f.run.id);
  assert.ok(!copied[0].includes('must-not-copy'));assert.match(page.textContent,/Link copied/);assert.equal(f.calls.length,0);
  navigator.clipboard.writeText=async()=>{throw new Error('Denied');};await copy.dispatch('click');
  assert.match(page.textContent,/Clipboard unavailable/);assert.equal(document.activeElement.id,'human-review-link-'+f.run.id);
  f.run.reviewAssignments[0].id='assignment-b';await copy.dispatch('click');assert.equal(copied.length,1);assert.match(page.textContent,/request changed/);
});

test('links follow saved human assignments and are withheld for stale, unassigned or agent-only work',()=>{
  const f=ownerReviewFixture(),hasLink=()=>Boolean(f.page().querySelector('#human-review-link-'+f.run.id));
  assert.equal(hasLink(),true);f.workspace.reviewRequests[f.run.id]='stale';assert.equal(hasLink(),false);
  assert.match(f.page().textContent,/Needs renewed assignment/);
  f.workspace.reviewRequests[f.run.id]='pending';f.run.reviewAssignments[0].reviewerIds=['review-service'];assert.equal(hasLink(),false);
  delete f.run.reviewAssignments;f.workspace.reviewRequests[f.run.id]='unassigned';assert.equal(hasLink(),false);
});

test('request button enforces the visible eight-reviewer limit before sending an assignment',async()=>{
  const f=ownerReviewFixture();f.workspace.authentication.reviewerClientIds=Array.from({length:9},(_,index)=>'review-agent-'+index);
  delete f.run.reviewAssignments;const page=f.page(),nodes=node=>[node,...node.children.flatMap(nodes)];
  const choices=nodes(page).filter(node=>node.tagName==='INPUT'&&node.attrs.type==='checkbox');
  const button=nodes(page).find(node=>node.tagName==='BUTTON'&&node.textContent==='Request review');
  assert.equal(button.disabled,true);
  for(const input of choices.slice(0,8)){input.checked=true;await input.dispatch('change');}
  assert.equal(button.disabled,false);assert.match(page.textContent,/8 \/ 8 reviewers selected/);
  choices[8].checked=true;await choices[8].dispatch('change');assert.equal(button.disabled,true);
  assert.match(page.textContent,/9 \/ 8 reviewers selected/);assert.deepEqual(f.calls,[]);
});

test('saving a display name sends only presentation metadata and the current version',async()=>{
  const f=ownerReviewFixture(),calls=[];
  f.ports.mutate=async action=>action();f.ports.runOperation=async(path,body)=>{calls.push({path,body});return {};};f.ports.refresh=async()=>{};
  const page=createReviewView(f.ports)(),input=page.querySelector('#reviewer-name-review-person');input.value='Alex, security review';
  await input.parentElement.dispatch('submit');
  assert.deepEqual(calls,[{path:'/api/workspace/reviewer-name',body:{reviewerId:'review-person',name:'Alex, security review',expectedVersion:f.workspace.version}}]);
  assert.equal(f.workspace.authentication.reviewerSubjects[0],'review-person');
});

test('hosted passing checks land on a separate pending independent-review boundary',()=>{
 const f=fixture();f.workspace.provider='cloudflare-artifacts';f.workspace.authentication={reviewerClientIds:['reviewer'],permissions:{manage:false,review:true,merge:false}};
 f.run.evidence={verified:true,source:'independent-sandbox-checks',commit:f.run.headCommit,taskRevision:1,passed:1,total:1,exitCode:0,checks:[{name:'check',passed:true,detail:'observed'}]};location.hash='';
 const page=createReviewView(f.ports)(),grid=page.children.find(node=>node.className==='review-grid');assert.equal(grid.attrs['data-active-section'],'code-review');
 for(const phrase of ['Builder','Verifier','Independent reviewer','Owner','Independent code review required','Download read-only review context'])assert.ok(page.textContent.includes(phrase),phrase);
 assert.equal(f.calls.length,0);assert.ok(!page.textContent.includes('Passing assessment'));
});
test('demo review explains its illustrative records while a working hosted workspace retains setup guidance',()=>{
 const f=fixture();f.workspace.provider='cloudflare-artifacts';
 f.workspace.authentication={permissions:{manage:false,review:false,merge:false}};
 f.context.demo=true;
 const demo=createReviewView(f.ports)().textContent;
 assert.match(demo,/illustrative review/);assert.match(demo,/did not authenticate a reviewer or run these checks/);
 assert.ok(!demo.includes('No independent reviewer is configured'));
 f.context.demo=false;
 const hosted=createReviewView(f.ports)().textContent;
 assert.match(hosted,/No independent reviewer is configured/);assert.ok(!hosted.includes('illustrative review'));
 f.workspace.provider='local-git';
 const local=createReviewView(f.ports)().textContent;
 assert.match(local,/Local loopback decisions are attribution/);assert.ok(!local.includes('No independent reviewer is configured'));
 assert.equal(f.calls.length,0);
});

test('review view renders structured findings and labels older prose as history',()=>{
 const f=fixture();f.workspace.provider='cloudflare-artifacts';f.workspace.authentication={reviewerClientIds:['reviewer'],permissions:{manage:false,review:true,merge:false}};
 f.run.codeReview={id:'assessment',at:new Date().toISOString(),format:'projects-code-review-assessment/v2',verdict:'changes_requested',
   summary:'Found a line-level issue',findings:[{id:'finding',title:'Unsafe arithmetic',body:'The sum can overflow.',priority:1,
   location:{path:'index.js',side:'head',startLine:2,endLine:2},evidence:'The checked line lacks a bound.'}],
   identity:{displayName:'Reviewer'},context:{headCommit:f.run.headCommit}};
 const structured=createReviewView(f.ports)().textContent;
 for(const phrase of ['Found a line-level issue','P1 · Unsafe arithmetic','index.js · current source · line 2','The sum can overflow.'])assert.ok(structured.includes(phrase),phrase);
 delete f.run.codeReview.format;f.run.codeReview.findings='Old prose, preserved';f.run.codeReview.summary=undefined;
 const historical=createReviewView(f.ports)().textContent;assert.ok(historical.includes('Historical prose assessment: Old prose, preserved'));
});

test('review context download is an observed action restricted to the owner or assigned reviewer',async()=>{
  const f=fixture();f.workspace.provider='cloudflare-artifacts';
  f.workspace.authentication={principal:{kind:'owner',id:'owner'},permissions:{manage:true,review:true},agentClientIds:['builder'],reviewerClientIds:['reviewer']};
  f.run.evidence={verified:true,source:'independent-sandbox-checks',commit:f.run.headCommit,taskRevision:1,passed:1,total:1,exitCode:0,checks:[{name:'check',passed:true}]};
  const nodes=node=>[node,...node.children.flatMap(nodes)];
  const control=()=>nodes(createReviewView(f.ports)()).find(node=>node.tagName==='BUTTON'&&node.textContent==='Download read-only review context');
  await control().dispatch('click');assert.deepEqual(f.calls,[['review-context',f.run.id]]);
  f.context.busy=true;assert.equal(control().disabled,true);f.context.busy=false;
  f.workspace.authentication.permissions={manage:false,review:false};f.workspace.authentication.principal={kind:'agent',id:'builder'};
  assert.equal(control(),undefined);
  f.workspace.authentication.principal={kind:'reviewer',id:'reviewer'};f.run.reviewAssignments=[{id:'assignment',reviewerIds:['other']}];
  assert.equal(control(),undefined);f.run.reviewAssignments[0].reviewerIds=['reviewer'];assert.ok(control());
});
test('an earlier open finding is labeled as historical after a newer resolution',()=>{
 const f=fixture();f.workspace.provider='cloudflare-artifacts';f.workspace.authentication={agentClientIds:[],reviewerClientIds:['reviewer'],permissions:{manage:true,review:true,merge:true},principal:{kind:'owner'}};
 const old={id:'older',at:new Date().toISOString(),format:'projects-code-review-assessment/v2',verdict:'changes_requested',summary:'Earlier issue',
   unresolvedFindingIds:['finding'],findings:[{id:'finding',title:'Unsafe total',body:'The sum can overflow.',priority:1,
     location:{path:'index.js',side:'head',startLine:1,endLine:1},evidence:'Earlier source line.'}],
   identity:{displayName:'Reviewer'},context:{headCommit:f.run.headCommit}};
 f.run.codeReviewHistory=[old];f.run.codeReview={...old,id:'newer',verdict:'pass',summary:'Rechecked the source',findings:[],
   unresolvedFindingIds:[],resolvedPriorFindingIds:['finding']};
 const text=createReviewView(f.ports)().textContent;
 assert.ok(text.includes('1 earlier blocking finding explicitly resolved in this assessment.'));
 assert.ok(text.includes('1 blocking finding remained open after this assessment.'));
 assert.ok(!text.includes('remain open across revisions'));
});

test('all four page modules render selected project work without leaking another project',()=>{
  const f=fixture();
  for(const [name,create] of Object.entries({overview:ports=>createTaskViews(ports).task,work:createWorkView,review:createReviewView,evidence:createEvidenceView})){
    f.context.view=name;
    const text=create(f.ports)().textContent;
    assert.match(text,name==='overview'?/Task brief/:/Selected candidate/);assert.ok(!text.includes('Foreign work'),name);assert.ok(!text.includes('Foreign candidate'),name);
  }
});

test('task details define the work while candidate warnings and exact-result inspection remain reachable',async()=>{
 const f=fixture(),nodes=node=>[node,...node.children.flatMap(nodes)];
 f.task.revision=2;f.run.evidence={taskRevision:1,commit:f.run.headCommit,passed:0,total:2,checks:[],exitCode:1};
 f.workspace.coordination={[f.run.id]:{overlaps:[{runId:'other',paths:['index.js']}],acceptance:[{met:false,message:'Current independent checks are required'}]}};
 const retained=structuredClone(f.workspace),brief=createTaskViews(f.ports).task();
 assert.match(brief.textContent,/Task brief/);assert.match(brief.textContent,/1 candidate/);assert.ok(!brief.textContent.includes('Selected candidate'));
 await nodes(brief).find(node=>node.tagName==='BUTTON'&&node.textContent==='Open candidates →').dispatch('click');
 assert.deepEqual(f.calls,[['work',f.task.id,null]]);
 const candidates=createWorkView(f.ports)();
 for(const phrase of ['Selected candidate','report covers r1','Current requirements are r2','Shared files','index.js','Before acceptance · 1 unmet','Current independent checks are required'])assert.ok(candidates.textContent.includes(phrase),phrase);
 await nodes(candidates).find(node=>node.tagName==='BUTTON'&&node.textContent==='Inspect candidate ↗').dispatch('click');
 assert.deepEqual(f.calls[1],['review',f.task.id,f.run.id]);assert.deepEqual(f.workspace,retained);
 f.run.status='running';f.run.assignedRevision=1;
 assert.match(createWorkView(f.ports)().textContent,/Send the updated requirements through your agent conversation/);
 f.run.status='assigned';assert.match(createWorkView(f.ports)().textContent,/This assignment cannot start under revised requirements/);
});

test('project history exposes recorded filenames and opens the exact candidate changes without a mutation',async()=>{
  const f=fixture(),project=f.ports.currentProject(),before=structuredClone(f.workspace);
  f.context.view='history';
 const page=createEvidenceView(f.ports)();
  const section=page.querySelector('#retained-heading').parentElement.parentElement;
  assert.equal(section.querySelector('strong').textContent,project.name);
  assert.match(section.textContent,/1 changed file/);
  assert.equal(section.querySelector('code').textContent,'index.js');
  assert.match(section.textContent,/does not cover file contents or every file/);
  const nodes=node=>[node,...node.children.flatMap(nodes)];
  const link=nodes(section).find(node=>node.tagName==='A'&&node.textContent==='View changes');
  assert.ok(link.attrs.href.includes('task='+f.task.id));
  assert.ok(link.attrs.href.includes('candidate='+f.run.id));
  assert.ok(link.attrs.href.endsWith('#candidate-changes'));
  await link.dispatch('click',{button:0,ctrlKey:true});assert.equal(f.calls.length,0);
  await link.dispatch('click',{button:0});
  assert.deepEqual(f.calls,[['review',f.task.id,f.run.id,{section:'candidate-changes'}]]);
  assert.deepEqual(f.workspace,before);
});

test('historical indexed matches do not present current filenames as files from the older commit',()=>{
  const f=fixture(),project=f.ports.currentProject();
  f.workspace.capabilities.retainedSearch=true;f.run.changedFiles=['current-only.js'];
  f.ports.retainedSearches.set(project.id,{draft:'older',query:'older',mode:'literal',limit:10,loading:false,error:'',request:0,
    remote:{total:2,matched:1,mode:'literal',query:'older',nextOffset:null,items:[{
      workspaceId:f.workspace.id,projectId:project.id,taskId:f.task.id,runId:f.run.id,
      headCommit:'c'.repeat(40),taskRevision:f.task.revision,text:'Older recorded change'}]}});
  f.context.view='history';
  const section=createEvidenceView(f.ports)().querySelector('#retained-heading').parentElement.parentElement;
  assert.match(section.textContent,/This match is an earlier revision/);
  assert.ok(!section.textContent.includes('current-only.js'));
  assert.match(section.textContent,/1 shown · 1 matching \/ 2 indexed records/);
  assert.equal(f.calls.length,0);
});

test('a task brief does not advertise uncommitted draft paths as recorded candidate files',()=>{
  const f=fixture();f.run.headCommit=null;f.run.changedFiles=['uncommitted-draft.js'];
  f.context.view='history';
  const section=createEvidenceView(f.ports)().querySelector('#retained-heading').parentElement.parentElement;
  assert.match(section.textContent,/Task brief · no committed candidate/);
  assert.ok(!section.textContent.includes('uncommitted-draft.js'));
  assert.equal(section.querySelector('code'),null);
});

test('shared verification shows pending and stale evidence without presenting it as current passing proof',()=>{
  const f=fixture();f.task.revision=2;
  f.run.evidence={commit:f.run.headCommit,taskRevision:1,verified:true,source:'independent-local-checks',checks:[{name:'Old check',passed:true,detail:'Earlier result'}],passed:1,total:1};
  f.run.verificationPending=true;
  const text=f.ports.parts.evidenceChecks(f.run).textContent;
  assert.match(text,/Independent checks are running/);assert.match(text,/REPORTED PASSING · UNVERIFIED/);
  assert.ok(!text.includes('CHECKS PASSING · INDEPENDENT'));
});

test('shared candidate navigation uses the current view and selection when activated',async()=>{
  const f=fixture();f.workspace.runs.push({...f.run,id:crypto.randomUUID(),label:'Another result'});
  const nav=f.ports.parts.candidateNav(f.task),button=nav.children[2];
  f.context.view='evidence';f.context.selectedRun='different';await button.dispatch('click');
  assert.deepEqual(f.calls,[['work',f.task.id,null]]);
});

test('one task change preserves its identity and continuation without a redundant selection button',async()=>{
  const f=fixture();let continued=0;
  const action=el('button',{onclick:()=>continued++},'Continue in your agent');
  const nav=f.ports.parts.candidateNav(f.task,action);
  assert.equal(nav.attrs['aria-label'],'Selected candidate');
  assert.match(nav.textContent,/CANDIDATE 1 OF 1/);
  assert.match(nav.textContent,/Selected candidate/);
  assert.equal(nav.querySelector('button'),action);
  await action.dispatch('click');assert.equal(continued,1);assert.equal(f.calls.length,0);
});

test('zero and single-result work stays task-first while retained failures remain in multiple-result totals',async()=>{
  const f=fixture(),nodes=node=>[node,...node.children.flatMap(nodes)];let progress;
  f.ports.openInspector=(title,body)=>{assert.equal(title,'Task progress');progress=body;};
  let view=createWorkView(f.ports)();
  assert.match(view.textContent,/1 total candidates/);
  assert.ok(!view.textContent.includes('Alternative candidates'));
  f.workspace.runs.push({...f.run,id:crypto.randomUUID(),label:'Failed earlier attempt',status:'failed',headCommit:null,error:'Retained preparation failure'});
  view=createWorkView(f.ports)();
  assert.match(view.textContent,/2 total candidates/);
  assert.match(view.textContent,/Failed earlier attempt/);
  await nodes(view).find(node=>node.tagName==='BUTTON'&&node.textContent==='Task progress').dispatch('click');
  assert.match(progress.textContent,/1 \/ 2 candidates have commits/);
  f.workspace.runs=f.workspace.runs.filter(run=>run.taskId!==f.task.id);
  view=createWorkView(f.ports)();
  assert.match(view.textContent,/0 total candidates/);
  assert.match(view.textContent,/Start with one checkout/);
});

test('review section links select content, update the fragment and focus the chosen panel without requesting work',async()=>{
  const f=fixture(),locations=[],sections=[];location.hash='#candidate-changes';
  f.ports.onSectionChange=id=>sections.push({id,fragment:locations.at(-1)});
  f.ports.reviewPanel=()=>el('section',{id:'review-decision',tabindex:'-1'},'Decision controls');
  const previousHistory=globalThis.history;
  globalThis.history={state:null,replaceState:(_state,_title,fragment)=>locations.push(fragment)};
  try {
    const page=createReviewView(f.ports)();
    const nav=page.children.find(node=>node.attrs?.['aria-label']==='Review sections');
    const grid=page.children.find(node=>node.className==='review-grid');
    assert.equal(grid.attrs['data-active-section'],'candidate-changes');
    await nav.children[3].dispatch('click');
    assert.equal(grid.attrs['data-active-section'],'review-decision');
    assert.equal(nav.children[3].attrs['aria-current'],'location');
    assert.equal(nav.children[0].attrs['aria-current'],undefined);
    assert.equal(document.activeElement.id,'review-decision');
    assert.deepEqual(locations,['#review-decision']);assert.equal(f.calls.length,0);
    assert.deepEqual(sections,[{id:'review-decision',fragment:'#review-decision'}]);
  } finally {
    if(previousHistory===undefined)delete globalThis.history;else globalThis.history=previousHistory;
  }
});
