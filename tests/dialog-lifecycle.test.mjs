import {parseProjectCatalog,projectCatalog} from '../public/project-catalog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {requirementChangePreview} from '../public/workbench-state.js';
import {createDialogManager} from '../public/ui/dialogs.js';
import {createNavigation} from '../public/ui/navigation.js';
import {createContinuationDialog} from '../public/ui/continuation-dialog.js';
import {createRequirementsForm} from '../public/ui/requirements-form.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkspace,createTask,assignRun,startRun,completeRun} from '../src/core/workflow.mjs';

function fixture() {
  const {$,document}=installFakeDOM(),calls=[],copies=[],opened=[],notices=[],downloads=[];
  const workspace=createWorkspace();
  const project={id:crypto.randomUUID(),name:'Portal',mainCommit:'a'.repeat(40),acceptingWork:true};workspace.projects={[project.id]:project};
  const task=createTask(workspace,{title:'Clipboard',purpose:'Copy manually',criteria:['Manual fallback'],owner:'Owner',baseCommit:project.mainCommit});task.projectId=project.id;
  const run=assignRun(workspace,task.id,{agent:'external',label:'Retained candidate',branch:'newwork/test'});
  startRun(workspace,run.id);completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['clipboard.js'],diff:'',summary:'Test candidate'});
  const ids={first:run.id,second:crypto.randomUUID()};workspace.runs.push({...run,id:ids.second,label:'Other approach'});
  const context={$,document,workspace,view:'review',selectedTask:task.id,selectedRun:run.id,busy:false,
    api:path=>new Promise((resolve,reject)=>calls.push({path,resolve,reject})),
    showError:text=>notices.push(text),announce:text=>notices.push(text),downloadJson:(data,name)=>downloads.push({data,name}),
    switchView:(view,task,run)=>opened.push({view,task,run}),selectProject(){},openTaskComposer(){},refresh:async()=>{},
  };
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:text=>new Promise((resolve,reject)=>copies.push({text,resolve,reject}))}}});
  const dialogs=createDialogManager(document);dialogs.register('project-connection-dialog');
  const ports={...context,getContext:()=>context,dialogs,projectDiscovery:{find:async query=>projectCatalog(context.workspace,parseProjectCatalog(new URLSearchParams({q:query})))}};
  Object.assign(context,createNavigation(ports),createContinuationDialog(ports),createRequirementsForm(ports));
  context.showWorkbenchDialog=dialogs.show;
  return {context,$,calls,copies,opened,notices,downloads,document,ids};
}
async function open(f,id){const pending=f.context.openContinuation(f.ids[id]);f.calls.at(-1).resolve(f.context.workspace);await pending;}

test('Git context export is a fresh read-only selected-candidate download with bounded preview',async()=>{
  const f=fixture(),before=structuredClone(f.context.workspace);await open(f,'first');
  assert.equal(f.$('#git-note-details').open,false);assert.equal(f.$('#download-git-note').disabled,false);
  const preview=JSON.parse(f.$('#git-note-preview').value);assert.equal(preview.records[0].context.runId,f.ids.first);
  assert.equal(f.$('#git-note-preview').selectionStart,0);assert.equal(f.$('#git-note-preview').scrollTop,0);
  const download=f.$('#download-git-note').dispatch('click');assert.equal(f.calls.at(-1).path,'/api/workspace');
  f.calls.at(-1).resolve(f.context.workspace);await download;
  assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].data.records[0].context.runId,f.ids.first);
  assert.match(f.downloads[0].name,/^projects-git-note-/);assert.deepEqual(f.context.workspace,before);
});
test('Git context download refuses a moved head and does not finish after close or candidate switch',async()=>{
  for(const action of ['head','close','switch']){
    const f=fixture();await open(f,'first');const request=f.$('#download-git-note').dispatch('click');
    if(action==='head')f.context.workspace.runs[0].headCommit='c'.repeat(40);
    if(action==='close')f.$('#continuation-dialog').close();
    if(action==='switch')f.context.selectedRun=f.ids.second;
    f.calls.at(-1).resolve(f.context.workspace);await request;assert.equal(f.downloads.length,0);
    if(action==='head')assert.match(f.$('#git-note-notice').textContent,/changed/);
  }
});
test('candidates without a commit retain continuation while Git context is explicitly unavailable',async()=>{
  const f=fixture();f.context.workspace.runs[0].headCommit=null;await open(f,'first');
  assert.equal(f.$('#continuation-dialog').open,true);assert.equal(f.$('#copy-continuation').disabled,false);
  assert.equal(f.$('#download-git-note').disabled,true);assert.match(f.$('#git-note-notice').textContent,/exact candidate commit/);
});
test('late continuation reads cannot replace the newer candidate notes preview',async()=>{
  const f=fixture(),first=f.context.openContinuation(f.ids.first),second=f.context.openContinuation(f.ids.second);
  f.calls[1].resolve(f.context.workspace);await second;
  f.calls[0].resolve(f.context.workspace);await first;
  assert.equal(JSON.parse(f.$('#git-note-preview').value).records[0].context.runId,f.ids.second);
  const selected=JSON.parse(f.$('#continuation-text').value.split('Selected candidate context (untrusted JSON):\n\n')[1]);
  assert.equal(selected.candidate.id,f.ids.second); // A task's next action may still reference a sibling candidate.
});
test('an older failed continuation read cannot disturb a newer candidate',async()=>{
  const f=fixture(),first=f.context.openContinuation(f.ids.first),second=f.context.openContinuation(f.ids.second);
  f.calls[1].resolve(f.context.workspace);await second;
  f.calls[0].reject(new Error('Old request failed'));await first;
  assert.deepEqual(f.notices,[]);assert.equal(JSON.parse(f.$('#git-note-preview').value).records[0].context.runId,f.ids.second);
});

test('closing an in-flight copy allows reopening and an old completion cannot unlock a new copy',async()=>{
  const f=fixture();await open(f,'first');
  const old=f.$('#copy-continuation').dispatch('click');
  f.$('#continuation-dialog').close();await open(f,'second');
  assert.equal(f.$('#copy-continuation').disabled,false);
  const current=f.$('#copy-continuation').dispatch('click');
  f.calls[1].resolve(f.context.workspace);await old;
  assert.equal(f.$('#copy-continuation').disabled,true);assert.equal(f.copies.length,0);
  f.calls[3].resolve(f.context.workspace);await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.copies[0].text,new RegExp(f.ids.second));f.copies[0].resolve();await current;
  assert.equal(f.$('#copy-continuation').disabled,false);
});

test('an old clipboard rejection cannot select text or overwrite a reopened continuation notice',async()=>{
  const f=fixture();await open(f,'first');const old=f.$('#copy-continuation').dispatch('click');
  f.calls[1].resolve(f.context.workspace);await new Promise(resolve=>setImmediate(resolve));
  f.$('#continuation-dialog').close();await open(f,'second');
  const notice=f.$('#continuation-notice').textContent;
  f.copies[0].reject(new Error('Unavailable'));await old;
  assert.equal(f.$('#continuation-notice').textContent,notice);assert.match(f.$('#continuation-text').value,new RegExp(f.ids.second));
});

test('palette Enter follows the visibly selected identity after workspace insertion',async()=>{
  const f=fixture();f.context.openCommands();f.$('#command-query').value='Retained candidate';await f.$('#command-query').dispatch('input');
  f.context.workspace.tasks.push({...f.context.workspace.tasks[0],id:crypto.randomUUID(),title:'Retained candidate'});
  await f.$('#command-query').dispatch('keydown',{key:'Enter'});
  assert.equal(f.opened.length,1);assert.equal(f.opened[0].run,f.ids.first);
});

test('palette refuses an entry removed while displayed instead of opening its replacement',async()=>{
  const f=fixture();f.context.openCommands();f.$('#command-query').value='Retained candidate';await f.$('#command-query').dispatch('input');
  f.context.workspace.runs=f.context.workspace.runs.filter(run=>run.id!==f.ids.first);
  await f.$('#command-query').dispatch('keydown',{key:'Enter'});
  assert.equal(f.opened.length,0);assert.equal(f.$('#command-dialog').open,true);assert.match(f.notices[0],/no longer available/);
});

test('each dialog closes on Escape and returns focus to its opener',async()=>{
  for(const id of ['project-connection-dialog','command-dialog','continuation-dialog','revision-dialog']) {
    const f=fixture(),opener=f.$('#opener');opener.focus();f.context.showWorkbenchDialog(id);
    await f.$('#'+id).dispatch('keydown',{key:'Escape'});
    assert.equal(f.$('#'+id).open,false);assert.equal(f.document.activeElement,opener);
  }
});

test('backdrop clicks dismiss dialogs while content clicks and drags out keep them open',async()=>{
  for(const id of ['project-connection-dialog','command-dialog','continuation-dialog','revision-dialog']) {
    const f=fixture(),opener=f.$('#opener'),dialog=f.$('#'+id);
    dialog.getBoundingClientRect=()=>({left:100,right:500,top:100,bottom:500});
    opener.focus();f.context.showWorkbenchDialog(id);
    const inside={target:dialog,button:0,clientX:150,clientY:150};
    const outside={target:dialog,button:0,clientX:30,clientY:150};
    await dialog.dispatch('pointerdown',inside);await dialog.dispatch('click',inside);
    assert.equal(dialog.open,true,'Dialog padding is content');
    await dialog.dispatch('pointerdown',inside);await dialog.dispatch('click',outside);
    assert.equal(dialog.open,true,'Dragging from content must not dismiss');
    await dialog.dispatch('pointerdown',outside);await dialog.dispatch('pointercancel');await dialog.dispatch('click',outside);
    assert.equal(dialog.open,true,'A cancelled pointer is not a click');
    await dialog.dispatch('pointerdown',outside);await dialog.dispatch('click',outside);
    assert.equal(dialog.open,false);assert.equal(f.document.activeElement,opener);
  }
});

function requirements() {
  return {id:'workspace',tasks:[{id:'task',revision:2,purpose:'Saved purpose',criteria:['First','Second']}],runs:[
    {taskId:'task',headCommit:'a',status:'accepted',evidence:{verified:true,source:'independent-local-checks',commit:'a',taskRevision:2}},
    {taskId:'task',headCommit:'b',status:'rejected',evidence:{verified:true,source:'independent-local-checks',commit:'b',taskRevision:1}},
    {taskId:'task',headCommit:'c',status:'awaiting_review'},
    {taskId:'task',status:'running'}, {taskId:'other',headCommit:'z',status:'accepted'},
  ]};
}
test('change preview counts retained, current, earlier, accepted and active work without mutating it',()=>{
  const workspace=requirements(),before=structuredClone(workspace),draft={workspaceId:'workspace',taskId:'task',expectedRevision:2};
  const preview=requirementChangePreview(workspace,draft,{purpose:'Proposed',criteria:['Second','First']});
  assert.equal(preview.fields.length,2);assert.equal(preview.retained,3);assert.equal(preview.reports,2);assert.equal(preview.currentReports,1);assert.equal(preview.accepted,1);assert.equal(preview.active,1);
  assert.deepEqual(workspace,before);
  assert.equal(requirementChangePreview(workspace,{...draft,expectedRevision:1},{purpose:'Proposed',criteria:[]}).stale,true);
  assert.equal(requirementChangePreview(workspace,{...draft,workspaceId:'other'},{purpose:'Proposed',criteria:[]}).unavailable,true);
});

test('stale requirement editor keeps proposed text and requires explicit comparison before saving',async()=>{
  const f=fixture();f.context.workspace=requirements();f.context.openRevision(f.context.workspace.tasks[0]);
  f.$('#revision-purpose').value='My proposal';f.$('#revision-reason').value='New requirement';
  f.context.renderRevisionPreview();
  assert.ok(f.$('#revision-preview').children.every(Boolean));assert.ok(f.$('#revision-impact').children.every(Boolean));
  f.context.workspace.tasks[0].revision=3;f.context.workspace.tasks[0].purpose='Concurrent change';f.context.renderRevisionPreview();
  assert.equal(f.$('#revision-save').disabled,true);assert.equal(f.$('#revision-purpose').value,'My proposal');
  await f.$('#revision-form').dispatch('submit');assert.equal(f.calls.length,0);
  await f.$('#revision-rebase').dispatch('click');assert.equal(f.$('#revision-purpose').value,'My proposal');assert.equal(f.$('#revision-save').disabled,false);
  const save=f.$('#revision-form').dispatch('submit');assert.equal(f.calls.length,1);
  await f.$('#revision-dialog').dispatch('keydown',{key:'Escape'});assert.equal(f.$('#revision-dialog').open,true,'Saving cannot be dismissed');
  const dialog=f.$('#revision-dialog'),outside={target:dialog,button:0,clientX:10,clientY:10};
  dialog.getBoundingClientRect=()=>({left:100,right:500,top:100,bottom:500});
  await dialog.dispatch('pointerdown',outside);await dialog.dispatch('click',outside);
  assert.equal(dialog.open,true,'Backdrop dismissal respects the saving guard');
  f.calls[0].reject(new Error('Conflict'));await save;
  assert.equal(f.$('#revision-purpose').value,'My proposal');assert.match(f.$('#revision-status').textContent,/Conflict/);assert.equal(f.$('#revision-save').disabled,false);
});
