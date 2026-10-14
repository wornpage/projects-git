import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskCreation} from '../public/ui/task-creation.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {readFileSync} from 'node:fs';

function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function fixture(saved = null) {
  const dom=installFakeDOM(), {$}=dom, calls=[], errors=[], announcements=[], savedSnapshots=[], selected=[];
  const context={workspace:{id:'workspace-a', provider:'local-git', tasks:[], runs:[], projects:{one:{id:'one',name:'First',owner:'Owner'},two:{id:'two',name:'Second',owner:'Other'}}, capabilities:{repository:true,dependencies:true}}, view:'overview',busy:false,projectId:'one'};
  $('#task-source').value='project:one';
  $('#task-execution').append(...['external','scripted','model'].map(value=>el('option',{value},value)));
  $('#task-form').querySelectorAll=()=>[...dom.nodes].filter(([key])=>key.startsWith('#task-')&&key.endsWith('-input')||/^#model-(candidates|requests|output|seconds|input)$/.test(key)||['#task-source','#task-execution'].includes(key)).map(([,value])=>value);
  let controller;
  const refresh=async()=>{if(context.refresh)await context.refresh();};
  const update=()=>controller.update();
  controller=createTaskCreation({getContext:()=>context, currentProject:()=>context.workspace.projects[context.projectId],
    selectProject:id=>{context.projectId=id;$('#task-launcher').close();}, selectTask:id=>selected.push(id), switchView:view=>{context.view=view;},
    api:(path,body,key)=>{const request=deferred();calls.push({path,body:structuredClone(body),key,...request});return request.promise;},
    refresh, render:update, updateChrome:update, schedulePoll(){}, saveSession:()=>savedSnapshots.push(controller.snapshot()),
    clearError(){}, showError:message=>errors.push(message), announce:message=>announcements.push(message)});
  controller.restore(saved); controller.update();
  async function fill(title='Improve task') {
    for(const [name,value] of Object.entries({title,purpose:' Preserve real work ',criteria:'First check\n Second check ',owner:' Owner '})) {
      const input=$('#task-'+name+'-input');input.value=value;await input.dispatch('input');
    }
  }
  return {...dom,context,controller,calls,errors,announcements,savedSnapshots,selected,fill,
    submit:()=>$('#task-form').dispatch('submit'), release:()=>$('#release-task-request').dispatch('click')};
}
const result=(projectId='one')=>{const taskId=crypto.randomUUID();return {projectId,taskId,taskIds:[taskId]};};

function repositoryFixture(saved=null) {
  const f=fixture();f.context.workspace.provider='cloudflare-artifacts';f.context.workspace.capabilities.repositoryCreate=true;
  f.controller.restore(saved);f.controller.update();f.$('#task-launcher').showModal();f.controller.activate('new-repository');f.controller.update();
  if(!saved){f.$('#repository-create-name').value='customer-portal';f.$('#repository-create-description').value='A useful project';}
  f.createRepository=()=>f.$('#create-repository').dispatch('click');
  return f;
}
function repositoryResult(f) {
  const projectId=crypto.randomUUID();f.context.workspace.projects[projectId]={id:projectId,name:'customer-portal',owner:'Owner',codeConnected:true};
  return {workspaceId:f.context.workspace.id,projectId,name:'customer-portal',defaultBranch:'main',baseCommit:'a'.repeat(40)};
}

test('create repository is a separate hosted choice and success opens its first-task composer',async()=>{
  const f=repositoryFixture();
  assert.equal(f.$('#repository-create-fields').hidden,false);assert.equal(f.$('#task-details-step').hidden,true);
  assert.equal(f.$('#repository-source-fields').hidden,true);assert.ok(f.$('#task-source').options.some(option=>option.value==='repository'));
  const pending=f.createRepository();assert.equal(f.calls[0].path,'/api/repositories');
  assert.deepEqual(f.calls[0].body,{name:'customer-portal',description:'A useful project'});assert.equal(f.controller.locked,true);
  const created=repositoryResult(f);f.calls[0].resolve(created);await pending;
  assert.equal(f.context.projectId,created.projectId);assert.equal(f.$('#task-source').value,'project:'+created.projectId);
  assert.equal(f.$('#task-details-step').hidden,false);assert.equal(f.$('#task-launcher').open,true);assert.equal(f.controller.locked,false);
  assert.match(f.$('#task-source-note').textContent,/Private repository created and connected/);
  assert.equal(f.calls.length,1,'Creating a repository does not queue tasks or start agents');assert.match(f.announcements.at(-1),/Private repository created/);
});

for(const failure of [{uncertain:true},{status:503},{status:401},{status:409,code:'OPERATION_IN_PROGRESS'}])
  test(`repository request survives ${JSON.stringify(failure)} and reload with its exact input`,async()=>{
    const f=repositoryFixture(),pending=f.createRepository(),original=f.calls[0];original.reject(Object.assign(Error('Creation not confirmed'),failure));await pending;
    const saved=f.controller.snapshot();assert.equal(f.controller.locked,true);assert.equal(saved.repositoryStart.key,original.key);
    f.controller.restore(saved);f.controller.update();assert.equal(f.$('#task-source').value,'new-repository');
    f.$('#repository-create-name').value='changed-in-DOM';const retry=f.createRepository();
    assert.equal(f.calls[1].key,original.key);assert.deepEqual(f.calls[1].body,original.body);
    f.calls[1].resolve(repositoryResult(f));await retry;assert.equal(f.controller.locked,false);
  });

test('a definite repository name refusal permits editing while uncertain success stays locked',async()=>{
  const f=repositoryFixture(),pending=f.createRepository(),oldKey=f.calls[0].key;
  f.calls[0].reject(Object.assign(Error('Choose another name'),{status:409,code:'REPOSITORY_NAME_TAKEN'}));await pending;
  assert.equal(f.controller.locked,false);const retry=f.createRepository();assert.notEqual(f.calls[1].key,oldKey);
  f.calls[1].resolve({});await retry;assert.equal(f.controller.locked,true);assert.equal(f.controller.snapshot().repositoryStart.key,f.calls[1].key);
});

test('unresolved repository creation survives capability removal without becoming a task request',async()=>{
  const f=repositoryFixture(),pending=f.createRepository();f.calls[0].reject(Error('Lost response'));await pending;
  const saved=f.controller.snapshot();f.context.workspace.capabilities.repositoryCreate=false;f.controller.restore(saved);f.controller.update();
  assert.equal(f.$('#task-source').value,'new-repository');assert.equal(f.$('#create-repository').disabled,true);
  await f.submit();await f.createRepository();assert.equal(f.calls.length,1);assert.equal(f.controller.locked,true);
});

for(const failed of [false,true])test(`late repository ${failed?'failure':'success'} cannot affect another workspace`,async()=>{
  const f=repositoryFixture(),pending=f.createRepository();
  f.context.workspace.id='other-workspace';f.controller.restore(null);f.controller.update();f.controller.activate('new-repository');f.controller.update();
  f.$('#repository-create-name').value='other-repo';const current=f.createRepository(),key=f.calls[1].key;
  if(failed)f.calls[0].reject(Error('Old request failed'));else f.calls[0].resolve({workspaceId:'workspace-a',projectId:crypto.randomUUID(),name:'customer-portal',defaultBranch:'main',baseCommit:'a'.repeat(40)});
  await pending;assert.equal(f.controller.snapshot().repositoryStart.key,key);assert.deepEqual(f.errors,[]);
  f.calls[1].reject(Error('Keep this request'));await current;
});

function modelFixture(saved=null) {
  const f=fixture();f.context.workspace.capabilities.model=true;f.context.workspace.execution={model:'controlled transport'};
  for(const [name,value] of Object.entries({candidates:3,requests:2,output:4096,seconds:120,input:32768}))f.$('#model-'+name).value=String(value);
  f.controller.restore(saved);f.controller.update();f.$('#task-launcher').showModal();f.controller.activate('sample');f.controller.update();
  return f;
}

test('sample actions distinguish starting agents from queueing ordinary work',()=>{
  const f=modelFixture();assert.equal(f.$('#create-task').textContent,'Start model agents');
  assert.match(f.$('#create-task').title,/start model agents within the displayed allowance/);
  f.context.workspace.capabilities.demo=true;
  f.controller.activate('project:one');f.controller.activate('sample');f.controller.update();
  assert.equal(f.$('#create-task').textContent,'Start 2 scripted agents');assert.match(f.$('#create-task').title,/No model calls/);
  f.controller.activate('project:one');f.controller.update();assert.equal(f.$('#create-task').textContent,'Queue 1 task');assert.equal(f.calls.length,0);
});

for(const status of [undefined,409,503])test(`unconfirmed model start ${status??'transport error'} preserves the visible allowance and exact retry across reload`,async()=>{
  let f=modelFixture();const pending=f.submit(),original=f.calls[0];
  assert.equal(f.savedSnapshots.at(-1).modelStart.key,original.key,'Save identity before dispatching the request.');
  original.reject(Object.assign(new Error('Start not confirmed'),{status,uncertain:true}));await pending;
  assert.equal(f.controller.locked,true);assert.equal(f.$('#model-candidates').disabled,true);
  assert.equal(f.$('#task-execution').disabled,true);assert.match(f.$('#create-task').textContent,/Retry same model start/);
  assert.match(f.$('#task-creation-status').textContent,/original allowance is locked/);
  assert.equal(f.controller.activate('project:two'),false,'An unresolved model start cannot be replaced by another destination.');
  f.$('#model-candidates').value='1';await f.$('#model-form').dispatch('input');
  assert.equal(f.$('#model-candidates').value,'3','Even a stale input event restores the displayed pending allowance.');
  f.$('#task-execution').value='scripted';await f.$('#task-execution').dispatch('change');assert.equal(f.$('#task-execution').value,'model');
  const saved=JSON.parse(JSON.stringify(f.controller.snapshot()));f=modelFixture(saved);
  assert.equal(f.calls.length,0,'Reload never executes the saved request.');assert.equal(f.controller.locked,true);
  assert.equal(f.$('#model-candidates').value,'3');assert.match(f.$('#model-budget').textContent,/6 requests and 24576 output tokens/);
  const retry=f.submit();assert.deepEqual(f.calls[0].body,original.body);assert.equal(f.calls[0].key,original.key);
  f.calls[0].resolve(result());await retry;
  assert.equal(f.controller.locked,false);assert.equal(f.controller.snapshot().modelStart,null);
});

test('a definite model validation refusal allows a changed allowance with a new request identity',async()=>{
  const f=modelFixture(),pending=f.submit(),original=f.calls[0];original.reject(Object.assign(new Error('Invalid allowance'),{status:422}));await pending;
  assert.equal(f.controller.locked,false);assert.equal(f.$('#model-candidates').disabled,false);
  f.$('#model-candidates').value='1';await f.$('#model-form').dispatch('input');
  const retry=f.submit();assert.notEqual(f.calls[1].key,original.key);assert.equal(f.calls[1].body.candidates,1);
  f.calls[1].resolve(result());await retry;
});

for(const status of [403,422,429])test(`a later retry refusal ${status} cannot erase an earlier uncertain model outcome`,async()=>{
  const f=modelFixture(),first=f.submit(),original=f.calls[0];original.reject(Object.assign(new Error('Start not confirmed'),{uncertain:true}));await first;
  const retry=f.submit();f.calls[1].reject(Object.assign(new Error('Retry refused'),{status}));await retry;
  assert.equal(f.controller.locked,true,'A refused retry does not prove the earlier attempt never started.');
  assert.equal(f.controller.snapshot().modelStart.key,original.key);assert.deepEqual(f.controller.snapshot().modelStart.body,original.body);
});

test('an unreadable model success keeps the request locked instead of granting a fresh start',async()=>{
  const f=modelFixture(),pending=f.submit(),original=f.calls[0];original.resolve({});await pending;
  assert.equal(f.controller.locked,true);assert.equal(f.controller.snapshot().modelStart.key,original.key);assert.equal(f.selected.length,0);
});

test('restoring an unresolved model start after capability removal cannot become a project task request',async()=>{
  const f=modelFixture(),pending=f.submit(),original=f.calls[0];original.reject(Object.assign(new Error('Start not confirmed'),{uncertain:true}));await pending;
  const saved=JSON.parse(JSON.stringify(f.controller.snapshot()));
  f.context.workspace.capabilities.model=false;f.controller.restore(saved);f.controller.update();
  assert.equal(f.$('#task-source').value,'sample');assert.equal(f.$('#task-execution').value,'model');
  assert.equal(f.controller.locked,true);assert.equal(f.$('#create-task').disabled,true);
  assert.equal(f.controller.snapshot().modelStart.key,original.key);await f.submit();assert.equal(f.calls.length,1);
  f.context.workspace.capabilities.model=true;f.controller.update();
  const retry=f.submit();assert.equal(f.calls[1].path,'/api/model-runs');assert.equal(f.calls[1].key,original.key);
  f.calls[1].resolve(result());await retry;
});

for(const failed of [false,true])test(`late model ${failed?'failure':'success'} cannot clear a new workspace request`,async()=>{
  const f=modelFixture(),old=f.submit(),original=f.calls[0];
  f.context.workspace.id='workspace-b';f.controller.restore(null);f.controller.update();f.controller.activate('sample');f.controller.update();
  const current=f.submit(),currentKey=f.calls[1].key;
  if(failed)original.reject(new Error('Old request failed'));else original.resolve(result());await old;
  assert.equal(f.controller.starting,true);assert.equal(f.controller.snapshot().modelStart.key,currentKey);assert.deepEqual(f.errors,[]);
  f.calls[1].resolve(result());await current;assert.equal(f.controller.locked,false);
});

test('malformed saved model requests fail explicitly without issuing a replacement',()=>{
  const f=modelFixture(),saved=f.controller.snapshot();saved.modelStart={key:crypto.randomUUID(),body:{candidates:1,limits:{}}};
  assert.throws(()=>f.controller.restore(saved),/saved model-start request is invalid/);assert.equal(f.calls.length,0);
});

for(const chosen of [null,2,4])test(`model allowance submits ${chosen ?? 'the one-candidate default'} with its explicit total budget`,async()=>{
  const f=fixture();
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  for(const name of ['candidates','requests','output','seconds','input']) {
    const tag=html.match(new RegExp('<input id="model-'+name+'"[^>]*>'))?.[0];
    assert.ok(tag);
    f.$('#model-'+name).value=tag.match(/value="([^"]+)"/)[1];
  }
  assert.equal(f.$('#model-candidates').value,'1');
  if(chosen!==null)f.$('#model-candidates').value=String(chosen);
  f.context.workspace.capabilities.model=true;f.context.workspace.execution={model:'test transport'};
  f.$('#task-launcher').showModal();f.controller.activate('sample');f.controller.update();
  await f.$('#model-form').dispatch('input');
  const count=chosen??1;
  assert.match(f.$('#model-budget').textContent,new RegExp(count*2+' requests and '+count*8192+' output tokens'));
  const pending=f.submit();assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].path,'/api/model-runs');assert.equal(f.calls[0].body.candidates,count);
  assert.equal(f.calls[0].body.limits.maxRequests,2);
  f.calls[0].resolve(result());await pending;
  assert.equal(f.calls.length,1);
});

test('hosted onboarding keeps explicit Artifacts commit entry without local inspection',async()=>{
  const f=fixture();f.context.workspace.provider='cloudflare-artifacts';
  f.controller.activate('repository');f.controller.update();
  assert.equal(f.$('#inspect-repository').hidden,true);
  f.$('#project-name-input').value='Hosted project';f.$('#repository-path').value='customer-portal';f.$('#repository-base').value='a'.repeat(40);
  await f.$('#repository-next').dispatch('click');
  assert.equal(f.$('#task-details-step').hidden,false);
  assert.match(f.$('#task-source-note').textContent,/Artifacts repository/);
  assert.equal(f.calls.length,0);
});

test('connecting code from workspace home opens its saved task queue without launching an agent',async()=>{
  const f=fixture();f.context.view='projects';f.context.projectId=null;
  f.controller.activate('repository');f.controller.update();
  f.$('#project-name-input').value='Connected from home';f.$('#repository-path').value='C:/code/ordinary';f.$('#repository-base').value='a'.repeat(40);
  await f.fill('First agreed task');
  await f.$('#repository-next').dispatch('click');
  const pending=f.submit(),saved=result('new-project');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.source,'repository');
  assert.equal(f.calls[0].body.tasks[0].owner,'Owner');
  f.context.workspace.projects['new-project']={id:'new-project',name:'Connected from home',owner:'Owner'};
  f.calls[0].resolve(saved);await pending;
  assert.equal(f.context.view,'overview');assert.deepEqual(f.selected,[saved.taskId]);
  assert.equal(f.controller.snapshot().source,'project:new-project');
  assert.equal(f.controller.snapshot().tasks[0].title,'');assert.equal(f.$('#task-launcher').open,false);
  assert.equal(f.calls.length,1);assert.equal(f.errors.length,0);
});

test('interrupted task stacks retain the exact body and request ID across reload and explicit retry', async()=>{
  let f=fixture(); await f.fill();
  const pending=f.submit(); await f.submit();
  assert.equal(f.calls.length,1); assert.equal(f.controller.starting,true);
  assert.equal(f.calls[0].path,'/api/tasks'); assert.equal(f.calls[0].key,f.calls[0].body.requestId);
  assert.deepEqual(f.calls[0].body.tasks[0],{title:'Improve task',purpose:'Preserve real work',owner:'Owner',criteria:['First check','Second check']});
  const original=f.calls[0]; original.reject(Object.assign(new Error('Connection lost'),{uncertain:true})); await pending;
  assert.equal(f.controller.starting,false); assert.equal(f.controller.locked,true);
  assert.equal(f.controller.activate('project:two'),false); assert.equal(f.$('#task-source').value,'project:one');
  const snapshot=JSON.parse(JSON.stringify(f.controller.snapshot()));
  f=fixture(snapshot); assert.equal(f.calls.length,0); assert.equal(f.controller.locked,true);
  assert.equal(f.$('#task-title-input').value,'Improve task'); assert.match(f.$('#create-task').textContent,/Retry/);
  const retry=f.submit(); assert.deepEqual(f.calls[0].body,original.body); assert.equal(f.calls[0].key,original.key);
  f.calls[0].resolve(result()); await retry;
  assert.equal(f.controller.locked,false); assert.equal(f.controller.snapshot().pending,null);
  assert.equal(f.controller.snapshot().tasks[0].title,''); assert.equal(f.selected.length,1);
  assert.match(f.announcements[0],/1 tasks queued/);
});

test('project draft stacks and prerequisites survive switching without sharing text', async()=>{
  const f=fixture(); await f.fill('First project');
  await f.$('#add-task-draft').dispatch('click');
  const second=f.$('#task-drafts').children[1];
  function find(node,predicate){if(predicate(node))return node;for(const child of node.children??[]){const found=find(child,predicate);if(found)return found;}}
  const dependency=find(second,node=>node.tagName==='INPUT'&&node.value==='draft:1');
  dependency.checked=true; await dependency.dispatch('change');
  f.context.projectId='two'; f.controller.activate('project:two');f.controller.update();
  assert.equal(f.$('#task-title-input').value,''); await f.fill('Second project');
  f.context.projectId='one'; f.controller.activate('project:one');f.controller.update();
  await f.$('#task-drafts').children[0].children[0].dispatch('click');
  assert.equal(f.$('#task-title-input').value,'First project');
  assert.equal(f.controller.snapshot().tasks.length,2);assert.deepEqual(f.controller.snapshot().tasks[1].dependsOn,['draft:1']);
  const restored=fixture(JSON.parse(JSON.stringify(f.controller.snapshot())));
  await restored.$('#task-drafts').children[0].children[0].dispatch('click');
  assert.equal(restored.$('#task-title-input').value,'First project');
  restored.context.projectId='two';restored.controller.activate('project:two');restored.controller.update();
  assert.equal(restored.$('#task-title-input').value,'Second project');assert.equal(restored.calls.length,0);
});

for(const status of [422,409,503])test(`task rejection ${status} ${status===422?'unlocks editing':'retains the saved request'}`,async()=>{
  const f=fixture();await f.fill();const pending=f.submit();
  f.calls[0].reject(Object.assign(new Error('Request refused'),{status}));await pending;
  assert.equal(f.controller.locked,status!==422);assert.equal(f.calls.length,1);
  assert.deepEqual(f.errors,['Request refused']);
});

for(const status of [403,422,429])test(`later task retry refusal ${status} cannot discard an earlier uncertain task stack`,async()=>{
  const f=fixture();await f.fill();const first=f.submit(),original=f.calls[0];
  original.reject(Object.assign(new Error('Lost task response'),{uncertain:true}));await first;
  const retry=f.submit();assert.equal(f.calls[1].key,original.key);
  f.calls[1].reject(Object.assign(new Error('Retry refused'),{status}));await retry;
  assert.equal(f.controller.locked,true);assert.equal(f.controller.snapshot().pending.requestId,original.key);
  assert.deepEqual(f.controller.snapshot().pending,original.body);
  const release=f.release();assert.ok(f.calls[2].path.includes(original.key));
  const saved=result();f.calls[2].resolve({result:saved});await release;
  assert.deepEqual(f.selected,[saved.taskId]);assert.equal(f.controller.locked,false);
  assert.equal(f.calls.filter(call=>call.path==='/api/tasks').length,2,'Recovery reads the saved outcome without creating another stack.');
});

for(const reloaded of [false,true])test(`an off-page pending task request ${reloaded?'restores':'stays'} bound to its original project`,async()=>{
  const f=fixture();await f.fill('Original project draft');const first=f.submit(),original=f.calls[0],project=f.context.workspace.projects.one;
  original.reject(Object.assign(new Error('Unconfirmed response'),{uncertain:true}));await first;
  const saved=JSON.parse(JSON.stringify(f.controller.snapshot()));
  f.context.workspace.projects={two:f.context.workspace.projects.two};f.context.projectId='two';
  f.context.workspace.page={scope:'loaded-projects',totalProjects:2};
  if(reloaded)f.controller.restore(saved);f.controller.update();
  assert.equal(f.$('#task-source').value,'project:one');
  assert.equal(f.$('#task-source').options.find(option=>option.value==='project:one').disabled,true);
  assert.equal(f.$('#create-task').disabled,true);assert.equal(f.$('#open-saved-project').hidden,false);
  assert.match(f.$('#task-creation-status').textContent,/Open the original project/);
  await f.submit();assert.equal(f.calls.length,1,'An unavailable project cannot be substituted with the loaded project.');
  await f.$('#open-saved-project').dispatch('click');assert.equal(f.context.projectId,'one');assert.equal(f.calls.length,1);
  f.context.workspace.projects={one:project};f.controller.update();
  assert.equal(f.$('#open-saved-project').hidden,true);assert.equal(f.$('#create-task').disabled,false);
  assert.equal(f.$('#task-title-input').value,'Original project draft');
  const retry=f.submit();assert.equal(f.calls[1].key,original.key);assert.deepEqual(f.calls[1].body,original.body);
  f.calls[1].resolve(result());await retry;assert.equal(f.controller.locked,false);
});

test('malformed success and unconfirmed release cannot silently discard an unresolved task request',async()=>{
  const f=fixture();await f.fill();const pending=f.submit(),requestId=f.calls[0].key;
  f.calls[0].resolve({});await pending;
  assert.equal(f.controller.snapshot().pending.requestId,requestId);assert.equal(f.selected.length,0);
  const release=f.release();assert.ok(f.calls[1].path.includes(requestId));
  f.calls[1].resolve({});await release;
  assert.equal(f.controller.locked,true);assert.equal(f.calls.length,2);assert.equal(f.announcements.length,0);
  const confirmed=f.release();f.calls[2].resolve({released:true});await confirmed;
  assert.equal(f.controller.locked,false);assert.equal(f.$('#task-title-input').value,'Improve task');
  assert.match(f.announcements.at(-1),/No tasks were saved/);
});

test('checking a saved request returns its original tasks without a second creation',async()=>{
  const f=fixture();await f.fill();const pending=f.submit();f.calls[0].reject(new Error('Lost response'));await pending;
  const release=f.release(), saved=result();f.calls[1].resolve({result:saved});await release;
  assert.deepEqual(f.selected,[saved.taskId]);assert.match(f.announcements[0],/already saved/);
  assert.equal(f.calls.filter(call=>call.path==='/api/tasks').length,1);assert.equal(f.controller.locked,false);
});

for(const failure of [false,true])test(`late ${failure?'failure':'success'} cannot affect a new request after workspace A to B to A`,async()=>{
  const f=fixture();await f.fill('Old work');const old=f.submit();
  f.context.workspace={...f.context.workspace,id:'workspace-b'};f.controller.restore(null);f.controller.update();
  f.context.workspace={...f.context.workspace,id:'workspace-a'};f.controller.restore(null);f.controller.update();
  await f.fill('New work');const next=f.submit(),newId=f.calls[1].key;
  if(failure)f.calls[0].reject(new Error('Old error'));else f.calls[0].resolve(result());await old;
  assert.equal(f.controller.starting,true);assert.equal(f.controller.snapshot().pending.requestId,newId);
  assert.equal(f.errors.length,0);assert.equal(f.announcements.length,0);assert.equal(f.selected.length,0);
  f.calls[1].resolve(result());await next;assert.equal(f.controller.starting,false);
});

test('workspace change during refresh cannot reset the new workspace composer',async()=>{
  const f=fixture(),refresh=deferred();f.context.refresh=()=>refresh.promise;
  await f.fill();const pending=f.submit();f.calls[0].resolve(result());await new Promise(resolve=>setImmediate(resolve));
  f.context.workspace={...f.context.workspace,id:'workspace-b'};f.controller.restore(null);f.controller.update();await f.fill('New workspace draft');
  refresh.resolve();await pending;
  assert.equal(f.controller.snapshot().tasks[0].title,'New workspace draft');assert.equal(f.announcements.length,0);
});

test('choosing a draft destination keeps the modal open and does not navigate the background project',async()=>{
  const f=fixture();await f.fill('First project draft');
  f.$('#task-launcher').showModal();
  f.$('#task-source').value='project:two';await f.$('#task-source').dispatch('change');
  assert.equal(f.$('#task-launcher').open,true);
  assert.equal(f.context.projectId,'one');assert.equal(f.context.view,'overview');
  assert.equal(f.controller.snapshot().source,'project:two');
  await f.fill('Second project draft');
  f.$('#task-source').value='project:one';await f.$('#task-source').dispatch('change');
  assert.equal(f.$('#task-title-input').value,'First project draft');
  assert.equal(f.$('#task-launcher').open,true);assert.equal(f.calls.length,0);
});

test('repository inspection reads a commit without queueing and ignores a late changed-path response',async()=>{
  const f=fixture();f.context.workspace.capabilities.inspectRepository=true;
  f.controller.activate('repository');f.controller.update();
  assert.equal(f.$('#task-details-step').hidden,true);
  f.$('#repository-path').value='C:/code/first';
  const pending=f.$('#inspect-repository').dispatch('click');
  assert.equal(f.calls[0].path,'/api/repositories/inspect');
  f.$('#repository-path').value='C:/code/second';await f.$('#repository-path').dispatch('input');
  f.calls[0].resolve({headCommit:'a'.repeat(40),name:'first'});await pending;
  assert.equal(f.$('#repository-base').value,'');
  const next=f.$('#inspect-repository').dispatch('click');
  f.calls[1].resolve({headCommit:'b'.repeat(40),name:'second'});await next;
  assert.equal(f.$('#repository-base').value,'b'.repeat(40));
  await f.$('#repository-next').dispatch('click');
  assert.equal(f.$('#task-details-step').hidden,false);
  assert.equal(f.$('#repository-source-fields').hidden,true);
  assert.equal(f.calls.length,2);assert.equal(f.selected.length,0);
  const restored=fixture(JSON.parse(JSON.stringify(f.controller.snapshot())));
  assert.equal(restored.$('#task-details-step').hidden,false);
  assert.equal(restored.$('#repository-base').value,'b'.repeat(40));
});

test('returning from code selection focuses the mounted stacked draft and keeps both briefs',async()=>{
  const f=fixture();f.controller.activate('repository');f.controller.update();
  f.$('#project-name-input').value='Stacked project';f.$('#repository-path').value='C:/code/source';f.$('#repository-base').value='a'.repeat(40);
  await f.$('#repository-next').dispatch('click');await f.fill('First brief');
  await f.$('#add-task-draft').dispatch('click');
  const title=f.$('#task-title-input-1');title.value='Second brief';await title.dispatch('input');
  await f.$('#repository-back').dispatch('click');
  await f.$('#repository-next').dispatch('click');
  assert.equal(f.document.activeElement,title);
  assert.deepEqual(f.controller.snapshot().tasks.map(task=>task.title),['First brief','Second brief']);
});
