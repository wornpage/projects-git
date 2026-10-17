import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {trialAccessPolicy,trialGrant} from '../src/cloudflare/trial-admission.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {index,policy,verifier,handler,token,context,fixture,req,admit} from './helpers/trial-http.mjs';

test('verified human admission is self-service, stable and not a false ready/sample/workflow success',async()=>{
  const c=fixture(),jwt=await token();
  assert.equal((await handler(req('/api/trial',jwt),c.env)).status,404);
  const first=await admit(c,jwt),again=await admit(c,jwt);
  assert.equal(first.workspaceId,again.workspaceId);assert.equal(first.status,'admitted');assert.equal(first.workflowReady,false);
  assert.equal(first.capabilities.repositoryCreation,false);assert.equal(c.calls.length,0);
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,1);
  const workspace=await handler(req('/api/workspace',jwt),c.env);assert.equal(workspace.status,200);
  const value=await workspace.json();assert.equal(value.id,first.workspaceId);assert.equal(value.trial.status,'admitted');
  assert.equal(value.authentication.permissions.manage,false);assert.ok(Object.values(value.capabilities).every(v=>v===false));
});

test('missing, forged, wrong-audience, expired, service and unverified identities cannot touch admission or workspaces',async()=>{
  const c=fixture();
  for(const jwt of [undefined,'forged',await token('a',{aud:['b'.repeat(64)]}),await token('a',{iss:'https://other.cloudflareaccess.com'}),
    await token('a',{exp:Math.floor(Date.now()/1000)-1}),await token('',{common_name:'b'.repeat(32)+'.access',email:undefined}),
    await token('a',{email_verified:false}),await token('a',{email_verified:'false'}),await token('a',{email:'invalid'}),await token('a',{iat:Math.floor(Date.now()/1000)+10})]){
    const result=await handler(req('/api/trial',jwt,{}),c.env);assert.ok([401,403].includes(result.status));
  }
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);assert.deepEqual(c.calls,[]);assert.deepEqual(c.assetCalls,[]);
});

test('admission rejects client identity/role/limits, query selectors, cross-origin writes and missing keys before reservation',async()=>{
  const c=fixture(),jwt=await token();
  for(const body of [{email:'victim@example.test'},{workspaceId:'real-workspace'},{ownerSubject:'victim'},{role:'owner'},{durationMs:99999999},{policy:{}}])
    assert.equal((await handler(req('/api/trial',jwt,body),c.env)).status,400);
  for(const path of ['/api/trial?workspaceId=real','/api/trial?email=victim'])assert.equal((await handler(req(path,jwt,{}),c.env)).status,400);
  const missingKey=req('/api/trial',jwt,{});missingKey.headers.delete('Idempotency-Key');assert.equal((await handler(missingKey,c.env)).status,400);
  assert.equal((await handler(req('/api/trial',jwt,{}, {'Origin':'https://evil.test'}),c.env)).status,403);
  assert.equal((await handler(req('/api/trial',jwt,{}, {'X-Workspace-Id':'real-workspace'}),c.env)).status,400);
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);assert.deepEqual(c.calls,[]);
});

test('two tenants get distinct real SQLite workspaces; header/query/foreign record IDs never select another tenant',async()=>{
  const c=fixture(),a=await token(),b=await token('person-b'),ga=await admit(c,a),gb=await admit(c,b);
  for(const jwt of [a,b])assert.equal((await handler(req('/api/workspace',jwt),c.env)).status,200);
  for(const [grant,label] of [[ga,'A private work'],[gb,'B private work']]){
    const store=new WorkspaceStore(c.contexts.get(grant.workspaceId).storage,grant.workspaceId),snapshot=store.read();snapshot.workspace.name=label;const revision=snapshot.revision;snapshot.revision++;store.write(snapshot,revision);
  }
  const ownA=await(await handler(req('/api/workspace',a),c.env)).json(),ownB=await(await handler(req('/api/workspace',b),c.env)).json();
  assert.equal(ownA.name,'A private work');assert.equal(ownB.name,'B private work');assert.notEqual(ownA.id,ownB.id);
  const before=c.calls.length;
  for(const path of ['/api/workspace?workspaceId='+gb.workspaceId,'/api/workspace?workspaceId='+ga.workspaceId+'&workspaceId='+gb.workspaceId,'/api/workspace?workspace=real-private'])
    assert.equal((await handler(req(path,a),c.env)).status,403);
  assert.equal((await handler(req('/api/workspace',a,undefined,{'X-Workspace-Id':gb.workspaceId}),c.env)).status,403);
  assert.equal(c.calls.length,before);
  const otherProject=crypto.randomUUID();
  const storeA=new WorkspaceStore(c.contexts.get(ga.workspaceId).storage,ga.workspaceId),snapshot=storeA.read();
  snapshot.workspace.projects[otherProject]={id:otherProject,name:'A secret project',repositoryName:'a-private'};const revision=snapshot.revision;snapshot.revision++;storeA.write(snapshot,revision);
  const catalog=await(await handler(req('/api/projects/catalog',b),c.env)).json();assert.equal(catalog.total,0);assert.doesNotMatch(JSON.stringify(catalog),/A secret/);
  const foreign=await handler(req('/api/projects/'+otherProject+'/metrics',b),c.env);assert.equal(foreign.status,403);
  const denied=await foreign.json();assert.equal(denied.code,'PROJECT_FORBIDDEN');assert.doesNotMatch(JSON.stringify(denied),/A secret/);
});

test('coordinator independently checks registry owner and current policy instead of trusting a forged RPC call',async()=>{
  const c=fixture(),a=await token(),b=await token('person-b'),ga=await admit(c,a),gb=await admit(c,b);
  await handler(req('/api/workspace',a),c.env);await handler(req('/api/workspace',b),c.env);
  const identity=await verifier.authenticateHuman(req('/api/workspace',b),policy),grant=trialGrant(await c.registry.read(identity,policy));
  const caller={provider:'cloudflare-access',kind:'owner',issuer:identity.issuer,id:identity.subject,workspaceId:gb.workspaceId,displayName:identity.displayName,issuedAt:identity.issuedAt,expiresAt:identity.expiresAt};
  const input={principal:{...caller,workspaceId:ga.workspaceId},policy:{...trialAccessPolicy(grant),workspaceId:ga.workspaceId},trialPolicy:policy,forbiddenSecrets:[],method:'GET',path:'/api/workspace',body:{},key:'',search:''};
  assert.equal((await c.contexts.get(ga.workspaceId).coordinator.api(input)).status,403);
  input.principal=caller;input.policy={...trialAccessPolicy(grant),agentClientIds:['b'.repeat(32)+'.access']};
  assert.equal((await c.contexts.get(gb.workspaceId).coordinator.api(input)).status,403);
});

test('all external workflow, discovery, backups, indexes, events and queue paths fail closed',async()=>{
  const c=fixture(),jwt=await token(),grant=await admit(c,jwt);
  for(const [path,body] of [['/api/repositories',undefined],['/api/repositories',{}],['/api/tasks',{}],['/api/model-runs',{}],['/api/workspace/backup',undefined],
    ['/api/projects/'+crypto.randomUUID()+'/search?q=secret',undefined],['/api/runs/'+crypto.randomUUID()+'/verify',{}],['/api/workspace/restore',{}]])
    assert.equal((await handler(req(path,jwt,body),c.env)).status,409,path);
  assert.deepEqual(c.calls,[]);
  await handler(req('/api/workspace',jwt),c.env);const coordinator=c.contexts.get(grant.workspaceId).coordinator;
  await assert.rejects(coordinator.indexProject(crypto.randomUUID(),0,false),{code:'TRIAL_CAPABILITY_UNAVAILABLE'});
  await assert.rejects(coordinator.artifactPush({},'event'),{code:'TRIAL_CAPABILITY_UNAVAILABLE'});
  await assert.rejects(index.default.queue({messages:[],queue:'anything'},c.env),{code:'TRIAL_CAPABILITY_UNAVAILABLE'});
  await coordinator.alarm(); // no scheduling or provider invocation
});

test('closure and exact-boundary expiry revoke coordinator and assets access without deleting records or restarting a trial',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const c=fixture(),jwt=await token(),grant=await admit(c,jwt);await handler(req('/api/workspace',jwt),c.env);
  now=Date.parse(grant.expiresAt);
  assert.equal((await handler(req('/api/workspace',jwt),c.env)).status,403);assert.equal((await handler(req('/workspace/',jwt),c.env)).status,403);
  const again=await admit(c,jwt);assert.equal(again.status,'expired');assert.equal(again.expiresAt,grant.expiresAt);
  const b=await token('person-b'),bg=await admit(c,b);await handler(req('/api/workspace',b),c.env);
  assert.equal((await handler(req('/api/trial/close',b,{}),c.env)).status,200);
  assert.equal((await handler(req('/api/workspace',b),c.env)).status,403);
  const status=await admit(c,b);assert.equal(status.status,'closed');assert.equal(status.workspaceId,bg.workspaceId);assert.equal(status.cleanup,'not-implemented');
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,2);
});

test('dedicated deployment refuses pinned-owner or provider bindings and missing deterministic object names',async()=>{
  const c=fixture(),jwt=await token();
  for(const changes of [{WORKSPACE_ID:'real-private'},{ACCESS_OWNER_SUB:'real-owner'},{ARTIFACTS:{}},{SEARCH_DB:{}},{LOADER:{}},{CURRENT_POLICY:{}},{MODEL_API_KEY:'private-key'}])
    assert.equal((await handler(req('/api/trial',jwt,{}),{...c.env,...changes})).status,503);
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);
  for(const name of [undefined,'competition','trial-short']){
    const sql=sqliteStorage();assert.throws(()=>new index.WorkspaceCoordinator(context(sql.storage,name),c.env),{code:'TRIAL_ROUTING_REQUIRED'});
    assert.equal(sql.storage.sql.exec("SELECT count(*) n FROM sqlite_master WHERE name='workspace_header'").one().n,0);
  }
});

test('real pinned-owner handler stays separate; neither application accepts the other audience',async()=>{
  const c=fixture(),jwt=await token();let dispatches=0;
  const env={WORKSPACE_ID:'real-private',ACCESS_OWNER_SUB:'real-owner',ACCESS_TEAM_DOMAIN:policy.issuer,ACCESS_AUD:'b'.repeat(64),ACCESS_AGENT_CLIENT_IDS:'[]',
    WORKSPACES:{getByName:id=>{assert.equal(id,'real-private');dispatches++;return{api:async()=>Response.json({id})};}},ASSETS:{fetch:async()=>new Response('private-static')}};
  const pinned=index.createAuthenticatedFetch(verifier),real=await token('real-owner',{aud:['b'.repeat(64)]});
  assert.equal((await pinned(req('/api/workspace',jwt),env)).status,401);assert.equal(dispatches,0);
  assert.equal((await pinned(req('/api/workspace',real),env)).status,200);assert.equal(dispatches,1);
  assert.equal((await handler(req('/api/trial',real,{}),c.env)).status,401);
  const mismatch=await pinned(req('/api/tasks',real,{expectedWorkspaceId:'victim'},{'X-Workspace-Id':'real-private'}),env);
  assert.equal(mismatch.status,403);assert.equal(dispatches,1);
});

test('registry outage returns a bounded failure, never the real or a default workspace',async()=>{
  const c=fixture(),jwt=await token();await admit(c,jwt);
  c.env.TRIAL_REGISTRY={getByName:()=>{throw new Error('internal registry secret');}};
  const result=await handler(req('/api/workspace',jwt),c.env);assert.equal(result.status,502);assert.doesNotMatch(await result.text(),/internal registry secret/);assert.deepEqual(c.calls,[]);
});

test('a misbound registry reply cannot disclose another owner admission or load workspace assets',async()=>{
  const c=fixture(),a=await token(),b=await token('person-b');await admit(c,b);
  const other=await verifier.authenticateHuman(req('/api/trial',b),policy),reply=await c.registry.read(other,policy);
  c.env.TRIAL_REGISTRY={getByName:()=>({read:async()=>reply,admit:async()=>reply})};
  for(const request of [req('/api/trial',a),req('/api/trial',a,{}),req('/workspace/',a)]){
    const response=await handler(request,c.env);assert.equal(response.status,403);assert.doesNotMatch(await response.text(),new RegExp(reply.grant.workspaceId));
  }
  assert.deepEqual(c.calls,[]);assert.deepEqual(c.assetCalls,[]);
});

test('current Worker settings cannot silently use a retained registry with older admission terms',async()=>{
  const c=fixture(),jwt=await token();await admit(c,jwt);
  const count=c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n;
  for(const change of [{revision:'next-policy'},{durationMs:120000},{dailyAdmissions:1}]){
    const env={...c.env,TRIAL_POLICY:JSON.stringify({...policy,...change})};
    for(const request of [req('/api/trial',jwt),req('/api/trial',jwt,{}),req('/api/workspace',jwt),req('/api/trial/close',jwt,{})]){
      const response=await handler(request,env);assert.equal(response.status,503);assert.equal((await response.json()).code,'TRIAL_POLICY_CHANGED');
    }
  }
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,count);assert.deepEqual(c.calls,[]);
});
