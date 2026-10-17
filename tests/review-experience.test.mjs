import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewForm} from '../public/ui/review-form.js';
import {automaticMergeControls} from '../public/ui/project-controls.js';
import {createBrowserSession} from '../public/browser-session.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {createWorkspace,createTask,assignRun,startRun,completeRun} from '../src/core/workflow.mjs';

function find(node,predicate){if(predicate(node))return node;for(const child of node.children??[]){const found=find(child,predicate);if(found)return found;}}
function fixture() {
  const {$}=installFakeDOM(),workspace=createWorkspace(),calls=[],errors=[],drafts=new Map(),saved=new Map();
  const task=createTask(workspace,{title:'Review improvement',purpose:'Reduce entry',criteria:['Current proof'],owner:'Coordinator',baseCommit:'a'.repeat(40)});
  const run=assignRun(workspace,task.id,{agent:'external',label:'Codex',branch:'newwork/review'});
  startRun(workspace,run.id);completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['ui.js'],diff:'',summary:'Change retained'});
  workspace.capabilities={merge:true};
  const context={workspace,busy:false,sessionWarning:false,ready:true,overlaps:[]};
  const session=createBrowserSession({drafts,disclosures:new Map(),assignmentRequests:new Map(),operationRequests:new Map(),projectSelections:new Map(),onWarning(){},storage:()=>({getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)})});
  session.enter(workspace);
  const comparisonHeads=()=>context.overlaps.map(({runId,headCommit})=>({runId,headCommit}));
  const review=createReviewForm({getContext:()=>context,drafts,getReviewerName:session.getReviewerName,rememberReviewerName:session.rememberReviewerName,
    api:async(path,body)=>{calls.push({path,body});return {};},mutate:async action=>action(),refresh:async()=>{},saveSession:()=>session.save(null),showError:message=>errors.push(message),
    runCoordination:()=>({acceptance:[{met:context.ready,label:'Current independent checks'}],overlaps:context.overlaps,activeRunIds:[],blockingRunIds:[]}),
    comparisonKey:()=>JSON.stringify(comparisonHeads()),comparisonHeads,acceptanceReady:()=>context.ready,
    disclosure:(id,title,...body)=>el('details',{id},el('summary',{},title),...body),evidenceChecks(){},diffPanel(){},switchView(){}});
  const panel=()=>review.reviewPanel(run,task);
  async function type(id,value){const input=$(id);input.value=value;await input.dispatch('input');}
  async function submit(node){await find(node,item=>item.tagName==='FORM').dispatch('submit');await new Promise(resolve=>setImmediate(resolve));}
  return {$,workspace,task,run,context,session,review,calls,errors,panel,type,submit};
}

test('hosted reviews show the signed-in owner and omit every caller-supplied identity field',async()=>{
  const f=fixture();f.workspace.authentication={mode:'cloudflare-access',principal:{kind:'owner',issuer:'https://team.cloudflareaccess.com',id:'owner-id',displayName:'owner@example.test'},permissions:{review:true,merge:true}};
  const node=f.panel(),input=f.$('#reviewer-'+f.run.id);
  assert.equal(input.value,'owner@example.test');assert.equal(input.readonly,true);
  await f.type('#reviewer-'+f.run.id,'Forged person');await f.submit(node);
  assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0].body,'reviewer'),false);assert.equal(Object.hasOwn(f.calls[0].body,'identity'),false);
});

test('an authenticated agent has no review form or owner decision controls',()=>{
  const f=fixture();f.workspace.authentication={mode:'cloudflare-access',principal:{kind:'agent',issuer:'https://team.cloudflareaccess.com',id:'client-id',displayName:'Agent client'},permissions:{review:false,merge:false}};
  assert.equal(find(f.panel(),item=>item.tagName==='FORM'),undefined);assert.equal(f.calls.length,0);
});

test('automatic merge switch is hosted-only, owner-controlled and sends the displayed policy version',async()=>{
  installFakeDOM(); const calls=[];
  const project={automaticMergePolicy:{enabled:false,version:3}};
  const options={project,hosted:true,canManage:true,busy:false,onChange:(...args)=>calls.push(args)};
  assert.equal(automaticMergeControls({...options,hosted:false}),null);
  for(const changed of [{canManage:false},{busy:true},{project:{...project,codeConnected:false}}]) {
    assert.equal(find(automaticMergeControls({...options,...changed}),node=>node.attrs?.role==='switch').disabled,true);
  }
  const control=automaticMergeControls(options),button=find(control,node=>node.attrs?.role==='switch');
  assert.equal(button.attrs['aria-checked'],'false'); assert.match(control.textContent,/including changes already waiting/);
  await button.dispatch('click'); assert.deepEqual(calls,[[true,3]]);
});

test('policy decisions have distinct attribution and a stopped decision can receive owner review',()=>{
  const f=fixture();f.run.status='accepted';f.task.acceptedRunId=f.run.id;
  f.run.review={decision:'accept',reviewer:'Automatic merge policy',headCommit:f.run.headCommit,at:new Date().toISOString(),policy:{version:2,enabledBy:{displayName:'Owner'}}};
  f.workspace.authentication={mode:'cloudflare-access',principal:{kind:'owner',displayName:'Owner'},permissions:{review:true,merge:true}};
  const node=f.panel();assert.match(node.textContent,/Approved by automatic policy/);
  assert.match(node.textContent,/Policy v2 · enabled by Owner/);assert.doesNotMatch(node.textContent,/Authenticated owner · Automatic/);
  assert.ok(find(node,item=>item.tagName==='FORM'));
});

test('name is reused for a new draft while notes and comparison acknowledgements stay specific',async()=>{
  const f=fixture();f.panel();assert.equal(f.review.draftFor(f.run).reviewer,'');
  await f.type('#reviewer-'+f.run.id,'Actual reviewer');await f.type('#review-note-'+f.run.id,'Specific feedback');
  const old=f.review.draftFor(f.run);old.comparisonKey='old heads';
  f.task.revision++;const next=f.review.draftFor(f.run);
  assert.equal(next.reviewer,'Actual reviewer');assert.equal(next.note,'');assert.equal(next.comparisonKey,null);
  assert.equal(old.note,'Specific feedback');assert.equal(old.comparisonKey,'old heads');
  f.session.rememberReviewerName('Different reviewer');assert.equal(f.review.draftFor(f.run).reviewer,'Actual reviewer');
  assert.equal(f.calls.length,0);
});

test('acceptance without a note records only the chosen commit and revision after explicit submission',async()=>{
  const f=fixture(),node=f.panel();await f.type('#reviewer-'+f.run.id,'Reviewer');
  assert.equal(f.$('#accept-'+f.run.id).disabled,false);assert.equal(f.calls.length,0);
  assert.equal(f.$('#review-note-'+f.run.id).attrs.required,undefined);
  assert.match(node.textContent,/Optional when accepting; explain rejections/);
  await f.submit(node);assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].body,{decision:'accept',reviewer:'Reviewer',note:'Accepted commit '+f.run.headCommit+' for requirements r'+f.task.revision+'.',headCommit:f.run.headCommit,taskRevision:f.task.revision,ownerVersion:f.task.ownerVersion,comparisons:[]});
  assert.ok(f.calls[0].path.endsWith('/review'));assert.ok(!f.calls.some(call=>call.path.endsWith('/merge')));
});

test('written acceptance context is preserved rather than replaced with the neutral record',async()=>{
  const f=fixture(),node=f.panel();await f.type('#reviewer-'+f.run.id,'Reviewer');await f.type('#review-note-'+f.run.id,'Checked the keyboard behavior.');
  await f.submit(node);assert.equal(f.calls[0].body.note,'Checked the keyboard behavior.');
});

test('rejection still requires actual feedback even when the name is already filled',async()=>{
  const f=fixture();f.panel();await f.type('#reviewer-'+f.run.id,'Reviewer');
  assert.equal(f.$('#reject-'+f.run.id).disabled,true);
  await f.$('#reject-'+f.run.id).dispatch('click');assert.equal(f.calls.length,0);assert.match(f.errors[0],/feedback/);
  await f.type('#review-note-'+f.run.id,'Keep the comparison guard.');assert.equal(f.$('#reject-'+f.run.id).disabled,false);
  await f.$('#reject-'+f.run.id).dispatch('click');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls[0].body.decision,'reject');assert.equal(f.calls[0].body.note,'Keep the comparison guard.');
});

test('remembered name and optional note do not bypass failed or stale verification',async()=>{
  const f=fixture();f.session.rememberReviewerName('Reviewer');f.context.ready=false;const node=f.panel();
  assert.equal(f.$('#accept-'+f.run.id).disabled,true);await f.submit(node);assert.equal(f.calls.length,0);
});

test('overlap acknowledgement remains explicit and becomes invalid when compared heads change',async()=>{
  const f=fixture();f.session.rememberReviewerName('Reviewer');
  const other={...f.run,id:crypto.randomUUID(),label:'Alternative',headCommit:'c'.repeat(40)};f.workspace.runs.push(other);
  f.context.overlaps=[{runId:other.id,headCommit:other.headCommit,label:other.label,paths:['ui.js']}];
  let node=f.panel();assert.equal(f.$('#accept-'+f.run.id).disabled,true);
  const checkbox=f.$('#comparison-'+f.run.id);checkbox.checked=true;await checkbox.dispatch('change');
  assert.equal(f.$('#accept-'+f.run.id).disabled,false);assert.equal(f.calls.length,0);
  f.context.overlaps[0].headCommit='d'.repeat(40);node=f.panel();assert.equal(f.$('#accept-'+f.run.id).disabled,true);
  await f.submit(node);assert.equal(f.calls.length,0);
});

test('empty reviewer name still blocks a decision',async()=>{
  const f=fixture(),node=f.panel();assert.equal(f.$('#accept-'+f.run.id).disabled,true);
  await f.submit(node);assert.equal(f.calls.length,0);
});
