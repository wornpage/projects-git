import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace,createTask,assignRun,startRun,completeRun} from '../src/core/workflow.mjs';
import {projectCoordination} from '../public/project-coordination.js';
import {projectCoordinationView} from '../public/ui/project-coordination.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkView} from '../public/ui/views/work.js';
import {el} from '../public/ui/dom.js';

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

test('board actions navigate by exact identities without mutations and shared paths do not claim conflicts',async()=>{
 installFakeDOM();const f=fixture(),calls=[];
 f.workspace.coordination[f.run.id].overlaps=[{runId:'other-run',headCommit:'d'.repeat(40),paths:['checkout.py']}];
 const view=projectCoordinationView({workspace:f.workspace,projectId:f.project.id,onOpenTask:id=>calls.push(['task',id]),onOpenRun:id=>calls.push(['run',id])});
 assert.match(view.textContent,/4 \/ 4 execution slots/);assert.match(view.textContent,/1 \/ 2 verification attempts/);
 assert.match(view.textContent,/2 running · 2 reserved · 7 model jobs waiting/);
 assert.match(view.textContent,/whole workspace/);assert.match(view.textContent,/does not prove a Git merge conflict/);
 assert.match(view.textContent,/Independent code review required/);
 const nodes=flatten(view),dependency=nodes.find(n=>n.tagName==='BUTTON'&&n.textContent==='Foundation');
 await dependency.dispatch('click');
 await nodes.find(n=>n.tagName==='BUTTON'&&n.textContent==='Inspect candidate').dispatch('click');
 assert.deepEqual(calls,[['task',f.task.id],['run',f.run.id]]);
 assert.equal(nodes.filter(n=>n.tagName==='ARTICLE').length,2);
 assert.ok(nodes.filter(n=>n.tagName==='ARTICLE').every(n=>n.attrs['aria-labelledby']));
});

test('event and registration denominators remain workspace-wide and are separate from project push observations',()=>{
 installFakeDOM();const f=fixture();
 f.workspace.artifactEvents={events:3,completed:1,pending:1,failed:1,attempts:5};
 f.workspace.artifactSubscriptions={repositories:4,ready:2,awaitingRecovery:2};
 f.run.repositoryObservation={observedAt:'2026-10-09T15:00:00Z',headCommit:'c'.repeat(40),requiresSubmission:true};
 const view=projectCoordinationView({workspace:f.workspace,projectId:f.project.id,onOpenTask(){},onOpenRun(){}});
 assert.match(view.textContent,/New push observed; authenticated submission is required/);
 assert.match(view.textContent,/Workspace events: 1 \/ 3 reconciled/);
 assert.match(view.textContent,/5 retained attempts/);
 assert.match(view.textContent,/automatic registrations: 2 \/ 4 ready/);
 assert.match(view.textContent,/Operator-configured subscriptions are outside this count/);
 assert.equal(f.run.headCommit,'b'.repeat(40),'Observation is not a submission');
});

test('paused admission and absent event observations remain explicit',()=>{
 installFakeDOM();const f=fixture();f.project.acceptingWork=false;
 const view=projectCoordinationView({workspace:f.workspace,projectId:f.project.id,onOpenTask(){},onOpenRun(){}});
 assert.match(view.textContent,/New assignments and starts are paused/);
 assert.match(view.textContent,/No repository push observation is recorded/);
 assert.match(view.textContent,/Automatic approval and merge: Off/);
 assert.ok(!view.textContent.includes('undefined'));
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
 const work=createWorkView({getContext:()=>({workspace:f.workspace,demo:true}),currentTask:()=>f.dependent,currentRun:()=>null,taskRuns:()=>[],
   repositoryAgents:()=>null,switchView(){},independentlyVerified:()=>false,openInspector(){},
   parts:{taskHeader:()=>el('div'),emptyState:(a,b)=>el('p',{},a,b),timeline:()=>el('div')}});
 const view=work();assert.match(view.textContent,/Waiting for integration/);assert.ok(!view.textContent.includes('Ready for work'));assert.ok(!view.textContent.includes('Start with one checkout'));
});
