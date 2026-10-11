import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {createReportList} from '../public/ui/report-list.js';
import {createTaskComposer} from '../public/ui/task-composer.js';
import {createWorkbenchParts} from '../public/ui/workbench-parts.js';
import {createWorkspace,createTask} from '../src/core/workflow.mjs';
const disclosure=(id,title,...body)=>el('details',{id},el('summary',{},title),...body);
const all=node=>[node,...(node.children??[]).flatMap(all)];

test('a single report shows its complete details without a redundant selection button',()=>{
  installFakeDOM();
  const report={commit:'b'.repeat(40),taskRevision:2,passed:3,total:3,exitCode:0,verifiedAt:'2026-10-05T20:00:00Z',source:'independent',command:'check',output:'Retained output',attemptId:'merge-attempt'};
  const entries=[{report,label:'Merge checks passed'}],before=JSON.stringify(entries);
  const panel=createReportList({id:'single',title:'Merge-attempt checks',entries,definition:'Separate reports',disclosure});
  assert.equal(all(panel).filter(node=>node.tagName==='BUTTON').length,0);
  const detail=panel.querySelector('#single-detail');
  assert.equal(detail.attrs['aria-label'],'Report details');
  for(const value of ['Merge checks passed','3 / 3',report.commit,'r2',report.verifiedAt,report.source,report.command,report.output,report.attemptId])assert.ok(detail.textContent.includes(value),value);
  assert.equal(JSON.stringify(entries),before);
});

test('a report row selects exact historical counts and provenance without nested disclosures or mutations',async()=>{
  installFakeDOM();
  const old={commit:'a'.repeat(40),taskRevision:1,passed:0,total:2,exitCode:1,verifiedAt:'2026-10-05T19:00:00Z',source:'independent',output:'Retained failure'};
  const fresh={...old,commit:'b'.repeat(40),taskRevision:2,passed:3,total:3,exitCode:0,verifiedAt:'2026-10-05T20:00:00Z',output:'Fresh result'};
  const entries=[{report:old,label:'Earlier'},{report:fresh,label:'Current'}],before=JSON.stringify(entries);
  const panel=createReportList({id:'reports',title:'Reports',entries,definition:'Separate populations',disclosure});
  const rows=all(panel).filter(node=>node.attrs?.['aria-controls']==='reports-detail');
  assert.match(document.getElementById('reports-detail').textContent,/3 \/ 3/);
  await rows[0].dispatch('click');
  const detail=document.getElementById('reports-detail');
  assert.match(detail.textContent,/0 \/ 2/);assert.ok(detail.textContent.includes(old.commit));assert.ok(!detail.textContent.includes(fresh.commit));
  assert.match(detail.textContent,/Retained failure/);assert.equal(rows[0].attrs['aria-pressed'],'true');
  for(const node of all(panel).filter(n=>n.tagName==='DETAILS'))assert.equal(all(node).filter(n=>n.tagName==='DETAILS').length,1);
  assert.equal(JSON.stringify(entries),before);
});

test('task navigation stays in its project and requests position preservation',async()=>{
  installFakeDOM();const workspace=createWorkspace('Navigation'),calls=[];
  const first=createTask(workspace,{title:'First',purpose:'Result',criteria:['One'],owner:'Owner',baseCommit:'a'.repeat(40)});
  const second=createTask(workspace,{title:'Second',purpose:'Result',criteria:['Two'],owner:'Owner',baseCommit:'a'.repeat(40)});
  const other=createTask(workspace,{title:'Foreign',purpose:'Result',criteria:['Three'],owner:'Owner',baseCommit:'a'.repeat(40)});
  first.projectId=second.projectId='one';other.projectId='two';
  const parts=createWorkbenchParts({getContext:()=>({workspace,view:'review'}),switchView:(...args)=>calls.push(args)});
  const rail=parts.taskList(first);assert.ok(!rail.textContent.includes('Foreign'));
  await all(rail).find(n=>n.id==='queue-task-'+second.id).dispatch('click');
  assert.deepEqual(calls[0],['review',second.id,null,{preservePosition:true}]);
});

test('every draft is validated even when another draft is the visible editor',()=>{
  const {$}=installFakeDOM(),errors=[];$('#task-source').value='repository';
  const tasks=[{title:'',purpose:'Result',criteria:'One',owner:'Owner'},{title:'Ready',purpose:'Result',criteria:'Two',owner:'Owner'}];
  const composer=createTaskComposer({getContext:()=>({workspace:{id:'w',tasks:[],capabilities:{}},taskStack:tasks}),saveSession(){},updateChrome(){},showError:message=>errors.push(message)});
  composer.renderTaskDrafts();assert.equal(composer.validateDrafts(),false);
  assert.match(errors[0],/task 1/);assert.equal($('#task-title-input').value,'');
  assert.equal(all($('#task-drafts')).filter(n=>n.tagName==='TEXTAREA').length,2,'Only one draft editor is mounted');
  assert.equal(all($('#task-drafts')).filter(n=>n.tagName==='DETAILS').length,0);
});

test('detached draft inputs cannot write into a replacement workspace or save its state',async()=>{
  const {$}=installFakeDOM();$('#task-source').value='repository';let saves=0;
  let context={workspace:{id:'a',tasks:[],capabilities:{}},taskStack:[{title:'Original',purpose:'Result',criteria:'One',owner:'Owner'}]};
  const composer=createTaskComposer({getContext:()=>context,saveSession:()=>saves++,updateChrome(){},showError(){}});
  composer.renderTaskDrafts();const old=$('#task-title-input');
  context={workspace:{id:'b',tasks:[],capabilities:{}},taskStack:[{title:'Replacement',purpose:'Result',criteria:'Two',owner:'Other'}]};
  composer.renderTaskDrafts();old.value='Late text';await old.dispatch('input');
  assert.equal(context.taskStack[0].title,'Replacement');assert.equal(saves,0);
});
