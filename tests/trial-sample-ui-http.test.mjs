import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrialClient} from '../public/trial/client.js';
import {renderTrial} from '../public/trial/view.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
import {trialSampleFixture} from './helpers/trial-sample.mjs';
import {handler,token} from './helpers/trial-http.mjs';

async function clientFixture(t,{loseSampleResponse=false}={}) {
  const server=await trialSampleFixture(t),jwt=await token(),calls=[];let lost=false;
  const client=createTrialClient({setTimer:()=>0,clearTimer(){},fetcher:async(path,options)=>{
    calls.push({path,method:options.method,body:options.body});
    const response=await handler(new Request('https://trial.example.test'+path,{...options,headers:{...options.headers,'Cf-Access-Jwt-Assertion':jwt,Origin:'https://trial.example.test'}}),server.env);
    if(loseSampleResponse&&!lost&&path==='/api/trial/sample'&&options.method==='POST'&&response.ok){lost=true;throw Error('Controlled lost response');}
    return response;
  }});
  return {server,client,calls};
}

test('the UI client explicitly prepares one real local Git sample through the authenticated HTTP contract',async t=>{
  const f=await clientFixture(t);await f.client.refresh();assert.equal(f.client.getState().phase,'eligible');await f.client.reserve('fixture-token');
  assert.equal(f.client.getState().sample.phase,'not-started');assert.equal(f.server.count('create'),0);
  await f.client.prepareSample();const state=f.client.getState();assert.equal(state.sample.phase,'ready');assert.equal(state.trial.workflowReady,false);
  assert.equal(f.server.count('create'),1);assert.equal(f.server.count('seed'),1);
  const {document}=installFakeDOM(),root=document.createElement('div'),announcement=document.createElement('p');renderTrial(root,announcement,state,f.client);
  assert.equal(root.querySelector('#open-sample').attrs.href,'/workspace/?view=queue&project='+state.sample.result.repository.projectId);
  await f.client.refresh();assert.equal(f.client.getState().sample.phase,'ready');assert.equal(f.calls.filter(call=>call.method==='POST').length,2);
  assert.ok([...f.server.repositories.values()].every(repo=>[...repo.tokens.values()].every(token=>token.state==='revoked')));f.client.suspend();
});

test('a lost real setup response recovers by status read without another creation or push',async t=>{
  const f=await clientFixture(t,{loseSampleResponse:true});await f.client.refresh();await f.client.reserve('fixture-token');await f.client.prepareSample();
  assert.equal(f.client.getState().sample.phase,'unknown');assert.equal(f.client.getState().sample.result,null);
  await f.client.prepareSample();assert.equal(f.calls.filter(call=>call.path==='/api/trial/sample'&&call.method==='POST').length,1);
  await f.client.refresh();assert.equal(f.client.getState().sample.phase,'ready');assert.equal(f.server.count('create'),1);assert.equal(f.server.count('seed'),1);
  assert.equal(f.calls.filter(call=>call.path==='/api/trial/sample'&&call.method==='POST').length,1);f.client.suspend();
});
