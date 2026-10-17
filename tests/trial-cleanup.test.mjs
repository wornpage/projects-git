import test from 'node:test';
import assert from 'node:assert/strict';
import {trialSampleFixture} from './helpers/trial-sample.mjs';
import {handler,req,admit,token} from './helpers/trial-http.mjs';
import {unapprovedTrialResources} from './helpers/trial-policy.mjs';
import {retainedTrialCleanup} from '../src/cloudflare/trial-cleanup.ts';

const prepare=(f,jwt)=>handler(req('/api/trial/sample',jwt,{}),f.env);
async function prepared(t){const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);assert.equal((await prepare(f,jwt)).status,201);return{f,jwt,grant};}
async function end(f,jwt,grant){
  assert.equal((await handler(req('/api/trial/close',jwt,{}),f.env)).status,200);
  // Advance only fixture timestamps past the explicit five-minute retention.
  f.sql.storage.sql.exec('UPDATE trial_admissions SET created_at=created_at-600000,expires_at=expires_at-600000,closed_at=closed_at-600000 WHERE workspace_id=?',grant.workspaceId);
}
function retryNow(f){f.sql.storage.sql.exec('UPDATE trial_cleanup SET next_at=? WHERE next_at IS NOT NULL',Date.now()-1);}
const status=async(f,jwt)=>(await handler(req('/api/trial',jwt),f.env)).json();

test('unapproved trial setup performs no provider creation, Git push or implicit approval',async t=>{
  const f=await trialSampleFixture(t,{policyOverrides:{resources:unapprovedTrialResources}}),jwt=await token();await admit(f,jwt);
  const sample=await(await handler(req('/api/trial/sample',jwt),f.env)).json();
  assert.equal(sample.allowance.setupAvailable,false);assert.equal(sample.allowance.spending,'TRIAL_SPENDING_UNAPPROVED');
  const denied=await prepare(f,jwt);assert.equal(denied.status,403);assert.equal((await denied.json()).code,'TRIAL_SPENDING_UNAPPROVED');
  assert.equal(f.count('create'),0);assert.equal(f.count('seed'),0);assert.equal(f.repositories.size,0);
});

test('confirmed cleanup purges only the owned repository/workspace, retains its receipt and admission/usage fences',async t=>{
  const {f,jwt,grant}=await prepared(t),policy=JSON.parse(f.env.TRIAL_POLICY);
  await f.registry.pauseResources(policy,'OWNER_STOP');await end(f,jwt,grant);await f.registry.alarm();
  assert.equal(f.count('delete'),1);assert.equal(f.repositories.size,0);assert.equal((await status(f,jwt)).cleanup,'complete');
  const local=f.contexts.get(grant.workspaceId);
  assert.deepEqual(retainedTrialCleanup(local.storage),{state:'complete',resources:1,deleted:1,reason:null});
  assert.equal(local.storage.sql.exec("SELECT count(*) n FROM sqlite_master WHERE name='workspace_records'").one().n,0);
  assert.equal(f.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,1);
  assert.equal(f.sql.storage.sql.exec('SELECT count(*) n FROM trial_resource_usage').one().n,1);
  f.restart(grant.workspaceId);await f.registry.alarm();assert.equal(f.count('delete'),1);
  assert.deepEqual(f.store(grant.workspaceId).read().workspace.projects,{});
  const repeat=await admit(f,jwt);assert.equal(repeat.status,'closed');assert.equal(repeat.workspaceId,grant.workspaceId);
  assert.equal((await handler(req('/api/workspace',jwt),f.env)).status,403);
});

test('a lost successful delete acknowledgement is confirmed by observation without a second delete',async t=>{
  const {f,jwt,grant}=await prepared(t);f.hooks.afterDelete=async()=>{delete f.hooks.afterDelete;throw Error('Lost delete response');};
  await end(f,jwt,grant);await f.registry.alarm();assert.equal((await status(f,jwt)).cleanup,'pending');
  assert.equal(f.count('delete'),1);assert.equal(f.repositories.size,0);
  assert.equal(retainedTrialCleanup(f.contexts.get(grant.workspaceId).storage),null);
  retryNow(f);f.restart(grant.workspaceId);await f.registry.alarm();
  assert.equal((await status(f,jwt)).cleanup,'complete');assert.equal(f.count('delete'),1);
});

test('an unconfirmed delete is never blindly repeated and six retained attempts stop automatic work',async t=>{
  const {f,jwt,grant}=await prepared(t);f.hooks.beforeDelete=async()=>{throw Error('Unknown delete outcome');};
  await end(f,jwt,grant);
  for(let i=0;i<6;i++){retryNow(f);await f.registry.alarm();}
  assert.equal(f.count('delete'),1);assert.equal(f.repositories.size,1);assert.equal((await status(f,jwt)).cleanup,'blocked');
  assert.equal(f.sql.storage.sql.exec('SELECT attempts,next_at FROM trial_cleanup').one().attempts,6);
  assert.equal(f.sql.storage.sql.exec('SELECT next_at FROM trial_cleanup').one().next_at,null);
  assert.equal(retainedTrialCleanup(f.contexts.get(grant.workspaceId).storage),null);
  await f.registry.alarm();assert.equal(f.count('delete'),1);
});

test('a replaced or foreign repository is not revoked, deleted, or called cleaned',async t=>{
  const {f,jwt,grant}=await prepared(t),repo=[...f.repositories.values()][0],revocations=f.count('revoke');
  repo.data.id='replacement';repo.data.description='Unrelated owner';repo.tokens.set('foreign',{id:'foreign',state:'active'});
  await end(f,jwt,grant);await f.registry.alarm();
  assert.equal((await status(f,jwt)).cleanup,'blocked');assert.equal(f.count('delete'),0);assert.equal(f.count('revoke'),revocations);
  assert.equal(repo.tokens.get('foreign').state,'active');assert.equal(retainedTrialCleanup(f.contexts.get(grant.workspaceId).storage),null);
});

test('an unknown creation remains recorded; it is neither recreated nor reported deleted',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
  f.hooks.create=async repo=>{f.repositories.delete(repo.data.name);throw Error('Create outcome unknown');};
  assert.equal((await prepare(f,jwt)).status,502);assert.equal(f.count('create'),1);
  const retry=await prepare(f,jwt);assert.equal((await retry.json()).code,'TRIAL_CREATE_OUTCOME_UNKNOWN');assert.equal(f.count('create'),1);
  await end(f,jwt,grant);await f.registry.alarm();assert.equal((await status(f,jwt)).cleanup,'pending');
  assert.equal(f.count('delete'),0);assert.equal(retainedTrialCleanup(f.contexts.get(grant.workspaceId).storage),null);
  assert.equal(Object.values(f.store(grant.workspaceId).read().operations).length,1);
});

test('a spending stop during create still revokes initial credentials and cannot attach a project',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt),policy=JSON.parse(f.env.TRIAL_POLICY);
  f.hooks.create=async()=>{await f.registry.pauseResources(policy,'OWNER_STOP');};
  const result=await prepare(f,jwt);assert.equal(result.status,403);assert.equal((await result.json()).code,'TRIAL_SPENDING_PAUSED');
  assert.ok([...f.repositories.values()].every(repo=>[...repo.tokens.values()].every(token=>token.state==='revoked')));
  assert.equal(Object.keys(f.store(grant.workspaceId).read().workspace.projects).length,0);
  await end(f,jwt,grant);await f.registry.alarm();assert.equal((await status(f,jwt)).cleanup,'complete');
});

test('cleanup waits for an in-flight creation and its retained lease before removing anything',async t=>{
  const f=await trialSampleFixture(t),jwt=await token(),grant=await admit(f,jwt);
  let entered,release;const started=new Promise(done=>entered=done),held=new Promise(done=>release=done);
  f.hooks.create=async()=>{entered();await held;};const pending=prepare(f,jwt);await started;
  await end(f,jwt,grant);await f.registry.alarm();assert.equal(f.count('delete'),0);
  assert.equal(f.sql.storage.sql.exec('SELECT result FROM trial_cleanup').one().result.includes('OPERATION_IN_FLIGHT'),true);
  release();assert.equal((await pending).status,403);
  // The fixture clock moved trial retention; now advance its operation lease too.
  f.contexts.get(grant.workspaceId).storage.sql.exec("UPDATE workspace_records SET data=json_set(data,'$.leaseUntil',?) WHERE kind='operations'",Date.now()-1);
  retryNow(f);await f.registry.alarm();assert.equal(f.count('delete'),1);assert.equal((await status(f,jwt)).cleanup,'complete');
});

test('cleanup of A cannot remove B’s repository or workspace',async t=>{
  const {f,jwt,grant}=await prepared(t),other=await token('person-b'),second=await admit(f,other);
  assert.equal((await prepare(f,other)).status,201);const otherName='sample-'+second.workspaceId.slice(6);
  await end(f,jwt,grant);await f.registry.alarm();assert.equal(f.count('delete'),1);assert.ok(f.repositories.has(otherName));
  const remaining=await handler(req('/api/workspace',other),f.env);assert.equal(remaining.status,200);
  assert.equal((await remaining.json()).trial.workspaceId,second.workspaceId);
  assert.equal((await status(f,other)).status,'admitted');
});
