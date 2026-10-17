import test from 'node:test';
import assert from 'node:assert/strict';
import {TrialResourceStore,readTrialResources} from '../src/cloudflare/trial-controls.ts';
import {TrialAdmissionStore} from '../src/cloudflare/trial-admission.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {approvedTrialResources,unapprovedTrialResources} from './helpers/trial-policy.mjs';

const start=Date.parse('2026-10-17T12:00:00Z'),a='trial-'+'a'.repeat(64),b='trial-'+'b'.repeat(64);
function fixture(t,changes={}){
  const sql=sqliteStorage();let now=start;t.after(()=>sql.db.close());
  const policy={...approvedTrialResources,...changes};const store=new TrialResourceStore(sql.storage,policy,()=>now);
  return {...sql,policy,store,get now(){return now;},set now(value){now=value;}};
}

test('resource policy has no implicit approval, unlimited values or unsupported fields',()=>{
  assert.deepEqual(readTrialResources(unapprovedTrialResources),unapprovedTrialResources);
  for(const value of [undefined,{},[],{...approvedTrialResources,extra:true},{...approvedTrialResources,providerCalls:201},
    {...approvedTrialResources,setupAttempts:1.5},{...approvedTrialResources,approvalExpiresAt:null},
    {...unapprovedTrialResources,totalSetups:1},{...unapprovedTrialResources,cleanupDelayMs:0}])
    assert.throws(()=>readTrialResources(value),{code:'TRIAL_NOT_CONFIGURED'});
});

test('unapproved spending prevents setup and effects without consuming a false allowance',t=>{
  const f=fixture(t,unapprovedTrialResources);
  assert.throws(()=>f.store.reserveSetup(a),{code:'TRIAL_SPENDING_UNAPPROVED'});
  assert.throws(()=>f.store.reserveEffect(a,'create'),{code:'TRIAL_SPENDING_UNAPPROVED'});
  assert.deepEqual(f.store.status(a),{spending:'TRIAL_SPENDING_UNAPPROVED',setupAvailable:false,reason:'TRIAL_SPENDING_UNAPPROVED',setupAttempts:{used:0,limit:0},providerCalls:{used:0,limit:0},billingCapGuaranteed:false});
});

test('reservations cap global setup starts, attempts and provider effects without refunds',t=>{
  const f=fixture(t,{dailySetups:1,totalSetups:1,setupAttempts:2,providerCalls:2});
  assert.throws(()=>f.store.reserveEffect(a,'read'),{code:'TRIAL_RESOURCE_REQUIRED'});
  f.store.reserveSetup(a);f.store.reserveEffect(a,'read'); // An unknown response still consumes its slot.
  f.store.reserveSetup(a);f.store.reserveEffect(a,'push');
  assert.throws(()=>f.store.reserveEffect(a,'read'),{code:'TRIAL_RESOURCE_LIMIT'});
  assert.throws(()=>f.store.reserveSetup(a),{code:'TRIAL_RESOURCE_LIMIT'});
  assert.throws(()=>f.store.reserveSetup(b),{code:'TRIAL_RESOURCE_LIMIT'});
  assert.deepEqual(f.store.status(a).providerCalls,{used:2,limit:2});
});

test('UTC rollover does not reset existing trials or the lifetime denominator',t=>{
  const f=fixture(t,{dailySetups:1,totalSetups:2});f.store.reserveSetup(a);
  assert.throws(()=>f.store.reserveSetup(b),{code:'TRIAL_RESOURCE_LIMIT'});
  f.now+=86400_000;f.store.reserveSetup(a);f.store.reserveSetup(b);
  assert.equal(f.store.status(a).setupAttempts.used,2);
  f.now+=86400_000;assert.throws(()=>f.store.reserveSetup('trial-'+'c'.repeat(64)),{code:'TRIAL_RESOURCE_LIMIT'});
});

test('an uncertain create is inspected instead of sending a second create after restart',t=>{
  const f=fixture(t);f.store.reserveSetup(a);f.store.reserveEffect(a,'create');
  const restarted=new TrialResourceStore(f.storage,f.policy,()=>f.now);restarted.reserveSetup(a);
  assert.throws(()=>restarted.reserveEffect(a,'create'),{code:'TRIAL_CREATE_OUTCOME_UNKNOWN'});
  restarted.reserveEffect(a,'read');assert.equal(restarted.status(a).providerCalls.used,2);
});

test('operator stop and approval expiry fence future effects while preserving status and counters',t=>{
  const f=fixture(t,{approvalExpiresAt:start+1000});f.store.reserveSetup(a);f.store.reserveEffect(a,'read');
  f.store.pause('OWNER_STOP');const restarted=new TrialResourceStore(f.storage,f.policy,()=>f.now);
  assert.throws(()=>restarted.reserveEffect(a,'push'),{code:'TRIAL_SPENDING_PAUSED'});
  assert.equal(restarted.status(a).providerCalls.used,1);f.now+=1000;
  assert.throws(()=>restarted.reserveSetup(b),{code:'TRIAL_APPROVAL_EXPIRED'});
});

function admission(t){
  const sql=sqliteStorage();let now=start;t.after(()=>sql.db.close());
  const policy={revision:'controls-fixture-v1',issuer:'https://fixture.cloudflareaccess.com',audience:'a'.repeat(64),durationMs:60000,
    dailyAdmissions:2,activeTrials:2,totalAdmissions:2,resources:approvedTrialResources};
  const store=new TrialAdmissionStore(sql.storage,policy,()=>now);
  const person={issuer:policy.issuer,audience:policy.audience,subject:'alice',displayName:'alice@example.test',issuedAt:Math.floor(start/1000)-1,expiresAt:Math.floor(start/1000)+3600};
  return {...sql,policy,store,person,get now(){return now;},set now(value){now=value;}};
}

test('resource admission rechecks closure after its asynchronous authorization',async t=>{
  const f=admission(t),grant=await f.store.admit(f.person,'resource-first');
  const principal={provider:'cloudflare-access',kind:'owner',id:f.person.subject,issuer:f.person.issuer,workspaceId:grant.workspaceId,
    displayName:f.person.displayName,issuedAt:f.person.issuedAt,expiresAt:f.person.expiresAt};
  const authorize=f.store.authorize.bind(f.store);f.store.authorize=async(...args)=>{const result=await authorize(...args);await f.store.close(f.person);return result;};
  await assert.rejects(f.store.reserveResource(grant.workspaceId,principal,'setup'),{code:'TRIAL_CLOSED'});
  assert.equal(f.store.resources.status(grant.workspaceId).setupAttempts.used,0);
});

test('a session expiring after asynchronous authorization cannot reserve new work',async t=>{
  const f=admission(t),grant=await f.store.admit(f.person,'session-boundary');
  const principal={provider:'cloudflare-access',kind:'owner',id:f.person.subject,issuer:f.person.issuer,workspaceId:grant.workspaceId,
    displayName:f.person.displayName,issuedAt:f.person.issuedAt,expiresAt:Math.floor(start/1000)+1};
  const authorize=f.store.authorize.bind(f.store);f.store.authorize=async(...args)=>{const result=await authorize(...args);f.now+=1000;return result;};
  await assert.rejects(f.store.reserveResource(grant.workspaceId,principal,'setup'),{code:'TRIAL_IDENTITY_FORBIDDEN'});
  assert.equal(f.store.resources.status(grant.workspaceId).setupAttempts.used,0);
});

test('cleanup claims are durable, bounded across crashes, and stop scheduling after the last allowance',async t=>{
  const f=admission(t),grant=await f.store.admit(f.person,'cleanup-bounded');await f.store.close(f.person);
  assert.throws(()=>f.store.cleanupGrant(grant.workspaceId),{code:'TRIAL_CLEANUP_NOT_DUE'});f.now+=300000;
  for(let i=0;i<6;i++){
    assert.equal(typeof f.store.claimCleanup(grant.workspaceId),'string');assert.equal(f.store.claimCleanup(grant.workspaceId),null);
    f.now=f.store.cleanupSchedule()[0].at;
  }
  assert.equal(f.store.claimCleanup(grant.workspaceId),null);assert.deepEqual(f.store.cleanupSchedule(),[]);
  assert.equal(f.store.cleanupStatus(grant).state,'blocked');
  assert.equal(f.storage.sql.exec('SELECT attempts FROM trial_cleanup').one().attempts,6);
  assert.equal(f.store.cleanupStatus(grant).resources,null);
});

test('stale cleanup results cannot replace a later attempt or completed receipt',async t=>{
  const f=admission(t),grant=await f.store.admit(f.person,'cleanup-stale');await f.store.close(f.person);f.now+=300000;
  const first=f.store.claimCleanup(grant.workspaceId);f.now=f.store.cleanupSchedule()[0].at;
  const second=f.store.claimCleanup(grant.workspaceId),done={state:'complete',resources:1,deleted:1,reason:null};
  f.store.recordCleanup(grant.workspaceId,first,done);assert.equal(f.store.cleanupStatus(grant).state,'pending');
  assert.throws(()=>f.store.recordCleanup(grant.workspaceId,second,{...done,raw:'provider secret'}),{code:'TRIAL_UNAVAILABLE'});
  f.store.recordCleanup(grant.workspaceId,second,done);f.store.recordCleanup(grant.workspaceId,second,{state:'pending',resources:null,deleted:null,reason:'LATE'});
  assert.deepEqual(f.store.cleanupStatus(grant),done);assert.deepEqual(f.store.cleanupSchedule(),[]);
  assert.equal(f.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,1,'The admission fence survives cleanup.');
});
