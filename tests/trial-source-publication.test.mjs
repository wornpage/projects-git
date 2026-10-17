import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {TrialSourcePublication} from '../src/cloudflare/trial-source-publication.ts';
import {gitHttpFixture} from './helpers/git-http.mjs';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
async function fixture(t){
  const f=await gitHttpFixture(t),db=sqliteStorage();t.after(()=>db.db.close());
  const context={workspaceId:'trial-'+'a'.repeat(64),runId:'run',taskId:'task',revision:1,baseCommit:f.baseCommit,branch:'agents/one',repositoryName:'fork',marker:'owned trial-'+'a'.repeat(64)+':assignment'};
  const info={id:'repository-a',name:'fork',remote:f.candidate.remote,defaultBranch:'main',description:context.marker},tokens=new Map();
  let active=true,lost=false,writes=0,issues=0,closeOnIssue=false,loseRevocation=false;
  const hooks={};
  const repo={async info(){await hooks.info?.();return {...info};},async listTokens(){await hooks.inventory?.();return{total:tokens.size,tokens:[...tokens.values()]};},
    async revokeToken(id){if(loseRevocation){loseRevocation=false;throw Error('Revocation unavailable');}tokens.get(id).state='revoked';return true;},async createToken(){issues++;const id=crypto.randomUUID();tokens.set(id,{id,state:'active'});if(closeOnIssue)active=false;return {id,plaintext:'never-return-this-token',expiresAt:new Date(Date.now()+60000).toISOString()};},
    async log({ref}){try{return[{hash:await f.git(path.join(f.root,'fork.git'),'rev-parse','--verify',ref)}];}catch{return[];}},[Symbol.dispose](){} };
  const artifacts={async get(name){assert.equal(name,'fork');return repo;}};
  const git={async commitCandidate(args){writes++;const result=await f.transport.commitCandidate(args);if(lost){lost=false;throw Error('Lost response after push');}return result;}};
  const validate=async()=>{if(!active)throw Object.assign(Error('Closed'),{code:'TRIAL_CLOSED'});return {...context};};
  const publisher=new TrialSourcePublication(db.storage,artifacts,git,validate,async()=>{});
  return {...f,...db,context,info,tokens,hooks,publisher,input:{headCommit:f.baseCommit,source:'export function checkoutTotal(items){ return 42; }'},
    restart:()=>new TrialSourcePublication(db.storage,artifacts,git,validate,async()=>{}),get writes(){return writes;},get issues(){return issues;},set active(v){active=v;},set lost(v){lost=v;},set closeOnIssue(v){closeOnIssue=v;},set loseRevocation(v){loseRevocation=v;}};
}
test('bounded trial source becomes a real exact Git commit without returning repository credentials',async t=>{
  const f=await fixture(t),result=await f.publisher.publish('run',f.input,'source-request');
  assert.equal(await f.git(path.join(f.root,'fork.git'),'show',result.headCommit+':checkout.mjs'),f.input.source);
  assert.equal(f.writes,1);assert.ok([...f.tokens.values()].every(t=>t.state==='revoked'));
  assert.ok(!JSON.stringify(result).includes('never-return'));assert.ok(!JSON.stringify(f.storage.sql.exec('SELECT * FROM trial_source_publications').toArray()).includes('never-return'));
  assert.deepEqual(await f.publisher.publish('run',f.input,'replay-request'),result);assert.equal(f.writes,1);assert.equal(f.issues,1);
  await assert.rejects(f.publisher.publish('run',{...f.input,source:'different'},'changed-request'),{code:'TRIAL_SOURCE_CHANGED'});
});
test('lost push response settles from exact branch observation after restart without another Git write',async t=>{
  const f=await fixture(t);f.lost=true;await assert.rejects(f.publisher.publish('run',f.input,'source-request'),/Lost response/);
  const retained=await f.publisher.status('run');assert.equal(retained.state,'publishing');assert.match(retained.headCommit,/^[a-f0-9]{40}$/);
  const result=await f.restart().publish('run',f.input,'source-request');assert.equal(result.headCommit,retained.headCommit);assert.equal(f.writes,1);assert.equal(f.issues,1);
});
test('closed trials and replaced repositories cannot publish or retrieve a previous outcome',async t=>{
  const f=await fixture(t);await f.publisher.publish('run',f.input,'source-request');f.info.id='replacement';
  await assert.rejects(f.publisher.publish('run',f.input,'source-request'),{code:'TRIAL_SOURCE_CHANGED'});assert.equal(f.writes,1);
  f.active=false;await assert.rejects(f.publisher.status('run'),{code:'TRIAL_CLOSED'});await assert.rejects(f.publisher.publish('run',f.input,'source-request'),{code:'TRIAL_CLOSED'});
});
test('closure after credential issuance stops the Git write but still revokes that credential',async t=>{
  const f=await fixture(t);f.closeOnIssue=true;
  await assert.rejects(f.publisher.publish('run',f.input,'source-request'),{code:'TRIAL_CLOSED'});
  assert.equal(f.writes,0);assert.equal(f.issues,1);assert.ok([...f.tokens.values()].every(t=>t.state==='revoked'));
});
test('unconfirmed credential teardown cannot become complete, and a retry only reconciles it',async t=>{
  const f=await fixture(t);f.loseRevocation=true;
  await assert.rejects(f.publisher.publish('run',f.input,'source-request'),/Revocation unavailable/);
  assert.equal((await f.publisher.status('run')).state,'publishing');assert.equal(f.writes,1);
  const result=await f.restart().publish('run',f.input,'source-request');assert.match(result.headCommit,/^[a-f0-9]{40}$/);assert.equal(f.writes,1);assert.equal(f.issues,1);
  assert.ok([...f.tokens.values()].every(t=>t.state==='revoked'));
});

test('a displaced publication cannot revoke successor credentials after delayed inventory',async t=>{
  const f=await fixture(t);let entered,release;
  const started=new Promise(done=>entered=done),held=new Promise(done=>release=done);
  f.hooks.inventory=async()=>{delete f.hooks.inventory;entered();await held;};
  const pending=f.publisher.publish('run',f.input,'old-request');await started;
  f.storage.sql.exec('UPDATE trial_source_publications SET lease_id=?,lease_until=? WHERE run_id=?','successor',Date.now()+120000,'run');
  f.tokens.set('successor-token',{id:'successor-token',state:'active'});release();
  await assert.rejects(pending,{code:'TRIAL_SOURCE_CHANGED'});
  assert.equal(f.tokens.get('successor-token').state,'active');assert.equal(f.writes,0);assert.equal(f.issues,0);
  assert.equal(f.storage.sql.exec('SELECT lease_id FROM trial_source_publications').one().lease_id,'successor');
});
