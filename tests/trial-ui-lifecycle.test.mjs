import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createTrialClient} from '../public/trial/client.js';
import {renderTrial} from '../public/trial/view.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

test('the real signup tab lifecycle clears A while hidden and checks B on return without a mutation',async()=>{
  const {$,document}=installFakeDOM(),listeners=new Map(),calls=[];
  document.body={classList:{add(){}}};document.addEventListener=(name,callback)=>listeners.set(name,callback);
  let email='alex@example.test',identityKey='a'.repeat(64),latest,client;
  const context={document,location:{pathname:'/trial/signup'},renderTrial,addEventListener(){},createTrialClient:options=>{
    client=createTrialClient({...options,setTimer:()=>0,clearTimer(){},fetcher:async(path,request)=>{
      calls.push({path,method:request.method});
      return path==='/api/trial/session'?Response.json({identityKey,email,policy:{revision:'test',durationMs:604800000}})
        :Response.json({code:'TRIAL_NOT_ADMITTED'},{status:404});
    }});
    const refresh=client.refresh;client.refresh=()=>latest=refresh();return client;
  }};
  const source=readFileSync(new URL('../public/trial/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  runInNewContext(source,context);await latest;assert.match($('#trial-state').textContent,/alex@example.test/);
  document.hidden=true;listeners.get('visibilitychange')();assert.ok(!$('#trial-state').textContent.includes('alex@example.test'));assert.equal(client.getState().identity,null);
  email='blair@example.test';identityKey='b'.repeat(64);document.hidden=false;listeners.get('visibilitychange')();
  assert.equal(client.getState().phase,'checking');assert.equal(client.getState().identity,null);await latest;
  assert.match($('#trial-state').textContent,/blair@example.test/);assert.ok(!$('#trial-state').textContent.includes('alex@example.test'));
  assert.equal(calls.length,4);assert.ok(calls.every(call=>call.method==='GET'));client.suspend();
});

test('returning as B cannot retain A’s ready sample link or repository metadata in the real app renderer',async()=>{
  const {$,document}=installFakeDOM(),listeners=new Map(),calls=[];document.body={classList:{add(){}}};document.addEventListener=(name,fn)=>listeners.set(name,fn);
  let owner='a',latest,client;
  const workspaceId='trial-'+'b'.repeat(64),projectId='11111111-1111-4111-8111-111111111111';
  const context={document,location:{pathname:'/trial/signup'},renderTrial,addEventListener(){},createTrialClient:options=>{
    client=createTrialClient({...options,setTimer:()=>0,clearTimer(){},fetcher:async(path,request)=>{
      calls.push({path,method:request.method});
      if(path==='/api/trial/session')return Response.json({identityKey:owner.repeat(64),email:owner==='a'?'alex@example.test':'blair@example.test',policy:{revision:'test',durationMs:604800000}});
      if(owner==='b')return Response.json({code:'TRIAL_NOT_ADMITTED'},{status:404});
      if(path==='/api/trial')return Response.json({workspaceId,status:'admitted',createdAt:'2026-10-17T12:00:00Z',expiresAt:'2026-10-24T12:00:00Z',remainingMs:604800000,policyRevision:'test',workflowReady:false,
        capabilities:{workspaceReads:true,repositoryCreation:false,agents:false,checks:false,modelCredits:false},cleanup:'not-due',identityKey:'a'.repeat(64)});
      return Response.json({workspaceId,template:'checkout-v1',phase:'ready',retryable:false,repository:{name:'sample-'+'b'.repeat(64),repositoryId:'a-repository',projectId,baseCommit:'c'.repeat(40)},errorCode:null,workflowReady:false});
    }});
    const refresh=client.refresh;client.refresh=()=>latest=refresh();return client;
  }};
  const source=readFileSync(new URL('../public/trial/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');runInNewContext(source,context);await latest;
  assert.ok($('#trial-state').querySelector('#open-sample'));assert.match($('#trial-state').textContent,/alex@example.test/);
  document.hidden=true;listeners.get('visibilitychange')();assert.equal($('#trial-state').querySelector('#open-sample'),null);assert.ok(!$('#trial-state').textContent.includes('alex@example.test'));
  owner='b';document.hidden=false;listeners.get('visibilitychange')();await latest;
  assert.match($('#trial-state').textContent,/blair@example.test/);assert.equal($('#trial-state').querySelector('#open-sample'),null);assert.equal(client.getState().sample,null);
  assert.ok(!$('#trial-state').textContent.includes('a-repository'));assert.ok(calls.every(call=>call.method==='GET'));assert.equal(calls.length,5);client.suspend();
});
