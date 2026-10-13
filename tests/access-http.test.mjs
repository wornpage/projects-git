import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {AccessVerifier} from '../src/cloudflare/access.ts';
import {testAuthority,AGENT_CLIENT,REVIEWER_CLIENT} from './helpers/hosted-authority.mjs';

const file=new URL('../src/cloudflare/index.ts',import.meta.url),require=createRequire(file),module={exports:{}};
const compiled=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code;
new Function('require','module','exports',compiled)(name=>name==='cloudflare:workers'?{DurableObject:class{},WorkerEntrypoint:class{}}:name==='./check-container.ts'?{RepositoryCheckContainer:class{}}:require(name),module,module.exports);
const policy=testAuthority().policy,pair=await generateKeyPair('RS256'),key={...await exportJWK(pair.publicKey),kid:'key',alg:'RS256'};
const jwt=async(kind='owner',changes={})=>new SignJWT({type:'app',iss:policy.issuer,aud:[policy.audience],sub:kind==='owner'?policy.ownerSubject:'',...(kind==='owner'?{email:'owner@example.test'}:{common_name:AGENT_CLIENT}),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...changes}).setProtectedHeader({alg:'RS256',kid:'key'}).sign(pair.privateKey);
const handler=module.exports.createAuthenticatedFetch(new AccessVerifier(async()=>Response.json({keys:[key]})));
function fixture(){const calls=[],assets=[];return{calls,assets,env:{ACCESS_TEAM_DOMAIN:policy.issuer,ACCESS_AUD:policy.audience,ACCESS_OWNER_SUB:policy.ownerSubject,ACCESS_AGENT_CLIENT_IDS:JSON.stringify(policy.agentClientIds),WORKSPACE_ID:policy.workspaceId,
  WORKSPACES:{getByName:id=>{calls.push({id});return{api:call=>{calls.push({call});return Response.json({ok:true});}};}},ASSETS:{fetch:request=>{assets.push(request.url);return new Response('static');}}}};}
async function request(path,token,body,headers={}){return new Request('https://workspace.example.test'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...(body!==undefined?{'Content-Type':'application/json','Idempotency-Key':'http-contract-request'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});}

test('display-name writes retain the owner-only Worker boundary for agents and both reviewer kinds',async()=>{
  const f=fixture();f.env.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify([REVIEWER_CLIENT]);f.env.ACCESS_REVIEWER_SUBJECTS=JSON.stringify(['human-reviewer']);
  const path='/api/workspace/reviewer-name',body={reviewerId:REVIEWER_CLIENT,name:'Review agent',expectedVersion:1};
  for(const token of [undefined,await jwt('agent'),await jwt('agent',{common_name:REVIEWER_CLIENT}),await jwt('owner',{sub:'human-reviewer',email:'reviewer@example.test'})]){
    const response=await handler(await request(path,token,body),f.env);assert.ok([401,403].includes(response.status));
  }
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.assets,[]);
  assert.equal((await handler(await request(path,await jwt(),body),f.env)).status,200);
  assert.equal(f.calls[1].call.principal.id,policy.ownerSubject);
});

test('Worker refuses invalid sessions and agent owner-actions before DO access or static assets',async()=>{
  const f=fixture();
  for(const input of [await request('/api/workspace'),await request('/app.js'),await request('/api/workspace','forged'),await request('/api/tasks',await jwt('agent'),{})]){
    const response=await handler(input,f.env);assert.ok([401,403].includes(response.status));
  }
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.assets,[]);
});

test('repository discovery is owner-only before the Durable Object is reached',async()=>{
  const f=fixture();f.env.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify([REVIEWER_CLIENT]);
  for(const path of ['/api/repositories','/api/repositories/head?name=starter']){
    for(const token of [undefined,await jwt('agent'),await jwt('agent',{common_name:REVIEWER_CLIENT})])
      assert.ok([401,403].includes((await handler(await request(path,token),f.env)).status));
    assert.equal(f.calls.length,0);
  }
  const result=await handler(await request('/api/repositories/head?name=starter',await jwt()),f.env);assert.equal(result.status,200);
  assert.equal(f.calls[1].call.principal.kind,'owner');assert.equal(f.calls[1].call.search,'?name=starter');
});

test('Worker binds the verified principal, excludes body impersonation, and protects static assets',async()=>{
  const f=fixture(),token=await jwt();
  assert.equal((await handler(await request('/api/workspace',token),f.env)).status,200);
  assert.equal(f.calls[0].id,policy.workspaceId);assert.equal(f.calls[1].call.principal.id,policy.ownerSubject);assert.equal(f.calls[1].call.principal.displayName,'owner@example.test');
  assert.equal((await handler(await request('/app.js',token),f.env)).status,200);assert.equal(f.assets.length,1);
});

test('Worker forwards its current validated policy and ignores body or header policy injection',async()=>{
 const f=fixture(),token=await jwt();f.env.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify([REVIEWER_CLIENT]);
 await handler(await request('/api/workspace',token),f.env);
 assert.deepEqual(f.calls[1].call.policy.reviewerClientIds,[REVIEWER_CLIENT]);
 f.env.ACCESS_REVIEWER_CLIENT_IDS='[]';
 await handler(await request('/api/tasks',token,{policy:{reviewerClientIds:[REVIEWER_CLIENT]}},{'X-Access-Policy':JSON.stringify(policy)}),f.env);
 assert.deepEqual(f.calls[3].call.policy.reviewerClientIds,[]);assert.equal(f.calls[3].call.policy.audience,policy.audience);
 assert.deepEqual(f.calls[1].call.policy.reviewerClientIds,[REVIEWER_CLIENT]);
});

test('wrong workspace and credential-bearing bodies refuse before state, forks or issuance',async()=>{
  const f=fixture(),token=await jwt();
  assert.equal((await handler(await request('/api/tasks',token,{expectedWorkspaceId:'other'}),f.env)).status,403);
  assert.equal((await handler(await request('/api/workspace',token,undefined,{'X-Workspace-Id':'other'}),f.env)).status,403);
  assert.equal((await handler(await request('/api/tasks',token,{note:token}),f.env)).status,400);
  assert.deepEqual(f.calls,[]);
});

test('project export and restore require the owner before durable dispatch',async()=>{
 const id=crypto.randomUUID(),f=fixture();f.env.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify([REVIEWER_CLIENT]);
 for(const token of [await jwt('agent'),await jwt('agent',{common_name:REVIEWER_CLIENT})]) {
  for(const [path,body] of [[`/api/projects/${id}/export`,undefined],[`/api/projects/${id}/history`,undefined],['/api/projects/restore',{}]])
   assert.equal((await handler(await request(path,token,body),f.env)).status,403);
 }
 assert.deepEqual(f.calls,[]);
 const token=await jwt();
 assert.equal((await handler(await request('/api/projects/restore',token,{}),f.env)).status,200);
 assert.equal(f.calls[1].call.key,'http-contract-request');
});

test('missing Access configuration never falls back to a shared bearer secret',async()=>{
  const f=fixture();delete f.env.ACCESS_OWNER_SUB;f.env.CONTROL_TOKEN='old-token';
  const response=await handler(await request('/api/workspace',await jwt(),undefined,{Authorization:'Bearer old-token'}),f.env);
  assert.equal(response.status,503);assert.deepEqual(f.calls,[]);
});

test('entrance is opt-in; enabled public paths never reach the workspace and private paths still require JWTs',async()=>{
  for (const flag of [undefined,'false','TRUE','1']) {
    const f=fixture();f.env.PUBLIC_ENTRANCE_ENABLED=flag;
    assert.equal((await handler(await request('/'),f.env)).status,401);
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.assets,[]);
  }
  const f=fixture();f.env.PUBLIC_ENTRANCE_ENABLED='true';
  f.env.ASSETS.fetch=request=>{f.assets.push(request.url);return new Response('<html><body>Public entrance</body></html>');};
  assert.equal((await handler(await request('/'),f.env)).status,200);
  assert.equal(f.assets.length,1);assert.deepEqual(f.calls,[]);
  f.assets.length=0;
  for(const path of ['/api/workspace','/api/tasks','/workspace/','/workspace/assets/app.js','/workspace/reviewer','/app.js']) {
    assert.equal((await handler(await request(path),f.env)).status,401,path);
  }
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.assets,[]);
  assert.equal((await handler(await request('/demo/assets/reviewer.js'),f.env)).status,404);
  assert.equal((await handler(await request('/api/workspace','forged'),f.env)).status,401);
  assert.equal((await handler(await request('/api/tasks',await jwt('agent'),{}),f.env)).status,403);
  assert.deepEqual(f.calls,[]);
  assert.equal((await handler(await request('/api/workspace',await jwt()),f.env)).status,200);
  assert.equal(f.calls[1].call.principal.id,policy.ownerSubject);
});

test('invalid owner assertions cannot load protected workbench assets when the entrance is enabled',async()=>{
  const f=fixture();f.env.PUBLIC_ENTRANCE_ENABLED='true';
  for(const token of ['forged',await jwt('owner',{aud:['b'.repeat(64)]}),await jwt('owner',{sub:'another-owner'})])
    assert.ok([401,403].includes((await handler(await request('/workspace/assets/app.js',token),f.env)).status));
  assert.deepEqual(f.assets,[]);assert.deepEqual(f.calls,[]);
  assert.equal((await handler(await request('/workspace/assets/app.js',await jwt()),f.env)).status,200);
  assert.equal(f.assets.length,1);assert.match(f.assets[0],/\/app.js$/);
});

test('reviewer tokens authorize only sealed context reads and assessment writes before DO access',async()=>{
 const f=fixture();f.env.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify([REVIEWER_CLIENT]);const token=await jwt('agent',{common_name:REVIEWER_CLIENT}),id=crypto.randomUUID();
 for(const [path,body] of [['/api/workspace',undefined],[`/api/runs/${id}/start`,{}],[`/api/runs/${id}/submit`,{}],[`/api/runs/${id}/review`,{}],[`/api/runs/${id}/merge`,{}],[`/api/runs/${id}/checks`,{}],[`/api/projects/${id}/claim`,{}],['/api/tasks',{}]])assert.equal((await handler(await request(path,token,body),f.env)).status,403);
 assert.deepEqual(f.calls,[]);
 assert.equal((await handler(await request(`/api/runs/${id}/review-context`,token),f.env)).status,200);
 assert.equal(f.calls[1].call.principal.kind,'reviewer');assert.equal(f.calls[1].call.principal.id,REVIEWER_CLIENT);
 assert.equal((await handler(await request(`/api/runs/${id}/code-review`,token,{contextId:'a'.repeat(64),verdict:'pass',findings:'Reviewed'}),f.env)).status,200);
 assert.equal((await handler(await request(`/api/runs/${id}/review-inference`,token,{contextId:'a'.repeat(64)}),f.env)).status,200);
 assert.equal((await handler(await request(`/api/runs/${id}/review-inference/${crypto.randomUUID()}/reconcile`,token,{}),f.env)).status,403);
 assert.equal((await handler(await request(`/api/runs/${id}/review-inference/${crypto.randomUUID()}/reconcile`,await jwt(),{}),f.env)).status,200);
 const human=fixture();human.env.ACCESS_REVIEWER_SUBJECTS=JSON.stringify(['human-reviewer']);
 const humanToken=await jwt('owner',{sub:'human-reviewer',email:'reviewer@example.test'});
 assert.equal((await handler(await request('/api/review-inbox',humanToken),human.env)).status,200);
 assert.equal(human.calls[1].call.principal.kind,'reviewer');
 assert.equal((await handler(await request('/api/tasks',humanToken,{}),human.env)).status,403);
 const overlap=fixture();overlap.env.ACCESS_REVIEWER_CLIENT_IDS=JSON.stringify([AGENT_CLIENT]);assert.equal((await handler(await request('/api/workspace',await jwt()),overlap.env)).status,503);assert.deepEqual(overlap.calls,[]);
});
