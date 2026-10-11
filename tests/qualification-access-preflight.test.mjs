import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchAccessInventory,verifyAccessBoundary,verifyAccessReceipt} from './qualification/access-preflight.mjs';

const now=Date.parse('2026-10-06T18:00:00Z');
const appId='11111111-1111-1111-1111-111111111111';
const setup={accessApplicationId:appId,hostname:'review.example.workers.dev',audience:'a'.repeat(64),
  issuer:'https://review.cloudflareaccess.com',ownerEmail:'owner@example.test',ownerSubject:'verified-owner',
  ownerVerifiedAt:'2026-10-06T17:00:00Z'};
const credentials=Array.from({length:10},(_,index)=>({id:`${String(index+1).padStart(8,'0')}-2222-2222-2222-222222222222`,
  client_id:(index+1).toString(16).repeat(32)+'.access',client_secret:'private-'+index}));
const agents=credentials.slice(0,8),reviewers=credentials.slice(8);
const application={id:appId,type:'self_hosted',domain:setup.hostname,aud:setup.audience,session_duration:'8h'};
const policies=[{id:'owner-policy',decision:'allow',include:[{email:{email:setup.ownerEmail}}]},
  {id:'service-policy',decision:'non_identity',include:credentials.map(item=>({service_token:{token_id:item.id}}))}];
const tokens=credentials.map(item=>({id:item.id,client_id:item.client_id,enabled:true,duration:'24h',
  expires_at:new Date(now+23*60*60*1000).toISOString()}));
const valid=()=>({setup,agents,reviewers,application,policies,tokens,now});

test('provider inventory proves exact owner and ten bounded service identities without retaining secrets',()=>{
  const result=verifyAccessBoundary(valid());
  assert.equal(result.application.audience,setup.audience);
  assert.equal(result.policies.serviceTokenCount,10);
  assert.equal(result.serviceTokens.length,10);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('broad or altered Access policies cannot qualify the private boundary',()=>{
  const broad=[
    [...policies,{id:'bypass',decision:'bypass',include:[{everyone:{}}]}],
    [{...policies[0],include:[{email_domain:{domain:'example.test'}}]},policies[1]],
    [policies[0],{...policies[1],include:[{any_valid_service_token:{}}]}],
    [policies[0],{...policies[1],include:policies[1].include.slice(1)}],
  ];
  for(const candidate of broad)assert.throws(()=>verifyAccessBoundary({...valid(),policies:candidate}));
});

test('expired, disabled, extended, or mismatched provider tokens fail before qualification',()=>{
  for(const changed of [
    {expires_at:new Date(now-1000).toISOString()},
    {expires_at:new Date(now+25*60*60*1000).toISOString()},
    {duration:'8760h'},
    {enabled:false},
    {client_id:'foreign.access'},
  ]){
    const altered=[{...tokens[0],...changed},...tokens.slice(1)];
    assert.throws(()=>verifyAccessBoundary({...valid(),tokens:altered}));
  }
});

test('wrong application audience, hostname, or owner session length fails closed',()=>{
  for(const changed of [{aud:'b'.repeat(64)},{domain:'foreign.example.workers.dev'},
    {session_duration:'24h'},{type:'saas'},
    {destinations:[{type:'public',uri:'review.example.workers.dev',overrides:[{behavior:'public',path_pattern:'/*'}]}]},
    {destinations:[{type:'public',uri:'review.example.workers.dev'},{type:'public',uri:'other.example.workers.dev'}]}])
    assert.throws(()=>verifyAccessBoundary({...valid(),application:{...application,...changed}}));
});

test('hosted scenarios reject stale receipts, changed source and changed token cohorts',()=>{
  const observation=verifyAccessBoundary(valid());
  const source={commit:'c'.repeat(40),tree:'d'.repeat(40),clean:true};
  const receipt={format:'projects-review-access-preflight/v1',status:'passed',account:'account',workspace:'workspace',source,observation};
  const pinned={...setup,account:'account',workspace:'workspace'};
  assert.doesNotThrow(()=>verifyAccessReceipt({receipt,setup:pinned,agents,reviewers,source,now}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:pinned,agents,reviewers,source:{...source,commit:'e'.repeat(40)},now}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:pinned,agents,reviewers,source:{...source,clean:false},now}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:{...pinned,ownerSubject:'different-owner'},agents,reviewers,source,now}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:{...pinned,ownerEmail:'other@example.test'},agents,reviewers,source,now}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:pinned,agents,reviewers,source,now:now+31*60*1000}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:pinned,agents,reviewers:[{...reviewers[0],id:'foreign'},reviewers[1]],source,now}));
  assert.throws(()=>verifyAccessReceipt({receipt,setup:pinned,agents,reviewers:[agents[0],reviewers[1]],source,now}));
});

test('Access preflight reads all policy pages and refuses a denied API response',async()=>{
  const paths=[];
  const fetchImpl=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer private-api-token');
    const path=new URL(url).pathname+new URL(url).search;
    paths.push(path);
    if(path.endsWith('/apps/'+appId))return Response.json({success:true,result:application});
    if(path.includes('/policies?')){
      const page=Number(new URL(url).searchParams.get('page'));
      return Response.json({success:true,result:[policies[page-1]],result_info:{total_pages:2}});
    }
    if(path.includes('/service_tokens?'))return Response.json({success:true,result:tokens,result_info:{total_pages:1}});
    return Response.json({success:false},{status:404});
  };
  const inventory=await fetchAccessInventory({account:'a'.repeat(32),applicationId:appId,
    apiToken:'private-api-token',fetchImpl});
  assert.equal(inventory.policies.length,2);
  assert.equal(paths.length,4);
  assert.equal(verifyAccessBoundary({...valid(),...inventory}).serviceTokens.length,10);
  await assert.rejects(fetchAccessInventory({account:'a'.repeat(32),applicationId:appId,
    apiToken:'private-api-token',fetchImpl:async()=>Response.json({success:false},{status:403})}),/HTTP 403/);
});
