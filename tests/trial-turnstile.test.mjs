import test from 'node:test';
import assert from 'node:assert/strict';
import {trial,verifier,fixture,req,token} from './helpers/trial-http.mjs';

const accepted={success:true,hostname:'trial.example.test',action:'turnstile-spin-v2'};
const count=c=>c.sql.storage.sql.exec('SELECT COUNT(*) n FROM trial_admissions').one().n;
const reservation=(jwt,body)=>new Request(req('/api/trial',jwt,{turnstileToken:'unused'}),{body:JSON.stringify(body)});

test('reservation verifies the token server-side with the trusted IP before admission; replay is refused',async()=>{
  const c=fixture(),jwt=await token(),seen=new Set(),calls=[];
  const handler=trial.createTrialFetch(verifier,async(url,init)=>{
    calls.push(url);assert.equal(count(c),seen.size?1:0);assert.equal(init.redirect,'manual');assert.ok(init.signal);
    const form=new URLSearchParams(init.body);assert.equal(form.get('secret'),'fixture-secret');assert.equal(form.get('remoteip'),'192.0.2.8');
    const response=form.get('response');if(seen.has(response))return Response.json({success:false,'error-codes':['timeout-or-duplicate']});
    seen.add(response);return Response.json(accepted);
  });
  const request=()=>{const r=reservation(jwt,{turnstileToken:'real-shaped-token'});r.headers.set('CF-Connecting-IP','192.0.2.8');r.headers.set('X-Forwarded-For','203.0.113.9');return r;};
  assert.equal((await handler(request(),c.env)).status,200);assert.equal(count(c),1);
  assert.equal((await handler(request(),c.env)).status,403);assert.equal(count(c),1);
  assert.deepEqual(calls,Array(2).fill('https://challenges.cloudflare.com/turnstile/v0/siteverify'));
});

test('missing, oversized and malformed tokens or selectors create no admission and make no provider call',async()=>{
  const c=fixture(),jwt=await token();let calls=0;const handler=trial.createTrialFetch(verifier,async()=>{calls++;return Response.json(accepted);});
  for(const body of [{},{turnstileToken:''},{turnstileToken:12},{turnstileToken:'x'.repeat(2049)},{turnstileToken:'valid',subject:'other'}]){
    const r=await handler(reservation(jwt,body),c.env);assert.ok(r.status===400||r.status===403);assert.equal(count(c),0);
  }assert.equal(calls,0);
});

test('false, expired, wrong-action, wrong-host and malformed provider results fail closed',async()=>{
  for(const value of [{success:false,'error-codes':['timeout-or-duplicate']},{...accepted,success:'true'},{...accepted,hostname:'other.example.test'},
    {...accepted,action:'other'},{success:true},null]){
    const c=fixture(),jwt=await token(),handler=trial.createTrialFetch(verifier,async()=>Response.json(value));
    const r=await handler(reservation(jwt,{turnstileToken:'token'}),c.env);assert.ok([403,503].includes(r.status));assert.equal(count(c),0);
  }
});

test('missing configuration, provider failures, oversized replies and redirects cannot admit or leak secrets',async()=>{
  for(const fetcher of [async()=>{throw Error('fixture-secret private-token');},async()=>new Response(null,{status:302,headers:{Location:'https://other.invalid/'}}),
    async()=>new Response('private-token',{status:500}),async()=>Response.json({success:true,padding:'x'.repeat(9000)})]){
    const c=fixture(),jwt=await token(),handler=trial.createTrialFetch(verifier,fetcher);
    const r=await handler(reservation(jwt,{turnstileToken:'private-token'}),c.env);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/fixture-secret|private-token/);assert.equal(count(c),0);
  }
  for(const name of ['TRIAL_TURNSTILE_SITE_KEY','TRIAL_TURNSTILE_SECRET','TRIAL_TURNSTILE_HOSTNAME']){
    const c=fixture(),jwt=await token();delete c.env[name];let called=false;
    const handler=trial.createTrialFetch(verifier,async()=>{called=true;return Response.json(accepted);});
    assert.equal((await handler(reservation(jwt,{turnstileToken:'token'}),c.env)).status,503);assert.equal(called,false);assert.equal(count(c),0);
  }
});

test('status, closure and scoped-agent authentication do not depend on a fresh Turnstile check',async()=>{
  const c=fixture(),jwt=await token();let calls=0;
  const handler=trial.createTrialFetch(verifier,async()=>{calls++;return Response.json(accepted);});
  assert.equal((await handler(reservation(jwt,{turnstileToken:'token'}),c.env)).status,200);
  assert.equal((await handler(req('/api/trial',jwt),c.env)).status,200);
  assert.equal((await handler(req('/api/trial/close',jwt,{}),c.env)).status,200);
  assert.notEqual((await handler(req('/agent/api/workspace'),c.env)).status,200);
  assert.equal(calls,1);
});

test('only the authenticated signup document allows the Turnstile script and frame',async()=>{
  const c=fixture(),jwt=await token(),handler=trial.createTrialFetch(verifier);
  const publicPage=await handler(req('/trial/'),c.env),signup=await handler(req('/trial/signup',jwt),c.env);
  assert.doesNotMatch(publicPage.headers.get('Content-Security-Policy'),/challenges.cloudflare.com/);
  assert.match(signup.headers.get('Content-Security-Policy'),/script-src 'self' https:\/\/challenges.cloudflare.com/);
  assert.match(signup.headers.get('Content-Security-Policy'),/frame-src https:\/\/challenges.cloudflare.com/);
  const session=await(await handler(req('/api/trial/session',jwt),c.env)).json();assert.equal(session.turnstile.siteKey,'fixture-sitekey');assert.doesNotMatch(JSON.stringify(session),/fixture-secret/);
});
