import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrialClient} from '../public/trial/client.js';

const session={identityKey:'a'.repeat(64),email:'alex@example.test',policy:{revision:'ui-v1',durationMs:604800000},turnstile:{siteKey:"fixture-sitekey",action:"turnstile-spin-v2"}};
const status=(changes={})=>({workspaceId:'trial-'+'b'.repeat(64),status:'admitted',createdAt:'2026-10-17T12:00:00.000Z',expiresAt:'2026-10-24T12:00:00.000Z',
  remainingMs:604800000,policyRevision:'ui-v1',workflowReady:false,capabilities:{workspaceReads:true,repositoryCreation:false,agents:false,checks:false,modelCredits:false},cleanup:'not-due',identityKey:session.identityKey,...changes});
const json=value=>Response.json(value),error=(code,http=503)=>Response.json({code,error:'untrusted server details must not be displayed'},{status:http});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(replies){const calls=[],states=[],timers=[];let i=0,clock=0;const client=createTrialClient({nonce:()=>`test-request-key-${++i}`,notify:s=>states.push(s),now:()=>clock,
  setTimer:(callback,ms)=>{const timer={callback,ms,cancelled:false};timers.push(timer);return timer;},clearTimer:timer=>{timer.cancelled=true;},
  // These admission tests deliberately use the existing metadata-only config.
  fetcher:async(path,options)=>{calls.push({path,options});if(path==='/api/trial/sample')return error('TRIAL_SAMPLE_UNAVAILABLE');
    const reply=replies.shift();assert.ok(reply,'Unexpected HTTP request '+path);return typeof reply==='function'?reply(path,options):reply;}});return{client,calls,states,timers,advance:ms=>{clock+=ms;}};}
const eligible=()=>[json(session),error('TRIAL_NOT_ADMITTED',404)];

test('bootstrap verifies identity before offering reservation and uses actual server duration',async()=>{
  const c=fixture(eligible());await c.client.refresh();const state=c.client.getState();
  assert.equal(state.phase,'eligible');assert.equal(state.identity.policy.durationMs,604800000);assert.equal(state.trial,null);
  assert.deepEqual(c.calls.map(x=>x.path),['/api/trial/session','/api/trial']);assert.ok(c.calls.every(x=>x.options.method==='GET'));
});

test('double clicks create one request with a security token, stable key and verified identity precondition',async()=>{
  const pending=deferred(),c=fixture([...eligible(),()=>pending.promise]);await c.client.refresh();
  const save=c.client.reserve('fixture-token');await c.client.reserve('fixture-token');assert.equal(c.client.getState().phase,'reserving');
  const posts=c.calls.filter(x=>x.options.method==='POST');assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].options.body),{turnstileToken:'fixture-token'});
  assert.equal(posts[0].options.headers['X-Trial-Identity'],session.identityKey);assert.equal(posts[0].options.headers['Idempotency-Key'],'test-request-key-1');
  pending.resolve(json(status()));await save;assert.equal(c.client.getState().phase,'admitted');assert.equal(c.client.getState().trial.workflowReady,false);
});

test('a lost save response offers inspection, then recovers the reservation with no repeated POST',async()=>{
  const c=fixture([...eligible(),()=>{throw Error('connection lost');},json(session),json(status())]);
  await c.client.refresh();await c.client.reserve('fixture-token');assert.equal(c.client.getState().phase,'failed');assert.equal(c.client.getState().error,'NETWORK_UNCERTAIN');
  assert.equal(c.client.getState().identity,null);assert.equal(c.client.getState().trial,null);
  await c.client.reserve('fixture-token');assert.equal(c.calls.filter(x=>x.options.method==='POST').length,1);
  await c.client.refresh();assert.equal(c.client.getState().phase,'admitted');assert.equal(c.calls.filter(x=>x.options.method==='POST').length,1);
});

test('an inspected missing reservation retries explicitly with the same idempotency key',async()=>{
  const c=fixture([...eligible(),()=>{throw Error('lost');},...eligible(),json(status())]);
  await c.client.refresh();await c.client.reserve('fixture-token');await c.client.refresh();await c.client.reserve('fixture-token');
  const posts=c.calls.filter(x=>x.options.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].options.headers['Idempotency-Key'],posts[1].options.headers['Idempotency-Key']);
});

test('capacity has its own state and never retries or assumes when a slot will open',async()=>{
  const c=fixture([...eligible(),error('TRIAL_CAPACITY_FULL',429)]);await c.client.refresh();await c.client.reserve('fixture-token');
  assert.equal(c.client.getState().phase,'capacity');await c.client.reserve('fixture-token');assert.equal(c.calls.length,3);
});

test('closure requires confirmation and keeps an uncertain result out of an open-workspace success state',async()=>{
  const closed=status({status:'closed',remainingMs:0,capabilities:{...status().capabilities,workspaceReads:false},cleanup:'pending'});
  const c=fixture([json(session),json(status()),()=>{throw Error('lost close');},json(session),json(closed)]);
  await c.client.refresh();await c.client.close();assert.equal(c.calls.length,3);
  c.client.confirmClose();assert.equal(c.client.getState().phase,'confirm-close');c.client.cancelClose();assert.equal(c.client.getState().phase,'admitted');
  c.client.confirmClose();await c.client.close();assert.equal(c.client.getState().phase,'failed');
  await c.client.refresh();assert.equal(c.client.getState().phase,'closed');await c.client.reserve('fixture-token');assert.equal(c.calls.filter(x=>x.options.method==='POST').length,1);
});

test('identity changes on mutation clear all previous user data and deny automatic continuation',async()=>{
  const c=fixture([...eligible(),error('TRIAL_IDENTITY_CHANGED',409)]);await c.client.refresh();await c.client.reserve('fixture-token');
  assert.deepEqual(c.client.getState(),{phase:'signedOut',identity:null,trial:null,error:'TRIAL_IDENTITY_CHANGED',sample:null});
  await c.client.reserve('fixture-token');assert.equal(c.calls.length,3);
});

test('a status response for a different identity is never displayed',async()=>{
  const c=fixture([json(session),json(status({identityKey:'c'.repeat(64)}))]);await c.client.refresh();
  assert.equal(c.client.getState().phase,'signedOut');assert.equal(c.client.getState().identity,null);assert.equal(c.client.getState().trial,null);
});

test('a late old bootstrap cannot overwrite a newer identity or continue its status request',async()=>{
  const old=deferred(),other={...session,identityKey:'c'.repeat(64),email:'blair@example.test'};
  const c=fixture([()=>old.promise,json(other),error('TRIAL_NOT_ADMITTED',404)]);
  const first=c.client.refresh();await c.client.refresh();old.resolve(json(session));await first;
  assert.equal(c.client.getState().identity.email,'blair@example.test');assert.equal(c.calls.length,3);assert.equal(c.calls[0].options.signal.aborted,true);
});

test('suspending clears identity and prevents a delayed reservation result from repainting it',async()=>{
  const pending=deferred(),c=fixture([...eligible(),()=>pending.promise]);await c.client.refresh();const save=c.client.reserve('fixture-token');
  c.client.suspend();pending.resolve(json(status()));await save;assert.deepEqual(c.client.getState(),{phase:'checking',identity:null,trial:null,error:null,sample:null});
});

test('closed and expired results offer neither renewal nor closure mutations',async()=>{
  for(const phase of ['closed','expired']){
    const c=fixture([json(session),json(status({status:phase,remainingMs:0,capabilities:{...status().capabilities,workspaceReads:false},cleanup:'pending'}))]);
    await c.client.refresh();assert.equal(c.client.getState().phase,phase);await c.client.reserve('fixture-token');c.client.confirmClose();await c.client.close();assert.equal(c.calls.length,2);
  }
});

test('authentication failure and redirects become sign-in states with no reservation',async()=>{
  for(const reply of [error('UNAUTHORIZED',401),{status:0,type:'opaqueredirect'}]){
    const c=fixture([reply]);await c.client.refresh();assert.equal(c.client.getState().phase,'signedOut');assert.equal(c.client.getState().identity,null);assert.equal(c.calls.length,1);
  }
});

test('an authentication failure after identity lookup clears the earlier email',async()=>{
  for(const code of ['HUMAN_IDENTITY_REQUIRED','TRIAL_IDENTITY_FORBIDDEN']){
    const c=fixture([json(session),error(code,403)]);await c.client.refresh();assert.equal(c.client.getState().identity,null);assert.equal(c.client.getState().trial,null);
  }
});

test('expiry schedules one status read and suspension cancels it without an automatic mutation',async()=>{
  const c=fixture([json(session),json(status())]);await c.client.refresh();assert.equal(c.timers.filter(timer=>!timer.cancelled).length,1);assert.equal(c.timers.at(-1).ms,604800100);
  c.client.suspend();assert.ok(c.timers.every(timer=>timer.cancelled));assert.equal(c.calls.length,3);assert.equal(c.client.getState().identity,null);
});

test('opening or cancelling closure never extends the observed expiry deadline',async()=>{
  const c=fixture([json(session),json(status())]);await c.client.refresh();const initial=c.timers.at(-1);c.advance(5000);c.client.confirmClose();
  assert.equal(initial.cancelled,true);assert.equal(c.timers.at(-1).ms,604795100);const confirming=c.timers.at(-1);
  c.advance(1000);c.client.cancelClose();assert.equal(confirming.cancelled,true);assert.equal(c.timers.at(-1).ms,604794100);
  c.client.suspend();assert.ok(c.timers.every(timer=>timer.cancelled));assert.equal(c.calls.length,3);
});

test('HTML, oversized JSON and unsupported capability claims fail without fabricated success',async()=>{
  for(const reply of [new Response('<html>Access login</html>',{headers:{'Content-Type':'text/html'}}),json({padding:'x'.repeat(40000)}),json({wrong:'shape'}),error('TRIAL_NOT_ADMITTED',500),json(status({workflowReady:true}))]){
    const c=fixture([json(session),reply]);await c.client.refresh();assert.equal(c.client.getState().phase,'failed');assert.equal(c.client.getState().trial,null);
  }
});
