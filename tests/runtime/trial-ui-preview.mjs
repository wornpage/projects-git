// Local QA only. Invented identities are signed here, never in product code.
// All provider fetches are intercepted by the shared workerd fixture.
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createLocalTrialRuntime} from '../helpers/trial-runtime.mjs';

const evidence=process.argv[2];if(!evidence)throw Error('Pass a local QA evidence directory.');
const runtime=await createLocalTrialRuntime({durationMs:604800000,dailyAdmissions:100,activeTrials:100,totalAdmissions:1000});
let scenario='fresh',actor,sequence=0,lost=false;const observations=[];
async function fresh(){actor=await runtime.token('preview-'+(++sequence),'alex@example.test');lost=false;}
await fresh();
const modes=new Set(['fresh','reserved','capacity','expired','closed','unavailable','session-expired','lost-response']);
const controls='<aside class="fixture-controls" aria-label="Local QA fixture"><strong>Local QA · invented identity · no emails or hosted services</strong><details><summary>QA states</summary><nav>'+[...modes].map(mode=>`<a href="/__fixture__/${mode}">${mode}</a>`).join(' · ')+' · <button id="fixture-switch" type="button">Switch to Blair without reloading</button></nav></details></aside><script src="/__fixture__/controls.js" defer></script>';
const server=createServer(async(req,res)=>{
  try{
    const origin='http://127.0.0.1:'+server.address().port,url=new URL(req.url,origin);
    if(url.pathname==='/__fixture__/fixture.css') {res.writeHead(200,{'Content-Type':'text/css','Cache-Control':'no-store'});res.end('.fixture-controls{padding:8px 24px;background:#e9f0f5;border-bottom:1px solid #bdcbd7;font:12px/1.6 system-ui;display:flex;gap:16px;flex-wrap:wrap}.fixture-controls summary{cursor:pointer}.fixture-controls a{display:inline-block;padding:4px}.fixture-controls button{font:inherit}');return;}
    if(url.pathname==='/__fixture__/controls.js'){
      res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end('document.getElementById("fixture-switch").addEventListener("click",async()=>{await fetch("/__fixture__/switch");document.getElementById("fixture-switch").textContent="Fixture identity is now Blair";});');return;
    }
    if(url.pathname==='/__fixture__/switch') {actor=await runtime.token('preview-blair-'+sequence,'blair@example.test');res.writeHead(200,{'Content-Type':'application/json'});res.end('{"fixture":"identity switched"}');return;}
    if(url.pathname.startsWith('/__fixture__/')){
      const mode=url.pathname.slice('/__fixture__/'.length);if(!modes.has(mode)){res.writeHead(404);res.end();return;}
      await fresh();scenario=mode;
      if(['reserved','expired','closed'].includes(mode))await runtime.request('/api/trial',actor,{});
      if(mode==='closed')await runtime.request('/api/trial/close',actor,{});
      res.writeHead(303,{Location:mode==='fresh'?'/trial/':'/trial/signup'});res.end();return;
    }
    let response;
    if(scenario==='unavailable'&&url.pathname==='/api/trial/session')response=Response.json({code:'TRIAL_UNAVAILABLE'},{status:503});
    if(scenario==='session-expired'&&url.pathname==='/api/trial/session')response=Response.json({code:'UNAUTHORIZED'},{status:401});
    if(scenario==='capacity'&&url.pathname==='/api/trial'&&req.method==='POST')response=Response.json({code:'TRIAL_CAPACITY_FULL'},{status:429});
    if(!response){
      const body=req.method==='POST'?await new Promise((done,fail)=>{const bytes=[];let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>2048){fail(Error('Fixture body too large'));req.destroy();}else bytes.push(chunk);});req.on('end',()=>done(Buffer.concat(bytes)));req.on('error',fail);}):undefined;
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value&&!['host','connection','content-length','accept-encoding','cf-access-jwt-assertion'].includes(name))headers.set(name,Array.isArray(value)?value.join(','):value);
      headers.set('Cf-Access-Jwt-Assertion',actor);
      response=await runtime.mf.dispatchFetch(origin+url.pathname+url.search,{method:req.method,headers,body});
      if(scenario==='expired'&&url.pathname==='/api/trial'&&req.method==='GET'&&response.ok){
        const value=await response.json(),expires=Date.now()-1000;response=Response.json({...value,status:'expired',createdAt:new Date(expires-604800000).toISOString(),expiresAt:new Date(expires).toISOString(),remainingMs:0,capabilities:{...value.capabilities,workspaceReads:false},cleanup:'not-implemented'});
      }
    }
    observations.push({method:req.method,path:url.pathname,status:response.status,scenario});
    if(scenario==='lost-response'&&!lost&&url.pathname==='/api/trial'&&req.method==='POST'&&response.ok){lost=true;res.destroy();return;}
    const headers=Object.fromEntries(response.headers);
    if(headers['content-type']?.includes('text/html')){
      const html=(await response.text()).replace('</head>','<link rel="stylesheet" href="/__fixture__/fixture.css"></head>').replace('<body>','<body>'+controls);
      delete headers['content-length'];delete headers['content-encoding'];res.writeHead(response.status,headers);res.end(html);
    }else{res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));}
  }catch{if(!res.headersSent)res.writeHead(500);res.end('Local fixture failed.');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/trial/',fixture:true,pid:process.pid}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();await new Promise(done=>server.close(done));await runtime.dispose();
  await mkdir(resolve(evidence),{recursive:true});await writeFile(resolve(evidence,'browser-fixture-receipt.json'),JSON.stringify({fixture:true,disposed:true,outbound:runtime.outbound,observations},null,2));
  console.log('Local fixture disposed.');process.exit(0);}
createInterface({input:process.stdin}).on('line',line=>{if(line==='stop')void stop();});
process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});setTimeout(()=>{void stop();},20*60_000).unref();
