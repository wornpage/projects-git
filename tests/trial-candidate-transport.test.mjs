import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {gitHttpFixture} from './helpers/git-http.mjs';

test('retained trial source and timestamp reproduce the same candidate after a pre-write interruption',async t=>{
  const f=await gitHttpFixture(t),timestamp=1792215000;let prepared;
  await assert.rejects(f.transport.commitCandidate({...f.candidate,timestamp,beforePush:async head=>{prepared=head;throw Error('Admission stopped');}}));
  assert.ok(prepared);assert.ok(!f.received.some(item=>item.path==='/fork.git/git-receive-pack'));
  const head=await f.transport.commitCandidate({...f.candidate,timestamp,beforePush:async value=>assert.equal(value,prepared)});
  assert.equal(head,prepared);assert.equal(await f.git(path.join(f.root,'fork.git'),'rev-parse','agents/one'),head);
  assert.equal(await f.git(path.join(f.root,'fork.git'),'diff','--name-only',f.baseCommit,head),'checkout.mjs');
});

test('a candidate publication cannot overwrite an existing assignment branch',async t=>{
  const f=await gitHttpFixture(t);const head=await f.transport.commitCandidate({...f.candidate,timestamp:1792215000});
  await assert.rejects(f.transport.commitCandidate({...f.candidate,timestamp:1792215001,files:[{path:'checkout.mjs',content:'export function checkoutTotal(){return 0;}'}]}));
  assert.equal(await f.git(path.join(f.root,'fork.git'),'rev-parse','agents/one'),head);
});
