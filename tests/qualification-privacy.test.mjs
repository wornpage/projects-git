import test from 'node:test';import assert from 'node:assert/strict';
import {privateQualificationFetch} from './qualification/private-fetch.ts';
test('public qualification requests and spoofed Host headers cannot reach app APIs or assets',async()=>{
  let invoked=0;const fetch=privateQualificationFetch(async()=>{invoked++;return new Response('Private app source');});
  for(const path of ['/','/api/workspace','/styles.css'])for(const host of ['projects-agent-identity-qa.example.workers.dev','qualification.invalid']){
    const response=await fetch(new Request('https://projects-agent-identity-qa.example.workers.dev'+path,{headers:{Host:host,'X-Forwarded-Host':'qualification.invalid'}}),{});
    assert.equal(response.status,404);assert.equal(await response.text(),'Not found');
  }
  assert.equal(invoked,0);
  const bound=await fetch(new Request('https://qualification.invalid/api/workspace'),{});assert.equal(bound.status,200);assert.equal(invoked,1);
});
test('only the pinned-audience sign-in callback gets an inert landing response',async()=>{
  let invoked=0;const fetch=privateQualificationFetch(async()=>{invoked++;return new Response('Private app source');}),env={ACCESS_AUD:'a'.repeat(64)};
  const query='?aud='+env.ACCESS_AUD+'&token=untrusted-query-data';
  for(const path of ['/','/cdn-cgi/access/cli']){const r=await fetch(new Request('https://qualification.example.workers.dev'+path+query),env);assert.equal(r.status,200);const body=await r.text();assert.ok(body.includes('sign-in only'));assert.ok(!body.includes('untrusted-query-data'));}
  for(const url of ['/api/workspace'+query,'/styles.css'+query,'/?aud=wrong&token=x','/?aud='+env.ACCESS_AUD])assert.equal((await fetch(new Request('https://qualification.example.workers.dev'+url),env)).status,404);
  assert.equal(invoked,0);
});
