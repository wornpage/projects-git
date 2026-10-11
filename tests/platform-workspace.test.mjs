import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createProjectsView} from '../public/ui/views/projects.js';
import {createTaskViews} from '../public/ui/views/queue.js';
import {projectCoordinationView} from '../public/ui/project-coordination.js';
import {createWorkbenchParts} from '../public/ui/workbench-parts.js';
import {el} from '../public/ui/dom.js';
import {projectBrief,readLocation,locationSearch} from '../public/workbench-state.js';
import {createWorkspace,createTask,assignRun,startRun} from '../src/core/workflow.mjs';

function fixture() {
  installFakeDOM();const workspace=createWorkspace({name:'UI QA'});
  const project={id:crypto.randomUUID(),name:'Customer portal',acceptingWork:true,mainCommit:'a'.repeat(40),defaultBranch:'main'};
  const other={...project,id:crypto.randomUUID(),name:'Other project',acceptingWork:false};
  workspace.projects={[project.id]:project,[other.id]:other};
  function add(owner,title){const task=createTask(workspace,{title,purpose:'Deliver agreed behavior',criteria:['Observable result'],owner:'Owner',baseCommit:owner.mainCommit});task.projectId=owner.id;task.origin='connected-git';return task;}
  const task=add(project,'Current task'),merged=add(project,'Integrated task');merged.mergedCommit='b'.repeat(40);merged.status='merged';
  add(other,'Other queue');const run=assignRun(workspace,task.id,{agent:'external',label:'Running candidate',branch:'newwork/test'});startRun(workspace,run.id);
  const calls=[],ports={getContext:()=>({workspace,busy:false,view:'overview',selectedRun:run.id}),getProjectSelection:()=>null,selectProject:id=>calls.push(['project',id]),switchView:(...args)=>calls.push(['view',...args]),openTaskComposer:source=>calls.push(['composer',source]),
    currentProject:()=>project,currentTask:()=>task,currentRun:()=>run,taskRuns:id=>workspace.runs.filter(run=>run.taskId===id),taskNumber:task=>workspace.tasks.indexOf(task)+1,taskLabel:task=>task.title,
    tasksInProject:project=>workspace.tasks.filter(task=>task.projectId===project.id),disclosure:(id,title,...body)=>el('details',{id},el('summary',{},title),...body),
    showError(){},announce(){},independentlyVerified:()=>false,checksFailed:()=>false,openRevision(){}};
  ports.parts=createWorkbenchParts(ports);
  return {workspace,project,other,task,run,calls,ports};
}
function nodes(root){return [root,...(root.children??[]).flatMap(nodes)];}

function queuedFixture() {
  const f=fixture();f.workspace.runs=[];
  const ready=createTask(f.workspace,{title:'Ready task',purpose:'Work that can start',criteria:['Observable result'],owner:'Owner',baseCommit:f.project.mainCommit});
  Object.assign(ready,{projectId:f.project.id,origin:'connected-git',dependsOn:[]});
  f.task.dependsOn=[ready.id];
  return {...f,ready};
}

test('project-card-next opens ready queued work ahead of a stored-first blocked task without hiding waiting counts',async()=>{
  const f=queuedFixture(),before=JSON.stringify(f.workspace);
  const card=nodes(createProjectsView(f.ports)()).find(node=>node.className==='project-card');
  const next=nodes(card).find(node=>node.className==='project-card-next');
  const link=nodes(next).find(node=>node.tagName==='A');
  assert.equal(readLocation(link.attrs.href).taskId,f.ready.id,'Ready queued work must precede the older blocked task.');
  assert.match(next.textContent,/Ready task/);assert.match(next.textContent,/View queued task/);
  assert.match(card.textContent,/Waiting1 \/ 3/);assert.match(card.textContent,/Ready to claim1 \/ 3/);
  assert.equal(JSON.stringify(f.workspace),before);assert.deepEqual(f.calls,[]);
  await link.dispatch('click');assert.deepEqual(f.calls,[['view','work',f.ready.id,null]]);
  f.ready.mergedCommit='c'.repeat(40);f.ready.status='merged';
  const brief=projectBrief(f.workspace,f.project.id);
  assert.equal(brief.next.taskId,f.task.id);assert.equal(brief.waiting,0);assert.equal(brief.eligibleQueued,1);assert.equal(brief.total,3);
});

test('all-waiting project queues retain an inspectable next task and admission/code gates keep their counts',()=>{
  const f=queuedFixture();f.ready.dependsOn=[crypto.randomUUID()];
  let brief=projectBrief(f.workspace,f.project.id);
  assert.equal(brief.next.taskId,f.task.id);assert.equal(brief.next.action,'Inspect prerequisites');
  assert.equal(brief.waiting,2);assert.equal(brief.eligibleQueued,0);assert.equal(brief.total,3);
  f.ready.dependsOn=[];
  for(const field of ['acceptingWork','codeConnected']){
    f.project[field]=false;brief=projectBrief(f.workspace,f.project.id);
    assert.equal(brief.next.taskId,f.task.id);assert.equal(brief.waiting,2);assert.equal(brief.eligibleQueued,0);
    f.project[field]=true;
  }
  assert.equal(projectBrief(f.workspace,f.project.id).next.taskId,f.ready.id);
});

test('workspace directory uses shared project counts and next actions without writing source state',()=>{
  const f=fixture(),before=JSON.stringify(f.workspace),view=createProjectsView(f.ports)(),cards=nodes(view).filter(node=>node.className==='project-card');
  assert.equal(cards.length,2);const first=cards[0].textContent,brief=projectBrief(f.workspace,f.project.id);
  assert.match(first,/Customer portal/);assert.match(first,/Admission on/);assert.match(first,new RegExp('Active tasks'+brief.active+' / '+brief.total));
  assert.match(first,/Follow agent work/);assert.match(cards[1].textContent,/Admission paused/);
  assert.equal(JSON.stringify(f.workspace),before);assert.deepEqual(f.calls,[]);
});

test('directory links use exact task identities and modified clicks retain native navigation',async()=>{
  const f=fixture(),view=createProjectsView(f.ports)(),all=nodes(view);
  const next=all.find(node=>node.tagName==='A'&&node.textContent==='Follow agent work →');
  const place=readLocation(next.attrs.href),selected=projectBrief(f.workspace,f.project.id).next;
  assert.equal(place.taskId,f.task.id);assert.equal(place.view,'work');assert.equal(place.runId,selected.runId??null);
  await next.dispatch('click',{ctrlKey:true});assert.deepEqual(f.calls,[]);
  await next.dispatch('click');assert.deepEqual(f.calls,[['view','work',f.task.id,selected.runId??null]]);
  await all.find(node=>node.tagName==='BUTTON'&&node.textContent==='+ New project').dispatch('click');
  assert.deepEqual(f.calls.at(-1),['composer','repository']);
});

test('workspace URLs clear task context while project URLs preserve task and candidate',()=>{
  assert.deepEqual(readLocation(locationSearch('projects','previous-task','previous-run')),{view:'projects',projectId:null,taskId:null,runId:null});
  assert.deepEqual(readLocation('?view=projects&task=previous-task&candidate=previous-run'),{view:'projects',projectId:null,taskId:null,runId:null});
  for(const view of ['overview','work','review','evidence'])assert.deepEqual(readLocation(locationSearch(view,'task','run')),{view,projectId:null,taskId:'task',runId:['review','evidence'].includes(view)?'run':null});
});

test('project directory opens a project collection without silently restoring a task',()=>{
 const f=fixture();const view=createProjectsView(f.ports)(),anchors=nodes(view).filter(node=>node.tagName==='A');
 const place=readLocation(anchors.find(node=>node.textContent===f.project.name).attrs.href);
 assert.equal(place.projectId,f.project.id);assert.equal(place.view,'queue');assert.equal(place.taskId,null);assert.equal(place.runId,null);
});

test('task collection includes ongoing and integrated work with the unchanged project denominator',()=>{
 const f=fixture(),view=projectCoordinationView({workspace:f.workspace,projectId:f.project.id,onOpenTask(){}}),text=view.textContent;
 assert.match(text,/Showing all 2 tasks/);assert.ok(text.includes('Current task'));assert.ok(text.includes('Integrated task'));assert.ok(!text.includes('Other queue'));
});

test('shared task context exposes direct task selection and current requirement identity',()=>{
  const f=fixture(),header=f.ports.parts.taskHeader(f.task),text=header.textContent;
  assert.match(text,/Requirements r1/);assert.match(text,/Coordinator · Owner/);assert.match(text,/1 retained candidate/);assert.match(text,/Read task brief/);
  assert.ok(!nodes(header).some(node=>node.tagName==='DETAILS'),'Primary context has no accordion');
});

test('loaded project summaries show occupied workspace slots even when all active work is off page',async()=>{
  const f=fixture();f.workspace.runs=[];f.workspace.page={totalProjects:100};
  f.workspace.capacity={limit:4,occupied:4,running:2,reserved:2,queued:3};
  let shown;f.ports.openInspector=(title,...body)=>{shown={title,body};};
  const view=createTaskViews(f.ports).queue();
  await nodes(view).find(node=>node.tagName==='BUTTON'&&node.textContent==='Loaded project summary').dispatch('click');
  assert.equal(shown.title,'Loaded project summary');
  const tiles=shown.body.flatMap(nodes).filter(node=>node.className==='metric-card');
  assert.match(tiles[0].textContent,/Workspace execution slots/);assert.match(tiles[0].textContent,/4\/ 4/);
  assert.match(tiles[0].textContent,/2 running · 2 reserved · 3 waiting across all projects/);
});
