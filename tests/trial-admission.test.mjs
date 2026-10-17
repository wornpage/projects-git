import {unapprovedTrialResources} from './helpers/trial-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TrialAdmissionStore,readTrialPolicy,trialStatus,trialAccessPolicy,trialReply,trialGrant} from '../src/cloudflare/trial-admission.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';

const start=Date.parse('2026-10-16T12:00:00Z');
const policy={revision:'fixture-v1',issuer:'https://fixture.cloudflareaccess.com',audience:'a'.repeat(64),durationMs:604800000,dailyAdmissions:20,activeTrials:50,totalAdmissions:1000,resources:unapprovedTrialResources};
const identity=(subject='person-a',now=start)=>({issuer:policy.issuer,audience:policy.audience,subject,displayName:'person@example.test',issuedAt:Math.floor(now/1000)-10,expiresAt:Math.floor(now/1000)+3600});
const principal=(person,grant)=>({provider:'cloudflare-access',kind:'owner',issuer:person.issuer,id:person.subject,workspaceId:grant.workspaceId,displayName:person.displayName,issuedAt:person.issuedAt,expiresAt:person.expiresAt});
function setup(changes={}){const sql=sqliteStorage();let clock=start;const store=new TrialAdmissionStore(sql.storage,{...policy,...changes},()=>clock);return {...sql,store,get now(){return clock;},set now(value){clock=value;}};}

test('explicit closed policy refuses invalid values, unknown keys and implicit defaults',()=>{
  assert.deepEqual(readTrialPolicy(JSON.stringify(policy)),policy);
  for(const value of [null,[],{}, {...policy,extra:true},{...policy,issuer:'https://evil.test'},{...policy,audience:'short'},
    {...policy,durationMs:1},{...policy,durationMs:604800001},{...policy,activeTrials:0},{...policy,dailyAdmissions:1.5},{...policy,totalAdmissions:10001}])
    assert.throws(()=>readTrialPolicy(JSON.stringify(value)),{code:'TRIAL_NOT_CONFIGURED'});
});

test('concurrent and changed-key signups produce one durable reservation without extending expiry',async()=>{
  const c=setup();
  const results=await Promise.all(Array.from({length:20},(_,i)=>c.store.admit(identity(),'request-'+i)));
  assert.equal(new Set(results.map(r=>r.workspaceId)).size,1);
  assert.equal(c.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,1);
  c.now+=10_000;const later=await c.store.admit(identity(),'different-request');
  assert.deepEqual(later,results[0]);assert.match(later.workspaceId,/^trial-[a-f0-9]{64}$/);
  assert.equal(later.expiresAt,start+policy.durationMs);
  assert.deepEqual(trialAccessPolicy(later).agentClientIds,[]);
  assert.equal(trialStatus(later,start).workflowReady,false);
});

test('one global quota transaction admits only available capacity under concurrent signup',async()=>{
  const c=setup({activeTrials:2});
  const result=await Promise.allSettled(Array.from({length:12},(_,i)=>c.store.admit(identity('person-'+i),'same-request-key')));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,2);
  for(const r of result.filter(r=>r.status==='rejected'))assert.equal(r.reason.code,'TRIAL_CAPACITY_FULL');
  assert.equal(c.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,2);
});

test('daily UTC and lifetime denominators include closed/expired reservations',async()=>{
  const c=setup({dailyAdmissions:1,totalAdmissions:2});
  await c.store.admit(identity(),'first-request');await c.store.close(identity());
  await assert.rejects(c.store.admit(identity('person-b'),'second-request'),{code:'TRIAL_CAPACITY_FULL'});
  c.now=Date.parse('2026-10-17T00:00:00Z');await c.store.admit(identity('person-b',c.now),'second-request');
  c.now+=86400_000;await assert.rejects(c.store.admit(identity('person-c',c.now),'third-request'),{code:'TRIAL_CAPACITY_FULL'});
});

test('closure and expiry never silently re-enroll, restore authority or report cleanup success',async()=>{
  const c=setup();const first=await c.store.admit(identity(),'first-request');
  const closed=await c.store.close(identity());assert.equal(trialStatus(closed,c.now).status,'closed');
  assert.equal(trialStatus(closed,c.now).remainingMs,0);assert.equal(trialStatus(closed,c.now).capabilities.workspaceReads,false);
  assert.equal(trialStatus(closed,c.now).cleanup,'pending');
  assert.equal((await c.store.admit(identity(),'another-key')).closedAt,closed.closedAt);
  await assert.rejects(c.store.authorize(first.workspaceId,principal(identity(),first)),{code:'TRIAL_CLOSED'});
  const b=await c.store.admit(identity('person-b'),'other-person-key');c.now=b.expiresAt;
  const current=identity('person-b',c.now);assert.equal(trialStatus(await c.store.read(current),c.now).status,'expired');
  await assert.rejects(c.store.authorize(b.workspaceId,principal(current,b)),{code:'TRIAL_EXPIRED'});
  assert.equal((await c.store.admit(current,'new-expired-key')).expiresAt,b.expiresAt);
});

test('owner identity derives from subject; duplicate email is not shared authority',async()=>{
  const c=setup();const a=identity(),b=identity('person-b');
  const ga=await c.store.admit(a,'request-a'),gb=await c.store.admit(b,'request-b');
  assert.notEqual(ga.workspaceId,gb.workspaceId);
  await assert.rejects(c.store.authorize(ga.workspaceId,{...principal(b,gb),workspaceId:ga.workspaceId}),{code:'WORKSPACE_FORBIDDEN'});
  for(const person of [{...a,issuer:'https://other.cloudflareaccess.com'},{...a,audience:'b'.repeat(64)},{...a,expiresAt:0},{...a,issuedAt:Math.floor(start/1000)+10},{...a,subject:'../../real'}])
    await assert.rejects(c.store.admit(person,'forged-request'),{code:'TRIAL_IDENTITY_FORBIDDEN'});
  assert.equal(c.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,2);
});

test('restart retains exact identity, capacity and immutable terms after a lost response',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'projects-git-trial-'));let db;
  try{
    let sql=sqliteStorage(join(dir,'registry.sqlite'));db=sql.db;
    const first=new TrialAdmissionStore(sql.storage,policy,()=>start);await first.admit(identity(),'lost-response');db.close();
    sql=sqliteStorage(join(dir,'registry.sqlite'));db=sql.db;
    const restarted=new TrialAdmissionStore(sql.storage,policy,()=>start+1000);
    const recovered=await restarted.admit(identity(),'lost-response');assert.equal(recovered.createdAt,start);
    assert.equal(sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,1);
    assert.throws(()=>new TrialAdmissionStore(sql.storage,{...policy,durationMs:60_000},()=>start),{code:'TRIAL_POLICY_CHANGED'});
  }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('an expired identity after async hashing is rejected before any reservation',async()=>{
  const c=setup();const promise=c.store.admit(identity(),'expired-during-hash');c.now+=7200_000;
  await assert.rejects(promise,{code:'TRIAL_IDENTITY_FORBIDDEN'});
  assert.equal(c.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);
});

test('RPC results allow only known failures and bounded grants; corrupted routing cannot select another store',async()=>{
  const c=setup(),grant=await c.store.admit(identity(),'rpc-contract-test');
  assert.deepEqual(trialGrant({ok:true,grant}),grant);
  assert.deepEqual(await trialReply(async()=>{throw new Error('private provider text');}),{ok:false,code:'TRIAL_UNAVAILABLE'});
  for(const reply of [null,{}, {ok:false,code:'made-up-private-error'}, {ok:true,grant:{...grant,secret:'private'}},
    {ok:true,grant:{...grant,expiresAt:Number.MAX_SAFE_INTEGER}}, {ok:true,grant:{...grant,closedAt:0}}])
    assert.throws(()=>trialGrant(reply),{code:'TRIAL_UNAVAILABLE'});
  c.storage.sql.exec('UPDATE trial_admissions SET workspace_id=?','trial-'+'0'.repeat(64));
  await assert.rejects(c.store.read(identity()),{code:'TRIAL_UNAVAILABLE'});
});
