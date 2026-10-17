import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceConnection} from '../public/workspace-connection.js';
import {connectionLabel} from '../public/workbench-state.js';

const snapshot=(id='workspace',version=1)=>({id,version,tasks:[],runs:[],events:[]});
function fixture(overrides={}) {
  const requests=[],timers=new Map(),changes=[],errors=[],received=[];
  const context={workspace:null,activity:{},time:'first'};
  let timerId=0;
  const connection=createWorkspaceConnection({api:path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject})),
    getWorkspace:()=>context.workspace,setWorkspace:value=>{context.workspace=value;},activity:()=>context.activity,now:()=>context.time,
    onChange:()=>changes.push({...connection.state}),onSnapshot:(data,previous,options)=>received.push({data,previous,...options}),onError:error=>errors.push(error),
    setTimer:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},clearTimer:id=>timers.delete(id),...overrides});
  return {connection,context,requests,timers,changes,errors,received};
}

test('forced refresh during a pending read waits for a subsequent read and coalesces callers',async()=>{
  const f=fixture();const first=f.connection.refresh();let finished=false;
  const forced=f.connection.refresh(true).then(()=>{finished=true;});
  const another=f.connection.refresh(true);
  assert.equal(f.requests.length,1);f.requests[0].resolve(snapshot('workspace',1));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false);assert.equal(f.requests.length,2);assert.equal(f.timers.size,0);
  assert.equal(f.received.length,0);assert.equal(f.context.workspace,null);
  f.requests[1].resolve(snapshot('workspace',2));await Promise.all([first,forced,another]);
  assert.equal(f.context.workspace.version,2);assert.equal(f.received.at(-1).force,true);assert.equal(f.timers.size,1);
});

test('a page navigation during an outstanding poll discards the old page before rendering',async()=>{
  let path='/api/workspace?limit=10&offset=0';const f=fixture({getPath:()=>path});
  const read=f.connection.refresh();path='/api/workspace?limit=10&offset=10';const next=f.connection.refresh(true);
  f.requests[0].resolve(snapshot('workspace',1));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.received.length,0);assert.equal(f.requests[1].path,path);
  f.requests[1].resolve(snapshot('workspace',2));await Promise.all([read,next]);assert.equal(f.received.length,1);assert.equal(f.context.workspace.version,2);
});

test('ordinary refresh callers share the current read without scheduling extra requests',async()=>{
  const f=fixture();const first=f.connection.refresh(),next=f.connection.refresh();
  assert.equal(first,next);f.requests[0].resolve(snapshot());await first;
  assert.equal(f.requests.length,1);assert.equal(f.connection.state.loading,false);
});

test('healthy reads keep the connected label steady while successful sync timestamps advance',async()=>{
  const f=fixture();assert.equal(connectionLabel(f.connection.state),'Connecting…');
  let read=f.connection.refresh();assert.equal(connectionLabel(f.connection.state),'Connecting…');
  f.requests[0].resolve(snapshot());await read;
  const labels=[];
  for(let index=1;index<=3;index++){
    f.context.time='sync-'+index;read=f.connection.refresh();labels.push(connectionLabel(f.connection.state));
    f.requests[index].resolve(snapshot());await read;labels.push(connectionLabel(f.connection.state));
    assert.equal(f.connection.state.lastSyncedAt,'sync-'+index);
  }
  assert.deepEqual(labels,Array(6).fill('Workspace connected'));
});

test('steady healthy labels do not hide interruption, authentication failure or reconnection',async()=>{
  const f=fixture();let read=f.connection.refresh();f.requests[0].resolve(snapshot());await read;
  read=f.connection.refresh();f.requests[1].reject(new Error('Offline'));await read;
  assert.equal(connectionLabel(f.connection.state),'Connection interrupted');
  read=f.connection.refresh(true);assert.equal(connectionLabel(f.connection.state),'Reconnecting…');
  f.requests[2].reject(Object.assign(new Error('Token expired'),{auth:true}));await read;
  assert.equal(connectionLabel(f.connection.state),'Authentication required');assert.equal(f.timers.size,0);
  read=f.connection.reconnect();assert.equal(connectionLabel(f.connection.state),'Reconnecting…');
  f.requests[3].resolve(snapshot());await read;assert.equal(connectionLabel(f.connection.state),'Workspace connected');
});

test('old poll responses cannot roll back a newer action result',async()=>{
  const f=fixture();f.connection.applySnapshot(snapshot('workspace',3));const read=f.connection.refresh();
  f.requests[0].resolve(snapshot('workspace',2));await read;
  assert.equal(f.context.workspace.version,3);assert.equal(f.received[0].data.version,3);
});
test('a principal round trip cannot revive an earlier captured session',()=>{
  const f=fixture(),as=(id,version)=>({...snapshot('workspace',version),authentication:{principal:{kind:'owner',id}}});
  f.connection.applySnapshot(as('owner-a',1));const first=f.connection.captureSession();
  f.connection.applySnapshot(as('owner-b',2));assert.equal(first(),false);
  f.connection.applySnapshot(as('owner-a',3));assert.equal(first(),false);
  assert.equal(f.connection.captureSession()(),true);
});

for(const failure of [false,true])test(`reconnect ignores late ${failure?'failure':'success'} from the previous connection`,async()=>{
  const f=fixture();const old=f.connection.refresh(),isCurrent=f.connection.captureSession(),fresh=f.connection.reconnect();
  assert.equal(isCurrent(),false);assert.equal(f.requests.length,2);
  f.requests[1].resolve(snapshot('new',2));await fresh;
  if(failure)f.requests[0].reject(new Error('Old failure'));else f.requests[0].resolve(snapshot('old',9));await old;
  assert.equal(f.context.workspace.id,'new');assert.equal(f.errors.length,0);assert.equal(f.received.length,1);assert.equal(f.timers.size,1);
});

test('connection failures retain the last successful timestamp and version until recovery',async()=>{
  const f=fixture();let read=f.connection.refresh();f.requests[0].resolve(snapshot());await read;
  read=f.connection.refresh();const error=new Error('Offline');f.requests[1].reject(error);await read;
  assert.equal(f.connection.state.error,error);assert.equal(f.connection.state.lastSyncedAt,'first');assert.equal(f.connection.state.lastSyncedVersion,1);
  f.context.time='second';read=f.connection.refresh(true);assert.equal(f.connection.state.loading,true);assert.equal(f.connection.state.error,error);
  f.requests[2].resolve(snapshot('workspace',2));await read;
  assert.equal(f.connection.state.error,null);assert.equal(f.connection.state.lastSyncedAt,'second');assert.equal(f.received.at(-1).recoveredError,error);
});

test('authentication failures stop polling until explicitly reconnected',async()=>{
  const f=fixture();const read=f.connection.refresh();f.requests[0].reject(Object.assign(new Error('Token required'),{auth:true}));await read;
  f.connection.schedulePoll();assert.equal(f.timers.size,0);assert.equal(f.requests.length,1);
  const reconnect=f.connection.reconnect();f.requests[1].resolve(snapshot());await reconnect;assert.equal(f.timers.size,1);
});

test('polling schedules one read timer for task creation, active work or idle state',()=>{
  const f=fixture();for(const [activity,delay] of [[{taskStarting:true},400],[{active:true},1400],[{},7000]]) {
    f.context.activity=activity;f.connection.schedulePoll();assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,delay);
  }
  assert.equal(f.requests.length,0);
});

test('invalid source data is reported without replacing a usable workspace',async()=>{
  const f=fixture();f.connection.applySnapshot(snapshot());const read=f.connection.refresh();f.requests[0].resolve({tasks:[]});await read;
  assert.equal(f.context.workspace.version,1);assert.match(f.errors[0].message,/invalid workspace model/);
});

for(const code of ['UNAUTHORIZED','FORBIDDEN','SESSION_EXPIRED','SESSION_REVOKED','WORKSPACE_FORBIDDEN','WORKSPACE_OWNER_MISMATCH',
  'HUMAN_IDENTITY_REQUIRED','TRIAL_NOT_ADMITTED','TRIAL_CLOSED','TRIAL_EXPIRED','TRIAL_IDENTITY_FORBIDDEN','TRIAL_IDENTITY_CHANGED','TRIAL_SAMPLE_FORBIDDEN'])
test(`${code} clears the previous workspace, invalidates its session and stops polling`,async()=>{
  const f=fixture();let read=f.connection.refresh();f.requests[0].resolve(snapshot('a'));await read;
  const isCurrent=f.connection.captureSession();read=f.connection.refresh();f.connection.refresh(true);
  f.requests[1].reject(Object.assign(Error('Access no longer available'),{code}));await read;
  assert.equal(f.context.workspace,null);assert.equal(isCurrent(),false);
  assert.equal(f.connection.state.lastSyncedAt,null);assert.equal(f.connection.state.lastSyncedVersion,null);
  assert.equal(f.connection.state.error.accessLost,true);f.connection.schedulePoll();assert.equal(f.timers.size,0);
  assert.equal(f.requests.length,2,'A denial must not start the queued forced read.');
  f.connection.applySnapshot(snapshot('a'));assert.equal(isCurrent(),false,'Returning to the same ID cannot revive an old session.');
});

test('an action denial invalidates an in-flight read and its late success cannot restore private data',async()=>{
  const f=fixture();f.connection.applySnapshot(snapshot('a'));const current=f.connection.captureSession(),read=f.connection.refresh();
  f.connection.invalidate(Object.assign(Error('Trial closed'),{code:'TRIAL_CLOSED'}));
  f.requests[0].resolve(snapshot('a',2));assert.equal(await read,false);
  assert.equal(f.context.workspace,null);assert.equal(current(),false);assert.equal(f.received.length,0);assert.equal(f.errors.length,1);assert.equal(f.timers.size,0);
});

test('an old denial from a pending poll cannot disconnect a newly applied identity',async()=>{
  const f=fixture();f.connection.applySnapshot(snapshot('a'));const read=f.connection.refresh();f.connection.applySnapshot(snapshot('b'));
  f.requests[0].reject(Object.assign(Error('Old identity denied'),{code:'TRIAL_NOT_ADMITTED'}));await read;
  assert.equal(f.context.workspace.id,'b');assert.equal(f.errors.length,0);assert.equal(f.connection.state.error,null);
});
