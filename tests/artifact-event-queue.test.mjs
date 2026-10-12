import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {transformSync}=createRequire(new URL('../node_modules/wrangler/package.json',import.meta.url))('esbuild');
function handler(){const file=new URL('../src/cloudflare/index.ts',import.meta.url),require=createRequire(file),module={exports:{}};
 const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code;
 new Function('require','module','exports',code)(name=>name==='cloudflare:workers'?{DurableObject:class{},WorkerEntrypoint:class{}}:name==='./check-container.ts'?{RepositoryCheckContainer:class{}}:require(name),module,module.exports);return module.exports.default.queue;
}
const queue='fixture-artifact-events';
const env={WORKSPACE_ID:'fixture',ARTIFACTS_EVENTS_ACCOUNT_ID:'1'.repeat(32),ARTIFACTS_EVENTS_NAMESPACE:'fixture',ARTIFACTS_EVENTS_QUEUE:queue,ARTIFACTS_EVENTS_SUBSCRIPTIONS:JSON.stringify([{id:'2'.repeat(32),repositoryName:'candidate'}])};
const body=()=>({type:'cf.artifacts.repo.pushed',source:{type:'artifacts.repo',namespace:'fixture',repoName:'candidate'},payload:{ref:'refs/heads/main',before:'a'.repeat(40),after:'b'.repeat(40)},metadata:{accountId:'1'.repeat(32),eventSubscriptionId:'2'.repeat(32),eventSchemaVersion:1,eventTimestamp:'2026-10-08T00:00:00.000Z'}});
function message(value=body()){const actions=[];return {id:'delivery-fixture',body:value,actions,ack(){actions.push('ack')},retry(options){actions.push(['retry',options])}};}
test('only the dedicated event queue reaches the owned coordinator, with acknowledgement after durable reconciliation',async()=>{
 const consume=handler(),calls=[],m=message();let completed=false;
 const runtime={...env,WORKSPACES:{getByName(id){assert.equal(id,'fixture');return {async artifactPush(value,delivery){calls.push({value,delivery});completed=true}}}}};
 m.ack=()=>{assert.equal(completed,true);m.actions.push('ack')};await consume({queue,messages:[m]},runtime);assert.equal(calls.length,1);assert.deepEqual(m.actions,['ack']);
 const foreignQueue=message();await consume({queue:'fixture-search',messages:[foreignQueue]},runtime);assert.equal(calls.length,1);assert.deepEqual(foreignQueue.actions,['ack']);
});
test('forged event authority and missing configuration fail before coordinator access; transient failures are retried',async()=>{
 const consume=handler();let calls=0;const runtime={...env,WORKSPACES:{getByName(){calls++;return {artifactPush:async()=>{throw Error('Controlled failure')}}}}};
 const forged=body();forged.source.namespace='foreign';const denied=message(forged);await consume({queue,messages:[denied]},runtime);assert.equal(calls,0);assert.deepEqual(denied.actions,['ack']);
 await assert.rejects(consume({queue,messages:[message()]},{...runtime,ARTIFACTS_EVENTS_SUBSCRIPTIONS:'[]'}),{code:'ARTIFACT_EVENTS_NOT_CONFIGURED'});assert.equal(calls,0);
 const retry=message();await consume({queue,messages:[retry]},runtime);assert.equal(calls,1);assert.deepEqual(retry.actions,[['retry',{delaySeconds:60}]]);
});

test('automatic registrations require the coordinator durable binding before acknowledgment',async()=>{
 const consume=handler(),m=message();let calls=0;
 const runtime={...env,ARTIFACTS_EVENTS_AUTOMATIC:'true',ARTIFACTS_EVENTS_SUBSCRIPTIONS:'[]',WORKSPACES:{getByName(id){assert.equal(id,env.WORKSPACE_ID);return {async artifactPush(){calls++;throw Error('Unregistered subscription');}}}}};
 await consume({queue,messages:[m]},runtime);assert.equal(calls,1);assert.deepEqual(m.actions,[['retry',{delaySeconds:60}]]);
 const bad=body();bad.metadata.accountId='3'.repeat(32);const foreign=message(bad);await consume({queue,messages:[foreign]},runtime);assert.equal(calls,1);assert.deepEqual(foreign.actions,['ack']);
});
