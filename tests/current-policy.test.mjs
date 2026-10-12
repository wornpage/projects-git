import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {currentPolicy} from '../src/cloudflare/current-policy.ts';
import {testAuthority} from './helpers/hosted-authority.mjs';

test('current authority reads are distinct private calls and never reuse an earlier policy',async()=>{
  const policy=testAuthority().policy,nonces=[];
  const source={async readPolicy(workspace,nonce){assert.equal(workspace,policy.workspaceId);nonces.push(nonce);return {nonce,policy};}};
  const first=await currentPolicy(source,policy.workspaceId);assert.equal(first.reviewerClientIds.length,1);
  policy.reviewerClientIds=[];
  const second=await currentPolicy(source,policy.workspaceId);assert.deepEqual(second.reviewerClientIds,[]);
  assert.equal(first.reviewerClientIds.length,1);assert.equal(nonces.length,2);assert.notEqual(nonces[0],nonces[1]);
});

test('missing, failed, malformed, wrong-workspace and replayed policy responses fail closed',async()=>{
  const policy=testAuthority().policy;
  for(const source of [undefined,{readPolicy:async()=>{throw Error('Unavailable');}},
    {readPolicy:async()=>null}, {readPolicy:async()=>({nonce:'stale',policy})},
    {readPolicy:async(_,nonce)=>({nonce,policy:{...policy,workspaceId:'other'}})},
    {readPolicy:async(_,nonce)=>({nonce,policy:{...policy,audience:'invalid'}})}])
    await assert.rejects(currentPolicy(source,policy.workspaceId),{code:'CURRENT_POLICY_UNAVAILABLE'});
});

test('current authority timeout rejects a late response without making it a cache',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const policy=testAuthority().policy;let release,nonce;
  const pending=currentPolicy({readPolicy:async(_,value)=>{nonce=value;return new Promise(resolve=>release=resolve);}},policy.workspaceId);
  const refused=assert.rejects(pending,{code:'CURRENT_POLICY_UNAVAILABLE'});t.mock.timers.tick(5000);await refused;
  release({nonce,policy});await Promise.resolve();
  await assert.rejects(currentPolicy(undefined,policy.workspaceId),{code:'CURRENT_POLICY_UNAVAILABLE'});
});

test('both shipped application configurations bind current authority to their own named entrypoint',()=>{
  for(const file of ['wrangler.jsonc','wrangler.hosted.jsonc']){
    const config=JSON.parse(readFileSync(new URL('../'+file,import.meta.url),'utf8'));
    assert.deepEqual(config.services.find(item=>item.binding==='CURRENT_POLICY'),{binding:'CURRENT_POLICY',service:config.name,entrypoint:'WorkspacePolicy'});
    assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  }
});
