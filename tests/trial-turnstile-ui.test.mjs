import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrialVerification} from '../public/trial/turnstile.js';
import {createTrialClient} from '../public/trial/client.js';
import {renderTrial} from '../public/trial/view.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
const identity={email:'alex@example.test',identityKey:'a'.repeat(64),policy:{revision:'test',durationMs:60000},turnstile:{siteKey:'fixture-sitekey',action:'turnstile-spin-v2'}};
const eligible={phase:'eligible',identity,trial:null,error:null};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({loadApi,compact=false}={}){
  installFakeDOM();const root=document.createElement('div'),announcement=document.createElement('p'),renders=[],removed=[];
  const api={render:(container,options)=>{renders.push(options);return renders.length;},remove:id=>removed.push(id)};
  const verification=createTrialVerification({root,loadApi:loadApi??(async()=>api),compact:()=>compact});
  const show=state=>{renderTrial(root,announcement,state,{});verification.sync(state);};
  return {root,renders,removed,verification,show,api};
}
test('only eligible reservations mount a widget; success enables once and expiry requires a fresh token',async()=>{
  const f=fixture({compact:true});f.show(eligible);assert.equal(f.root.querySelector('#reserve-trial').disabled,true);await tick();
  assert.equal(f.renders[0].size,'compact');assert.equal(f.renders[0].action,'turnstile-spin-v2');
  f.renders[0].callback('token-a');assert.equal(f.root.querySelector('#reserve-trial').disabled,false);
  f.renders[0]['expired-callback']();assert.equal(f.root.querySelector('#reserve-trial').disabled,true);assert.equal(f.verification.take(),'');
  f.root.querySelector('#trial-turnstile-retry').onclick();await tick();f.renders[1].callback('token-b');
  assert.equal(f.verification.take(),'token-b');assert.equal(f.verification.take(),'');
  f.show({phase:'closed',identity:null,trial:null});assert.equal(f.root.querySelector('#trial-turnstile'),null);assert.equal(f.renders.length,2);
});
test('late loads and callbacks from a previous identity cannot enable the current reservation',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r),f=fixture({loadApi:()=>pending});f.show(eligible);
  f.show({phase:'checking',identity:null});resolve(f.api);await tick();assert.equal(f.renders.length,0);
  const g=fixture();g.show(eligible);await tick();const stale=g.renders[0];
  g.show({...eligible,identity:{...identity,email:'blair@example.test',identityKey:'b'.repeat(64)}});await tick();
  stale.callback('stale');assert.equal(g.root.querySelector('#reserve-trial').disabled,true);assert.equal(g.verification.take(),'');
});
test('script errors and widget timeouts leave the action disabled with an explicit retry',async()=>{
  const f=fixture({loadApi:async()=>{throw Error('blocked');}});f.show(eligible);await tick();
  assert.equal(f.root.querySelector('#reserve-trial').disabled,true);assert.equal(f.root.querySelector('#trial-turnstile-retry').hidden,false);
  const g=fixture();g.show(eligible);await tick();g.renders[0].callback('token');g.renders[0]['timeout-callback']();
  assert.equal(g.verification.take(),'');assert.equal(g.root.querySelector('#reserve-trial').disabled,true);
});
test('client refuses a missing token and keeps verification tokens out of published state',async()=>{
  const calls=[],states=[],client=createTrialClient({notify:s=>states.push(s),setTimer:()=>0,clearTimer(){},fetcher:async(path,init)=>{
    calls.push({path,init});if(path==='/api/trial/session')return Response.json(identity);
    if(init.method==='GET')return Response.json({code:'TRIAL_NOT_ADMITTED'},{status:404});
    return Response.json({code:'TRIAL_VERIFICATION_FAILED'},{status:403});
  }});
  await client.refresh();await client.reserve();assert.equal(calls.length,2);await client.reserve('private-token');
  assert.deepEqual(JSON.parse(calls[2].init.body),{turnstileToken:'private-token'});assert.doesNotMatch(JSON.stringify(states),/private-token/);
  assert.equal(client.getState().error,'TRIAL_VERIFICATION_FAILED');await client.reserve('another');assert.equal(calls.length,3);
});
