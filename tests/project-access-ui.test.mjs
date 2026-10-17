import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {canManageProjectAccess,createProjectAccessPanel} from '../public/ui/project-access.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const data=()=>({projectId:'project-one',access:{version:1,configured:true,grants:[]},identities:[{kind:'member',id:'member-one',roles:['read']}],recovery:null});
function panel(api){
  installFakeDOM();const context={selectedProject:'project-one',workspace:{id:'fixture',authentication:{mode:'cloudflare-access',permissions:{manage:true}}}};
  let generation=0;const captureSession=()=>{const initial=generation;return()=>initial===generation;};
  const root=createProjectAccessPanel({projectId:'project-one',getContext:()=>context,captureSession,api,refresh:async()=>{}});
  return {root,context,changeSession:()=>generation++};
}
test('People controls are restricted to the private hosted owner',async()=>{
  const valid={workspace:{authentication:{mode:'cloudflare-access',permissions:{manage:true}}}};
  assert.equal(canManageProjectAccess(valid),true);
  for(const context of [{}, {...valid,demo:true},{workspace:{...valid.workspace,personalWorkspace:{}}},
    {workspace:{authentication:{mode:'cloudflare-access',permissions:{manage:false}}}},{workspace:{authentication:{mode:'local',permissions:{manage:true}}}}])
    assert.equal(Boolean(canManageProjectAccess(context)),false);
});
test('editing one role enables an explicit versioned save and does not automatically publish',async()=>{
  let current=data();const calls=[];
  const p=panel(async(path,input,key)=>{calls.push({path,input,key});if(!input)return structuredClone(current);
    current={...current,access:{...current.access,version:2,grants:input.grants}};
    return {projectId:current.projectId,accessVersion:2,credentialCleanup:'confirmed'};});
  await tick();assert.equal(p.root.querySelector('#save-project-access').disabled,true);
  const select=p.root.querySelector('select');select.value='read';await select.dispatch('change');
  assert.equal(p.root.querySelector('#save-project-access').disabled,false);
  assert.equal(calls.length,1);await p.root.querySelector('form').dispatch('submit');
  const writes=calls.filter(call=>call.input);assert.equal(writes.length,1);
  assert.deepEqual(writes[0].input,{expectedVersion:1,grants:[{kind:'member',id:'member-one',role:'read'}]});
  assert.match(writes[0].key,/^[a-f0-9-]{36}$/);assert.match(p.root.textContent,/access saved/);
});
test('an uncertain save retains its original UUID and inputs until an explicit recovery click',async()=>{
  let current=data();const writes=[];
  const p=panel(async(_path,input,key)=>{if(!input)return structuredClone(current);writes.push({input:structuredClone(input),key});
    if(writes.length===1){current={...current,access:{...current.access,version:2,grants:input.grants}};throw Error('Lost access response');}
    return {projectId:current.projectId,accessVersion:2,credentialCleanup:'confirmed',replayed:true};});
  await tick();const select=p.root.querySelector('select');select.value='read';await select.dispatch('change');
  await p.root.querySelector('form').dispatch('submit');
  assert.equal(writes.length,1);assert.match(p.root.textContent,/Lost access response/);assert.match(p.root.textContent,/Recover saved access change/);
  assert.equal(p.root.querySelector('select').disabled,true);
  await p.root.querySelector('form').dispatch('submit');assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);
  assert.doesNotMatch(p.root.textContent,/Lost access response/);
});
test('a pending server change reuses the retained payload and refuses a missing recovery ID',async()=>{
  for(const missing of [false,true]){
    const snapshot=data(),original={expectedVersion:0,grants:[]};
    snapshot.recovery={requestId:missing?undefined:'10000000-0000-4000-8000-000000000001',input:original,pendingRuns:['run-one']};
    const writes=[];const p=panel(async(_path,input,key)=>{if(!input)return snapshot;writes.push({input,key});return {projectId:snapshot.projectId,accessVersion:1,credentialCleanup:'pending'};});
    await tick();await p.root.querySelector('form').dispatch('submit');
    assert.equal(writes.length,missing?0:1);
    if(!missing){assert.deepEqual(writes[0].input,original);assert.equal(writes[0].key,snapshot.recovery.requestId);}
    else assert.match(p.root.textContent,/operator inspection/);
  }
});
test('late access reads cannot populate a different session, project or detached inspector',async()=>{
  for(const change of [p=>p.changeSession(),p=>{p.context.selectedProject='another-project';},p=>{p.root.isConnected=false;},
    p=>{p.context.workspace.authentication.permissions.manage=false;}]){
    const response=Promise.withResolvers(),p=panel(()=>response.promise);await tick();change(p);
    response.resolve(data());await tick();assert.doesNotMatch(p.root.textContent,/member-one/);
  }
});
