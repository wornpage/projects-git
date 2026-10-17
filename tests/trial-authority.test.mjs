import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAuthority,accessPolicy} from '../src/cloudflare/access.ts';
import {authenticatedReviewer} from '../public/review-boundary.js';
const workspaceId='trial-'+'a'.repeat(64),issuer='https://fixture.cloudflareaccess.com';
const principal={provider:'trial-credential',kind:'agent',issuer,id:'agent-'+workspaceId,workspaceId,displayName:'Agent',issuedAt:1,expiresAt:9999999999,credentialId:crypto.randomUUID()};
const policy={issuer,audience:'b'.repeat(64),workspaceId,ownerSubject:'owner',agentClientIds:[principal.id],reviewerClientIds:['reviewer-'+workspaceId],credentialProvider:'trial-credential'};
test('application credentials require an explicitly derived trial policy and cannot become an owner',()=>{
  assertAuthority({policy,principal},workspaceId);
  for(const changed of [{...policy,credentialProvider:undefined},{...policy,workspaceId:'private'}, {...policy,agentClientIds:[]}])assert.throws(()=>assertAuthority({policy:changed,principal},workspaceId));
  assert.throws(()=>assertAuthority({policy,principal:{...principal,kind:'owner',id:'owner'}},workspaceId));
  assert.throws(()=>assertAuthority({policy,principal:{...principal,kind:'reviewer'}},workspaceId));
  const privatePolicy=accessPolicy({WORKSPACE_ID:'private',ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUD:'b'.repeat(64),ACCESS_OWNER_SUB:'owner',ACCESS_AGENT_CLIENT_IDS:'[]'});
  assert.equal(privatePolicy.credentialProvider,undefined);
});
test('retained trial reviewer provenance stays bound to its owner issuer and trial workspace',()=>{
  const workspace={id:workspaceId,provider:'cloudflare-artifacts',authentication:{issuer}},reviewer={...principal,kind:'reviewer',id:'reviewer-'+workspaceId};
  assert.equal(authenticatedReviewer(workspace,reviewer),true);
  for(const changed of [{...reviewer,id:principal.id},{...reviewer,issuer:'https://foreign.cloudflareaccess.com'},{...reviewer,workspaceId:'private'}])assert.equal(authenticatedReviewer(workspace,changed),false);
  assert.equal(authenticatedReviewer({...workspace,id:'private'},reviewer),false);
  assert.equal(authenticatedReviewer({...workspace,provider:'local-git'},reviewer),false);
});
