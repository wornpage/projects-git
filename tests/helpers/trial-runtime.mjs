import {unapprovedTrialResources} from './trial-policy.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {generateKeyPair,exportJWK,SignJWT,decodeJwt} from 'jose';

const root=fileURLToPath(new URL('../../',import.meta.url)),publicRoot=resolve(root,'public');
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml'};
export async function createLocalTrialRuntime(overrides={}) {
  const issuer='https://fixture.cloudflareaccess.com',audience='a'.repeat(64);
  const pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'runtime-fixture',alg:'RS256'};
  const policy={revision:'runtime-local-v1',issuer,audience,durationMs:60000,dailyAdmissions:2,activeTrials:2,totalAdmissions:2,resources:unapprovedTrialResources,...overrides};
  const result=await build({entryPoints:[resolve(root,'src/cloudflare/trial-worker.ts')],bundle:true,write:false,
    platform:'neutral',format:'esm',target:'es2022',external:['cloudflare:*','node:*'],mainFields:['module','main'],conditions:['workerd','worker','browser'],
    banner:{js:'import {createRequire} from "node:module"; const require = createRequire("/trial.mjs");'},logLevel:'silent'});
  const outbound=[],assetRequests=[];
  const mf=new Miniflare({host:'127.0.0.1',port:0,inspectorPort:0,telemetry:{enabled:false},logRequests:false,workers:[{
    config:{name:'trial-fixture',compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'trial.mjs',modules:{'trial.mjs':{type:'esm',contents:result.outputFiles[0].text}}},
      env:{WORKSPACE_ID:{type:'text',value:''},ACCESS_OWNER_SUB:{type:'text',value:''},TRIAL_POLICY:{type:'text',value:JSON.stringify(policy)},
        TRIAL_REGISTRY:{type:'durable-object',worker:'trial-fixture',exportName:'TrialAdmissions'},
        WORKSPACES:{type:'durable-object',worker:'trial-fixture',exportName:'WorkspaceCoordinator'},
        ASSETS:{type:'fetcher',handler:async request=>{
          const path=resolve(publicRoot,'.'+decodeURIComponent(new URL(request.url).pathname));
          assert.ok(path.startsWith(publicRoot+sep),'Asset escaped public root');assetRequests.push(new URL(request.url).pathname);
          if(!types[extname(path)])return new Response('No fixture asset',{status:404});
          try{return new Response(await readFile(path),{headers:{'Content-Type':types[extname(path)]}});}catch{return new Response('Missing fixture asset',{status:404});}
        }}},
      exports:{TrialAdmissions:{type:'durable-object',storage:'sqlite'},WorkspaceCoordinator:{type:'durable-object',storage:'sqlite'}}},
    dev:{unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler:request=>{
      outbound.push(request.url);assert.equal(request.url,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});}}}}]});
  const token=async(sub,email='runtime@example.test')=>{const now=Math.floor(Date.now()/1000);return new SignJWT({type:'app',iss:issuer,aud:[audience],sub,email,iat:now-1,exp:now+3600})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);};
  const request=async(path,jwt,body,headers={})=>{
    const claims=decodeJwt(jwt),identityKey=createHash('sha256').update(JSON.stringify([issuer,audience,claims.sub])).digest('hex');
    return mf.dispatchFetch('https://trial.example.test'+path,{method:body===undefined?'GET':'POST',
      headers:{'Cf-Access-Jwt-Assertion':jwt,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':'runtime-admission-key','Origin':'https://trial.example.test','X-Trial-Identity':identityKey}),...headers},
      body:body===undefined?undefined:JSON.stringify(body)});
  };
  return {mf,policy,token,request,outbound,assetRequests,dispose:()=>mf.dispose()};
}
