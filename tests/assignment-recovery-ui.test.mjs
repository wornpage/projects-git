import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el,panel} from '../public/ui/dom.js';

// Exercise the actual form inside the app without booting its polling shell.
// The changed work-view port alone cannot establish that recovery is usable.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function repositoryAgents(task) {');
const end=source.indexOf('\nfunction externalHandoff(run) {',start);
assert.ok(start>=0&&end>start);
const body=source.slice(start,end);

function fixture({closed='merged',pending=true,hosted=true}={}) {
  installFakeDOM();
  const task={id:crypto.randomUUID(),projectId:crypto.randomUUID(),origin:hosted?'artifacts':'connected-git',
    acceptedRunId:closed==='accepted'?crypto.randomUUID():null,mergedCommit:closed==='merged'?'a'.repeat(40):null};
  const request={label:'Previously authorized assignment',requestId:crypto.randomUUID(),...(hosted?{agentClientId:'11111111111111111111111111111111.access'}:{})};
  const workspace={provider:hosted?'cloudflare-artifacts':'local-git',projects:{[task.projectId]:{acceptingWork:true}},repositoryWorkflow:{busyTaskIds:[]},
    ...(hosted?{authentication:{permissions:{manage:true},agentClientIds:[request.agentClientId]}}:{})};
  const requests=new Map(pending?[[task.id,request]]:[]),actions={busy:false},calls=[],errors=[],refreshes=[],notices=[];
  let uuidCalls=0,ready=true,reply=async()=>({taskId:task.id,runId:crypto.randomUUID(),credentials:null,replayed:true});
  const ports={workspace,actions,assignmentRequests:requests,dependencyState:()=>({ready}),actionKey:()=> 'assignment-key',actionFeedback:new Map(),el,panel,
    connection:{captureSession:()=>()=>true},saveSession(){},showError:message=>errors.push({message}),
    mutate:async(fn,success,options)=>{notices.push({success,pending:options.pending});try{return await fn();}catch(error){errors.push(error);return null;}},
    api:async(path,input,key)=>{calls.push({path,input:structuredClone(input),key});return reply();},forkCredentials:new Map(),selectedRun:null,
    refresh:async force=>refreshes.push(force),saveLocation(){},actionNotice:()=>null,
    crypto:{randomUUID:()=>{uuidCalls++;return crypto.randomUUID();}}};
  const build=new Function(...Object.keys(ports),'return ('+body+');')(...Object.values(ports));
  const view=()=>build(task);
  const submit=async page=>{const form=page.querySelector('form');form.closest=()=>null;await form.dispatch('submit',{currentTarget:form});};
  return {task,request,workspace,requests,actions,calls,errors,refreshes,notices,view,submit,uuidCalls:()=>uuidCalls,
    setReady:value=>{ready=value;},setReply:value=>{reply=value;}};
}

for(const hosted of [false,true])for(const closed of ['accepted','merged'])test(`${hosted?'hosted':'local'} ${closed} task recovers the exact saved request through its real form`,async()=>{
  const f=fixture({hosted,closed}),page=f.view(),button=page.querySelector('#assign-'+f.task.id);
  assert.equal(button.disabled,false);assert.equal(button.textContent,'Recover saved assignment');
  assert.match(page.textContent,/Closed tasks can return an existing result; they cannot prepare new work/);
  const name=page.querySelector('#agent-label');assert.equal(name.readonly,true);name.value='Tampered form label';
  if(hosted){const client=page.querySelector('#agent-client');assert.equal(client.disabled,true);client.value='not-the-saved-client';}
  if(hosted)assert.match(page.textContent,/completed assignment does not reissue its Git credentials/);
  await f.submit(page);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].key,f.request.requestId);
  assert.deepEqual(f.calls[0].input,f.request);assert.equal(f.calls[0].path,'/api/tasks/'+f.task.id+'/agents');
  assert.equal(f.uuidCalls(),0);assert.equal(f.requests.has(f.task.id),false);assert.deepEqual(f.refreshes,[true]);
  assert.match(f.notices[0].success,/Saved assignment result recovered/);
  assert.match(f.notices[0].pending,/Reconciling the saved assignment request/);
  assert.doesNotMatch(f.notices[0].success,/fork prepared|checkout prepared/);
});

for(const closed of ['accepted','merged'])test(`${closed} task cannot prepare a fresh assignment without a saved request`,async()=>{
  const f=fixture({closed,pending:false}),page=f.view();
  assert.equal(page.querySelector('#assign-'+f.task.id).disabled,true);
  await f.submit(page);assert.equal(f.calls.length,0);assert.equal(f.uuidCalls(),0);assert.equal(f.requests.size,0);
});

test('paused, dependency-blocked and occupied work can reconcile a saved outcome while fresh assignments stay blocked',async()=>{
  const f=fixture();f.workspace.projects[f.task.projectId].acceptingWork=false;f.workspace.repositoryWorkflow.busyTaskIds=[f.task.id];f.setReady(false);
  const page=f.view();assert.equal(page.querySelector('#assign-'+f.task.id).disabled,false);await f.submit(page);assert.equal(f.calls.length,1);
  const fresh=fixture({pending:false,closed:'open'});fresh.workspace.projects[fresh.task.projectId].acceptingWork=false;fresh.setReady(false);
  const blocked=fresh.view();assert.equal(blocked.querySelector('#assign-'+fresh.task.id).disabled,true);await fresh.submit(blocked);assert.equal(fresh.calls.length,0);
});

for(const code of [403,409])test(`a saved recovery refusal ${code} retains the uncertain request and its original details`,async()=>{
  const f=fixture();f.setReply(async()=>{throw Object.assign(new Error('Recovery refused'),{status:code});});
  await f.submit(f.view());assert.equal(f.calls.length,1);assert.equal(f.requests.get(f.task.id),f.request);
  assert.equal(f.errors[0].uncertain,true);assert.equal(f.uuidCalls(),0);assert.deepEqual(f.refreshes,[]);
});

test('a malformed recovery result never clears the saved request',async()=>{
  const f=fixture();f.setReply(async()=>({taskId:f.task.id,runId:'not-a-run'}));await f.submit(f.view());
  assert.equal(f.requests.get(f.task.id),f.request);assert.equal(f.errors[0].uncertain,true);assert.equal(f.uuidCalls(),0);
});

test('a stale recovery form cannot replace a removed or changed request with new work',async()=>{
  for(const change of ['removed','replaced']){
    const f=fixture(),page=f.view();
    if(change==='removed')f.requests.delete(f.task.id);else f.requests.set(f.task.id,{...f.request,requestId:crypto.randomUUID()});
    await f.submit(page);assert.equal(f.calls.length,0);assert.equal(f.uuidCalls(),0);
    assert.match(f.errors[0].message,/saved assignment request changed/);
  }
});

test('busy actions and restricted roles keep recovery unavailable',async()=>{
  const f=fixture(),page=f.view();f.actions.busy=true;await f.submit(page);assert.equal(f.calls.length,0);
  assert.equal(f.view().querySelector('#assign-'+f.task.id).disabled,true);
  f.actions.busy=false;f.workspace.authentication.permissions.manage=false;assert.equal(f.view(),null);
});

test('trial assignment and retained handoff use scoped MCP instructions without promising Git credentials',()=>{
  const f=fixture({closed:'open',pending:false});f.workspace.trial={workflowReady:true};
  const assignment=f.view();assert.match(assignment.textContent,/private MCP connection/);assert.doesNotMatch(assignment.textContent,/15 minutes|Access agent client|agent clones/);
  const begin=source.indexOf('function hostedHandoff(run) {'),end=source.indexOf('\nasync function finishBaseUpdate',begin);
  const ports={workspace:f.workspace,forkCredentials:new Map(),el,disclosure:(_id,title,...children)=>el('details',{},el('summary',{},title),...children),actions:{busy:false}};
  const build=new Function(...Object.keys(ports),'return ('+source.slice(begin,end)+');')(...Object.values(ports));
  const handoff=build({id:crypto.randomUUID(),taskId:f.task.id,status:'assigned',repository:'https://git.example.test/fork.git',baseCommit:'a'.repeat(40)});
  assert.match(handoff.textContent,/projects_git_trial_source/);assert.match(handoff.textContent,/projects_git_trial_publish/);
  assert.doesNotMatch(handoff.textContent,/service client|Git credentials were issued|Copy temporary Git token|Git remote:/);
  assert.match(handoff.textContent,/Close assignment/);
});
