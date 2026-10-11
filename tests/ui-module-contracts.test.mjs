import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../public/api-client.js';
import {createReviewForm} from '../public/ui/review-form.js';
import {createTaskComposer} from '../public/ui/task-composer.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {el} from '../public/ui/dom.js';
import {createWorkspace,createTask,assignRun,startRun,completeRun,verifyRun,reviewRun} from '../src/core/workflow.mjs';

test('one HTTP client uses the Access browser session, preserves guards and never retries a mutation',async()=>{
  const calls=[];let auth=0;
  const api=createApiClient({onAuthRequired:()=>auth++,fetchRequest:async(path,options)=>{
    calls.push({path,options});return {status:409,ok:false,json:async()=>({error:{code:'STALE',message:'Refresh the current revision.'}})};
  }});
  await assert.rejects(api('/api/task/revise',{expectedRevision:3},'request-one'),error=>error.status===409 && error.code==='STALE');
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers['Idempotency-Key'],'request-one');assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(JSON.parse(calls[0].options.body).expectedRevision,3);assert.equal(auth,0);
});

test('extracted review form sends acceptance and merge as separate guarded requests',async()=>{
  const {$}=installFakeDOM(),workspace=createWorkspace(),calls=[],errors=[],drafts=new Map();
  const task=createTask(workspace,{title:'Review',purpose:'Review the exact commit',criteria:['Passing'],owner:'Owner',baseCommit:'a'.repeat(40)});
  const run=assignRun(workspace,task.id,{agent:'external',label:'Candidate',branch:'newwork/test'});
  startRun(workspace,run.id);completeRun(workspace,run.id,{headCommit:'b'.repeat(40),changedFiles:['file.js'],diff:'',summary:'Retained'});
  verifyRun(workspace,run.id,{verified:true,source:'independent-local-checks',commit:run.headCommit,taskRevision:task.revision,
    passed:1,total:1,checks:[{name:'Passing',passed:true,detail:'Observed'}],command:'node check',exitCode:0,output:'pass',verifiedAt:'2026-10-05T21:00:00Z'});
  workspace.capabilities={merge:true};
  let ready=false;
  const coordination=()=>({acceptance:[{met:ready,label:'Current proof'}],overlaps:[],activeRunIds:[],blockingRunIds:[]});
  const review=createReviewForm({getContext:()=>({workspace,busy:false,sessionWarning:false}),drafts,
    getReviewerName:()=>'',rememberReviewerName(){},
    api:async(path,body)=>{calls.push({path,body});return {};},mutate:async action=>action(),refresh:async()=>{},saveSession(){},showError:message=>errors.push(message),
    runCoordination:coordination,comparisonKey:()=> '[]',comparisonHeads:()=>[],acceptanceReady:()=>true,
    disclosure:(id,title,...body)=>el('details',{id},el('summary',{},title),...body),evidenceChecks(){},diffPanel(){},switchView(){},
  });
  let panel=review.reviewPanel(run,task);const draft=review.draftFor(run);draft.reviewer='Human';draft.note='Inspected this commit.';
  function find(node,predicate){if(predicate(node))return node;for(const child of node.children??[]){const result=find(child,predicate);if(result)return result;}}
  let form=find(panel,node=>node.tagName==='FORM');await form.dispatch('submit');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,0);assert.equal($('#accept-'+run.id).disabled,true);
  ready=true;panel=review.reviewPanel(run,task);form=find(panel,node=>node.tagName==='FORM');await form.dispatch('submit');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.ok(calls[0].path.endsWith('/review'));assert.equal(calls[0].body.decision,'accept');
  assert.equal(calls[0].body.headCommit,run.headCommit);assert.equal(calls[0].body.taskRevision,task.revision);assert.equal(calls[0].body.ownerVersion,task.ownerVersion);
  reviewRun(workspace,run.id,calls[0].body);
  panel=review.reviewPanel(run,task);const merge=find(panel,node=>node.tagName==='BUTTON'&&node.textContent==='Merge accepted candidate');
  assert.equal(merge.disabled,false);await merge.dispatch('click');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2);assert.ok(calls[1].path.endsWith('/merge'));assert.deepEqual(calls[1].body,{headCommit:run.headCommit});
});

test('extracted task composer preserves prerequisite references when removing a draft',async()=>{
  const {$}=installFakeDOM(),messages=[];$('#task-source').value='repository';
  const taskStack=[{title:'First',purpose:'First',criteria:'A',owner:'Owner'},{title:'Unused',purpose:'Unused',criteria:'B',owner:'Owner'},
    {title:'Client',purpose:'Client',criteria:'C',owner:'Owner',dependsOn:['draft:1']}];
  const composer=createTaskComposer({getContext:()=>({workspace:{tasks:[],capabilities:{dependencies:true}},taskStack}),saveSession(){},updateChrome(){},showError:message=>messages.push(message)});
  composer.renderTaskDrafts();
  await $('#task-drafts').children[0].children[1].dispatch('click');
  const fields=$('#task-drafts').children[1];
  const remove=fields.children.find(node=>node.tagName==='BUTTON');await remove.dispatch('click');
  assert.equal(taskStack.length,2);assert.equal(taskStack[1].title,'Client');assert.deepEqual(taskStack[1].dependsOn,['draft:1']);assert.deepEqual(messages,[]);
});
