import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {createWorkspace,createTask,assignRun,startRun,completeRun,verifyRun,reviewRun,codeReviewContext,recordCodeReview,assignReviewers} from '../src/core/workflow.mjs';

// Actual reviewer UI and workflow core with controlled transport only. These
// synthetic checks and owner decisions never reach a hosted service or Git.
let moduleVersion=0;
const all=node=>[node,...node.children.flatMap(all)];
const response=(value,status=200)=>({status,ok:status<400,json:async()=>value});
for(const firstReply of ['lost','malformed'])for(const refusal of [403,422,429])
test(`${firstReply} assessment response then ${refusal} retains one receipt and the existing owner decision`,async()=>{
  const state=createWorkspace({id:'reviewer-retry-fixture',provider:'cloudflare-artifacts'}),head='b'.repeat(40);
  const task=createTask(state,{title:'Synthetic retry case',purpose:'Retain one assessment across response faults.',criteria:['Preserve identity and owner decision.'],baseCommit:'a'.repeat(40),owner:'Owner'});
  const run=assignRun(state,task.id,{agent:'external',label:'Synthetic candidate',branch:'candidate'});
  run.agentIdentity={provider:'cloudflare-access',kind:'agent',issuer:'https://fixture.invalid',id:'builder',workspaceId:state.id,displayName:'Synthetic builder'};
  startRun(state,run.id);completeRun(state,run.id,{headCommit:head,changedFiles:['index.mjs'],diff:'+ source',summary:'Fixture'});
  verifyRun(state,run.id,{verified:true,commit:head,taskRevision:1,passed:1,total:1,checks:[{name:'Synthetic check',passed:true,detail:'No command executed'}],command:'node trusted.mjs',exitCode:0,output:'Fixture only',verifiedAt:new Date().toISOString(),source:'independent-sandbox-checks',verification:{kind:'repository-command-checks/v1',definitionSha256:'1'.repeat(64),verifierSha256:'2'.repeat(64),inputHandoffSha256:'3'.repeat(64),requirementsSha256:'4'.repeat(64),image:'sha256:'+'5'.repeat(64),tree:'6'.repeat(40)}});
  const reviewer={...run.agentIdentity,id:'reviewer',kind:'reviewer',displayName:'Synthetic reviewer'};
  assignReviewers(state,run.id,{contextId:codeReviewContext(state,run.id).contextId,expectedVersion:state.version,reviewerIds:[reviewer.id]},{...reviewer,id:'owner',kind:'owner'},[reviewer.id],'assignment');
  const packet={...codeReviewContext(state,run.id),source:{files:[]},baseSource:{files:[]}},item={workspaceId:state.id,runId:run.id,assignmentId:run.reviewAssignments.at(-1).id,taskTitle:task.title,runLabel:run.label,headCommit:head,assignmentScope:'personal',status:'pending'};
  const {document}=installFakeDOM();document.body=document.createElement('body');document.activeElement=document.body;location.search='';
  const requests=[],receipts=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(path,options)=>{
    if(path==='/api/review-inbox')return response({workspaceId:state.id,principal:reviewer,total:1,items:[item]});
    if(path===`/api/runs/${run.id}/review-context`)return response(packet);
    assert.equal(path,`/api/runs/${run.id}/code-review`);assert.equal(options.method,'POST');
    const input=JSON.parse(options.body),key=options.headers['Idempotency-Key'];requests.push({key,input});
    if(requests.length===2)return response({error:{code:'SYNTHETIC_REFUSAL',message:'Current retry refused.'}},refusal);
    const saved=recordCodeReview(state,run.id,input,reviewer,key);receipts.push(saved.codeReview.id);
    if(requests.length===1)return firstReply==='lost'?response({error:{message:'Response lost after commit.'}},503):response({});
    return response({runId:run.id,codeReview:saved.codeReview});
  };
  try{await import(`../public/reviewer.js?retryAcceptance=${++moduleVersion}`);}finally{globalThis.fetch=originalFetch;}
  await all(document.getElementById('inbox')).find(node=>node.tagName==='BUTTON'&&node.textContent==='Inspect candidate').dispatch('click');
  const form=all(document.getElementById('review')).find(node=>node.tagName==='FORM');
  all(form).find(node=>node.tagName==='SELECT').value='pass';all(form).find(node=>node.tagName==='TEXTAREA').value='Inspected this exact synthetic candidate.';
  await form.dispatch('submit');
  reviewRun(state,run.id,{decision:'accept',note:'Synthetic owner acceptance after the recorded assessment.',reviewer:'Owner',headCommit:head,taskRevision:task.revision,ownerVersion:task.ownerVersion,comparisons:[]});
  const accepted=structuredClone(run.review);
  await form.dispatch('submit');await form.dispatch('submit');
  assert.equal(requests.length,3);assert.equal(new Set(requests.map(item=>item.key)).size,1);
  assert.deepEqual(requests[0].input,requests[1].input);assert.deepEqual(requests[1].input,requests[2].input);
  assert.equal(new Set(receipts).size,1);assert.equal(1+(run.codeReviewHistory?.length??0),1);
  assert.equal(run.status,'accepted');assert.deepEqual(run.review,accepted);
});
