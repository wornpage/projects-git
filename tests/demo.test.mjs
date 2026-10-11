import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import demo from '../src/demo/worker.mjs';
import {demoDocument} from '../src/demo/document.mjs';
import {createDemoApi} from '../public/demo/client.js';
import {createExampleWorkspace,exampleIds} from '../public/demo/workspace.js';
import {candidateLifecycle} from '../public/task-lifecycle.js';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const index=await read('public/index.html'),welcome=await read('public/demo/welcome.html');
function fixture(){
  const calls=[];
  const env=new Proxy({ASSETS:{fetch:async request=>{const path=new URL(request.url).pathname;calls.push(path);
    if(path==='/index.html')return new Response(index,{headers:{'Content-Type':'text/html'}});
    if(path==='/demo/welcome.html')return new Response(welcome,{headers:{'Content-Type':'text/html'}});
    if(path==='/app.js')return new Response('/* workbench */',{headers:{'Content-Type':'text/javascript'}});
    return new Response('Not found',{status:404});}}},{get(target,key){assert.equal(key,'ASSETS','Demo reached a non-asset binding');return target[key];}});
  return {calls,fetch:(path,method='GET')=>demo.fetch(new Request('https://demo.example'+path,{method}),env)};
}

test('welcome and guided pages share one workbench document with explicit sample labels',async()=>{
  const f=fixture(),landing=await f.fetch('/'),page=await f.fetch('/?view=review&task='+exampleIds.task);
  assert.equal(landing.status,200);const text=await landing.text();
  assert.match(text,/Explore a completed project/);assert.match(text,/invented records/);assert.doesNotMatch(text,/hosted-proof|qualification record|Historical October/);
  const app=await page.text();assert.match(app,/<body data-demo="read-only">/);assert.match(app,/id="demo-guide"/);
  assert.match(app,/id="open-demo-guide"[^>]*aria-haspopup="dialog"/);assert.match(app,/id="demo-guide-body"[^>]*hidden/);
  assert.match(app,/Read-only example\./);assert.match(app,/id="demo-guide-steps"/);
  assert.match(app,/script type="module" src="\/app.js"/);assert.equal((app.match(/id="content"/g)??[]).length,1);
  assert.deepEqual(f.calls,['/demo/welcome.html','/index.html']);
});

test('collection deep links survive a full page reload without opening an individual task',async()=>{
  const f=fixture();
  for(const view of ['projects','queue','history']){
    const response=await f.fetch('/?view='+view+'&project='+exampleIds.project);
    assert.equal(response.status,200);assert.match(await response.text(),/data-demo="read-only"/);
  }
});

test('the public demo refuses every non-read method before accessing any binding',async()=>{
  const f=fixture();
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS'])for(const path of ['/','/api/tasks','/api/runs/'+exampleIds.safe+'/merge','/app.js']){
    const response=await f.fetch(path,method);assert.equal(response.status,405);assert.equal(response.headers.get('Allow'),'GET, HEAD');
    assert.equal((await response.json()).error.code,'DEMO_READ_ONLY');
  }
  assert.deepEqual(f.calls,[]);
});

test('workspace APIs, login routes, foreign pages and encoded traversal have no demo authority',async()=>{
  const f=fixture();
  for(const path of ['/api/workspace','/api/health','/cdn-cgi/access/login','/reviewer.html','/qa/.dev.vars','/%2e%2e%2fprivate.js','/private%5csecret.js','/?view=unknown'])
    assert.equal((await f.fetch(path)).status,404,path);
  assert.equal((await f.fetch('/bad%zz.js')).status,400);assert.deepEqual(f.calls,[]);
});

test('both HTML entry names preserve the demo and HEAD responses have no body',async()=>{
  const f=fixture();
  assert.match(await (await f.fetch('/index.html?view=work')).text(),/data-demo="read-only"/);
  for(const path of ['/','/?view=work','/app.js']){
    const response=await f.fetch(path,'HEAD');assert.equal(response.status,200);assert.equal(await response.text(),'');
    assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'none'/);
  }
});

test('private proof data and historical evidence routes are unavailable',async()=>{
  const f=fixture();
  for(const method of ['GET','HEAD']) for(const path of ['/demo/proof.json','/docs/evidence/private.json'])
    assert.equal((await f.fetch(path,method)).status,404);
  assert.deepEqual(f.calls,[]);
});

test('document drift fails explicitly instead of opening an unlabeled working UI',()=>{
  assert.throws(()=>demoDocument(index.replace('<body>','<body class="different">')),/contract changed/);
  assert.throws(()=>demoDocument(index.replace('<div id="content"','<div id="other"')),/contract changed/);
});

test('the demo client is immutable and never falls through to HTTP, including forged owner actions',async()=>{
  const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Network forbidden');};
  try{const api=createDemoApi(),first=await api('/api/workspace');first.authentication.permissions.manage=true;first.projects[exampleIds.project].name='Tampered';
    const next=await api('/api/workspace');assert.equal(next.authentication.permissions.manage,false);assert.notEqual(next.projects[exampleIds.project].name,'Tampered');
    for(const path of ['/api/tasks','/api/runs/'+exampleIds.safe+'/review','/api/runs/'+exampleIds.safe+'/merge','/api/workspace'])
      await assert.rejects(api(path,{principal:'owner'}),error=>error.status===405);
    await assert.rejects(api('/api/runs/foreign/review-context'),error=>error.status===404);assert.equal(calls,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('example counts, attribution and queued follow-up remain separate from hosted proof',()=>{
  const workspace=createExampleWorkspace(),safe=workspace.runs.find(run=>run.id===exampleIds.safe),fast=workspace.runs.find(run=>run.id===exampleIds.fast);
  assert.equal(workspace.demonstration.records,'synthetic');assert.equal(workspace.authentication.mode,'read-only-demo');
  assert.deepEqual([fast.evidence.passed,fast.evidence.total,safe.evidence.passed,safe.evidence.total],[1,3,3,3]);
  assert.equal(safe.evidence.operation,undefined);assert.equal(safe.evidenceHistory[0].operation,'merge');
  assert.deepEqual(candidateLifecycle(workspace,safe).map(stage=>stage.label),['Commit submitted','Passed','Passed','Accepted','Merged']);
  assert.match(candidateLifecycle(workspace,safe)[3].detail,/Illustrative owner/);
  assert.equal(workspace.tasks[1].baseCommit,workspace.projects[exampleIds.project].mainCommit);
  assert.deepEqual(workspace.tasks[1].dependsOn,[exampleIds.task]);assert.equal(workspace.tasks[1].status,'open');
});

test('demo configuration contains no workspace, provider or credential bindings and stays offline',async()=>{
  const config=JSON.parse(await read('wrangler.demo.jsonc'));
  assert.deepEqual(Object.keys(config).sort(),['$schema','assets','compatibility_date','main','name','observability','preview_urls','routes','workers_dev']);
  assert.equal(config.assets.binding,'ASSETS');assert.equal(config.assets.run_worker_first,true);
  assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);
});
