import {createCollectionPager} from '../public/ui/collection.js';
const makePager=workspace=>createCollectionPager({getScope:()=>workspace.id,render(){}});
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun,completeRun} from '../src/core/workflow.mjs';
import {projectCoordination} from '../public/project-coordination.js';
import {projectCoordinationView,projectActivityDetails} from '../public/ui/project-coordination.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkView} from '../public/ui/views/work.js';
import {el} from '../public/ui/dom.js';
const disclosure=(id,title,...body)=>el('details',{id},el('summary',{},title),...body);

function fixture(){
 const workspace=createWorkspace();workspace.provider='cloudflare-artifacts';
 const project={id:crypto.randomUUID(),name:'Checkout',mainCommit:'a'.repeat(40),acceptingWork:true};
 workspace.projects={[project.id]:project};
 const task=createTask(workspace,{title:'Foundation',purpose:'Implement totals',criteria:['Reject invalid inputs'],owner:'Owner',baseCommit:project.mainCommit});
 Object.assign(task,{projectId:project.id,origin:'artifacts',dependsOn:[]});
 const run=assignRun(workspace,task.id,{agent:'external',label:'Builder one',branch:'agents/a'});
 startRun(workspace,run.id);completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['checkout.py','tests/test_checkout.py'],summary:'Retained implementation',diff:'retained'});
 workspace.coordination={[run.id]:{acceptance:[{met:false,message:'Independent checks are required.'}],overlaps:[]}};
 const dependent=createTask(workspace,{title:'Receipt',purpose:'Use totals',criteria:['Show total'],owner:'Owner',baseCommit:project.mainCommit});
 Object.assign(dependent,{projectId:project.id,origin:'artifacts',dependsOn:[task.id]});
 workspace.capacity={limit:4,occupied:4,running:2,reserved:2,queued:7,verification:{limit:2,occupied:1,waiting:2}};
 return {workspace,project,task,run,dependent};
}
const flatten=node=>[node,...node.children.flatMap(flatten)];

test('project cards preserve scope, prerequisites, failed evidence and every candidate denominator',()=>{
 const f=fixture(),foreign={id:crypto.randomUUID(),name:'Foreign',mainCommit:'c'.repeat(40)};
 f.workspace.projects[foreign.id]=foreign;
 const extra=createTask(f.workspace,{title:'Outside task',purpose:'Other work',criteria:['Other'],owner:'Owner',baseCommit:foreign.mainCommit});extra.projectId=foreign.id;
 let model=projectCoordination(f.workspace,f.project.id);
 assert.equal(model.totalTasks,2);assert.equal(model.totalCandidates,1);assert.ok(!JSON.stringify(model.cards).includes('Outside task'));
 assert.equal(model.cards[1].dependencies.waiting[0].id,f.task.id);
 assert.equal(model.cards[0].candidates[0].blockers[0],'Independent checks are required.');
 assert.equal(model.capacity.occupied,4);assert.equal(model.capacity.queued,7);
 f.task.mergedCommit=f.run.headCommit;f.run.status='merged';
 model=projectCoordination(f.workspace,f.project.id);
 assert.equal(model.cards[1].dependencies.waiting.length,0);assert.equal(model.cards[1].dependencies.integrated.length,1);
 assert.equal(model.totalTasks,2);assert.equal(model.totalCandidates,1);
});

test('task collection uses exact task links, includes every status and keeps candidate details out of the list',async()=>{
 installFakeDOM();const f=fixture(),calls=[],before=structuredClone(f.workspace);
 const view=projectCoordinationView({collections:makePager(f.workspace),disclosure,workspace:f.workspace,projectId:f.project.id,onOpenTask:id=>calls.push(id),onOpenCandidates:id=>calls.push(['candidates',id])});
 assert.match(view.textContent,/2 total tasks/);assert.match(view.textContent,/Workspace execution: 4 \/ 4 slots/);
 const help=view.querySelector('#task-count-help-'+f.project.id);assert.equal(help.tagName,'DETAILS');assert.equal(help.open,false);assert.match(help.textContent,/Execution capacity covers all projects/);
 const nodes=flatten(view),list=nodes.find(n=>n.tagName==='UL'&&n.attrs['aria-label']==='Tasks in this project');
 assert.equal(list.children.length,2);assert.ok(!view.textContent.includes('checkout.py'));assert.ok(!view.textContent.includes('Inspect candidate'));
 const link=nodes.find(n=>n.tagName==='A'&&n.textContent==='Foundation');
 await link.dispatch('click',{ctrlKey:true});assert.deepEqual(calls,[]);await link.dispatch('click');assert.deepEqual(calls,[f.task.id]);
 assert.equal(link.attrs.href,'?view=overview&task='+f.task.id);assert.deepEqual(f.workspace,before);
 const candidates=nodes.find(n=>n.tagName==='A'&&n.attrs['aria-label']==='1 candidate for Foundation');
 await candidates.dispatch('click',{ctrlKey:true});assert.deepEqual(calls,[f.task.id]);
 await candidates.dispatch('click');assert.deepEqual(calls,[f.task.id,['candidates',f.task.id]]);
 assert.equal(candidates.attrs.href,'?view=work&task='+f.task.id);
});

test('project operation details retain observations and separate workspace counters from project data',()=>{
 installFakeDOM();const f=fixture();
 f.workspace.artifactEvents={events:3,completed:1,pending:1,failed:1,attempts:5};
 f.workspace.artifactSubscriptions={repositories:4,ready:2,awaitingRecovery:2};
 f.run.repositoryObservation={observedAt:'2026-10-09T15:00:00Z',headCommit:'c'.repeat(40),requiresSubmission:true};
 const foreign={id:crypto.randomUUID(),name:'Foreign',mainCommit:'d'.repeat(40),repositoryObservation:{observedAt:'2026-10-11T15:00:00Z',headCommit:'d'.repeat(40)}};
 f.workspace.projects[foreign.id]=foreign;const before=structuredClone(f.workspace);
 const view=projectActivityDetails({workspace:f.workspace,projectId:f.project.id}),text=view.textContent;
 for(const value of ['4 / 4 execution slots','1 / 2 verification attempts','2 waiting for verification','cccccccccc','1 / 3 reconciled','5 retained attempts','2 / 4 ready','2 awaiting recovery','counts cover the whole workspace'])assert.ok(text.includes(value),value);
 assert.ok(!text.includes('dddddddddd'));assert.deepEqual(f.workspace,before);
});

test('queue preserves status and denominator without mixing repository event counters into the task collection',()=>{
 installFakeDOM();const f=fixture();f.project.acceptingWork=false;
 f.workspace.artifactEvents={events:3,completed:1,pending:1,failed:1,attempts:5};
 f.run.repositoryObservation={observedAt:'2026-10-09T15:00:00Z',headCommit:'c'.repeat(40),requiresSubmission:true};
 const view=projectCoordinationView({collections:makePager(f.workspace),disclosure,workspace:f.workspace,projectId:f.project.id,onOpenTask(){}});
 assert.match(view.textContent,/New assignments are paused/);assert.match(view.textContent,/New push observed/);
 assert.match(view.textContent,/2 total tasks/);assert.ok(!view.textContent.includes('undefined'));
 assert.equal(f.run.headCommit,'b'.repeat(40));
});

test('running and failed candidates without a submitted head do not present premature review requirements',()=>{
 const f=fixture();
 for(const status of ['assigned','running','failed']){
   f.run.status=status;f.run.headCommit=null;
   const model=projectCoordination(f.workspace,f.project.id);
   assert.equal(model.cards[0].candidates[0].review,null);
 }
});

test('a dependency-blocked empty work view never invites a checkout as ready',()=>{
 installFakeDOM();const f=fixture();
 const work=createWorkView({collections:makePager(f.workspace),getContext:()=>({workspace:f.workspace,demo:true}),currentTask:()=>f.dependent,currentRun:()=>null,taskRuns:()=>[],
   repositoryAgents:()=>null,switchView(){},independentlyVerified:()=>false,openInspector(){},
   parts:{taskHeader:()=>el('div'),emptyState:(a,b)=>el('p',{},a,b),timeline:()=>el('div')}});
 const view=work();assert.match(view.textContent,/Waiting for integration/);assert.ok(!view.textContent.includes('Ready for work'));assert.ok(!view.textContent.includes('Start with one checkout'));
});

test('an empty candidate view reflects paused admission or unavailable agents without offering a checkout',()=>{
 installFakeDOM();const f=fixture();f.workspace.runs=[];
 const work=createWorkView({collections:makePager(f.workspace),getContext:()=>({workspace:f.workspace,demo:true}),currentTask:()=>f.task,currentRun:()=>null,taskRuns:()=>[],
   repositoryAgents:()=>null,switchView(){},independentlyVerified:()=>false,openInspector(){},
   parts:{taskHeader:()=>el('div'),emptyState:(a,b)=>el('p',{},a,b),timeline:()=>el('div')}});
 f.project.acceptingWork=false;
 assert.match(work().textContent,/New work paused/);assert.ok(!work().textContent.includes('Ready for work'));
 f.project.acceptingWork=true;f.workspace.personalWorkspace={agentConnections:false};
 const text=work().textContent;assert.match(text,/Agents not connected/);assert.match(text,/0 total candidates/);
 assert.ok(!text.includes('Ready for work'));assert.ok(!text.includes('Start with one checkout'));
});

test('a one-task collection retains its candidate count and full task denominator',()=>{
 installFakeDOM();const f=fixture();f.workspace.tasks=[f.task];
 const text=projectCoordinationView({collections:makePager(f.workspace),disclosure,workspace:f.workspace,projectId:f.project.id,onOpenTask(){}}).textContent;
 assert.match(text,/1 retained candidate(?!s)/);assert.match(text,/1 matching \/ 1 total tasks/);
});
