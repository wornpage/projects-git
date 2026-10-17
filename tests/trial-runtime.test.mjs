import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalTrialRuntime} from './helpers/trial-runtime.mjs';

// Local workerd/SQLite fixture; every outbound request is intercepted.
test('local workerd admission RPC and tenant DOs enforce isolation, replay and closure',{timeout:30000},async()=>{
  const runtime=await createLocalTrialRuntime();
  const {token:jwt,request,outbound,policy}=runtime;
  try{
    const a=await jwt('runtime-a'),b=await jwt('runtime-b'),c=await jwt('runtime-c');
    const admitted=await Promise.all([request('/api/trial',a,{}),request('/api/trial',b,{})]);
    for(const response of admitted)assert.equal(response.status,200,await response.clone().text());
    const [ga,gb]=await Promise.all(admitted.map(r=>r.json()));assert.notEqual(ga.workspaceId,gb.workspaceId);
    const repeat=await request('/api/trial',a,{});assert.equal((await repeat.json()).workspaceId,ga.workspaceId);
    assert.equal((await request('/api/trial',c,{})).status,429);
    for(const [token,grant] of [[a,ga],[b,gb]]){
      const response=await request('/api/workspace',token);assert.equal(response.status,200,await response.clone().text());
      const data=await response.json();assert.equal(data.id,grant.workspaceId);assert.equal(data.trial.workflowReady,false);
      assert.equal(data.authentication.permissions.manage,false);
    }
    assert.equal((await request('/api/workspace',a,undefined,{'X-Workspace-Id':gb.workspaceId})).status,403);
    assert.equal((await request('/api/model-runs',a,{})).status,409);
    assert.equal((await request('/api/trial/close',a,{})).status,200);
    assert.equal((await request('/api/workspace',a)).status,403);
    assert.equal((await request('/api/workspace',b)).status,200);
    const resumed=await(await request('/api/trial',a,{})).json();assert.equal(resumed.status,'closed');assert.equal(resumed.workspaceId,ga.workspaceId);
    assert.ok(outbound.length>0);assert.ok(outbound.every(url=>url===policy.issuer+'/cdn-cgi/access/certs'));
  }finally{await runtime.dispose();}
});
