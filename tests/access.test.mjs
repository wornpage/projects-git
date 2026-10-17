import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {AccessVerifier, accessPolicy, assertAuthority, authorizeRoute} from '../src/cloudflare/access.ts';
import {testAuthority, AGENT_CLIENT} from './helpers/hosted-authority.mjs';

const authority=testAuthority(), policy=authority.policy;
const first=await generateKeyPair('RS256'), second=await generateKeyPair('RS256');
const jwk=async(pair,kid)=>({...await exportJWK(pair.publicKey),kid,alg:'RS256',use:'sig'});
const now=Date.now(), seconds=Math.floor(now/1000);
const claims={type:'app',iss:policy.issuer,aud:[policy.audience],sub:policy.ownerSubject,email:'owner@example.test',iat:seconds,exp:seconds+3600};
const token=(body=claims,pair=first,kid='first')=>new SignJWT(body).setProtectedHeader({alg:'RS256',kid}).sign(pair.privateKey);
const request=value=>new Request('https://workspace.example.test/api/workspace',{headers:value?{'Cf-Access-Jwt-Assertion':value}:{}});
function fixture(){let clock=now,keys=[first],calls=0;const verifier=new AccessVerifier(async(url,options)=>{
  assert.equal(String(url),policy.issuer+'/cdn-cgi/access/certs');assert.equal(options.redirect,'manual');calls++;
  return Response.json({keys:await Promise.all(keys.map(pair=>jwk(pair,pair===first?'first':'second')))});
},()=>clock);return {verifier,advance:ms=>clock+=ms,rotate:()=>keys=[second],calls:()=>calls};}

test('Access configuration requires pinned issuer, audience, owner and distinct allowlisted clients',()=>{
  assert.throws(()=>accessPolicy({}),{code:'AUTH_NOT_CONFIGURED'});
  const env={ACCESS_TEAM_DOMAIN:policy.issuer,ACCESS_AUD:policy.audience,ACCESS_OWNER_SUB:policy.ownerSubject,WORKSPACE_ID:policy.workspaceId,ACCESS_AGENT_CLIENT_IDS:JSON.stringify(policy.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(policy.reviewerClientIds),ACCESS_REVIEWER_SUBJECTS:'[]'};
  assert.deepEqual(accessPolicy(env),policy);
  for(const mutation of [{ACCESS_TEAM_DOMAIN:'http://fixture.cloudflareaccess.com'},{ACCESS_TEAM_DOMAIN:policy.issuer+'/evil'},{ACCESS_AUD:''},{ACCESS_OWNER_SUB:''},{ACCESS_AGENT_CLIENT_IDS:JSON.stringify([AGENT_CLIENT,AGENT_CLIENT])}])assert.throws(()=>accessPolicy({...env,...mutation}),{code:'AUTH_NOT_CONFIGURED'});
});
test('allowlisted human reviewer subjects get review scope without owner powers',async()=>{
 const f=fixture(),subject='human-reviewer',scoped={...policy,reviewerSubjects:[subject]};
 const reviewer=await f.verifier.authenticate(request(await token({...claims,sub:subject,email:'reviewer@example.test'})),scoped);
 assert.equal(reviewer.kind,'reviewer');assert.equal(reviewer.id,subject);assertAuthority({policy:scoped,principal:reviewer},policy.workspaceId);
 assert.throws(()=>authorizeRoute(reviewer,'POST','/api/tasks'),{code:'REVIEWER_READ_ONLY'});
 assert.throws(()=>accessPolicy({ACCESS_TEAM_DOMAIN:policy.issuer,ACCESS_AUD:policy.audience,ACCESS_OWNER_SUB:policy.ownerSubject,WORKSPACE_ID:policy.workspaceId,ACCESS_AGENT_CLIENT_IDS:'[]',ACCESS_REVIEWER_SUBJECTS:JSON.stringify([policy.ownerSubject])}),{code:'AUTH_NOT_CONFIGURED'});
});

test('configured human members authenticate by signed subject and receive read-only routes',async()=>{
 const f=fixture(),subject='team-member',scoped={...policy,memberSubjects:[subject]};
 const member=await f.verifier.authenticate(request(await token({...claims,sub:subject,email:'member@example.test'})),scoped);
 assert.equal(member.kind,'member');assert.equal(member.id,subject);assertAuthority({policy:scoped,principal:member},policy.workspaceId);
 authorizeRoute(member,'GET','/api/workspace');
 assert.throws(()=>authorizeRoute(member,'POST','/api/tasks'),{code:'MEMBER_READ_ONLY'});
 await assert.rejects(f.verifier.authenticate(request(await token({...claims,sub:'another-subject',email:'member@example.test'})),scoped),{code:'FORBIDDEN'});
 assert.throws(()=>assertAuthority({policy:{...scoped,memberSubjects:[]},principal:member},policy.workspaceId),{code:'FORBIDDEN'});
});

test('member configuration rejects duplicates and identities with another authority role',()=>{
 const env={ACCESS_TEAM_DOMAIN:policy.issuer,ACCESS_AUD:policy.audience,ACCESS_OWNER_SUB:policy.ownerSubject,WORKSPACE_ID:policy.workspaceId,
   ACCESS_AGENT_CLIENT_IDS:JSON.stringify(policy.agentClientIds),ACCESS_REVIEWER_CLIENT_IDS:JSON.stringify(policy.reviewerClientIds),ACCESS_REVIEWER_SUBJECTS:'["reviewer-person"]'};
 for(const entries of [[policy.ownerSubject],[AGENT_CLIENT],[policy.reviewerClientIds[0]],['reviewer-person'],['one','one'],['*'],{}])
   assert.throws(()=>accessPolicy({...env,ACCESS_MEMBER_SUBJECTS:JSON.stringify(entries)}),{code:'AUTH_NOT_CONFIGURED'});
 assert.deepEqual(accessPolicy({...env,ACCESS_MEMBER_SUBJECTS:'["stable-member-subject"]'}).memberSubjects,['stable-member-subject']);
});

test('signed owner and service sessions derive distinct trusted principals',async()=>{
  const f=fixture();assert.deepEqual(await f.verifier.authenticate(request(await token()),policy),{...authority.principal,issuedAt:seconds,expiresAt:seconds+3600});
  const {email,...service}=claims;service.sub='';service.common_name=AGENT_CLIENT;
  const actor=await f.verifier.authenticate(request(await token(service)),policy);
  assert.equal(actor.kind,'agent');assert.equal(actor.id,AGENT_CLIENT);assert.equal(f.calls(),1);
  assertAuthority({policy,principal:actor},policy.workspaceId);
  assert.throws(()=>assertAuthority({policy:{...policy,agentClientIds:[]},principal:actor},policy.workspaceId),{code:'FORBIDDEN'});
});

const invalidClaims=[['expired',{exp:seconds-1}],['not yet valid',{nbf:seconds+60}],['future issued',{iat:seconds+60}],['wrong issuer',{iss:'https://other.cloudflareaccess.com'}],['wrong audience',{aud:['b'.repeat(64)]}],['global session',{type:'org'}]];
for(const [label,change]of invalidClaims)test('Access rejects '+label+' tokens',async()=>{await assert.rejects(fixture().verifier.authenticate(request(await token({...claims,...change})),policy),{code:'UNAUTHORIZED'});});
for(const field of ['exp','iat','sub'])test('Access rejects a token missing '+field,async()=>{const body={...claims};delete body[field];await assert.rejects(fixture().verifier.authenticate(request(await token(body)),policy),{code:'UNAUTHORIZED'});});

test('missing assertions, raw service headers, old bearer secrets and unsigned tokens cannot authenticate',async()=>{
  const f=fixture();
  for(const headers of [{},{Authorization:'Bearer old-shared-secret'},{'CF-Access-Client-Id':AGENT_CLIENT,'CF-Access-Client-Secret':'not-an-assertion'},{'Cf-Access-Jwt-Assertion':Buffer.from(JSON.stringify({alg:'none'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.'}])await assert.rejects(f.verifier.authenticate(new Request('https://workspace.example.test',{headers}),policy),{code:'UNAUTHORIZED'});
});

test('forged signatures and signed but unapproved identities fail closed',async()=>{
  const f=fixture();await assert.rejects(f.verifier.authenticate(request(await token(claims,second,'first')),policy),{code:'UNAUTHORIZED'});
  await assert.rejects(f.verifier.authenticate(request(await token({...claims,sub:'another-owner'})),policy),{code:'FORBIDDEN'});
  const {email,...service}=claims;await assert.rejects(f.verifier.authenticate(request(await token({...service,sub:'',common_name:'f'.repeat(32)+'.access'})),policy),{code:'FORBIDDEN'});
});

test('public keys rotate without caching tokens or ignoring session expiration',async()=>{
  const f=fixture(),old=await token();await f.verifier.authenticate(request(old),policy);f.rotate();f.advance(31_000);
  await f.verifier.authenticate(request(await token(claims,second,'second')),policy);assert.equal(f.calls(),2);
  f.advance(3_600_000);await assert.rejects(f.verifier.authenticate(request(await token(claims,second,'second')),policy),{code:'UNAUTHORIZED'});
});

test('unknown keys have bounded refresh and unavailable or oversized JWKS responses refuse access',async()=>{
  const f=fixture();await f.verifier.authenticate(request(await token()),policy);
  for(let index=0;index<4;index++)await assert.rejects(f.verifier.authenticate(request(await token(claims,second,'unknown')),policy),{code:'UNAUTHORIZED'});
  assert.equal(f.calls(),1);
  for(const fetchKeys of [async()=>new Response(null,{status:302,headers:{Location:'https://foreign.example/keys'}}),async()=>new Response('unavailable',{status:503}),async()=>new Response(' '.repeat(128*1024+1)),async()=>{throw Error('private upstream credential text');}])await assert.rejects(new AccessVerifier(fetchKeys,()=>now).authenticate(request(await token()),policy),error=>error.code==='UNAUTHORIZED'&&!error.message.includes('credential'));
});

test('workspace and role authorization reject confused principals and owner actions by agents',()=>{
  assertAuthority(authority,policy.workspaceId);
  assert.throws(()=>assertAuthority({...authority,principal:{...authority.principal,workspaceId:'other'}},policy.workspaceId),{code:'WORKSPACE_FORBIDDEN'});
  assert.throws(()=>assertAuthority({...authority,principal:{...authority.principal,id:'another'}},policy.workspaceId),{code:'FORBIDDEN'});
  const actor=testAuthority(policy.workspaceId,AGENT_CLIENT).principal,id='a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12);
  for(const path of ['/api/tasks','/api/runs/'+id+'/review','/api/runs/'+id+'/merge','/api/runs/'+id+'/verify','/api/projects/'+id+'/policy','/api/workspace/adopt-owner'])assert.throws(()=>authorizeRoute(actor,'POST',path),{code:'OWNER_REQUIRED'});
  authorizeRoute(actor,'GET','/api/workspace');authorizeRoute(actor,'POST','/api/projects/'+id+'/claim');authorizeRoute(actor,'POST','/api/runs/'+id+'/submit');
});
