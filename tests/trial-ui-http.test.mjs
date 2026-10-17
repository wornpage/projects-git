import test from 'node:test';
import assert from 'node:assert/strict';
import {handler,fixture,req,token,admit,identityKey} from './helpers/trial-http.mjs';

test('trial landing/assets are a closed public surface with no admission or caller identity forwarded',async()=>{
  const c=fixture(),assets=[];
  c.env.ASSETS={fetch:async request=>{assets.push(request);return new Response('public-static',{headers:{'Content-Type':'text/html','Set-Cookie':'must-not-leave'}});}};
  for(const path of ['/trial/','/trial/app.js','/trial/client.js','/trial/view.js','/ui/dom.js','/trial/styles.css']){
    const response=await handler(req(path,'invalid-cookie'),c.env);assert.equal(response.status,200,path);
    assert.equal(response.headers.get('Set-Cookie'),null);assert.match(response.headers.get('Content-Security-Policy'),/form-action 'none'/);
    assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'self'/);
  }
  assert.ok(assets.every(request=>[...request.headers].length===0));assert.deepEqual(c.calls,[]);
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);
  for(const path of ['/trial/index.html','/trial/assets/../private.js','/trial/assets/%61pp.js','/trial/assets/config.json'])
    assert.notEqual((await handler(req(path),c.env)).status,200,path);
  assert.equal((await handler(req('/trial/',undefined,{}),c.env)).status,405);
});

test('signup document needs verified identity but never requires or creates a reservation',async()=>{
  const c=fixture();assert.equal((await handler(req('/trial/signup'),c.env)).status,401);assert.deepEqual(c.assetCalls,[]);
  assert.equal((await handler(req('/trial/signup',await token()),c.env)).status,200);
  assert.equal(c.assetCalls.length,1);assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);assert.deepEqual(c.calls,[]);
});

test('session exposes only the verified email, identity precondition and actual trial duration',async()=>{
  const c=fixture(),jwt=await token(),response=await handler(req('/api/trial/session',jwt),c.env);assert.equal(response.status,200);
  const value=await response.json();assert.deepEqual(Object.keys(value).sort(),['email','identityKey','policy','turnstile']);
  assert.equal(value.identityKey,identityKey(jwt));assert.equal(value.email,'same@example.test');assert.equal(value.policy.durationMs,60000);
  assert.doesNotMatch(JSON.stringify(value),/person-a|ownerSubject|audience|workspaceId/);
  for(const path of ['/api/trial/session?subject=other','/api/trial/session?workspaceId=real'])assert.equal((await handler(req(path,jwt),c.env)).status,400);
  assert.deepEqual(c.calls,[]);assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);
});

test('missing or stale identity preconditions cannot reserve or close a different signed-in user trial',async()=>{
  const c=fixture(),a=await token(),b=await token('person-b');
  const missing=req('/api/trial',a,{});missing.headers.delete('X-Trial-Identity');assert.equal((await handler(missing,c.env)).status,409);
  const stale=await handler(req('/api/trial',b,{}, {'X-Trial-Identity':identityKey(a)}),c.env);assert.equal(stale.status,409);assert.equal((await stale.json()).code,'TRIAL_IDENTITY_CHANGED');
  assert.equal(c.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,0);
  const ga=await admit(c,a),gb=await admit(c,b);assert.notEqual(ga.identityKey,gb.identityKey);
  assert.equal((await handler(req('/api/trial/close',b,{}, {'X-Trial-Identity':ga.identityKey}),c.env)).status,409);
  const current=await(await handler(req('/api/trial',b),c.env)).json();assert.equal(current.status,'admitted');assert.equal(current.identityKey,gb.identityKey);
});

test('trial workspace navigation uses authenticated private workbench routing after admission',async()=>{
  const c=fixture(),jwt=await token();await admit(c,jwt);
  c.env.ASSETS={fetch:async request=>{c.assetCalls.push(request.url);return new Response('<body><script type="module" src="/app.js"></script></body>',{headers:{'Content-Type':'text/html'}});}};
  const response=await handler(req('/workspace/?view=projects',jwt),c.env);assert.equal(response.status,200);
  assert.match(await response.text(),/\/workspace\/assets\/app.js/);assert.equal(new URL(c.assetCalls[0]).pathname,'/index.html');
});
