import test from 'node:test';
import assert from 'node:assert/strict';
import {TrialCredentials} from '../src/cloudflare/trial-credentials.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
const now=Date.now(),workspaceId='trial-'+'a'.repeat(64);
const grant={workspaceId,issuer:'https://fixture.cloudflareaccess.com',audience:'a'.repeat(64),ownerSubject:'owner-a',createdAt:now-1000,expiresAt:now+86400000,closedAt:null,policyRevision:'test-v1'};
const identity={issuer:grant.issuer,audience:grant.audience,subject:grant.ownerSubject,issuedAt:Math.floor(now/1000)-1,expiresAt:Math.floor(now/1000)+1000,displayName:'owner@example.test'};
function fixture(t){const db=sqliteStorage();t.after(()=>db.db.close());let clock=now,current={...grant};const credentials=new TrialCredentials(db.storage,id=>{assert.equal(id,workspaceId);return current;},()=>clock);return {...db,credentials,set now(v){clock=v;},set grant(v){current=v;}};}
test('credentials retain hashes only and separate builder and reviewer authority',async t=>{
  const f=fixture(t),a=await f.credentials.issue(workspaceId,identity,'agent','agent-request'),r=await f.credentials.issue(workspaceId,identity,'reviewer','review-request');
  assert.notEqual(a.principal.id,r.principal.id);assert.equal(a.principal.provider,'trial-credential');
  assert.deepEqual(await f.credentials.authenticate(a.token),a.principal);assert.deepEqual(await f.credentials.authenticate(r.token),r.principal);
  const rows=JSON.stringify(f.storage.sql.exec('SELECT * FROM trial_credentials').toArray());assert.ok(!rows.includes(a.token)&&!rows.includes(r.token));
  await assert.rejects(f.credentials.authenticate(a.token.slice(0,-1)+'z'),{code:'TRIAL_CREDENTIAL_INVALID'});
});
test('lost-response retry does not mint another credential; explicit rotation revokes the old one',async t=>{
  const f=fixture(t),first=await f.credentials.issue(workspaceId,identity,'agent','first-request');
  const replay=await f.credentials.issue(workspaceId,identity,'agent','first-request');assert.equal(replay.token,null);assert.equal(replay.replayed,true);
  const next=await f.credentials.issue(workspaceId,identity,'agent','next-request');assert.notEqual(next.token,first.token);
  await assert.rejects(f.credentials.authenticate(first.token),{code:'TRIAL_CREDENTIAL_INVALID'});assert.throws(()=>f.credentials.authorize(first.principal),{code:'TRIAL_CREDENTIAL_INVALID'});
  assert.equal((await f.credentials.authenticate(next.token)).kind,'agent');
  await assert.rejects(f.credentials.issue(workspaceId,identity,'reviewer','first-request'),{code:'IDEMPOTENCY_CONFLICT'});
});
test('role, tenant and principal fields cannot be substituted and a foreign human cannot issue credentials',async t=>{
  const f=fixture(t),created=await f.credentials.issue(workspaceId,identity,'agent','first-request');
  for(const changed of [{kind:'reviewer'},{provider:'cloudflare-access'},{workspaceId:'trial-'+'b'.repeat(64)},{id:'owner-a'},{expiresAt:created.principal.expiresAt+1}])
    assert.throws(()=>f.credentials.authorize({...created.principal,...changed}),{code:'TRIAL_CREDENTIAL_INVALID'});
  await assert.rejects(f.credentials.issue(workspaceId,{...identity,subject:'owner-b'},'agent','other-request'),{code:'WORKSPACE_FORBIDDEN'});
});
test('expiry and closure revoke all delegated work, and explicit revocation is role scoped',async t=>{
  const f=fixture(t),a=await f.credentials.issue(workspaceId,identity,'agent','agent-request'),r=await f.credentials.issue(workspaceId,identity,'reviewer','review-request');
  f.credentials.revoke(workspaceId,identity,'agent');await assert.rejects(f.credentials.authenticate(a.token),{code:'TRIAL_CREDENTIAL_INVALID'});
  assert.equal((await f.credentials.authenticate(r.token)).kind,'reviewer');f.grant={...grant,closedAt:now};await assert.rejects(f.credentials.authenticate(r.token),{code:'TRIAL_CLOSED'});
  f.grant={...grant};f.now=now+3600001;await assert.rejects(f.credentials.authenticate(r.token),{code:'TRIAL_CREDENTIAL_INVALID'});
});
test('registry cleanup purges only a closed or expired trial and is idempotent',async t=>{
  const f=fixture(t),issued=await f.credentials.issue(workspaceId,identity,'agent','agent-request');
  assert.throws(()=>f.credentials.purge(workspaceId),{code:'TRIAL_CLEANUP_NOT_DUE'});
  f.grant={...grant,closedAt:now};f.credentials.purge(workspaceId);f.credentials.purge(workspaceId);
  assert.equal(f.storage.sql.exec('SELECT count(*) n FROM trial_credentials').one().n,0);
  await assert.rejects(f.credentials.authenticate(issued.token),{code:'TRIAL_CREDENTIAL_INVALID'});
});
