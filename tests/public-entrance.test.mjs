import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {publicEntrance} from '../src/entrance/handler.mjs';
import {privateWorkbench} from '../src/cloudflare/workbench-assets.mjs';
import {DEMO_ASSETS} from '../src/entrance/assets.mjs';
import {entranceAssets} from '../scripts/entrance-assets.mjs';

const read = path => readFile(new URL('../public/' + path,import.meta.url),'utf8');
const index = await read('index.html'), landing = await read('entrance/index.html'), reviewer = await read('reviewer.html');
function fixture() {
  const calls = [];
  const binding = {fetch:async request=>{
    calls.push({path:new URL(request.url).pathname,headers:[...request.headers]});
    const path = new URL(request.url).pathname;
    return new Response(path === '/index.html' ? index : path === '/reviewer.html' ? reviewer : path === '/entrance/index.html' ? landing : '/* asset */',
      {headers:{'Content-Type':path.endsWith('.html')?'text/html':'text/javascript','Set-Cookie':'should-not-escape=1'}});
  }};
  return {calls,binding,fetch:(path,method='GET',headers={})=>publicEntrance(new Request('https://git.example' + path,{method,headers}),binding)};
}

test('public entrance explains the example and sign-in without publishing repository, video or owner data',async()=>{
  const f = fixture(), response = await f.fetch('/'), html = await response.text();
  assert.equal(response.status,200); assert.match(html,/Keep the work/); assert.match(html,/FICTIONAL EXAMPLE/);
  assert.match(html,/href="\/workspace\/"/); assert.match(html,/1 \/ 3 checks/); assert.match(html,/3 \/ 3 checks/);
  assert.doesNotMatch(html,/github\.com|\.mp4|\.webm|@|cloudflareaccess\.com|Access-Aud|ACCESS_OWNER_SUB/i);
  assert.deepEqual(f.calls.map(c=>c.path),['/entrance/index.html']);
  assert.equal(response.headers.get('Set-Cookie'),null);
});

test('read-only demo has scoped module assets and stays in its own path when navigating',async()=>{
  const f = fixture(), response = await f.fetch('/demo/?view=review'), html = await response.text();
  assert.equal(response.status,200); assert.match(html,/<body data-demo="read-only">/);
  assert.match(html,/src="\/demo\/assets\/app.js"/); assert.match(html,/href="\/demo\/assets\/styles.css"/);
  assert.match(html,/href="\?view=projects"/); assert.doesNotMatch(html,/href="\/\?view=/);
  assert.match(html,/href="\/">About Projects Git/);
  assert.match(html,/Sign in to private workspace/); assert.doesNotMatch(html,/#hosted-proof/);
  const headers = response.headers.get('Content-Security-Policy'); assert.match(headers,/connect-src 'none'/); assert.match(headers,/form-action 'none'/);
});

test('every approved workbench dependency is served and no caller identity is sent to the asset binding',async()=>{
  const f = fixture();
  for (const path of DEMO_ASSETS) {
    const response = await f.fetch('/demo/assets/' + path,'GET',{'Cf-Access-Jwt-Assertion':'do-not-forward','Cookie':'CF_Authorization=secret'});
    assert.equal(response.status,200,path); assert.equal(response.headers.get('Set-Cookie'),null);
  }
  assert.ok(f.calls.every(c=>c.headers.length === 0));
  assert.deepEqual(DEMO_ASSETS,await entranceAssets());
  assert.ok(!DEMO_ASSETS.some(path=>/reviewer|welcome|proof|\.html|\.json|entrance/.test(path)));
});

test('all public mutations are rejected before reading any asset or touching workspace state',async()=>{
  const f = fixture();
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) for (const path of ['/','/demo/','/demo/assets/app.js','/entrance/styles.css']) {
    const response = await f.fetch(path,method,{'Cf-Access-Jwt-Assertion':'owner'});
    assert.equal(response.status,405); assert.equal(response.headers.get('Allow'),'GET, HEAD');
  }
  assert.deepEqual(f.calls,[]);
});

test('unapproved assets, proof records, foreign views and encoded paths fail without any asset lookup',async()=>{
  const f = fixture();
  for (const path of ['/demo/assets/reviewer.js','/demo/assets/index.html','/demo/assets/.dev.vars','/demo/assets/%61pp.js',
    '/demo/assets/app.js.map','/demo/assets/..%2freviewer.js','/demo/assets/private%5csecret.js','/demo/api/workspace','/demo/proof.json','/demo/?view=unknown']) {
    assert.equal((await f.fetch(path)).status,404,path);
  }
  assert.deepEqual(f.calls,[]);
  for (const path of ['/api/workspace','/app.js','/workspace/','/workspace/assets/app.js','/qa/.dev.vars']) assert.equal(await f.fetch(path),null);
});

test('legacy task and reviewer links redirect to private routes without reading or reflecting workspace records',async()=>{
  const f = fixture();
  for (const [path,target] of [['/?view=review&task=foreign','/workspace/?view=review&task=foreign'],['/reviewer.html?run=foreign','/workspace/reviewer?run=foreign'],['/index.html','/'],['/demo?view=work','/demo/?view=work']]) {
    const response = await f.fetch(path); assert.ok([307,308].includes(response.status)); assert.equal(response.headers.get('Location'),target); assert.equal(await response.text(),'');
  }
  assert.deepEqual(f.calls,[]);
});

test('public HEAD requests have no body and retain the read-only content security policy',async()=>{
  const f = fixture();
  for (const path of ['/','/demo/','/demo/assets/app.js','/entrance/styles.css']) {
    const response = await f.fetch(path,'HEAD'); assert.equal(response.status,200); assert.equal(await response.text(),'');
    assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'none'/);
  }
});

test('document failures and overlarge documents fail explicitly without serving an unlabelled working UI',async()=>{
  for (const response of [new Response('missing',{status:404}),new Response('x'.repeat(65537))]) {
    await assert.rejects(publicEntrance(new Request('https://git.example/demo/'),{fetch:async()=>response}));
  }
});

test('authenticated workbench and reviewer documents use only protected asset paths',async()=>{
  const f = fixture();
  const page = await privateWorkbench(new Request('https://git.example/workspace/?view=review'),f.binding);
  const html = await page.text(); assert.match(html,/src="\/workspace\/assets\/app.js"/);
  assert.match(html,/href="\/workspace\/">Sign in with Access/); assert.doesNotMatch(html,/data-demo="read-only"/);
  const review = await privateWorkbench(new Request('https://git.example/workspace/reviewer'),f.binding);
  assert.match(await review.text(),/src="\/workspace\/assets\/reviewer.js"/);
  assert.equal((await privateWorkbench(new Request('https://git.example/workspace/assets/app.js'),f.binding)).status,200);
  assert.equal((await privateWorkbench(new Request('https://git.example/workspace/assets/.dev.vars'),f.binding)).status,404);
});

test('public activation is off in working configurations and preview has only local static assets',async()=>{
  for (const name of ['wrangler.jsonc','wrangler.hosted.jsonc']) {
    const config = JSON.parse(await readFile(new URL('../'+name,import.meta.url),'utf8'));
    assert.equal(config.vars.PUBLIC_ENTRANCE_ENABLED,'false'); assert.equal(config.assets.run_worker_first,true);
  }
  const config = JSON.parse(await readFile(new URL('../wrangler.entrance-preview.jsonc',import.meta.url),'utf8'));
  assert.equal(config.workers_dev,false); assert.equal(config.preview_urls,false); assert.deepEqual(config.routes,[]);
  for (const binding of ['durable_objects','artifacts','containers','ai','services','vars','queues']) assert.equal(config[binding],undefined);
});

test('protected owner and reviewer documents retain a same-origin CSP on GET and HEAD',async()=>{
  const f = fixture();
  for (const path of ['/workspace/','/workspace/reviewer']) for (const method of ['GET','HEAD']) {
    const response = await privateWorkbench(new Request('https://git.example'+path,{method}),f.binding);
    assert.equal(response.status,200);
    const policy = response.headers.get('Content-Security-Policy');
    assert.ok(policy);
    for (const directive of ["default-src 'self'","script-src 'self'","style-src 'self'","connect-src 'self'","object-src 'none'","base-uri 'none'","frame-ancestors 'none'"])
      assert.ok(policy.split(';').map(s=>s.trim()).includes(directive),method+' '+path+' '+directive);
    assert.doesNotMatch(policy,/unsafe-inline|unsafe-eval|\*/);
    if (method === 'HEAD') assert.equal(await response.text(),'');
  }
});
