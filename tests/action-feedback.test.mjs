import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../public/api-client.js';
import {createWorkbenchActions} from '../public/workbench-actions.js';
import {createWorkspaceConnection} from '../public/workspace-connection.js';

const snapshot=(id='w',version=1)=>({id,version,tasks:[],runs:[],events:[]});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function fixture(options={}) {
  const context={workspace:snapshot()}, announcements=[], errors=[], frames=[], refreshes=[], actionFeedback=new Map(), operationRequests=new Map(), calls=[], arrivals=[];
  const connection=createWorkspaceConnection({api:()=>{},getWorkspace:()=>context.workspace,setWorkspace:value=>{context.workspace=value;},
    activity:()=>({}),onChange(){},onSnapshot(){},onError(){},setTimer(){},clearTimer(){}});
  const actions=createWorkbenchActions({getContext:()=>context,captureSession:connection.captureSession,applySnapshot:connection.applySnapshot,
    getPath:()=>context.pagePath??'/api/workspace',refresh:async force=>{refreshes.push({force,path:context.pagePath});return true;},
    actionFeedback,operationRequests,saveSession(){},render:()=>frames.push([...actionFeedback.values()].map(value=>({...value}))),
    clearError(){},showError:message=>errors.push(message),announce:message=>announcements.push(message),
    captureActionFocus:()=>null,restoreActionFocus(){},
    api:(path,body,key)=>{const request=deferred();calls.push({path,body,key,...request});arrivals[calls.length-1]?.resolve(calls.at(-1));return request.promise;},...options});
  function changeWorkspace(id) {connection.applySnapshot(snapshot(id));actions.reset();operationRequests.clear();}
  const waitForCall=index=>calls[index]?Promise.resolve(calls[index]):(arrivals[index]??=deferred()).promise;
  return {context,connection,actions,announcements,errors,frames,refreshes,actionFeedback,operationRequests,calls,changeWorkspace,waitForCall};
}

test('scoped action reports pending immediately without claiming verification passed',async()=>{
  const f=fixture(),request=deferred(),feedback={key:'check',pending:'Checking retained commit'};
  const work=f.actions.mutate(()=>request.promise,'Request recorded; follow the report',feedback);
  assert.equal(f.actions.busy,true);assert.equal(f.actionFeedback.get('check').phase,'pending');
  let duplicate=0;await f.actions.mutate(()=>{duplicate++;},'duplicate',feedback);assert.equal(duplicate,0);
  request.resolve({verificationPending:true});await work;
  assert.equal(f.actions.busy,false);assert.equal(f.actionFeedback.get('check').phase,'recorded');assert.deepEqual(f.errors,[]);
});

test('uncertain outcomes retain inline errors and a visible notice without automatic retries',async()=>{
  const f=fixture();let calls=0;
  await f.actions.mutate(()=>{calls++;throw Object.assign(new Error('Connection lost'),{uncertain:true});},'Done',{key:'assignment',pending:'Preparing'});
  assert.equal(calls,1);assert.equal(f.actions.busy,false);assert.equal(f.actionFeedback.get('assignment').uncertain,true);
  assert.equal(f.actionFeedback.get('assignment').phase,'error');
  assert.deepEqual(f.errors,['Connection lost The outcome is not confirmed. Refresh status before trying again.']);
});

test('action feedback is scoped to workspace, candidate head and requirements',()=>{
  const f=fixture(),task={id:'t',revision:1},run={id:'r',headCommit:'a'};
  const original=f.actions.actionKey('checks',task,run);
  assert.notEqual(original,f.actions.actionKey('checks',{...task,revision:2},run));
  assert.notEqual(original,f.actions.actionKey('checks',task,{...run,headCommit:'b'}));
  f.changeWorkspace('other');assert.notEqual(original,f.actions.actionKey('checks',task,run));
});

test('action focus returns after failure but never pulls the user back from another view',async()=>{
  const restored=[],focus={id:'publication-action'},f=fixture({captureActionFocus:()=>focus,restoreActionFocus:value=>restored.push(value)});
  await f.actions.mutate(()=>{throw new Error('Refused');},'Recorded');
  assert.deepEqual(restored,[focus]);
  const request=deferred(),pending=f.actions.mutate(()=>request.promise,'Recorded');
  f.context.view='evidence';request.resolve({ok:true});await pending;
  assert.deepEqual(restored,[focus]);
});

test('an expired session keeps the sign-in focus instead of restoring the failed action',async()=>{
  const restored=[],f=fixture({captureActionFocus:()=>({id:'action'}),restoreActionFocus:value=>restored.push(value)});
  await f.actions.mutate(()=>{throw Object.assign(new Error('Sign in'),{auth:true});},'Recorded');
  assert.deepEqual(restored,[]);assert.deepEqual(f.errors,['Sign in']);
});

for(const failure of [true,false])test(`late action ${failure?'failure':'success'} cannot clear a newer action after workspace A to B to A`,async()=>{
  const f=fixture(),old=deferred(),next=deferred();
  const oldWork=f.actions.mutate(()=>old.promise,'Old result',{key:'old',pending:'Working'});
  f.changeWorkspace('b');f.changeWorkspace('w');
  const nextWork=f.actions.mutate(()=>next.promise,'New result',{key:'new',pending:'Working'});
  if(failure)old.reject(new Error('Old error'));else old.resolve(snapshot('w',99));await oldWork;
  assert.equal(f.actions.busy,true);assert.equal(f.context.workspace.version,1);
  assert.equal(f.actionFeedback.has('old'),false);assert.equal(f.actionFeedback.get('new').phase,'pending');
  assert.deepEqual(f.announcements,[]);assert.deepEqual(f.errors,[]);
  next.resolve({verificationPending:true});await nextWork;assert.equal(f.actions.busy,false);
});

test('older action snapshots cannot overwrite a newer workspace read',async()=>{
  const f=fixture(),request=deferred();const work=f.actions.mutate(()=>request.promise,'Policy recorded');
  f.connection.applySnapshot(snapshot('w',3));request.resolve(snapshot('w',2));await work;
  assert.equal(f.context.workspace.version,3);assert.deepEqual(f.announcements,['Policy recorded']);
});

test('a late project A mutation keeps project B loaded and refreshes B without hiding the confirmed outcome',async()=>{
  const read=deferred(),refreshes=[],f=fixture({refresh:async force=>{refreshes.push({force,task:f.context.selectedTask});return read.promise;}}),request=deferred();
  const a={...snapshot('w',1),tasks:[{id:'a'}],projects:{a:{id:'a'}},page:{scope:'loaded-projects'}};
  const b={...snapshot('w',2),tasks:[{id:'b'}],projects:{b:{id:'b'}},page:{scope:'loaded-projects'}};
  Object.assign(f.context,{workspace:a,view:'review',selectedTask:'a',selectedRun:null,pagePath:'/api/workspace?task=a'});
  const pending=f.actions.mutate(()=>request.promise,'A policy saved',{key:'a-policy',pending:'Saving A policy'});
  Object.assign(f.context,{workspace:b,selectedTask:'b',pagePath:'/api/workspace?task=b'});
  request.resolve({...a,version:3});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.context.workspace,b);assert.equal(f.context.selectedTask,'b');assert.deepEqual(refreshes,[{force:true,task:'b'}]);
  assert.equal(f.actionFeedback.get('a-policy').phase,'recorded');assert.deepEqual(f.announcements,['A policy saved']);
  read.resolve(false);await pending;
  assert.equal(f.context.workspace,b);assert.deepEqual(f.errors,[]);assert.equal(f.actions.busy,false);
});

test('a late mutation cannot replace another project-list page even when view and task are unchanged',async()=>{
  const f=fixture(),request=deferred();Object.assign(f.context,{view:'projects',selectedTask:null,selectedRun:null,pagePath:'/api/workspace?offset=0'});
  const pending=f.actions.mutate(()=>request.promise,'Saved');
  const current={...snapshot('w',2),projects:{b:{id:'b'}},page:{offset:10}};
  Object.assign(f.context,{workspace:current,pagePath:'/api/workspace?offset=10'});
  request.resolve({...snapshot('w',3),projects:{a:{id:'a'}},page:{offset:0}});await pending;
  assert.equal(f.context.workspace,current);assert.deepEqual(f.refreshes,[{force:true,path:'/api/workspace?offset=10'}]);
});

test('a refresh exception after a confirmed off-page mutation does not relabel the mutation uncertain',async()=>{
  const f=fixture({refresh:async()=>{throw Error('Read unavailable');}}),request=deferred();
  f.context.selectedTask='a';const pending=f.actions.mutate(()=>request.promise,'Saved',{key:'policy',pending:'Saving'});
  f.context.selectedTask='b';request.resolve(snapshot('w',2));await pending;
  assert.equal(f.actionFeedback.get('policy').phase,'recorded');assert.equal(f.actionFeedback.get('policy').uncertain,undefined);
  assert.deepEqual(f.announcements,['Saved']);assert.match(f.errors[0],/recorded.*Read unavailable/);
});

test('a response from another workspace is uncertain and does not replace the current one',async()=>{
  const f=fixture();await f.actions.mutate(()=>snapshot('other',2),'Changed',{key:'policy',pending:'Saving'});
  assert.equal(f.context.workspace.id,'w');assert.equal(f.actionFeedback.get('policy').uncertain,true);assert.deepEqual(f.announcements,[]);
});

test('operation retry preserves its submitted body and ID until confirmed',async()=>{
  const f=fixture(),path='/api/runs/run/verify',body={headCommit:'a',taskRevision:1};
  const first=f.actions.runOperation(path,body);await f.waitForCall(0);
  f.calls[0].reject(Object.assign(new Error('Lost response'),{status:503}));await assert.rejects(first);
  const saved=f.operationRequests.get(path);assert.ok(saved.requestId);
  const retry=f.actions.runOperation(path,body);await f.waitForCall(1);
  assert.equal(f.calls[1].key,saved.requestId);assert.deepEqual(f.calls[1].body,body);
  f.calls[1].resolve({verificationPending:true});await retry;assert.equal(f.operationRequests.size,0);
});

test('workspace changes during fingerprinting prevent sending an operation',async()=>{
  const fingerprint=deferred(),f=fixture({hash:()=>fingerprint.promise});
  const operation=f.actions.runOperation('/api/runs/run/verify',{headCommit:'a'});
  f.changeWorkspace('other');fingerprint.resolve('a'.repeat(64));await assert.rejects(operation,/workspace changed/);
  assert.equal(f.calls.length,0);assert.equal(f.operationRequests.size,0);
});

test('a late operation reply cannot remove a newer saved request',async()=>{
  const f=fixture(),path='/api/runs/run/verify';
  const old=f.actions.runOperation(path,{headCommit:'a'});await f.waitForCall(0);
  f.changeWorkspace('other');f.changeWorkspace('w');
  const next=f.actions.runOperation(path,{headCommit:'a'});await f.waitForCall(1);
  const newId=f.calls[1].key;f.calls[0].resolve({verificationPending:true});await old;
  assert.equal(f.operationRequests.get(path).requestId,newId);
  f.calls[1].resolve({verificationPending:true});await next;assert.equal(f.operationRequests.size,0);
});

test('transport and unreadable mutation replies retain uncertainty without automatic retry',async()=>{
  let calls=0,fetchRequest=async()=>{calls++;throw new Error('offline');};
  const api=createApiClient({onAuthRequired(){},fetchRequest:(...args)=>fetchRequest(...args)});
  await assert.rejects(api('/mutation',{}),error=>error.uncertain===true);assert.equal(calls,1);
  fetchRequest=async()=>({status:200,ok:true,json:async()=>{throw new Error('invalid');}});
  await assert.rejects(api('/mutation',{}),error=>error.uncertain===true);
  await assert.rejects(api('/workspace'),error=>error.uncertain===false);
});

test('an authentication failure using an old token cannot reopen the current auth prompt',async()=>{
  let token='old',prompts=0;const request=deferred();
  const api=createApiClient({captureSession:()=>{const captured=token;return()=>captured===token;},onAuthRequired:()=>prompts++,fetchRequest:()=>request.promise});
  const old=api('/api/workspace');token='new';request.resolve({status:401});await assert.rejects(old,error=>error.auth);
  assert.equal(prompts,0);
});
