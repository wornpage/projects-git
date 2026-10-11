import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ArtifactSubscriptions,subscriptionPlan} from '../src/cloudflare/artifact-subscriptions.ts';
import {CloudflareSubscriptions} from '../src/cloudflare/subscription-provider.ts';
import {ApiError} from '../src/cloudflare/security.ts';

const scope={accountId:'1'.repeat(32),namespace:'owned',queueId:'2'.repeat(32),workspaceId:'workspace',ownerKey:'3'.repeat(64)};
const plan=subscriptionPlan({...scope,repositoryName:'project'}),id='4'.repeat(32);
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let confirms=0;
  const storage={
    sync:async()=>{confirms++;},
    sql:{exec(sql,...args){
      const rows=db.prepare(sql).all(...args).map(r=>({...r}));
      return {toArray:()=>rows,one(){assert.equal(rows.length,1);return rows[0]}};
    }},
    transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  };
  const ledger=new ArtifactSubscriptions(storage),calls=[];let record;
  const provider={find:async()=>{calls.push('find');return record?[{...record}]:[];},create:async()=>{
    assert.ok(confirms>=2);assert.equal(db.prepare('SELECT phase FROM artifact_subscriptions').get().phase,'creating');
    calls.push('create');record={id,enabled:false};return {...record};},enable:async()=>{
    assert.deepEqual(ledger.bindings(scope),[{id,repositoryName:'project'}]);calls.push('enable');record.enabled=true;return {...record};}};
  return {db,storage,ledger,provider,calls,record:()=>record,ensure:(validate=()=>{})=>ledger.ensure(plan,provider,validate)};
}
const barrier=()=>{let open;return {promise:new Promise(resolve=>open=resolve),open:()=>open()};};

test('competing requests reuse the durable subscription and bind before enabling',async t=>{
  const f=fixture(t);await Promise.all(Array.from({length:8},()=>f.ensure()));
  assert.deepEqual(f.calls,['find','create','enable']);assert.deepEqual(f.ledger.summary(),{repositories:1,ready:1,awaitingRecovery:0,attempts:1,definition:'Owned repositories, enabled subscriptions and retained registration attempts are separate counts.'});
  assert.equal(f.db.prepare('SELECT status FROM artifact_subscription_attempts').get().status,'complete');
});
test('a lost create response recovers its exact disabled subscription without a second POST',async t=>{
  const f=fixture(t),create=f.provider.create;f.provider.create=async()=>{await create();throw Error('lost response');};
  await assert.rejects(f.ensure(),/lost response/);assert.equal(f.ledger.summary().awaitingRecovery,1);
  await new ArtifactSubscriptions(f.storage).ensure(plan,f.provider,()=>{});
  assert.deepEqual(f.calls,['find','create','find','enable']);assert.equal(f.ledger.summary().ready,1);
  assert.deepEqual(f.db.prepare('SELECT status FROM artifact_subscription_attempts ORDER BY rowid').all().map(r=>r.status),['failed','complete']);
});
test('unconfirmed creation stays visible and cannot be repeated even when listing is empty',async t=>{
  const f=fixture(t);let posts=0;f.provider.create=async()=>{posts++;throw Error('timeout');};
  await assert.rejects(f.ensure(),/timeout/);
  await assert.rejects(new ArtifactSubscriptions(f.storage).ensure(plan,f.provider,()=>{}),{code:'SUBSCRIPTION_OUTCOME_UNKNOWN'});
  assert.equal(posts,1);assert.equal(f.ledger.summary().attempts,2);assert.equal(f.ledger.summary().awaitingRecovery,1);
});
test('a confirmed provider rejection retains the failed attempt and permits a new create attempt',async t=>{
  const f=fixture(t),create=f.provider.create;f.provider.create=async()=>{throw new ApiError(502,'SUBSCRIPTION_CREATE_REJECTED','refused');};
  await assert.rejects(f.ensure(),{code:'SUBSCRIPTION_CREATE_REJECTED'});f.provider.create=create;await f.ensure();
  assert.equal(f.ledger.summary().attempts,2);assert.equal(f.ledger.summary().ready,1);
});
test('restart after durable binding reuses the ID and retains a lost enable response',async t=>{
  const f=fixture(t),enable=f.provider.enable;f.provider.enable=async()=>{await enable();throw Error('enable response lost');};
  await assert.rejects(f.ensure(),/enable response lost/);assert.deepEqual(f.ledger.bindings(scope),[{id,repositoryName:'project'}]);
  f.provider.enable=enable;await new ArtifactSubscriptions(f.storage).ensure(plan,f.provider,()=>{});
  assert.deepEqual(f.calls,['find','create','enable','enable']);assert.equal(f.ledger.summary().ready,1);
});
test('a late superseded POST completion cannot enable or overwrite a recovered registration',async t=>{
  const f=fixture(t),entered=barrier(),release=barrier(),create=f.provider.create;
  f.provider.create=async()=>{const value=await create();entered.open();await release.promise;return value;};
  const earlier=f.ensure();await entered.promise;
  await new ArtifactSubscriptions(f.storage).ensure(plan,f.provider,()=>{});release.open();
  await assert.rejects(earlier,{code:'SUBSCRIPTION_ATTEMPT_SUPERSEDED'});
  assert.deepEqual(f.calls,['find','create','find','enable']);assert.equal(f.ledger.summary().ready,1);
  assert.deepEqual(f.db.prepare('SELECT status FROM artifact_subscription_attempts ORDER BY rowid').all().map(r=>r.status),['superseded','complete']);
});
test('owner rejection precedes persistence; changed owner or destination cannot reuse receipts',async t=>{
  const f=fixture(t);await assert.rejects(f.ensure(()=>{throw Error('wrong workspace');}),/wrong workspace/);
  assert.equal(f.ledger.summary().repositories,0);assert.deepEqual(f.calls,[]);await f.ensure();
  for(const change of [{workspaceId:'foreign'},{ownerKey:'5'.repeat(64)},{queueId:'6'.repeat(32)}]){
    await assert.rejects(f.ledger.ensure(subscriptionPlan({...scope,...change,repositoryName:'project'}),f.provider,()=>{}),{code:'SUBSCRIPTION_CONFIG_CHANGED'});
    assert.deepEqual(f.ledger.bindings({...scope,...change}),[]);
  }
});
test('changed ownership during a delayed lookup prevents provider creation',async t=>{
  const f=fixture(t),entered=barrier(),release=barrier();let authorized=true;
  f.provider.find=async()=>{entered.open();await release.promise;return [];};
  const pending=f.ensure(()=>{if(!authorized)throw new ApiError(403,'OWNER_CHANGED','owner changed');});
  await entered.promise;authorized=false;release.open();await assert.rejects(pending,{code:'OWNER_CHANGED'});
  assert.deepEqual(f.calls,[]);assert.equal(f.ledger.summary().awaitingRecovery,1);
});
test('failed disk confirmation admits no provider I/O',async t=>{
  const f=fixture(t);f.storage.sync=async()=>{throw Error('storage failure');};await assert.rejects(f.ensure(),/storage failure/);assert.deepEqual(f.calls,[]);
});

function providerFixture(options={}){
  const calls=[],row={id,name:plan.name,enabled:false,source:{type:'artifacts.repo',namespace:scope.namespace,repo_name:'project'},destination:{type:'queues.queue',queue_id:scope.queueId},events:['pushed']};
  const api=new CloudflareSubscriptions(scope,'test-secret-never-retained',async(url,init)=>{
    calls.push({url,method:init.method,body:init.body});assert.equal(init.redirect,'manual');assert.ok(init.signal);
    if(options.reply)return options.reply(url,init,row);
    if(init.method==='PATCH')row.enabled=true;
    return Response.json({success:true,result:options.result??(url.includes('?')?[row]:row),result_info:{total_pages:1}});
  });return {api,calls,row};
}
test('private provider rejects foreign scopes before HTTP and pins event, repository and queue',async()=>{
  const f=providerFixture();
  for(const change of [{accountId:'5'.repeat(32)},{namespace:'foreign'},{workspaceId:'foreign'},{ownerKey:'5'.repeat(64)},{queueId:'5'.repeat(32)}]){
    await assert.rejects(f.api.create(subscriptionPlan({...scope,...change,repositoryName:'project'})),{code:'SUBSCRIPTION_SCOPE_FORBIDDEN'});
  }
  assert.equal(f.calls.length,0);assert.deepEqual(await f.api.find(plan),[{id,enabled:false}]);
  await f.api.create(plan);const sent=JSON.parse(f.calls.at(-1).body);assert.equal(sent.enabled,false);assert.deepEqual(sent.events,['pushed']);assert.equal(sent.source.repo_name,'project');
  assert.deepEqual(await f.api.enable(plan,id),{id,enabled:true});assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  await f.api.enable(plan,id);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
test('provider response mismatches and oversized/partial inventory fail closed',async()=>{
  for(const mutate of [r=>r.source.namespace='foreign',r=>r.destination.queue_id='5'.repeat(32),r=>r.events.push('cloned'),r=>r.name='another',r=>r.enabled='true',r=>r.source.name={},r=>r.source.wildcard=true]){
    const f=providerFixture();mutate(f.row);await assert.rejects(f.api.create(plan),{code:'SUBSCRIPTION_PROVIDER_MISMATCH'});
  }
  const limited=providerFixture({reply:()=>Response.json({success:true,result:[],result_info:{total_pages:11}})});
  await assert.rejects(limited.api.find(plan),{code:'SUBSCRIPTION_LIST_LIMIT'});
  const huge=providerFixture({reply:()=>new Response('x'.repeat(2097153))});await assert.rejects(huge.api.find(plan),{code:'SUBSCRIPTION_RESPONSE_LIMIT'});
});
test('the observed provider display label is metadata and cannot change the pinned repository authority',async()=>{
  const f=providerFixture();f.row.source.name='Artifacts';
  assert.deepEqual(await f.api.find(plan),[{id,enabled:false}]);
  assert.deepEqual(await f.api.create(plan),{id,enabled:false});
  f.row.source.repo_name='foreign';await assert.rejects(f.api.enable(plan,id),{code:'SUBSCRIPTION_PROVIDER_MISMATCH'});
  assert.equal(f.calls.filter(call=>call.method==='PATCH').length,0);
});
test('provider failure receipts expose stable codes, never response messages or secrets',async()=>{
  const redirected=providerFixture({reply:()=>new Response(null,{status:302,headers:{Location:'https://foreign.invalid'}})});
  await assert.rejects(redirected.api.create(plan),{code:'SUBSCRIPTION_REDIRECT_REFUSED'});assert.equal(redirected.calls.length,1);
  for(const status of [403,500]){
    const f=providerFixture({reply:()=>Response.json({success:false,errors:[{message:'sensitive provider response'}]},{status})});
    await assert.rejects(f.api.create(plan),error=>error.code===(status===403?'SUBSCRIPTION_CREATE_REJECTED':'SUBSCRIPTION_PROVIDER_FAILED')&&!String(error).includes('sensitive'));
  }
});
