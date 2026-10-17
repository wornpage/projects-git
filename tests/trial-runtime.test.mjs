import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';

// This is a local workerd/SQLite fixture, not Cloudflare account qualification.
// No provider binding exists; every outbound request is handled in this process.
test('local workerd admission RPC and tenant DOs enforce isolation, replay and closure',{timeout:30000},async()=>{
  const issuer='https://fixture.cloudflareaccess.com',audience='a'.repeat(64);
  const pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'runtime-fixture',alg:'RS256'};
  const policy={revision:'runtime-local-v1',issuer,audience,durationMs:60000,dailyAdmissions:2,activeTrials:2,totalAdmissions:2};
  const result=await build({entryPoints:[new URL('../src/cloudflare/trial-worker.ts',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')],bundle:true,write:false,
    platform:'neutral',format:'esm',target:'es2022',external:['cloudflare:*','node:*'],mainFields:['module','main'],conditions:['workerd','worker','browser'],
    banner:{js:'import {createRequire} from "node:module"; const require = createRequire("/trial.mjs");'},logLevel:'silent'});
  const outbound=[];
  const mf=new Miniflare({host:'127.0.0.1',port:0,inspectorPort:0,telemetry:{enabled:false},logRequests:false,workers:[{
    config:{name:'trial-fixture',compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'trial.mjs',modules:{'trial.mjs':{type:'esm',contents:result.outputFiles[0].text}}},
      env:{WORKSPACE_ID:{type:'text',value:''},ACCESS_OWNER_SUB:{type:'text',value:''},TRIAL_POLICY:{type:'text',value:JSON.stringify(policy)},
        TRIAL_REGISTRY:{type:'durable-object',worker:'trial-fixture',exportName:'TrialAdmissions'},
        WORKSPACES:{type:'durable-object',worker:'trial-fixture',exportName:'WorkspaceCoordinator'}},
      exports:{TrialAdmissions:{type:'durable-object',storage:'sqlite'},WorkspaceCoordinator:{type:'durable-object',storage:'sqlite'}}},
    dev:{unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:request=>{
      outbound.push(request.url);assert.equal(request.url,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});}}}}]});
  try{
    const jwt=async sub=>{const now=Math.floor(Date.now()/1000);return new SignJWT({type:'app',iss:issuer,aud:[audience],sub,email:'runtime@example.test',iat:now-1,exp:now+3600}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);};
    const a=await jwt('runtime-a'),b=await jwt('runtime-b'),c=await jwt('runtime-c');
    const request=async(path,token,body,headers={})=>mf.dispatchFetch('https://trial.example.test'+path,{method:body===undefined?'GET':'POST',
      headers:{'Cf-Access-Jwt-Assertion':token,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':'runtime-admission-key','Origin':'https://trial.example.test'}),...headers},
      body:body===undefined?undefined:JSON.stringify(body)});
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
    assert.ok(outbound.length>0);assert.ok(outbound.every(url=>url===issuer+'/cdn-cgi/access/certs'));
  }finally{await mf.dispose();}
});
