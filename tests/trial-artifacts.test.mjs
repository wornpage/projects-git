import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedTrialArtifacts} from '../src/cloudflare/trial-artifacts.ts';
import {TRIAL_SAMPLE} from '../src/core/trial-sample.mjs';
const workspaceId='trial-'+'a'.repeat(64),name='sample-'+'a'.repeat(64),key='b'.repeat(64),marker=`Projects Git creation: ${workspaceId}:${key}\n\n${TRIAL_SAMPLE.description}`;
function fixture(){let active=true,providerCalls=0;const reservations=[];
  const state={workspace:{id:workspaceId},operations:{[key]:{kind:'repository-create',resourceName:name,seedTemplate:TRIAL_SAMPLE.id,marker,repositoryId:'repo-a'}}};
  const data={name,id:'repo-a',description:marker};
  const raw={async info(){providerCalls++;return {...data};},async createToken(){providerCalls++;return{id:'token-a',plaintext:'private'};},async revokeToken(){providerCalls++;return true;},async readBlob(){providerCalls++;return new Blob(['source']);},[Symbol.dispose](){} };
  const binding={async get(){providerCalls++;return raw;},async create(){providerCalls++;return {};}};
  const validate=async()=>{if(!active)throw Object.assign(Error('Stopped'),{code:'TRIAL_SPENDING_PAUSED'});};
  const scoped=scopedTrialArtifacts(binding,()=>state,async kind=>{reservations.push(kind);},validate);
  return {scoped,state,data,reservations,get calls(){return providerCalls;},set active(value){active=value;}};
}
test('trial namespace access requires an exact retained creation/assignment intent before provider I/O',async()=>{
  const f=fixture();for(const action of [()=>f.scoped.get('foreign'),()=>f.scoped.list(),()=>f.scoped.import({}),()=>f.scoped.delete(name)])await assert.rejects(action(),{code:'TRIAL_REPOSITORY_FORBIDDEN'});
  assert.equal(f.calls,0);await f.scoped.get(name);assert.equal(f.calls,2);assert.deepEqual(f.reservations,['read','read']);
});
test('stopped resource work cannot read or issue, but an existing handle can revoke its owned credential',async()=>{
  const f=fixture(),repo=await f.scoped.get(name);await repo.createToken('write',60);assert.equal(f.reservations.at(-1),'issue');f.active=false;const before=f.calls;
  await assert.rejects(repo.readBlob('a'.repeat(40)),{code:'TRIAL_SPENDING_PAUSED'});await assert.rejects(repo.createToken('write',60),{code:'TRIAL_SPENDING_PAUSED'});assert.equal(f.calls,before);
  assert.equal(await repo.revokeToken('token-a'),true);assert.equal(f.calls,before+2);
});
test('repository replacement blocks teardown and long-lived tokens are refused',async()=>{
  const f=fixture(),repo=await f.scoped.get(name);await assert.rejects(repo.createToken('write',900),{code:'TRIAL_TOKEN_LIMIT'});f.data.id='replacement';await assert.rejects(repo.revokeToken('token-a'),{code:'TRIAL_REPOSITORY_FORBIDDEN'});
});
