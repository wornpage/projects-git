import {approvedTrialAllowance} from './helpers/trial-policy.mjs';
import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createTrialClient} from '../public/trial/client.js';

const identity={identityKey:'a'.repeat(64),email:'alex@example.test',policy:{revision:'sample-ui-v1',durationMs:604800000},turnstile:{siteKey:"fixture-sitekey",action:"turnstile-spin-v2"}};
const trial={workspaceId:'trial-'+'b'.repeat(64),status:'admitted',createdAt:'2026-10-17T12:00:00Z',expiresAt:'2026-10-24T12:00:00Z',remainingMs:604800000,
  policyRevision:identity.policy.revision,workflowReady:false,capabilities:{workspaceReads:true,repositoryCreation:false,agents:false,checks:false,modelCredits:false},cleanup:'not-due',identityKey:identity.identityKey};
const repo={name:'sample-'+'b'.repeat(64),repositoryId:'repository-fixture',projectId:'11111111-1111-4111-8111-111111111111',baseCommit:'c'.repeat(40)};
const sample=(changes={})=>({workspaceId:trial.workspaceId,template:'checkout-v1',phase:'not-started',retryable:true,repository:null,errorCode:null,workflowReady:false,allowance:structuredClone(approvedTrialAllowance),...changes});
const ready=(changes={})=>sample({phase:'ready',retryable:false,repository:repo,...changes});
const json=value=>Response.json(value),error=(code,status=503)=>Response.json({code,error:'private raw provider error'},{status});
const admission=(value=sample())=>[json(identity),json(trial),json(value)];
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const unexpected=[];afterEach(()=>{assert.deepEqual(unexpected.splice(0),[]);});
function fixture(replies){const calls=[],states=[],timers=[];let sequence=0,clock=0;
  const client=createTrialClient({notify:state=>states.push(state),nonce:()=>`sample-key-${++sequence}`,now:()=>clock,
    setTimer:(fn,ms)=>{const timer={fn,ms,cancelled:false};timers.push(timer);return timer;},clearTimer:timer=>{timer.cancelled=true;},
    fetcher:async(path,options)=>{calls.push({path,options});const reply=replies.shift();if(!reply){unexpected.push(path);throw Error('Unexpected request');}return typeof reply==='function'?reply(path,options):reply;}});
  return {client,calls,states,timers,advance:ms=>{clock+=ms;}};
}

test('unapproved or exhausted allowances cannot send preparation even through direct client calls',async()=>{
  for(const allowance of [
    {spending:'TRIAL_SPENDING_UNAPPROVED',setupAvailable:false,reason:'TRIAL_SPENDING_UNAPPROVED',setupAttempts:{used:0,limit:0},providerCalls:{used:0,limit:0},billingCapGuaranteed:false},
    {...approvedTrialAllowance,setupAvailable:false,reason:'TRIAL_RESOURCE_LIMIT',setupAttempts:{used:10,limit:10}},
  ]){
    const c=fixture(admission(sample({allowance})));await c.client.refresh();assert.equal(c.client.getState().phase,'admitted');
    await c.client.prepareSample();assert.equal(c.calls.length,3);assert.ok(c.calls.every(call=>call.options.method==='GET'));c.client.suspend();
  }
});

test('a claimed invoice cap or inconsistent allowance cannot enable resource work',async()=>{
  for(const change of [{billingCapGuaranteed:true},{providerCalls:{used:0,limit:601}},{reason:'TRIAL_RESOURCE_LIMIT'},
    {spending:'TRIAL_SPENDING_UNAPPROVED'}]){
    const c=fixture(admission(sample({allowance:{...approvedTrialAllowance,...change}})));await c.client.refresh();
    assert.equal(c.client.getState().phase,'failed');assert.equal(c.client.getState().sample,null);c.client.suspend();
  }
});

test('bootstrap inspects sample state with GET only; reservation never automatically prepares it',async()=>{
  const c=fixture(admission());await c.client.refresh();assert.equal(c.client.getState().sample.phase,'not-started');assert.ok(c.calls.every(call=>call.options.method==='GET'));
  const reserve=fixture([json(identity),error('TRIAL_NOT_ADMITTED',404),json(trial),json(sample())]);await reserve.client.refresh();await reserve.client.reserve('fixture-token');
  assert.deepEqual(reserve.calls.filter(call=>call.options.method==='POST').map(call=>call.path),['/api/trial']);assert.equal(reserve.client.getState().sample.phase,'not-started');
});

test('explicit preparation sends one empty, identity-bound POST and disables double submission and closure',async()=>{
  const pending=defer(),c=fixture([...admission(),()=>pending.promise]);await c.client.refresh();const save=c.client.prepareSample();
  await c.client.prepareSample();c.client.confirmClose();assert.equal(c.client.getState().phase,'admitted');assert.equal(c.client.getState().sample.phase,'saving');
  const posts=c.calls.filter(call=>call.options.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/trial/sample');assert.equal(posts[0].options.body,'{}');
  assert.equal(posts[0].options.headers['X-Trial-Identity'],identity.identityKey);assert.equal(posts[0].options.headers['Idempotency-Key'],'sample-key-1');
  pending.resolve(json(ready({replayed:false})));await save;assert.equal(c.client.getState().sample.phase,'ready');assert.equal(c.client.getState().trial.workflowReady,false);
});

test('an uncertain preparation requires status inspection; reads recover ready without another POST',async()=>{
  const c=fixture([...admission(),()=>{throw Error('Lost result');},...admission(ready())]);await c.client.refresh();await c.client.prepareSample();
  assert.equal(c.client.getState().sample.phase,'unknown');assert.equal(c.client.getState().sample.result,null);
  await c.client.prepareSample();assert.equal(c.calls.length,4);await c.client.refresh();assert.equal(c.client.getState().sample.phase,'ready');
  assert.equal(c.calls.filter(call=>call.options.method==='POST').length,1);
});

test('an inspected retryable failure resumes explicitly with the retained key and never changes the expiry',async()=>{
  const interrupted=sample({phase:'failed',retryable:true,repository:{...repo,baseCommit:null},errorCode:'REPOSITORY_CREATION_INTERRUPTED'});
  const c=fixture([...admission(),()=>{throw Error('Lost');},...admission(interrupted),json(ready({replayed:true}))]);await c.client.refresh();c.advance(2000);await c.client.prepareSample();
  const expiry=c.client.getState().trial.expiresAt;await c.client.refresh();await c.client.prepareSample();
  const posts=c.calls.filter(call=>call.options.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
  assert.equal(c.client.getState().sample.phase,'ready');assert.equal(c.client.getState().trial.expiresAt,expiry);
});

test('pending and permanent failures retain their meaning; unsafe states cannot prepare',async()=>{
  for(const value of [ready(),sample({phase:'failed',retryable:false,repository:{...repo,baseCommit:null},errorCode:'REPOSITORY_ID_CHANGED'})]){
    const c=fixture(admission(value));await c.client.refresh();await c.client.prepareSample();assert.equal(c.calls.length,3);
  }
  const pending=sample({phase:'preparing',repository:{...repo,repositoryId:null,baseCommit:null}}),c=fixture([...admission(pending),error('OPERATION_IN_PROGRESS',409)]);
  await c.client.refresh();assert.equal(c.client.getState().sample.phase,'preparing');await c.client.prepareSample();assert.equal(c.client.getState().sample.phase,'unknown');
  await c.client.prepareSample();assert.equal(c.calls.length,4);
});

test('unavailable preparation preserves the verified reservation but offers no mutation',async()=>{
  const c=fixture([json(identity),json(trial),error('TRIAL_SAMPLE_UNAVAILABLE')]);await c.client.refresh();
  assert.equal(c.client.getState().phase,'admitted');assert.equal(c.client.getState().sample.phase,'unavailable');await c.client.prepareSample();assert.equal(c.calls.length,3);
});

test('an inconsistent saved setup requires operator attention without offering another preparation',async()=>{
  const c=fixture([json(identity),json(trial),error('TRIAL_SAMPLE_STATE_CHANGED',409)]);await c.client.refresh();
  assert.equal(c.client.getState().sample.phase,'blocked');assert.equal(c.client.getState().sample.result,null);await c.client.prepareSample();assert.equal(c.calls.length,3);
});

test('a foreign sample response clears all earlier identity, trial and sample data',async()=>{
  const c=fixture(admission(ready({workspaceId:'trial-'+'d'.repeat(64)})));await c.client.refresh();
  assert.equal(c.client.getState().phase,'signedOut');assert.equal(c.client.getState().identity,null);assert.equal(c.client.getState().trial,null);assert.equal(c.client.getState().sample,null);
});

for(const code of ['TRIAL_IDENTITY_CHANGED','TRIAL_SAMPLE_FORBIDDEN','WORKSPACE_FORBIDDEN','TRIAL_CLOSED','TRIAL_EXPIRED'])
test(`${code} during preparation removes the previous sample and prevents retry`,async()=>{
  const c=fixture([...admission(),error(code,code==='TRIAL_IDENTITY_CHANGED'?409:403)]);await c.client.refresh();await c.client.prepareSample();
  assert.equal(c.client.getState().identity,null);assert.equal(c.client.getState().sample,null);await c.client.prepareSample();assert.equal(c.calls.length,4);
});

test('suspension fences a late preparation result; a fresh identity cannot inherit its repository or key',async()=>{
  const pending=defer(),other={...identity,identityKey:'e'.repeat(64),email:'blair@example.test'};
  const c=fixture([...admission(),()=>pending.promise,json(other),error('TRIAL_NOT_ADMITTED',404)]);await c.client.refresh();const save=c.client.prepareSample();
  c.client.suspend();assert.equal(c.client.getState().sample,null);await c.client.refresh();pending.resolve(json(ready({replayed:false})));await save;
  assert.equal(c.client.getState().phase,'eligible');assert.equal(c.client.getState().identity.email,other.email);assert.equal(c.client.getState().sample,null);
});

test('an explicit status read can abandon a pending response and ignore its later completion',async()=>{
  const pending=defer(),c=fixture([...admission(),()=>pending.promise,...admission(ready())]);await c.client.refresh();const old=c.client.prepareSample();
  await c.client.refresh();pending.resolve(error('TRIAL_IDENTITY_CHANGED',409));await old;
  assert.equal(c.client.getState().phase,'admitted');assert.equal(c.client.getState().sample.phase,'ready');assert.equal(c.calls.filter(call=>call.options.method==='POST').length,1);
});

test('sample updates and closure confirmations retain the observed expiry deadline',async()=>{
  const c=fixture([...admission(),json(ready({replayed:false}))]);await c.client.refresh();c.advance(5000);await c.client.prepareSample();
  assert.equal(c.timers.at(-1).ms,604795100);c.advance(1000);c.client.confirmClose();assert.equal(c.timers.at(-1).ms,604794100);
  c.client.suspend();assert.ok(c.timers.every(timer=>timer.cancelled));
});

test('preparation at the observed expiry rechecks access instead of sending a POST',async()=>{
  const expired={...trial,status:'expired',remainingMs:0,capabilities:{...trial.capabilities,workspaceReads:false},cleanup:'pending'};
  const c=fixture([...admission(),json(identity),json(expired)]);await c.client.refresh();c.advance(trial.remainingMs);await c.client.prepareSample();
  assert.equal(c.client.getState().phase,'expired');assert.equal(c.client.getState().sample,null);assert.ok(c.calls.every(call=>call.options.method==='GET'));
});

test('malformed or overclaimed sample DTOs never create a ready state or a usable action',async()=>{
  for(const value of [ready({workflowReady:true}),ready({repository:{...repo,name:'unrelated'}}),ready({repository:{...repo,projectId:'javascript:alert(1)'}}),
    ready({repository:{...repo,baseCommit:null}}),ready({retryable:true}),ready({token:'must-not-be-used'}),sample({repository:repo}),sample({phase:'failed',repository:repo}),
    sample({phase:'preparing',repository:repo,errorCode:'REPOSITORY_CREATION_INTERRUPTED'})]){
    const c=fixture(admission(value));await c.client.refresh();assert.equal(c.client.getState().phase,'failed');assert.equal(c.client.getState().sample,null);await c.client.prepareSample();assert.equal(c.calls.length,3);
  }
  const badPost=fixture([...admission(),json({...sample(),replayed:false})]);await badPost.client.refresh();await badPost.client.prepareSample();assert.equal(badPost.client.getState().phase,'failed');
});

test('HTML access denials clear the entire current identity instead of retaining sample data',async()=>{
  const c=fixture([...admission(),new Response('<h1>Access denied</h1>',{status:403,headers:{'Content-Type':'text/html'}})]);await c.client.refresh();await c.client.prepareSample();
  assert.equal(c.client.getState().phase,'signedOut');assert.equal(c.client.getState().identity,null);assert.equal(c.client.getState().sample,null);
});
