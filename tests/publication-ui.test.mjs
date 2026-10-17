import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createPublicationView,publicationLink} from '../public/ui/publication.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const buttons=node=>[...(node?.tagName==='BUTTON'?[node]:[]),...(node?.children??[]).flatMap(buttons)];
const button=(node,label)=>buttons(node).find(item=>item.textContent===label);
function fixture(){
  installFakeDOM();let epoch=0;
  const run={id:'run',taskId:'task',status:'merged',headCommit:'b'.repeat(40)},task={id:'task',origin:'connected-git'};
  const context={workspace:{id:'workspace',provider:'local-git',runs:[run],capabilities:{publish:true},githubPublication:{repository:'owner/repo'}},selectedRun:'run',selectedTask:'task',view:'review',busy:false};
  const calls=[],dialogs=[],errors=[];let refreshes=0;
  const render=createPublicationView({getContext:()=>context,captureSession:()=>{const before=epoch;return ()=>before===epoch;},
    api:(path,body)=>{const pending=deferred();calls.push({path,body,...pending});return pending.promise;},
    mutate:async work=>{try{return await work();}catch(error){errors.push(error.message);return null;}},
    refresh:async()=>{refreshes++;},openInspector:(...args)=>dialogs.push(args)});
  const binding={repository:'owner/repo',baseBranch:'main',headBranch:'newwork/projects-test',local:{baseCommit:'a'.repeat(40),headCommit:run.headCommit,taskRevision:1}};
  const prepared={id:crypto.randomUUID(),binding,title:'A useful change',body:'Requirements',expiresAt:new Date(Date.now()+300000).toISOString()};
  const record={id:crypto.randomUUID(),binding,status:'open',stage:'pr',pr:{number:7,url:'https://github.com/owner/repo/pull/7',headCommit:run.headCommit},observations:[]};
  return {run,task,context,render,calls,dialogs,errors,prepared,record,refreshes:()=>refreshes,changeWorkspace:()=>{epoch++;}};
}

test('rendering a merged task does not publish; configuration and hosted boundaries stay explicit',()=>{
  const f=fixture();assert.match(f.render(f.task,f.run).textContent,/Locally merged/);assert.equal(f.calls.length,0);
  f.context.workspace.capabilities.publish=false;assert.match(f.render(f.task,f.run).textContent,/not configured/);
  assert.equal(buttons(f.render(f.task,f.run)).length,0);
  f.context.workspace.provider='cloudflare-artifacts';assert.equal(f.render(f.task,f.run),null);
});

test('hosted owner receives an export and local instructions, with no GitHub request or credential input',async()=>{
  const f=fixture(),exports=[];f.context.workspace.provider='cloudflare-artifacts';
  f.context.workspace.authentication={permissions:{manage:true}};
  const render=createPublicationView({getContext:()=>f.context,downloadHandoff:async task=>exports.push(task.id)});
  const view=render(f.task,f.run);assert.match(view.textContent,/credentials stay on your machine/);assert.match(view.textContent,/historical evidence/);
  assert.match(view.textContent,/hosted-github-delivery.mjs/);assert.equal(f.calls.length,0);
  assert.equal(button(view,'Publish private PR'),undefined);await button(view,'Export task for local delivery').dispatch('click');assert.deepEqual(exports,[f.task.id]);
  f.context.workspace.authentication.permissions.manage=false;assert.equal(render(f.task,f.run),null);
});

test('merged trial work offers its source/history export instead of GitHub delivery',()=>{
  const f=fixture();f.context.workspace.provider='cloudflare-artifacts';
  f.context.workspace.trial={workflowReady:true};f.context.workspace.authentication={permissions:{manage:true}};
  const view=f.render(f.task,f.run);assert.equal(view.querySelector('a').attrs.href,'/api/trial/export');
  assert.match(view.textContent,/3 export attempts/);assert.doesNotMatch(view.textContent,/GitHub|local delivery/);assert.equal(f.calls.length,0);
  f.context.workspace.authentication.permissions.manage=false;assert.equal(f.render(f.task,f.run),null);
  f.context.workspace.authentication.permissions.manage=true;f.context.workspace.trial.workflowReady=false;assert.equal(f.render(f.task,f.run),null);
});

test('preview and explicit confirmation are separate; double clicks send one stable publication request',async()=>{
  const f=fixture(),view=f.render(f.task,f.run),pending=button(view,'Preview GitHub PR').dispatch('click');
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].path.endsWith('/preview'));
  f.calls[0].resolve(f.prepared);await pending;
  const body=f.dialogs[0][1];assert.match(body.textContent,/owner\/repo/);assert.match(body.textContent,/New branch/);
  assert.ok(body.textContent.includes(f.run.headCommit));assert.equal(f.calls.length,1);
  const confirm=button(body,'Publish private PR'),published=confirm.dispatch('click');await confirm.dispatch('click');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.previewId,f.prepared.id);assert.ok(f.calls[1].body.requestId);
  f.calls[1].resolve(f.record);await published;
  assert.match(body.textContent,/PR open/);assert.equal(f.refreshes(),1);assert.equal(f.calls.length,2);
  const refreshed=button(body,'Refresh GitHub status').dispatch('click');
  f.calls[2].resolve({...f.record,status:'merged',pr:{...f.record.pr,mergeCommit:'d'.repeat(40)}});await refreshed;
  assert.match(body.textContent,/Merged on GitHub/);assert.ok(body.textContent.includes('d'.repeat(40)));
});

test('late preview and stale confirmation cannot act after workspace or selection changes',async()=>{
  const f=fixture(),pending=button(f.render(f.task,f.run),'Preview GitHub PR').dispatch('click');
  f.changeWorkspace();f.calls[0].resolve(f.prepared);await pending;assert.equal(f.dialogs.length,0);
  const g=fixture(),next=button(g.render(g.task,g.run),'Preview GitHub PR').dispatch('click');g.calls[0].resolve(g.prepared);await next;
  g.context.selectedRun='other';await button(g.dialogs[0][1],'Publish private PR').dispatch('click');assert.equal(g.calls.length,1);
});

test('uncertain response never resends automatically and a started PR creation offers refresh only',async()=>{
  const f=fixture(),pending=button(f.render(f.task,f.run),'Preview GitHub PR').dispatch('click');f.calls[0].resolve(f.prepared);await pending;
  const body=f.dialogs[0][1],sent=button(body,'Publish private PR').dispatch('click');f.calls[1].reject(new Error('Lost response'));await sent;
  assert.match(body.textContent,/not confirmed/);assert.equal(f.calls.length,2);
  f.run.publication={...f.record,pr:null,status:'needs_attention',prStartedAt:'recorded',pushStartedAt:'recorded'};
  const view=f.render(f.task,f.run);assert.ok(button(view,'Refresh GitHub status'));assert.equal(button(view,'Continue publication'),undefined);
});

test('untrusted PR links cannot become executable links',()=>{
  assert.equal(publicationLink({pr:{number:1,url:'javascript:alert(1)'}}),null);
  assert.equal(publicationLink({pr:{number:1,url:'https://other.example/pull/1'}}),null);
});
