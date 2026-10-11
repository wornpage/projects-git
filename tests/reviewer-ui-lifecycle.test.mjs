import test from 'node:test';
import assert from 'node:assert/strict';
import {installFakeDOM} from './helpers/fake-dom.mjs';

let moduleVersion=0;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const find=(node,predicate)=>predicate(node)?node:node.children?.map(child=>find(child,predicate)).find(Boolean);
const response=(value,status=200)=>({status,ok:status<400,json:async()=>value});

async function fixture({search='',status='pending',packetAssignment='assignment-a'}={}){
  const {document}=installFakeDOM();document.body=document.createElement('body');
  location.search=search;
  const item={workspaceId:'workspace',assignmentId:'assignment-a',runId:'candidate',taskTitle:'Review',runLabel:'Candidate',headCommit:'b'.repeat(40),assignmentScope:'personal',status};
  let principal={kind:'reviewer',id:'reviewer-a',displayName:'Reviewer A'};
  const calls=[],arrivals=[],reads=[];
  const packet={contextId:'context',context:{workspaceId:'workspace',runId:'candidate',reviewAssignmentId:packetAssignment,headCommit:item.headCommit,baseCommit:'a'.repeat(40),taskRevision:1},
    candidate:{changedFiles:[],diff:''},source:{files:[]},baseSource:{files:[]}};
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async(path,options)=>{
    if(path==='/api/review-inbox')return response({workspaceId:'workspace',principal,total:1,items:[item]});
    if(path.endsWith('/review-context')){reads.push(path);return response(packet);}
    assert.equal(path,'/api/runs/candidate/code-review');
    const call={body:JSON.parse(options.body),key:options.headers['Idempotency-Key'],...deferred()};
    calls.push(call);arrivals[calls.length-1]?.resolve(call);return call.promise;
  };
  try{await import(`../public/reviewer.js?test=${++moduleVersion}`);}finally{globalThis.fetch=previousFetch;}
  const inbox=()=>document.getElementById('inbox'),review=()=>document.getElementById('review');
  const button=(node,text)=>find(node,value=>value.tagName==='BUTTON'&&value.textContent===text);
  const inspect=()=>button(inbox(),'Inspect candidate').dispatch('click');
  const form=()=>find(review(),node=>node.tagName==='FORM');
  function submit(summary){
    find(form(),node=>node.tagName==='SELECT').value='pass';
    find(form(),node=>node.tagName==='TEXTAREA').value=summary;
    return form().dispatch('submit');
  }
  async function changeIdentity(id){
    principal={kind:'reviewer',id,displayName:id};
    // The click schedules loadInbox. Observe its explicit completion through status(),
    // instead of a timer or an assumption about the number of promise continuations.
    const status=document.getElementById('status'),loaded=deferred();
    Object.defineProperty(status,'className',{configurable:true,set(value){this.classValue=value;
      if(this.textContent==='Choose an assigned candidate.')loaded.resolve();},get(){return this.classValue;}});
    await button(inbox(),'All · 1').dispatch('click');await loaded.promise;
  }
  return {calls,reads,document,review,inspect,submit,changeIdentity,
    submitButton:()=>button(form(),'Submit independent assessment'),
    controls:()=>find(form(),node=>node.tagName==='FIELDSET'),
    waitForCall:index=>calls[index]?Promise.resolve(calls[index]):(arrivals[index]??=deferred()).promise};
}

test('reopening a candidate retains its pending guard and uncertain retry identity',async()=>{
  const f=await fixture();await f.inspect();
  const first=f.submit('Same assessment');await f.waitForCall(0);
  await f.inspect();assert.equal(f.submitButton().disabled,true);assert.equal(f.controls().disabled,true);
  await f.submit('Same assessment');assert.equal(f.calls.length,1);
  f.calls[0].resolve(response({error:{message:'Response uncertain'}},503));await first;
  assert.equal(f.submitButton().disabled,false);assert.equal(f.controls().disabled,false);
  const retry=f.submit('Same assessment');await f.waitForCall(1);
  assert.equal(f.calls[1].key,f.calls[0].key);assert.deepEqual(f.calls[1].body,f.calls[0].body);
  f.calls[1].resolve(response({error:{message:'Invalid assessment'}},422));await retry;
});

test('a human link opens only the matching saved assignment and performs no mutation',async()=>{
  const f=await fixture({search:'?workspace=workspace&run=candidate&assignment=assignment-a'});
  assert.equal(f.reads.length,1);assert.equal(f.calls.length,0);
  assert.match(f.review().textContent,/Your assessment/);
  assert.match(f.document.getElementById('inbox').textContent,/Awaiting review/);
  assert.match(f.document.getElementById('inbox').textContent,/Shared assignments/);
  assert.doesNotMatch(f.document.getElementById('inbox').textContent,/my team/);
});

for(const search of ['?workspace=foreign&run=candidate&assignment=assignment-a','?workspace=workspace&run=foreign&assignment=assignment-a',
  '?workspace=workspace&run=candidate&assignment=old','?workspace=workspace&run=candidate',
  '?workspace=workspace&workspace=foreign&run=candidate&assignment=assignment-a'])test(`unavailable or superseded link does not fetch source: ${search}`,async()=>{
  const f=await fixture({search});assert.deepEqual(f.reads,[]);assert.deepEqual(f.calls,[]);
  assert.match(f.document.getElementById('error-text').textContent,/link/);assert.equal(f.review().textContent,'');
});

test('a changed assignment between the inbox and source read never renders the new packet',async()=>{
  const f=await fixture({search:'?workspace=workspace&run=candidate&assignment=assignment-a',packetAssignment:'assignment-b'});
  assert.equal(f.reads.length,1);assert.equal(f.review().textContent,'');
  assert.match(f.document.getElementById('error-text').textContent,/assignment changed/);
});

test('a stale request cannot open source from a shared link or inbox action',async()=>{
  const f=await fixture({search:'?workspace=workspace&run=candidate&assignment=assignment-a',status:'stale'});
  assert.deepEqual(f.reads,[]);assert.match(f.document.getElementById('inbox').textContent,/Needs renewed assignment/);
  assert.equal(find(f.document.getElementById('inbox'),node=>node.tagName==='BUTTON'&&node.textContent==='Inspect candidate').disabled,true);
});

for(const oldStatus of [200,422])test(`late reviewer ${oldStatus} cannot erase a new session's uncertain retry key`,async()=>{
  const f=await fixture();await f.inspect();const old=f.submit('Earlier assessment');await f.waitForCall(0);
  await f.changeIdentity('reviewer-b');await f.changeIdentity('reviewer-a');await f.inspect();
  const newer=f.submit('Newer assessment');await f.waitForCall(1);
  assert.notEqual(f.calls[0].key,f.calls[1].key);
  f.calls[0].resolve(response(oldStatus===200?{codeReview:{id:'old'}}:{error:{message:'Old refusal'}},oldStatus));await old;
  assert.equal(f.submitButton().disabled,true);assert.equal(f.controls().disabled,true);
  f.calls[1].resolve(response({error:{message:'Response uncertain'}},503));await newer;
  const retry=f.submit('Newer assessment');await f.waitForCall(2);
  assert.equal(f.calls[2].key,f.calls[1].key);assert.deepEqual(f.calls[2].body,f.calls[1].body);
  f.calls[2].resolve(response({error:{message:'Invalid assessment'}},422));await retry;
  assert.equal(f.calls.length,3);
});

test('retained assessment keys belong to one viewer session',async()=>{
  const f=await fixture();await f.inspect();const first=f.submit('Same assessment');await f.waitForCall(0);
  f.calls[0].resolve(response({error:{message:'Response uncertain'}},503));await first;
  await f.changeIdentity('reviewer-b');await f.inspect();
  const other=f.submit('Same assessment');await f.waitForCall(1);
  assert.notEqual(f.calls[1].key,f.calls[0].key);
  f.calls[1].resolve(response({error:{message:'Invalid assessment'}},422));await other;
});
