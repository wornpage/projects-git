import {createHash} from 'node:crypto';
import {decodeJwt} from 'jose';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {AccessVerifier} from '../../src/cloudflare/access.ts';
import {sqliteStorage} from './sqlite-store.mjs';

const base=new URL('../../src/cloudflare/',import.meta.url),require=createRequire(base);
class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}
function load(name,index){
  const file=new URL(name,base),module={exports:{}};
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code;
  new Function('require','module','exports',code)(path=>path==='cloudflare:workers'?{DurableObject,WorkerEntrypoint:DurableObject}
    :path==='./check-container.ts'?{RepositoryCheckContainer:class{}}:path==='./index.ts'?index:require(path),module,module.exports);
  return module.exports;
}
const index=load('index.ts'),trial=load('trial-worker.ts',index);
const pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'trial-test',alg:'RS256'};
const policy={revision:'fixture-v1',issuer:'https://fixture.cloudflareaccess.com',audience:'a'.repeat(64),durationMs:60_000,dailyAdmissions:20,activeTrials:50,totalAdmissions:1000};
const verifier=new AccessVerifier(async()=>Response.json({keys:[jwk]}),()=>Date.now());
const handler=trial.createTrialFetch(verifier);
async function token(subject='person-a',changes={}){
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({type:'app',iss:policy.issuer,aud:[policy.audience],sub:subject,email:'same@example.test',iat:now-1,exp:now+3600,...changes})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(pair.privateKey);
}
function context(storage,name){return{storage:{...storage,getAlarm:async()=>null,setAlarm:async()=>{throw new Error('No background scheduling allowed');}},id:{name}};}
function fixture(){
  const contexts=new Map(),calls=[],assetCalls=[];
  let registry;
  const env={WORKSPACE_ID:'',ACCESS_OWNER_SUB:'',TRIAL_POLICY:JSON.stringify(policy),
    TRIAL_REGISTRY:{getByName:name=>{assert.equal(name,'trial-admissions-v1');return registry;}},
    WORKSPACES:{getByName:name=>{
      calls.push(name);
      if(!contexts.has(name)){const sql=sqliteStorage();const ctx=context(sql.storage,name);contexts.set(name,{...sql,ctx,coordinator:new index.WorkspaceCoordinator(ctx,env)});}
      return contexts.get(name).coordinator;
    }},ASSETS:{fetch:async request=>{assetCalls.push(request.url);return new Response('static app');}}};
  const sql=sqliteStorage();registry=new trial.TrialAdmissions(context(sql.storage,'trial-admissions-v1'),env);
  return{env,registry,contexts,calls,assetCalls,sql};
}
function req(path,jwt,body,extra={}){
  const mutation=body!==undefined;
  return new Request('https://trial.example.test'+path,{method:mutation?'POST':'GET',
    headers:{...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),...(mutation?{'Content-Type':'application/json','Idempotency-Key':'trial-test-request','Origin':'https://trial.example.test',...(jwt?{'X-Trial-Identity':identityKey(jwt)}:{})}:{}),...extra},
    body:mutation?JSON.stringify(body):undefined});
}
async function admit(c,jwt){const result=await handler(req('/api/trial',jwt,{}),c.env);assert.equal(result.status,200);return result.json();}


function identityKey(jwt){try{const c=decodeJwt(jwt);return createHash('sha256').update(JSON.stringify([c.iss,Array.isArray(c.aud)?c.aud[0]:c.aud,c.sub])).digest('hex');}catch{return '';}}
export {index,trial,policy,verifier,handler,token,context,fixture,req,admit,identityKey};
