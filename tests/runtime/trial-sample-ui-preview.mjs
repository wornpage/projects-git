// Local browser QA: invented identities, real loopback Git/SQLite and a simulated
// Artifacts control plane. No Cloudflare resource or email is created.
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {trialSampleFixture} from '../helpers/trial-sample.mjs';
import {trialWorkflowFixture} from '../helpers/trial-workflow.mjs';
import {handler,token,req,admit} from '../helpers/trial-http.mjs';

const evidence=process.argv[2];if(!evidence)throw Error('Pass a local QA evidence directory.');
const cleanups=[],lifecycle={after:fn=>cleanups.push(fn)},workflow=process.argv.includes('--workflow');
const f=workflow?await trialWorkflowFixture(lifecycle):await trialSampleFixture(lifecycle,{policyOverrides:{durationMs:604800000}});
const publicRoot=fileURLToPath(new URL('../../public/',import.meta.url)),types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml'};
f.env.ASSETS={fetch:async request=>{
  const path=resolve(publicRoot,'.'+decodeURIComponent(new URL(request.url).pathname));
  if(!path.startsWith(resolve(publicRoot)+sep)||!types[extname(path)])return new Response('No fixture asset',{status:404});
  try{return new Response(await readFile(path),{headers:{'Content-Type':types[extname(path)]}});}catch{return new Response('Missing fixture asset',{status:404});}
}};
const modes=['not-started','unavailable','lost-response','retryable','permanent','closed','expired'];
let actor,sequence=0,scenario='not-started',lost=false,stopping=false;const observations=[];
async function fresh(mode){
  scenario=mode;actor=await token('sample-preview-'+(++sequence),{email:'alex@example.test'});lost=false;
  for(const key of Object.keys(f.hooks))delete f.hooks[key];
  f.env.TRIAL_ARTIFACTS=mode==='unavailable'?undefined:f.artifacts;
  await admit(f,actor);
  if(mode==='retryable')f.hooks.afterSeed=async()=>{delete f.hooks.afterSeed;throw Error('Controlled interruption after local push');};
  if(mode==='permanent')f.hooks.create=async repo=>{delete f.hooks.create;repo.data.description='Unrelated fixture ownership';};
  if(mode==='closed')await handler(req('/api/trial/close',actor,{}),f.env);
}
await fresh('not-started');
const controls='<aside class="fixture-controls" aria-label="Local QA fixture"><strong>Local QA · invented identities · real local Git/SQLite · simulated Artifacts · no hosted services</strong><details><summary>QA states</summary><nav>'
  +modes.map(mode=>`<a href="/__fixture__/${mode}">${mode}</a>`).join(' · ')+' · <button id="fixture-switch" type="button">Switch to Blair without reloading</button></nav></details></aside><script src="/__fixture__/controls.js" defer></script>';
const server=createServer(async(request,response)=>{
  try {
    const origin='http://127.0.0.1:'+server.address().port,url=new URL(request.url,origin);
    if(url.pathname==='/__fixture__/controls.js'){response.writeHead(200,{'Content-Type':'text/javascript'});response.end('document.getElementById("fixture-switch").addEventListener("click",async()=>{await fetch("/__fixture__/switch");document.getElementById("fixture-switch").textContent="Fixture identity is now Blair";});');return;}
    if(url.pathname==='/__fixture__/fixture.css'){response.writeHead(200,{'Content-Type':'text/css'});response.end('.fixture-controls{padding:8px 24px;background:#e9f0f5;border-bottom:1px solid #bdcbd7;font:12px/1.6 system-ui}.fixture-controls nav{display:flex;gap:8px;flex-wrap:wrap}.fixture-controls button{font:inherit}.fixture-controls summary{cursor:pointer}');return;}
    if(url.pathname==='/__fixture__/switch'){actor=await token('sample-blair-'+sequence,{email:'blair@example.test'});response.writeHead(200);response.end('Fixture identity switched.');return;}
    if(url.pathname.startsWith('/__fixture__/')){const mode=url.pathname.slice('/__fixture__/'.length);if(!modes.includes(mode)){response.writeHead(404);response.end();return;}await fresh(mode);response.writeHead(303,{Location:'/trial/signup'});response.end();return;}
    const body=request.method==='POST'?await new Promise((done,fail)=>{const chunks=[];let size=0;request.on('data',chunk=>{size+=chunk.length;if(size>2048){request.destroy();fail(Error('Fixture body limit'));}else chunks.push(chunk);});request.on('end',()=>done(Buffer.concat(chunks)));request.on('error',fail);}):undefined;
    const headers=new Headers();for(const [name,value] of Object.entries(request.headers))if(value&&!['host','connection','content-length','accept-encoding','cf-access-jwt-assertion'].includes(name))headers.set(name,Array.isArray(value)?value.join(','):value);
    headers.set('Cf-Access-Jwt-Assertion',actor);
    let result=await handler(new Request(origin+url.pathname+url.search,{method:request.method,headers,body}),f.env);
    if(scenario==='expired'&&url.pathname==='/api/trial'&&request.method==='GET'&&result.ok){const status=await result.json(),expires=Date.now()-1000;
      result=Response.json({...status,status:'expired',createdAt:new Date(expires-604800000).toISOString(),expiresAt:new Date(expires).toISOString(),remainingMs:0,capabilities:{...status.capabilities,workspaceReads:false},cleanup:'pending'});}
    observations.push({method:request.method,path:url.pathname,status:result.status,scenario});
    if(scenario==='lost-response'&&!lost&&url.pathname==='/api/trial/sample'&&request.method==='POST'&&result.ok){lost=true;response.destroy();return;}
    const outgoing=Object.fromEntries(result.headers);outgoing['cache-control']='no-store';
    if(outgoing['content-type']?.includes('text/html')){const html=(await result.text()).replace('</head>','<link rel="stylesheet" href="/__fixture__/fixture.css"></head>').replace('<body>','<body>'+controls);
      delete outgoing['content-length'];response.writeHead(result.status,outgoing);response.end(html);
    }else{response.writeHead(result.status,outgoing);response.end(Buffer.from(await result.arrayBuffer()));}
  }catch{if(!response.headersSent)response.writeHead(500);response.end('Local QA fixture failed.');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/trial/signup',fixture:true,pid:process.pid}));
async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();await new Promise(done=>server.close(done));for(const cleanup of [...cleanups].reverse())await cleanup();
  await mkdir(resolve(evidence),{recursive:true});await writeFile(resolve(evidence,'browser-fixture-receipt.json'),JSON.stringify({fixture:true,disposed:true,provider:'simulated Artifacts',git:'real loopback smart-HTTP',sqlite:'real',observations,
    effects:{creates:f.count('create'),seeds:f.count('seed'),gitPushes:f.git.received.filter(call=>call.path.endsWith('/git-receive-pack')).length}},null,2));console.log('Local sample UI fixture disposed.');process.exit(0);}
createInterface({input:process.stdin}).on('line',line=>{if(line==='stop')void stop();});
process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});setTimeout(()=>{void stop();},20*60_000).unref();
