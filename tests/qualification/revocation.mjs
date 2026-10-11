import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory,agents,setup,receipt,ownerToken,request,ok,control,passed,save,waitFor} from './client.mjs';
let failure;
try{
  const owner=await ownerToken(),service=await readFile(join(privateDirectory,'agent-jwt'),'utf8');
  const oldServiceClaims=JSON.parse(Buffer.from(service.split('.')[1],'base64url'));
  assert.ok(oldServiceClaims.exp>Math.floor(Date.now()/1000),'Service JWT must still be valid before revocation');
  assert.equal((await request({token:owner},'/api/workspace')).status,200);
  assert.equal((await request({token:service},'/api/workspace')).status,200);
  const before=(await control('/snapshot')).result;
  const revoked=await ok('owner','/api/workspace/revoke-sessions',{});
  for(const token of [owner,service]){const denied=await request({token},'/api/workspace');assert.equal(denied.status,401);assert.equal(denied.result.code,'SESSION_REVOKED');}
  await control('/restart');
  const after=(await control('/snapshot')).result;
  assert.equal(after.workspace.sessionsValidAfter,revoked.sessionsValidAfter);assert.equal(after.workspace.runs.length,before.workspace.runs.length);
  for(const token of [owner,service])assert.equal((await request({token},'/api/workspace')).status,401);
  receipt.revocation={cutoff:revoked.sessionsValidAfter,ownerIssuedAt:JSON.parse(Buffer.from(owner.split('.')[1],'base64url')).iat,agentIssuedAt:oldServiceClaims.iat,retainedRuns:after.workspace.runs.length};
  passed('previously valid real owner and service JWTs are refused by a durable cutoff across restart');
  // The public hostname remains disabled. Session renewal is intentionally not
  // attempted through a public route in this private requalification cohort.
  assert.equal((await fetch('https://'+setup.hostname+'/api/workspace',{redirect:'manual'})).status,404);
  const seed=await control('/seed',{retireTokens:true});assert.equal(seed.status,200);assert.ok(seed.result.tokens.every(t=>t.state!=='active'));
  receipt.seedCredentialState=seed.result;
  passed('initial seed Git credential retired after all provider writes complete');
}catch(error){failure=error;}finally{await save('revocation',failure);}if(failure)throw failure;
