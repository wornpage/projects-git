import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace, createTask, assignRun, startRun, completeRun, verifyRun} from '../src/core/workflow.mjs';
import {projectAttentionBrief, taskOutcome} from '../public/workbench-state.js';
import {independentReviewBinding} from '../public/review-boundary.js';
import {createProjectsView} from '../public/ui/views/projects.js';
import {createCollectionPager} from '../public/ui/collection.js';
import {el} from '../public/ui/dom.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

function fixture() {
  const workspace=createWorkspace({name:'Catalog source fixture'});
  workspace.projects={};
  const add=(name)=>{
    const project={id:crypto.randomUUID(),name,acceptingWork:true,mainCommit:'a'.repeat(40),defaultBranch:'main'};
    workspace.projects[project.id]=project;
    const task=createTask(workspace,{title:name+' task',purpose:'Source fixture',criteria:['One observable result'],owner:'Fixture owner',baseCommit:project.mainCommit});
    Object.assign(task,{projectId:project.id,origin:'connected-git'});return {project,task};
  };
  const running=add('Active repository'),paused=add('Paused repository'),review=add('Review repository'),blocked=add('Repair repository');
  paused.project.acceptingWork=false;
  const active=assignRun(workspace,running.task.id,{agent:'external',label:'Active candidate',branch:'agent/active'});startRun(workspace,active.id);
  const submit=(entry,passed)=>{
    const run=assignRun(workspace,entry.task.id,{agent:'external',label:'Submitted candidate',branch:'agent/'+entry.project.id});startRun(workspace,run.id);
    completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['app.js'],diff:'+fixture',summary:'Source fixture'});
    verifyRun(workspace,run.id,{source:'independent-local-checks',verified:true,commit:run.headCommit,taskRevision:1,passed,total:1,
      checks:[{name:'Fixture check',passed:passed===1,detail:'Synthetic source check'}],exitCode:passed===1?0:1,command:'fixture',output:'fixture',verifiedAt:'2026-10-16T20:00:00Z'});
    return run;
  };
  review.run=submit(review,1);blocked.run=submit(blocked,0);
  return {workspace,running,paused,review,blocked};
}
const nodes=root=>[root,...(root.children??[]).flatMap(nodes)];
function renderFixture(f) {
  installFakeDOM();let current;const calls=[];
  const collections=createCollectionPager({getScope:()=>JSON.stringify([f.workspace.id,f.workspace.authentication?.principal??null]),render:()=>{current=render();}});
  const ports={getContext:()=>({workspace:f.workspace,busy:false,demo:false}),collections,disclosure:(id,title,...body)=>el('details',{id},el('summary',{},title),...body),
    selectProject:id=>calls.push(['project',id]),switchView:(...args)=>calls.push(['view',...args]),openTaskComposer:source=>calls.push(['composer',source]),
    openProjectSearch:()=>calls.push(['find']),changeProjectPage:(...args)=>calls.push(['page',...args]),createStarter:()=>calls.push(['starter'])};
  const render=createProjectsView(ports);current=render();
  return {render:()=>{current=render();return current;},view:()=>current,calls,find:id=>nodes(current).find(node=>node.id===id)};
}

test('attention projection distinguishes failed checks, manual review, active work and an intentional pause without writing state',()=>{
  const f=fixture(),before=structuredClone(f.workspace);
  const repair=projectAttentionBrief(f.workspace,f.blocked.project.id),review=projectAttentionBrief(f.workspace,f.review.project.id);
  assert.equal(repair.blocked,1);assert.equal(repair.needsAttention,true);assert.equal(repair.next.action,'Inspect failures');
  assert.equal(review.review,1);assert.equal(review.blocked,0);assert.equal(review.next.label,'Checks pass · review next');
  assert.ok(repair.priority<review.priority);
  const active=projectAttentionBrief(f.workspace,f.running.project.id),paused=projectAttentionBrief(f.workspace,f.paused.project.id);
  assert.equal(active.active,1);assert.equal(active.needsAttention,false);
  assert.equal(paused.waiting,1);assert.equal(paused.blocked,0);assert.equal(paused.needsAttention,false);
  assert.deepEqual(f.workspace,before);
});

test('stale reports, pending verification and recovery keep their existing next actions',()=>{
  const f=fixture(),entry=f.review;
  entry.task.revision=2;
  let brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.blocked,1);assert.equal(brief.review,0);assert.equal(brief.next.action,'Update checks');
  entry.run.verificationPending=true;brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.active,1);assert.equal(brief.needsAttention,false);assert.equal(brief.next.action,'Follow checks');
  entry.run.verificationPending=false;f.workspace.mergeStateByRun={[entry.run.id]:'recovery-required'};
  brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.blocked,1);assert.equal(brief.next.action,'Inspect merge recovery');
  assert.deepEqual(brief.next,{taskId:entry.task.id,title:entry.task.title,...taskOutcome(f.workspace,entry.task)});
});

test('hosted independent-review requirements remain distinct from passing checks',()=>{
  const f=fixture();f.workspace.provider='cloudflare-artifacts';
  const brief=projectAttentionBrief(f.workspace,f.review.project.id);
  assert.equal(brief.needsAttention,true);assert.equal(brief.review,1);
  assert.equal(brief.next.label,'Independent code review required');
  assert.equal(f.review.run.status,'awaiting_review');assert.equal(f.review.task.acceptedRunId,null);
});

test('blocking independent-review findings remain visible as blocked work despite passing checks',()=>{
  const f=fixture(),run=f.review.run;f.workspace.provider='cloudflare-artifacts';
  const assignment={id:crypto.randomUUID(),reviewerIds:['synthetic-reviewer']};run.reviewAssignments=[assignment];
  run.codeReview={format:'projects-code-review-assessment/v2',assignmentId:assignment.id,
    identity:{id:'synthetic-reviewer',kind:'reviewer',provider:'cloudflare-access',workspaceId:f.workspace.id},
    context:independentReviewBinding(f.workspace,run),verdict:'fail'};
  const before=structuredClone(f.workspace);let brief=projectAttentionBrief(f.workspace,f.review.project.id);
  assert.equal(brief.blocked,1);assert.equal(brief.next.label,'Independent reviewer requested changes');
  assert.deepEqual(f.workspace,before);
  run.verificationPending=true;brief=projectAttentionBrief(f.workspace,f.review.project.id);
  assert.equal(brief.needsAttention,false);assert.equal(brief.active,1);assert.equal(brief.next.action,'Follow checks');
});

test('automatic integration waiting on its scheduler is not presented as a new owner decision',()=>{
  const f=fixture(),entry=f.review;f.workspace.provider='cloudflare-artifacts';entry.run.status='accepted';entry.task.acceptedRunId=entry.run.id;
  entry.run.review={policy:{version:1,decisionId:'fixture-policy'}};entry.project.automaticMergePolicy={enabled:true,version:1};
  let brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.needsAttention,false);assert.equal(brief.review,0);assert.equal(brief.next.label,'Policy approved · merge queued');
  entry.project.automaticMergePolicy.enabled=false;brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.needsAttention,true);assert.equal(brief.blocked,1);assert.equal(brief.next.label,'Automatic merge stopped');
});

test('invalid prerequisites and unavailable code require attention, while an empty healthy project does not',()=>{
  const f=fixture(),entry=f.paused;entry.task.dependsOn=[crypto.randomUUID()];
  let brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.blocked,1);assert.equal(brief.next.action,'Inspect prerequisites');
  f.workspace.tasks=f.workspace.tasks.filter(task=>task.projectId!==entry.project.id);
  brief=projectAttentionBrief(f.workspace,entry.project.id);assert.equal(brief.total,0);assert.equal(brief.needsAttention,false);
  entry.project.codeConnected=false;brief=projectAttentionBrief(f.workspace,entry.project.id);
  assert.equal(brief.needsAttention,true);assert.equal(brief.attention,0);assert.equal(brief.blocked,0);
});

test('catalog places recovery and reviews ahead of active or paused repositories, using exact read-only navigation',async()=>{
  const f=fixture(),before=structuredClone(f.workspace),ui=renderFixture(f);
  const rows=nodes(ui.view()).filter(node=>node.className==='repository-row');
  assert.equal(rows.length,4);assert.match(rows[0].textContent,/Repair repository/);assert.match(rows[1].textContent,/Review repository/);
  const link=nodes(rows[0]).find(node=>node.tagName==='A'&&node.textContent==='Inspect failures →');
  assert.ok(link.attrs.href.includes('candidate='+f.blocked.run.id));
  await link.dispatch('click',{metaKey:true});assert.deepEqual(ui.calls,[]);
  await link.dispatch('click');assert.deepEqual(ui.calls,[['view','review',f.blocked.task.id,f.blocked.run.id]]);
  assert.deepEqual(f.workspace,before);
});

test('filters and name searches explicitly retain loaded-page denominators and use the existing global finder',async()=>{
  const f=fixture();f.workspace.page={offset:0,limit:4,totalProjects:100,nextOffset:4,previousOffset:null,revision:1};
  const ui=renderFixture(f),before=structuredClone(f.workspace);
  assert.match(ui.view().textContent,/4 loaded \/ 100 connected projects/);
  const filter=ui.find('repository-catalog-filter');filter.value='blocked';await filter.dispatch('change');
  assert.equal(nodes(ui.view()).filter(node=>node.className==='repository-row').length,1);
  assert.match(ui.view().textContent,/1 matching \/ 4 total loaded repositories/);
  const input=ui.find('repository-catalog-query');input.value='absent';await input.dispatch('input');
  assert.match(ui.view().textContent,/No loaded repositories match/);assert.match(ui.view().textContent,/0 matching \/ 4 total loaded repositories/);
  await nodes(ui.view()).find(node=>node.tagName==='BUTTON'&&node.textContent==='Find across workspace').dispatch('click');
  assert.deepEqual(ui.calls,[['find']]);assert.deepEqual(f.workspace,before);
});

test('catalog filters reset when the workspace reader identity changes and creation remains owner-only',async()=>{
  const f=fixture();f.workspace.authentication={principal:{id:'owner-one',kind:'owner'},permissions:{manage:true}};
  const ui=renderFixture(f);const input=ui.find('repository-catalog-query');input.value='absent';await input.dispatch('input');
  assert.equal(nodes(ui.view()).filter(node=>node.className==='repository-row').length,0);
  f.workspace.authentication={principal:{id:'builder-two',kind:'agent'},permissions:{manage:false}};ui.render();
  assert.equal(nodes(ui.view()).filter(node=>node.className==='repository-row').length,4);
  assert.equal(ui.find('repository-catalog-query').value,'');
  assert.ok(!nodes(ui.view()).some(node=>node.tagName==='BUTTON'&&node.textContent==='+ New project'));
  assert.deepEqual(ui.calls,[]);
});

test('empty repositories show zero tasks without a fabricated readiness ratio or agent creation controls',()=>{
  const f=fixture();f.workspace.tasks=[];f.workspace.runs=[];
  f.workspace.authentication={principal:{id:'builder',kind:'agent'},permissions:{manage:false}};
  const ui=renderFixture(f),text=ui.view().textContent;
  assert.equal(nodes(ui.view()).filter(node=>node.className==='repository-work-empty').length,4);
  assert.ok(!text.includes('0 / 0'));assert.match(text,/The owner can add the first task/);
  assert.ok(!nodes(ui.view()).some(node=>node.attrs?.label==='Add first task →'));
  assert.deepEqual(ui.calls,[]);
});
