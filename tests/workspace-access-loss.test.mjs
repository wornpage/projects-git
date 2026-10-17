import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createApiClient} from '../public/api-client.js';
import {createWorkspaceConnection} from '../public/workspace-connection.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {createNavigation} from '../public/ui/navigation.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const cleanup=source.slice(source.indexOf('function leaveWorkspace()'),source.indexOf("\n$('#adopt-owner').addEventListener"));
const snapshot=id=>({id,version:1,tasks:[],runs:[],events:[],authentication:{principal:{kind:'owner',id,displayName:id+'@example.test'}},trial:{expiresAt:'2026-10-24T12:00:00Z'}});
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};

test('access-loss cleanup only addresses elements present in the current shell',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  for(const [,id] of cleanup.matchAll(/\$\('#([^']+)'\)/g))assert.ok(html.includes('id="'+id+'"'),'Missing shell element: '+id);
});

test('a current action denial clears rendered A data, including hidden dialogs and identity labels',async()=>{
  const {$,document,nodes}=installFakeDOM(),closed=[],reset=[],content=$('#content');
  const privateIds=['identity-status','project-navigation','project-header','inspector-content','project-connection-content','task-drafts','announcement',
    'task-source-note','task-creation-status','repository-inspection-status','model-availability','model-budget','continuation-notice','git-note-notice'];
  for(const id of privateIds)$('#'+id).textContent='Private A data';
  for(const id of ['continuation-text','git-note-preview'])$('#'+id).value='Private A data';
  $('#identity-status').title='A@example.test';content.textContent='Private A project';
  $('#inspector-dialog').open=true;document.querySelectorAll=selector=>selector==='dialog[open]'?[...nodes.values()].filter(node=>node.open):[];
  $('#project-navigation').after=node=>{assert.equal(node,$('#project-views'));reset.push('static navigation rescued');};
  const owner=name=>({leave:()=>reset.push(name)});
  const context={$,el,document,content,workspace:snapshot('a'),view:'work',selectedTask:'a-task',selectedRun:'a-run',selectedProject:'a-project',projectOffset:10,pageRevision:1,
    renderKey:'a',navigationKey:'a',projectHeaderKey:'a',location:{pathname:'/workspace/'},
    compactNavigation:{restore:()=>reset.push('drawer restored')},dialogs:{skipFocusRestore:id=>closed.push(id)},
    browserSession:owner('session'),projectDiscovery:owner('discovery'),navigation:owner('navigation'),requirementsForm:owner('requirements'),
    actions:{reset:()=>reset.push('actions')},taskCreation:{restore:value=>{assert.equal(value,null);reset.push('composer');}},artifactPicker:{reset:()=>reset.push('artifacts')},
    verificationDrafts:new Map([['a','private']]),retainedSearches:new Map([['a','private']]),forkCredentials:new Map([['a','secret']]),
    browserTools:{disable(){}},saveLocation:()=>reset.push('location'),clearError(){},showError(){},updateConnectionStatus(){},refresh(){throw Error('No automatic recovery request');},
  };
  runInNewContext(cleanup,context);
  let connection;
  const api=createApiClient({captureSession:()=>connection.captureSession(),onAccessLost:error=>connection.invalidate(error),
    fetchRequest:async()=>Response.json({code:'TRIAL_NOT_ADMITTED',error:'Access denied'},{status:404})});
  connection=createWorkspaceConnection({api,getWorkspace:()=>context.workspace,setWorkspace:value=>{context.workspace=value;},activity:()=>({}),
    onChange(){},onSnapshot(){},onError:context.connectionFailed,setTimer(){throw Error('Do not poll after denial');},clearTimer(){}});
  const isCurrent=connection.captureSession();await assert.rejects(api('/api/projects/catalog'),error=>error.code==='TRIAL_NOT_ADMITTED');
  assert.equal(context.workspace,null);assert.equal(isCurrent(),false);assert.equal(document.activeElement.tagName,'A');assert.equal(document.activeElement.attrs.href,'/trial/signup');
  assert.deepEqual(reset.slice(0,2),['drawer restored','static navigation rescued']);assert.deepEqual(closed,['inspector-dialog']);assert.equal($('#inspector-dialog').open,false);
  for(const id of privateIds)assert.ok(!$('#'+id).textContent.includes('Private A'),id);
  assert.equal($('#identity-status').title,'');assert.equal($('#continuation-text').value,'');assert.equal($('#git-note-preview').value,'');
  assert.ok(!content.textContent.includes('Private A'));assert.match(content.textContent,/Workspace access required/);
  assert.equal(context.selectedProject,null);assert.equal(context.view,'projects');assert.equal(context.forkCredentials.size,0);
});

test('navigation cleanup removes private commands and ignores a delayed catalog after disconnect',async()=>{
  const {$}=installFakeDOM(),pending=defer();let workspace=snapshot('a');
  const navigation=createNavigation({getContext:()=>({workspace}),dialogs:{register(){},show:()=>{$('#command-dialog').open=true;}},
    announce(){},selectProject(){},switchView(){},prepareOpen:()=>null,projectDiscovery:{find:()=>pending.promise}});
  navigation.openCommands();$('#command-query').value='private A query';
  workspace=null;navigation.leave();$('#command-dialog').close();
  pending.resolve({items:[{id:'a-project',name:'Private A project',taskCount:1,candidateCount:1}]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('#command-query').value,'');assert.equal($('#command-results').textContent,'');assert.equal($('#command-support').textContent,'');assert.equal($('#command-count').textContent,'');
});

for(const response of [()=>Response.json({code:'TRIAL_EXPIRED'},{status:410}),()=>new Response(null,{status:401}),
  ()=>new Response('<html>Access denied</html>',{status:403,headers:{'Content-Type':'text/html'}}),()=>new Response(null,{status:403})])
test('an old HTTP denial cannot clear a newly signed-in workspace',async()=>{
  const pending=defer();let id='a',cleared=0;
  const api=createApiClient({captureSession:()=>{const started=id;return()=>id===started;},onAccessLost:()=>cleared++,fetchRequest:()=>pending.promise});
  const old=api('/api/workspace');id='b';pending.resolve(response());await assert.rejects(old);assert.equal(cleared,0);
});

for(const response of [()=>new Response('<html>Access denied</html>',{status:403,headers:{'Content-Type':'text/html'}}),()=>new Response(null,{status:403})])
test('a current non-JSON Access denial clears the rendered previous workspace',async()=>{
  let workspace=snapshot('a'),rendered='Private A project',connection;
  const api=createApiClient({captureSession:()=>connection.captureSession(),onAccessLost:error=>connection.invalidate(error),fetchRequest:async()=>response()});
  connection=createWorkspaceConnection({api,getWorkspace:()=>workspace,setWorkspace:value=>{workspace=value;},activity:()=>({}),
    onChange(){},onSnapshot(){},onError:()=>{rendered='Access required';},clearTimer(){},setTimer(){throw Error('No polling after denial');}});
  const current=connection.captureSession();await assert.rejects(api('/api/workspace'),error=>error.status===403&&error.code==='FORBIDDEN');
  assert.equal(workspace,null);assert.equal(current(),false);assert.equal(rendered,'Access required');assert.equal(connection.state.lastSyncedAt,null);
});

for(const reply of [()=>Response.json({code:'PROJECT_FORBIDDEN'},{status:403}),()=>Response.json({code:'SERVER_ERROR'},{status:503}),()=>{throw Error('offline');}])
test('project-level denial or transient failure preserves the usable workspace',async()=>{
  let cleared=0;const api=createApiClient({onAccessLost:()=>cleared++,fetchRequest:async()=>reply()});
  await assert.rejects(api('/api/project'));assert.equal(cleared,0);
});
